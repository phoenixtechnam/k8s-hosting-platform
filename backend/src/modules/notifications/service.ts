import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { notifications } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getActiveChannels } from './channels/registry.js';
import type { NotificationRecord } from './channels/types.js';
import type { Database } from '../../db/index.js';

interface CreateNotificationInput {
  readonly userId: string;
  readonly type: 'info' | 'warning' | 'error' | 'success';
  readonly title: string;
  readonly message: string;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
}

export async function createNotification(db: Database, input: CreateNotificationInput) {
  const id = crypto.randomUUID();
  await db.insert(notifications).values({
    id,
    userId: input.userId,
    type: input.type,
    title: input.title,
    message: input.message,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
  });

  const [created] = await db.select().from(notifications).where(eq(notifications.id, id));
  return created;
}

export async function listNotifications(
  db: Database,
  userId: string,
  params: { limit?: number; unreadOnly?: boolean },
) {
  const limit = Math.min(params.limit ?? 20, 100);
  const conditions = [eq(notifications.userId, userId)];

  if (params.unreadOnly) {
    conditions.push(eq(notifications.isRead, 0));
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  return rows;
}

export async function markAsRead(db: Database, userId: string, ids: string[]) {
  await db
    .update(notifications)
    .set({ isRead: 1, readAt: new Date() })
    .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids)));
}

export async function getUnreadCount(db: Database, userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, 0)));

  return Number(result?.count ?? 0);
}

export async function deleteNotification(db: Database, userId: string, id: string) {
  const [notification] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));

  if (!notification) {
    throw new ApiError('NOTIFICATION_NOT_FOUND', `Notification '${id}' not found`, 404, { notification_id: id });
  }

  await db.delete(notifications).where(eq(notifications.id, id));
}

/**
 * Fire-and-forget notification helper. Wraps createNotification in try/catch
 * so callers can safely notify without risking their own operation.
 *
 * After the persisted row is created, every active channel
 * (in-app, email, future Slack/webhook/sms) gets a chance to deliver.
 * Channel availability is decided by `channels/registry.ts` —
 * unavailable channels are filtered out before this function sees them.
 *
 * Round-2 refactor: `encryptionKey` defaults to
 * `process.env.OIDC_ENCRYPTION_KEY` (the same key used by
 * startDkimScheduler in app.ts), so call sites no longer need to
 * thread it through every layer just to get emails sent. Pass an
 * explicit key to override — useful for tests.
 */
export async function notifyUser(
  db: Database,
  userId: string,
  opts: {
    readonly type: 'info' | 'warning' | 'error' | 'success';
    readonly title: string;
    readonly message: string;
    readonly resourceType?: string | null;
    readonly resourceId?: string | null;
  },
  encryptionKey?: string,
): Promise<void> {
  let created: NotificationRecord | undefined;
  try {
    const row = await createNotification(db, { userId, ...opts });
    if (!row) return;
    created = {
      id: row.id,
      userId: row.userId,
      type: row.type as NotificationRecord['type'],
      title: row.title,
      message: row.message,
      resourceType: row.resourceType ?? null,
      resourceId: row.resourceId ?? null,
    };
  } catch {
    // Fire-and-forget: notification failure must not break the caller
    return;
  }

  // Iterate the channel registry. Each channel decides for itself
  // whether to skip / deliver / fail; failures are caught here so a
  // bad channel can't starve the others. The in-app channel is a
  // no-op (the row is already persisted above) so we tolerate it
  // running unconditionally.
  const channels = getActiveChannels();
  const ctx = { db, notification: created, encryptionKey };
  for (const channel of channels) {
    // Sequential: keeps log ordering predictable for ops triage and
    // avoids hammering an SMTP relay with parallel sends per fan-out.
    // eslint-disable-next-line no-await-in-loop
    await channel.deliver(ctx).catch(() => {
      // Channels SHOULD return DeliveryResult rather than throw, but
      // a defensive catch here means a buggy channel impl can't kill
      // the loop. Swallow without logging — channels are responsible
      // for their own diagnostics.
    });
  }
}

/**
 * Fan-out helper: fire the same notification to every user ID in the
 * given list. Individual failures are swallowed (notifyUser is already
 * fire-and-forget) so one bad recipient cannot starve the others.
 *
 * Used by the events.ts helpers that resolve client_admin recipients
 * via getClientNotificationRecipients and then call this with the
 * resolved list.
 */
export async function notifyUsers(
  db: Database,
  userIds: readonly string[],
  opts: {
    readonly type: 'info' | 'warning' | 'error' | 'success';
    readonly title: string;
    readonly message: string;
    readonly resourceType?: string | null;
    readonly resourceId?: string | null;
  },
  encryptionKey?: string,
): Promise<void> {
  for (const uid of userIds) {
    // Sequential, not parallel: createNotification is cheap and
    // serial keeps the log ordering predictable for ops triage.
    // eslint-disable-next-line no-await-in-loop
    await notifyUser(db, uid, opts, encryptionKey);
  }
}
