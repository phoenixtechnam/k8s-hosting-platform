import { eq, and, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { workloads, containerImages, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { getClientById } from '../clients/service.js';
import { deployWorkload, stopWorkload, startWorkload, deleteWorkloadResources } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import type { CreateWorkloadInput, UpdateWorkloadInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

export const workloadNotFound = (id: string) =>
  new ApiError('WORKLOAD_NOT_FOUND', `Workload '${id}' not found`, 404, { workload_id: id }, 'Verify workload exists');

export const imageNotFound = (id: string) =>
  new ApiError('IMAGE_NOT_FOUND', `Container image '${id}' not found`, 404, { image_id: id }, 'Verify image exists');

export async function createWorkload(db: Database, clientId: string, input: CreateWorkloadInput, _actorId: string, k8s?: K8sClients) {
  const client = await getClientById(db, clientId);

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

  // Deploy to k8s if cluster is available
  if (k8s && client.kubernetesNamespace) {
    try {
      await deployWorkload(k8s, {
        name: input.name,
        image: image.registryUrl ?? `${image.code}:latest`,
        containerPort: image.containerPort ?? 8080,
        replicaCount: input.replica_count ?? 1,
        cpuRequest: input.cpu_request ?? '100m',
        memoryRequest: input.memory_request ?? '128Mi',
        mountPath: image.mountPath,
        namespace: client.kubernetesNamespace,
      });
      await db.update(workloads).set({ status: 'running' }).where(eq(workloads.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(workloads).set({ status: 'failed' }).where(eq(workloads.id, id));
      // Don't throw — workload record exists, just failed to deploy
      // Caller can see status='failed' and retry
    }
  }

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

export async function updateWorkload(db: Database, clientId: string, workloadId: string, input: UpdateWorkloadInput, k8s?: K8sClients) {
  const workload = await getWorkloadById(db, clientId, workloadId);

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

  // Apply k8s changes for status transitions
  if (k8s && input.status) {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const namespace = client?.kubernetesNamespace;
    if (namespace) {
      try {
        if (input.status === 'stopped') {
          await stopWorkload(k8s, namespace, workload.name);
        } else if (input.status === 'running') {
          await startWorkload(k8s, namespace, workload.name, workload.replicaCount ?? 1);
        }
      } catch {
        // K8s operation failed — DB already updated, status will be reconciled
      }
    }
  }

  return getWorkloadById(db, clientId, workloadId);
}

export async function deleteWorkload(db: Database, clientId: string, workloadId: string, k8s?: K8sClients) {
  const workload = await getWorkloadById(db, clientId, workloadId);

  // Delete k8s resources first
  if (k8s) {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const namespace = client?.kubernetesNamespace;
    if (namespace) {
      try {
        await deleteWorkloadResources(k8s, namespace, workload.name);
      } catch {
        // K8s cleanup failed — still delete DB record
      }
    }
  }

  await db.delete(workloads).where(eq(workloads.id, workloadId));
}
