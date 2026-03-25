import crypto from 'crypto';
import { eq, and, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { databases } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { getClientById } from '../clients/service.js';
import { hashNewPassword } from '../auth/service.js';
import type { Database } from '../../db/index.js';
import type { CreateDatabaseInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

function databaseNotFound(id: string): ApiError {
  return new ApiError('DATABASE_NOT_FOUND', `Database '${id}' not found`, 404, { database_id: id }, 'Verify database exists');
}

function generatePassword(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateUsername(name: string): string {
  const shortId = crypto.randomUUID().slice(0, 8);
  return `db_${name}_${shortId}`;
}

export async function createDatabase(
  db: Database,
  clientId: string,
  input: CreateDatabaseInput,
  _actorId: string,
): Promise<{ record: typeof databases.$inferSelect; password: string }> {
  // Verify client exists
  await getClientById(db, clientId);

  // Check for duplicate name
  const [existing] = await db.select().from(databases).where(eq(databases.name, input.name));
  if (existing) {
    throw new ApiError('DUPLICATE_ENTRY', 'This database already exists', 409, { resource: 'database', name: input.name }, 'Use unique identifier');
  }

  const id = crypto.randomUUID();
  const password = generatePassword();
  const passwordHash = await hashNewPassword(password);
  const username = generateUsername(input.name);
  const port = input.db_type === 'postgresql' ? 5432 : 3306;

  await db.insert(databases).values({
    id,
    clientId,
    name: input.name,
    databaseType: input.db_type,
    username,
    passwordHash,
    port,
    status: 'active',
  });

  const [created] = await db.select().from(databases).where(eq(databases.id, id));
  return { record: created, password };
}

export async function getDatabaseById(db: Database, clientId: string, databaseId: string) {
  const [record] = await db
    .select()
    .from(databases)
    .where(and(eq(databases.id, databaseId), eq(databases.clientId, clientId)));
  if (!record) throw databaseNotFound(databaseId);
  return record;
}

export async function listDatabases(
  db: Database,
  clientId: string,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' } },
): Promise<{ data: typeof databases.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort } = params;

  const conditions = [eq(databases.clientId, clientId)];

  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(
      sort.direction === 'desc' ? lt(databases.createdAt, new Date(decoded.sort)) : gt(databases.createdAt, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(databases.createdAt) : asc(databases.createdAt);
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(databases)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'database',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(databases).where(where);

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

export async function deleteDatabase(db: Database, clientId: string, databaseId: string) {
  await getDatabaseById(db, clientId, databaseId);
  await db.update(databases).set({ status: 'deleting' }).where(eq(databases.id, databaseId));
  await db.delete(databases).where(eq(databases.id, databaseId));
}

export async function rotateCredentials(
  db: Database,
  clientId: string,
  databaseId: string,
): Promise<{ record: typeof databases.$inferSelect; password: string }> {
  await getDatabaseById(db, clientId, databaseId);

  const password = generatePassword();
  const passwordHash = await hashNewPassword(password);

  await db.update(databases).set({ passwordHash }).where(eq(databases.id, databaseId));

  const [updated] = await db.select().from(databases).where(eq(databases.id, databaseId));
  return { record: updated, password };
}
