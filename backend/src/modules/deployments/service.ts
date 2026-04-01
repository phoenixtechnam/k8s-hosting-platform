/**
 * Deployment CRUD service.
 *
 * Manages the unified deployments table that replaces both workloads and application_instances.
 */

import { eq, and, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { deployments, catalogEntries, catalogEntryVersions, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { getClientById } from '../clients/service.js';
import {
  deployCatalogEntry,
  stopDeployment,
  startDeployment,
  deleteDeploymentResources,
} from './k8s-deployer.js';
import type { DeployComponentInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import type { CreateDeploymentInput, UpdateDeploymentInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

// ─── Error Helpers ──────────────────────────────────────────────────────────

const deploymentNotFound = (id: string) =>
  new ApiError('DEPLOYMENT_NOT_FOUND', `Deployment '${id}' not found`, 404, { deployment_id: id }, 'Verify deployment exists');

const catalogEntryNotFound = (id: string) =>
  new ApiError('CATALOG_ENTRY_NOT_FOUND', `Catalog entry '${id}' not found`, 404, { catalog_entry_id: id }, 'Verify catalog entry exists');

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJsonField<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return null; }
  }
  return value as T;
}

// ─── Component Resolution ───────────────────────────────────────────────────

function resolveComponents(
  entry: typeof catalogEntries.$inferSelect,
  versionComponents?: readonly { name: string; image: string }[] | null,
): DeployComponentInput[] {
  // If version-specific components are provided, use those images
  const rawComponents = parseJsonField<unknown[]>(entry.components) ?? [];
  const baseComponents = rawComponents as Array<{
    name: string;
    type: 'deployment' | 'statefulset' | 'cronjob' | 'job';
    image: string;
    ports?: Array<{ port: number; protocol: string; ingress?: boolean }>;
    optional?: boolean;
    schedule?: string;
  }>;

  if (baseComponents.length === 0) {
    // Simple runtime/single-image entry — build a single deployment component
    const image = versionComponents?.[0]?.image ?? entry.image ?? `${entry.code}:latest`;
    return [{
      name: entry.code,
      type: 'deployment',
      image,
      ports: resolveIngressPorts(entry),
      optional: false,
    }];
  }

  return baseComponents.map(comp => {
    // Override image from version-specific components if available
    const versionImage = versionComponents?.find(vc => vc.name === comp.name)?.image;

    return {
      name: comp.name,
      type: comp.type,
      image: versionImage ?? comp.image,
      ports: comp.ports ?? [],
      optional: comp.optional ?? false,
      schedule: comp.schedule,
    };
  });
}

function resolveIngressPorts(
  entry: typeof catalogEntries.$inferSelect,
): Array<{ port: number; protocol: string; ingress?: boolean }> {
  const networking = entry.networking as { ingress_ports?: Array<{ port: number; protocol: string }> } | null;
  if (networking?.ingress_ports && networking.ingress_ports.length > 0) {
    return networking.ingress_ports.map(p => ({ port: p.port, protocol: p.protocol, ingress: true }));
  }
  // Default: expose port 8080
  return [{ port: 8080, protocol: 'tcp', ingress: true }];
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function createDeployment(
  db: Database,
  clientId: string,
  input: CreateDeploymentInput,
  actorId: string,
  k8s?: K8sClients,
) {
  const client = await getClientById(db, clientId);

  // Look up catalog entry
  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, input.catalog_entry_id));

  if (!entry) throw catalogEntryNotFound(input.catalog_entry_id);

  // Resolve version-specific components
  let versionComponents: readonly { name: string; image: string }[] | null = null;
  let installedVersion: string | null = null;

  if (input.version) {
    const [version] = await db
      .select()
      .from(catalogEntryVersions)
      .where(
        and(
          eq(catalogEntryVersions.catalogEntryId, entry.id),
          eq(catalogEntryVersions.version, input.version),
        ),
      );
    if (version) {
      versionComponents = version.components;
      installedVersion = version.version;
    }
  } else if (entry.defaultVersion) {
    // Use default version
    const [version] = await db
      .select()
      .from(catalogEntryVersions)
      .where(
        and(
          eq(catalogEntryVersions.catalogEntryId, entry.id),
          eq(catalogEntryVersions.version, entry.defaultVersion),
        ),
      );
    if (version) {
      versionComponents = version.components;
      installedVersion = version.version;
    }
  }

  const components = resolveComponents(entry, versionComponents);
  const namespace = client.kubernetesNamespace;
  const volumes = (parseJsonField<unknown[]>(entry.volumes) ?? []) as Array<{ local_path: string; container_path: string; size_megabytes: number }>;

  const id = crypto.randomUUID();

  await db.insert(deployments).values({
    id,
    clientId,
    catalogEntryId: input.catalog_entry_id,
    name: input.name,
    domainName: input.domain_name ?? null,
    replicaCount: input.replica_count ?? 1,
    cpuRequest: input.cpu_request ?? '0.25',
    memoryRequest: input.memory_request ?? '256Mi',
    configuration: input.configuration ?? null,
    installedVersion,
    targetVersion: installedVersion,
    status: 'pending',
  });

  // Deploy to K8s if cluster is available
  if (k8s && namespace) {
    try {
      await deployCatalogEntry(k8s, {
        deploymentName: input.name,
        namespace,
        components,
        volumes,
        replicaCount: input.replica_count ?? 1,
        cpuRequest: input.cpu_request ?? '0.25',
        memoryRequest: input.memory_request ?? '256Mi',
        configuration: input.configuration,
        envVars: parseJsonField<{ fixed?: Record<string, string> }>(entry.envVars) ?? undefined,
      });
      await db.update(deployments).set({ status: 'deploying' }).where(eq(deployments.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[deployments] K8s deploy failed for ${input.name}:`, message);
      await db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, id));
    }
  }

  const [created] = await db.select().from(deployments).where(eq(deployments.id, id));
  return created;
}

export async function getDeploymentById(db: Database, clientId: string, deploymentId: string) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.clientId, clientId)));

  if (!deployment) throw deploymentNotFound(deploymentId);
  return deployment;
}

export async function listDeployments(
  db: Database,
  clientId: string,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' } },
): Promise<{ data: typeof deployments.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort } = params;

  const conditions = [eq(deployments.clientId, clientId)];

  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(
      sort.direction === 'desc'
        ? lt(deployments.createdAt, new Date(decoded.sort))
        : gt(deployments.createdAt, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(deployments.createdAt) : asc(deployments.createdAt);
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(deployments)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'deployment',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(deployments)
    .where(where);

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

export async function updateDeployment(
  db: Database,
  clientId: string,
  deploymentId: string,
  input: UpdateDeploymentInput,
  k8s?: K8sClients,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.replica_count !== undefined) updateValues.replicaCount = input.replica_count;
  if (input.cpu_request !== undefined) updateValues.cpuRequest = input.cpu_request;
  if (input.memory_request !== undefined) updateValues.memoryRequest = input.memory_request;
  if (input.configuration !== undefined) updateValues.configuration = input.configuration;
  if (input.status !== undefined) updateValues.status = input.status;

  if (Object.keys(updateValues).length > 0) {
    await db.update(deployments).set(updateValues).where(eq(deployments.id, deploymentId));
  }

  // Apply K8s changes for status transitions
  if (k8s && input.status) {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const namespace = client?.kubernetesNamespace;

    if (namespace) {
      // Load catalog entry to get component definitions
      const [entry] = await db
        .select()
        .from(catalogEntries)
        .where(eq(catalogEntries.id, deployment.catalogEntryId));

      if (entry) {
        const components = resolveComponents(entry, null);

        try {
          if (input.status === 'stopped') {
            await stopDeployment(k8s, namespace, deployment.name, components);
          } else if (input.status === 'running') {
            await startDeployment(k8s, namespace, deployment.name, components, deployment.replicaCount ?? 1);
          }
        } catch {
          // K8s operation failed — DB already updated, status will be reconciled
        }
      }
    }
  }

  return getDeploymentById(db, clientId, deploymentId);
}

export async function deleteDeployment(
  db: Database,
  clientId: string,
  deploymentId: string,
  k8s?: K8sClients,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  // Delete K8s resources first
  if (k8s) {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const namespace = client?.kubernetesNamespace;

    if (namespace) {
      const [entry] = await db
        .select()
        .from(catalogEntries)
        .where(eq(catalogEntries.id, deployment.catalogEntryId));

      if (entry) {
        const components = resolveComponents(entry, null);

        try {
          await deleteDeploymentResources(k8s, namespace, deployment.name, components);
        } catch {
          // K8s cleanup failed — still delete DB record
        }
      }
    }
  }

  await db.delete(deployments).where(eq(deployments.id, deploymentId));
}
