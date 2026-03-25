import { eq, and, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { workloads, containerImages } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { getClientById } from '../clients/service.js';
import type { Database } from '../../db/index.js';
import type { CreateWorkloadInput, UpdateWorkloadInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

export const workloadNotFound = (id: string) =>
  new ApiError('WORKLOAD_NOT_FOUND', `Workload '${id}' not found`, 404, { workload_id: id }, 'Verify workload exists');

export const imageNotFound = (id: string) =>
  new ApiError('IMAGE_NOT_FOUND', `Container image '${id}' not found`, 404, { image_id: id }, 'Verify image exists');

export async function createWorkload(db: Database, clientId: string, input: CreateWorkloadInput, _actorId: string) {
  await getClientById(db, clientId);

  const [image] = await db.select().from(containerImages).where(eq(containerImages.id, input.image_id));
  if (!image) {
    throw imageNotFound(input.image_id);
  }

  const id = crypto.randomUUID();
  await db.insert(workloads).values({
    id,
    clientId,
    name: input.name,
    containerImageId: input.image_id,
    replicaCount: input.replica_count,
    cpuRequest: input.cpu_request,
    memoryRequest: input.memory_request,
    status: 'pending',
  });

  const [created] = await db.select().from(workloads).where(eq(workloads.id, id));
  return created;
}

export async function getWorkloadById(db: Database, clientId: string, workloadId: string) {
  const [workload] = await db
    .select()
    .from(workloads)
    .where(and(eq(workloads.id, workloadId), eq(workloads.clientId, clientId)));
  if (!workload) throw workloadNotFound(workloadId);
  return workload;
}

export async function listWorkloads(
  db: Database,
  clientId: string,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' } },
): Promise<{ data: typeof workloads.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort } = params;

  const conditions = [eq(workloads.clientId, clientId)];

  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(
      sort.direction === 'desc' ? lt(workloads.createdAt, new Date(decoded.sort)) : gt(workloads.createdAt, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(workloads.createdAt) : asc(workloads.createdAt);
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(workloads)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'workload',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(workloads).where(where);

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

export async function updateWorkload(db: Database, clientId: string, workloadId: string, input: UpdateWorkloadInput) {
  await getWorkloadById(db, clientId, workloadId);

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.image_id !== undefined) {
    const [image] = await db.select().from(containerImages).where(eq(containerImages.id, input.image_id));
    if (!image) throw imageNotFound(input.image_id);
    updateValues.containerImageId = input.image_id;
  }
  if (input.replica_count !== undefined) updateValues.replicaCount = input.replica_count;
  if (input.cpu_request !== undefined) updateValues.cpuRequest = input.cpu_request;
  if (input.memory_request !== undefined) updateValues.memoryRequest = input.memory_request;
  if (input.status !== undefined) updateValues.status = input.status;

  if (Object.keys(updateValues).length > 0) {
    await db.update(workloads).set(updateValues).where(eq(workloads.id, workloadId));
  }

  return getWorkloadById(db, clientId, workloadId);
}

export async function deleteWorkload(db: Database, clientId: string, workloadId: string) {
  await getWorkloadById(db, clientId, workloadId);
  await db.delete(workloads).where(eq(workloads.id, workloadId));
}
