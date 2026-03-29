import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { notifications } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { sendNotificationEmail } from './email-sender.js';
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
  try {
    const created = await createNotification(db, { userId, ...opts });

    // Fire-and-forget email notification if encryption key is available
    if (encryptionKey && created) {
      sendNotificationEmail(db, created, encryptionKey).catch(() => {
        // Silently ignore email failures
      });
    }
  } catch {
    // Fire-and-forget: notification failure must not break the caller
  }
}
