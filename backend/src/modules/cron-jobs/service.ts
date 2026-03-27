import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { cronJobs } from '../../db/schema.js';
import { getClientById } from '../clients/service.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { CreateCronJobInput, UpdateCronJobInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

export async function createCronJob(db: Database, clientId: string, input: CreateCronJobInput) {
  await getClientById(db, clientId);

  const id = crypto.randomUUID();
  await db.insert(cronJobs).values({
    id,
    clientId,
    name: input.name,
    schedule: input.schedule,
    command: input.command,
    enabled: input.enabled ? 1 : 0,
  });

  const [created] = await db.select().from(cronJobs).where(eq(cronJobs.id, id));
  return created;
}

export async function getCronJobById(db: Database, clientId: string, cronJobId: string) {
  const [job] = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, cronJobId), eq(cronJobs.clientId, clientId)));
  if (!job) {
    throw new ApiError('CRON_JOB_NOT_FOUND', `Cron job '${cronJobId}' not found`, 404, { cron_job_id: cronJobId });
  }
  return job;
}

export async function listAllCronJobs(
  db: Database,
  params: { limit: number; cursor?: string },
): Promise<{ data: typeof cronJobs.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor } = params;

  const conditions = [];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(lt(cronJobs.createdAt, new Date(decoded.sort)));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(cronJobs)
    .where(where)
    .orderBy(desc(cronJobs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'cron_job',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(cronJobs);

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

export async function listCronJobs(
  db: Database,
  clientId: string,
  params: { limit: number; cursor?: string },
): Promise<{ data: typeof cronJobs.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor } = params;

  const conditions = [eq(cronJobs.clientId, clientId)];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(lt(cronJobs.createdAt, new Date(decoded.sort)));
  }

  const rows = await db
    .select()
    .from(cronJobs)
    .where(and(...conditions))
    .orderBy(desc(cronJobs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'cron_job',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(cronJobs)
    .where(eq(cronJobs.clientId, clientId));

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

export async function updateCronJob(db: Database, clientId: string, cronJobId: string, input: UpdateCronJobInput) {
  await getCronJobById(db, clientId, cronJobId);

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.schedule !== undefined) updateValues.schedule = input.schedule;
  if (input.command !== undefined) updateValues.command = input.command;
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;

  if (Object.keys(updateValues).length > 0) {
    await db.update(cronJobs).set(updateValues).where(eq(cronJobs.id, cronJobId));
  }

  return getCronJobById(db, clientId, cronJobId);
}

export async function runCronJobNow(db: Database, clientId: string, cronJobId: string) {
  await getCronJobById(db, clientId, cronJobId);

  // Record a "run now" execution — in production this would trigger the actual job via k8s Job API
  await db.update(cronJobs).set({
    lastRunAt: new Date(),
    lastRunStatus: 'success',
  }).where(eq(cronJobs.id, cronJobId));

  return getCronJobById(db, clientId, cronJobId);
}

export async function deleteCronJob(db: Database, clientId: string, cronJobId: string) {
  await getCronJobById(db, clientId, cronJobId);
  await db.delete(cronJobs).where(eq(cronJobs.id, cronJobId));
}
