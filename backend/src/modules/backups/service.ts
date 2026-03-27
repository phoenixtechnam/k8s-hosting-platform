import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { backups } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getClientById } from '../clients/service.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { CreateBackupInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

export async function createBackup(db: Database, clientId: string, input: CreateBackupInput) {
  await getClientById(db, clientId);

  const id = crypto.randomUUID();
  await db.insert(backups).values({
    id,
    clientId,
    backupType: input.backup_type,
    resourceType: input.resource_type,
    resourceId: input.resource_id ?? null,
    status: 'pending',
    notes: input.notes ?? null,
  });

  const [created] = await db.select().from(backups).where(eq(backups.id, id));
  return created;
}

export async function listBackups(
  db: Database,
  clientId: string,
  params: { limit: number; cursor?: string },
): Promise<{ data: typeof backups.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor } = params;

  const conditions = [eq(backups.clientId, clientId)];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(lt(backups.createdAt, new Date(decoded.sort)));
  }

  const rows = await db
    .select()
    .from(backups)
    .where(and(...conditions))
    .orderBy(desc(backups.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'backup',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(backups)
    .where(eq(backups.clientId, clientId));

  return {
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    },
  };
}

export async function deleteBackup(db: Database, clientId: string, backupId: string) {
  const [backup] = await db
    .select()
    .from(backups)
    .where(and(eq(backups.id, backupId), eq(backups.clientId, clientId)));

  if (!backup) {
    throw new ApiError('BACKUP_NOT_FOUND', `Backup '${backupId}' not found`, 404, { backup_id: backupId });
  }

  await db.delete(backups).where(eq(backups.id, backupId));
}
