/**
 * Deployment CRUD service.
 *
 * Manages the unified deployments table that replaces both workloads and application_instances.
 */

import { eq, and, ne, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { deployments, catalogEntries, catalogEntryVersions, clients, hostingPlans, ingressRoutes, domains } from '../../db/schema.js';
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

export function parseJsonField<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return null; }
  }
  return value as T;
}

export function generateSecurePassword(length: number): string {
  // Avoid $, `, \, ', " — these get mangled by shell/env var expansion in K8s
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#%^&*_-+=';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
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
    volumes?: string[];
    command?: string[];
    args?: string[];
    resources?: { cpu?: string; memory?: string };
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
      volumes: comp.volumes,
      command: comp.command,
      args: comp.args,
      resources: comp.resources,
    };
  });
}

// ─── Version-Aware Deployment Configuration Resolver ───────────────────────

export interface ResolvedDeploymentConfig {
  readonly components: DeployComponentInput[];
  readonly volumes: Array<{ container_path: string }>;
  readonly fixedEnvVars: Record<string, string>;
  readonly generatedEnvKeys: readonly string[];
  readonly configurableEnvKeys: readonly string[];
  readonly installedVersion: string | null;
}

/**
 * Resolve the effective deployment configuration by merging entry-level defaults
 * with version-specific overrides.
 *
 * Version-specific volumes REPLACE entry-level volumes when present.
 * Version-specific fixed env vars MERGE with entry-level (version wins on conflict).
 * Generated env keys come from the entry level only (not version-specific).
 */
export async function resolveVersionAwareDeploymentConfig(
  db: Database,
  entry: typeof catalogEntries.$inferSelect,
  targetVersion: string | null | undefined,
): Promise<ResolvedDeploymentConfig> {
  // Fetch version record if a version is requested
  let versionRecord: typeof catalogEntryVersions.$inferSelect | null = null;
  const effectiveVersion = targetVersion ?? entry.defaultVersion ?? null;

  if (effectiveVersion) {
    const [version] = await db
      .select()
      .from(catalogEntryVersions)
      .where(
        and(
          eq(catalogEntryVersions.catalogEntryId, entry.id),
          eq(catalogEntryVersions.version, effectiveVersion),
        ),
      );
    if (version) versionRecord = version;
  }

  // Components
  const versionComponents = versionRecord
    ? parseJsonField<readonly { name: string; image: string }[]>(versionRecord.components)
    : null;
  const components = resolveComponents(entry, versionComponents);

  // Volumes — version overrides entry-level completely.
  //
  // `local_path` carries the catalog author's intended subdirectory name on
  // the shared PVC (e.g. `applications/wordpress/content` vs
  // `applications/wordpress/database`). The deployer uses its basename as
  // the per-volume subPath suffix so multi-volume apps (WordPress =
  // wp-content + mysql data) don't collide on the same PVC directory.
  const entryVolumes = (parseJsonField<unknown[]>(entry.volumes) ?? []) as Array<{ container_path: string; local_path?: string }>;
  const versionVolumes = versionRecord
    ? parseJsonField<Array<{ container_path: string; local_path?: string }>>(versionRecord.volumes)
    : null;
  const volumes = (versionVolumes && versionVolumes.length > 0) ? versionVolumes : entryVolumes;

  // Env vars — merge fixed (version wins on conflict), generated from entry level only
  const entryEnvVars = parseJsonField<{ generated?: string[]; fixed?: Record<string, string>; configurable?: string[] }>(entry.envVars);
  const versionEnvVars = versionRecord
    ? parseJsonField<{ fixed?: Record<string, string>; configurable?: string[] }>(versionRecord.envVars)
    : null;
  const fixedEnvVars: Record<string, string> = {
    ...(entryEnvVars?.fixed ?? {}),
    ...(versionEnvVars?.fixed ?? {}),
  };

  // Env-var names that may come from `configuration` at deploy time.
  // Includes both user-configurable names AND generated-secret names, because
  // service.ts stores generated values in `configuration` so the deployer
  // can hand them off as container env vars and SQL Manager can read them
  // later. Meta parameters (e.g. `wordpress.siteTitle`) intentionally stay
  // out of this list so they don't leak into the pod env.
  const versionConfigurable = versionEnvVars?.configurable && versionEnvVars.configurable.length > 0
    ? versionEnvVars.configurable
    : (entryEnvVars?.configurable ?? []);
  const generated = entryEnvVars?.generated ?? [];
  const configurableEnvKeys = Array.from(new Set([...versionConfigurable, ...generated]));

  return {
    components,
    volumes,
    fixedEnvVars,
    generatedEnvKeys: entryEnvVars?.generated ?? [],
    configurableEnvKeys,
    installedVersion: versionRecord?.version ?? null,
  };
}

function resolveIngressPorts(
  entry: typeof catalogEntries.$inferSelect,
): Array<{ port: number; protocol: string; ingress?: boolean }> {
  const networking = parseJsonField<{ ingress_ports?: Array<{ port: number; protocol: string }> }>(entry.networking);
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

  // Resolve version-aware configuration: components, volumes, env vars
  const resolved = await resolveVersionAwareDeploymentConfig(db, entry, input.version);
  const { components, volumes, fixedEnvVars, generatedEnvKeys, configurableEnvKeys, installedVersion } = resolved;
  const namespace = client.kubernetesNamespace;

  const resources = parseJsonField<{ recommended?: { cpu?: string; memory?: string; storage?: string }; minimum?: { cpu?: string; memory?: string; storage?: string } }>(entry.resources);
  const storageRequest = resources?.recommended?.storage ?? resources?.minimum?.storage ?? '1Gi';
  const catalogCpu = resources?.recommended?.cpu ?? resources?.minimum?.cpu ?? '0.1';
  const catalogMemory = resources?.recommended?.memory ?? resources?.minimum?.memory ?? '256Mi';

  // Generate secrets for env_vars.generated entries
  const generatedSecrets: Record<string, string> = {};
  for (const key of generatedEnvKeys) {
    generatedSecrets[key] = generateSecurePassword(32);
  }

  // Merge: fixed env vars + user config + generated secrets (generated cannot be overridden by user)
  const finalConfiguration: Record<string, unknown> = {
    ...fixedEnvVars,
    ...(input.configuration ?? {}),
    ...generatedSecrets,
  };

  // Build envVars object for the deployer — merged fixed so deployer treats them uniformly
  const finalEnvVars = { fixed: fixedEnvVars };

  const id = crypto.randomUUID();
  const storagePath = input.storage_mode === 'custom' && input.storage_path
    ? input.storage_path
    : `${entry.type}/${entry.code}/${input.name}`;

  try {
    await db.insert(deployments).values({
      id,
      clientId,
      catalogEntryId: input.catalog_entry_id,
      name: input.name,
      domainName: input.domain_name ?? null,
      replicaCount: input.replica_count ?? 1,
      cpuRequest: input.cpu_request ?? catalogCpu,
      memoryRequest: input.memory_request ?? catalogMemory,
      configuration: finalConfiguration,
      storagePath,
      installedVersion,
      targetVersion: installedVersion,
      status: 'pending',
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ApiError(
        'DUPLICATE_NAME',
        `A deployment named '${input.name}' already exists for this client`,
        409,
        { name: input.name },
      );
    }
    throw err;
  }

  // Deploy to K8s if cluster is available
  if (k8s && namespace) {
    try {
      // Detect password env var for password-reset init container
      const passwordEnvVar = generatedEnvKeys.find(k =>
        k.includes('PASSWORD') || k.includes('ROOT_PASSWORD'),
      );

      await deployCatalogEntry(k8s, {
        deploymentName: input.name,
        storagePath,
        namespace,
        components,
        volumes,
        replicaCount: input.replica_count ?? 1,
        cpuRequest: input.cpu_request ?? catalogCpu,
        memoryRequest: input.memory_request ?? catalogMemory,
        storageRequest,
        configuration: finalConfiguration,
        envVars: finalEnvVars,
        configurableEnvKeys,
        reuseExistingData: input.storage_mode === 'custom',
        catalogCode: entry.code,
        passwordEnvVar,
        timezone: client.timezone ?? undefined,
        // M5: pin tenant pods to the client's assigned worker if one is
        // set; undefined lets the default scheduler choose.
        workerNodeName: client.workerNodeName ?? undefined,
      });
      await db.update(deployments).set({ status: 'deploying' }).where(eq(deployments.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[deployments] K8s deploy failed for ${input.name}:`, message);
      await db.update(deployments).set({ status: 'failed', lastError: message }).where(eq(deployments.id, id));
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

export async function clearDeploymentError(db: Database, deploymentId: string): Promise<void> {
  await db.update(deployments).set({ lastError: null }).where(eq(deployments.id, deploymentId));
}

export async function listDeployments(
  db: Database,
  clientId: string,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' }; includeDeleted?: boolean },
): Promise<{ data: typeof deployments.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort, includeDeleted } = params;

  const conditions = [eq(deployments.clientId, clientId)];

  // Exclude soft-deleted deployments unless explicitly requested
  if (!includeDeleted) {
    conditions.push(ne(deployments.status, 'deleted'));
  }

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
  // For start/stop: set to 'pending' first, let status-reconciler confirm final state
  if (input.status === 'running' || input.status === 'stopped') {
    updateValues.status = 'pending';
    updateValues.lastError = null;
  } else if (input.status !== undefined) {
    updateValues.status = input.status;
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(deployments).set(updateValues).where(eq(deployments.id, deploymentId));
  }

  // Apply K8s changes for status transitions
  if (k8s && input.status) {
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
          if (input.status === 'stopped') {
            await stopDeployment(k8s, namespace, deployment.name, components);
          } else if (input.status === 'running') {
            await startDeployment(k8s, namespace, deployment.name, components, deployment.replicaCount ?? 1);
          }
        } catch (err) {
          console.error('[deployments] K8s start/stop failed:', err instanceof Error ? err.message : String(err));
          // Mark as failed so the user sees the error
          await db.update(deployments).set({
            status: 'failed',
            lastError: err instanceof Error ? err.message : String(err),
          }).where(eq(deployments.id, deploymentId));
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

  // Soft-delete: mark as deleted and scale K8s resources to 0
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
          await stopDeployment(k8s, namespace, deployment.name, components);
        } catch {
          // K8s stop failed — still mark as deleted in DB
        }
      }
    }
  }

  await db.update(deployments)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(deployments.id, deploymentId));

  // Unlink ingress routes (set deployment_id to NULL)
  await db.update(ingressRoutes)
    .set({ deploymentId: null })
    .where(eq(ingressRoutes.deploymentId, deploymentId));
}

export async function restoreDeployment(
  db: Database,
  clientId: string,
  deploymentId: string,
  k8s?: K8sClients,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  if (deployment.status !== 'deleted') {
    throw new ApiError(
      'DEPLOYMENT_NOT_DELETED',
      `Deployment '${deploymentId}' is not in deleted state`,
      400,
      { deployment_id: deploymentId, current_status: deployment.status },
      'Only soft-deleted deployments can be restored',
    );
  }

  // Scale K8s resources back up
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
          await startDeployment(k8s, namespace, deployment.name, components, deployment.replicaCount ?? 1);
        } catch {
          // K8s start failed — still update DB, reconciler will catch up
        }
      }
    }
  }

  await db.update(deployments)
    .set({ status: 'running', deletedAt: null, lastError: null })
    .where(eq(deployments.id, deploymentId));

  return getDeploymentById(db, clientId, deploymentId);
}

export async function hardDeleteDeployment(
  db: Database,
  clientId: string,
  deploymentId: string,
  k8s?: K8sClients,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  // Hard-delete: destroy K8s resources + PVCs + DB row
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

export async function getDeletePreview(
  db: Database,
  clientId: string,
  deploymentId: string,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  // Find all ingress routes linked to this deployment
  const routes = await db
    .select({
      id: ingressRoutes.id,
      hostname: ingressRoutes.hostname,
      path: ingressRoutes.path,
      domainId: ingressRoutes.domainId,
    })
    .from(ingressRoutes)
    .where(eq(ingressRoutes.deploymentId, deploymentId));

  // Resolve domain names for each route
  const affectedRoutes = [];
  for (const route of routes) {
    const [domain] = await db
      .select({ domainName: domains.domainName })
      .from(domains)
      .where(eq(domains.id, route.domainId));

    affectedRoutes.push({
      id: route.id,
      hostname: route.hostname,
      path: route.path,
      domainName: domain?.domainName ?? 'unknown',
    });
  }

  return {
    deploymentId: deployment.id,
    deploymentName: deployment.name,
    affectedRoutes,
  };
}

// ─── Resource Adjustment + Restart (Issue 7) ────────────────────────────────

/**
 * Get resource availability for a deployment — how much the client can allocate.
 * Returns min (from catalog entry) and max (remaining plan capacity + current deployment alloc).
 */
export async function getResourceAvailability(
  db: Database,
  clientId: string,
  deploymentId: string,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);
  const { parseResourceValue } = await import('../../shared/resource-parser.js');

  // Get plan limits (with overrides)
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, client.planId));
  const cpuLimit = Number(client.cpuLimitOverride ?? plan?.cpuLimit ?? 2);
  const memoryLimitGi = Number(client.memoryLimitOverride ?? plan?.memoryLimit ?? 4);

  // Sum all OTHER deployments' resource requests
  const allDeployments = await db.select().from(deployments)
    .where(and(
      eq(deployments.clientId, clientId),
      ne(deployments.id, deploymentId),
      ne(deployments.status, 'deleted'),
    ));

  let otherCpu = 0;
  let otherMemoryGi = 0;
  for (const d of allDeployments) {
    otherCpu += parseResourceValue(d.cpuRequest || '0', 'cpu');
    otherMemoryGi += parseResourceValue(d.memoryRequest || '0', 'memory');
  }

  // Get min from catalog entry
  const [entry] = await db.select().from(catalogEntries).where(eq(catalogEntries.id, deployment.catalogEntryId));
  const resources = parseJsonField<{ minimum?: { cpu?: string; memory?: string }; recommended?: { cpu?: string; memory?: string } }>(entry?.resources);

  const minCpu = resources?.minimum?.cpu ?? '0.1';
  const minMemory = resources?.minimum?.memory ?? '64Mi';

  return {
    cpu: {
      min: minCpu,
      max: String(Math.round((cpuLimit - otherCpu) * 100) / 100),
      current: deployment.cpuRequest,
      planLimit: String(cpuLimit),
    },
    memory: {
      min: minMemory,
      max: `${Math.round((memoryLimitGi - otherMemoryGi) * 1024)}Mi`,
      current: deployment.memoryRequest,
      planLimit: `${memoryLimitGi}Gi`,
    },
  };
}

export async function updateDeploymentResources(
  db: Database,
  clientId: string,
  deploymentId: string,
  input: { cpu_request?: string; memory_request?: string },
  k8s?: K8sClients,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);
  const { parseResourceValue } = await import('../../shared/resource-parser.js');

  // Validate against plan limits
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, client.planId));
  const cpuLimit = Number(client.cpuLimitOverride ?? plan?.cpuLimit ?? 2);
  const memoryLimitGi = Number(client.memoryLimitOverride ?? plan?.memoryLimit ?? 4);

  // Sum all OTHER deployments
  const allDeployments = await db.select().from(deployments)
    .where(and(
      eq(deployments.clientId, clientId),
      ne(deployments.id, deploymentId),
      ne(deployments.status, 'deleted'),
    ));

  let otherCpu = 0;
  let otherMemoryGi = 0;
  for (const d of allDeployments) {
    otherCpu += parseResourceValue(d.cpuRequest || '0', 'cpu');
    otherMemoryGi += parseResourceValue(d.memoryRequest || '0', 'memory');
  }

  const newCpu = input.cpu_request ? parseResourceValue(input.cpu_request, 'cpu') : parseResourceValue(deployment.cpuRequest || '0', 'cpu');
  const newMemoryGi = input.memory_request ? parseResourceValue(input.memory_request, 'memory') : parseResourceValue(deployment.memoryRequest || '0', 'memory');

  if (newCpu + otherCpu > cpuLimit) {
    const available = Math.round((cpuLimit - otherCpu) * 100) / 100;
    throw new ApiError('RESOURCE_LIMIT_EXCEEDED', `CPU request ${input.cpu_request} exceeds available capacity. Maximum: ${available} cores (plan limit: ${cpuLimit} cores)`, 400, { field: 'cpu_request', available: String(available), limit: String(cpuLimit) });
  }

  if (newMemoryGi + otherMemoryGi > memoryLimitGi) {
    const availableMi = Math.round((memoryLimitGi - otherMemoryGi) * 1024);
    throw new ApiError('RESOURCE_LIMIT_EXCEEDED', `Memory request ${input.memory_request} exceeds available capacity. Maximum: ${availableMi}Mi (plan limit: ${memoryLimitGi}Gi)`, 400, { field: 'memory_request', available: `${availableMi}Mi`, limit: `${memoryLimitGi}Gi` });
  }

  const updateValues: Record<string, unknown> = {};
  if (input.cpu_request) updateValues.cpuRequest = input.cpu_request;
  if (input.memory_request) updateValues.memoryRequest = input.memory_request;

  if (Object.keys(updateValues).length === 0) {
    return deployment;
  }

  // Set to pending since pod will restart with new resources
  updateValues.status = 'pending';
  updateValues.lastError = null;

  await db.update(deployments).set(updateValues).where(eq(deployments.id, deploymentId));

  // Redeploy to K8s with updated resources
  if (k8s) {
    const namespace = await getClientNamespace(db, clientId);
    const [entry] = await db
      .select()
      .from(catalogEntries)
      .where(eq(catalogEntries.id, deployment.catalogEntryId));

    if (entry && namespace) {
      // Use version-aware resolver — respects per-version volume/env overrides
      const resolved = await resolveVersionAwareDeploymentConfig(db, entry, deployment.installedVersion);
      const resources = parseJsonField<{ recommended?: { cpu?: string; memory?: string; storage?: string }; minimum?: { cpu?: string; memory?: string; storage?: string } }>(entry.resources);
      const storageRequest = resources?.recommended?.storage ?? resources?.minimum?.storage ?? '1Gi';
      const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};

      try {
        await deployCatalogEntry(k8s, {
          deploymentName: deployment.name,
          storagePath: deployment.storagePath ?? '',
          namespace,
          components: resolved.components,
          volumes: resolved.volumes,
          replicaCount: deployment.replicaCount ?? 1,
          cpuRequest: input.cpu_request ?? deployment.cpuRequest,
          memoryRequest: input.memory_request ?? deployment.memoryRequest,
          storageRequest,
          configuration: config,
          envVars: { fixed: resolved.fixedEnvVars },
          configurableEnvKeys: resolved.configurableEnvKeys,
        });
        // Force pod restart by deleting existing pods — K8s recreates from updated spec.
        // The patchNamespacedDeployment annotation approach doesn't work reliably
        // with this K8s client version due to content-type issues.
        const baseName = deployment.name;
        try {
          const podList = await k8s.core.listNamespacedPod({
            namespace,
            labelSelector: `app=${baseName}`,
          });
          const pods = (podList as { items?: readonly { metadata?: { name?: string } }[] }).items ?? [];
          for (const pod of pods) {
            if (pod.metadata?.name) {
              await k8s.core.deleteNamespacedPod({ name: pod.metadata.name, namespace });
            }
          }
        } catch { /* pod deletion is best-effort */ }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[deployments] K8s resource update failed for ${deployment.name}:`, message);
        await db.update(deployments).set({ lastError: message }).where(eq(deployments.id, deploymentId));
      }
    }
  }

  return getDeploymentById(db, clientId, deploymentId);
}

// ─── Volume Path Computation (Issue 9) ──────────────────────────────────────

export interface VolumePath {
  readonly containerPath: string;
  readonly k8sPath: string;
}

export function computeVolumePaths(
  deployment: { storagePath: string | null },
  entry: { volumes: unknown },
): VolumePath[] {
  const volumes = parseJsonField<Array<{ container_path: string }>>(entry.volumes) ?? [];
  const basePath = deployment.storagePath ?? '';

  return volumes.map(v => ({
    containerPath: v.container_path,
    k8sPath: basePath,
  }));
}

export async function getDeploymentWithVolumePaths(
  db: Database,
  clientId: string,
  deploymentId: string,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));

  const volumePaths = entry ? computeVolumePaths(deployment, entry) : [];

  return { ...deployment, volumePaths };
}

// ─── Shared Helpers (used by routes for restart, etc.) ───────────────────────

export async function resolveDeploymentComponents(
  db: Database,
  deployment: typeof deployments.$inferSelect,
): Promise<DeployComponentInput[]> {
  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));

  if (!entry) throw catalogEntryNotFound(deployment.catalogEntryId);
  return resolveComponents(entry, null);
}

/**
 * Redeploy a deployment with its current configuration.
 * Used after credential regeneration to update pod env vars.
 */
export async function redeployWithCurrentConfig(
  db: Database,
  deployment: typeof deployments.$inferSelect,
  k8s: K8sClients,
): Promise<void> {
  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));

  if (!entry) return;

  const namespace = await getClientNamespace(db, deployment.clientId);
  // Use version-aware resolver — respects per-version volume/env overrides
  const resolved = await resolveVersionAwareDeploymentConfig(db, entry, deployment.installedVersion);
  const resources = parseJsonField<{ recommended?: { cpu?: string; memory?: string; storage?: string }; minimum?: { cpu?: string; memory?: string; storage?: string } }>(entry.resources);
  const storageRequest = resources?.recommended?.storage ?? resources?.minimum?.storage ?? '1Gi';
  const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};

  await deployCatalogEntry(k8s, {
    deploymentName: deployment.name,
    storagePath: deployment.storagePath ?? '',
    namespace,
    components: resolved.components,
    volumes: resolved.volumes,
    replicaCount: deployment.replicaCount ?? 1,
    cpuRequest: deployment.cpuRequest,
    memoryRequest: deployment.memoryRequest,
    storageRequest,
    configuration: config,
    envVars: { fixed: resolved.fixedEnvVars },
    configurableEnvKeys: resolved.configurableEnvKeys,
  });

  // Force pod restart by deleting existing pods — K8s recreates from updated spec.
  const baseName = deployment.name;
  try {
    const podList = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `app=${baseName}`,
    });
    const pods = (podList as { items?: readonly { metadata?: { name?: string } }[] }).items ?? [];
    for (const pod of pods) {
      if (pod.metadata?.name) {
        await k8s.core.deleteNamespacedPod({ name: pod.metadata.name, namespace });
      }
    }
  } catch { /* best-effort */ }
}

export async function getClientNamespace(
  db: Database,
  clientId: string,
): Promise<string> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
  return client.kubernetesNamespace;
}

// ─── Credentials ─────────────────────────────────────────────────────────────

interface ConnectionInfo {
  readonly host: string;
  readonly port: number | null;
  readonly database: string | null;
  readonly username: string | null;
}

function buildConnectionInfo(
  deployment: typeof deployments.$inferSelect,
  entry: typeof catalogEntries.$inferSelect,
  provides: Record<string, unknown> | null,
): ConnectionInfo {
  const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};
  const components = parseJsonField<Array<{ name: string; ports?: Array<{ port: number }> }>>(entry.components) ?? [];

  // Determine port from provides or first component port
  let port: number | null = null;
  if (provides && typeof provides.port === 'number') {
    port = provides.port;
  } else if (components.length > 0 && components[0].ports && components[0].ports.length > 0) {
    port = components[0].ports[0].port;
  }

  // Build internal K8s DNS hostname using deployment-scoped resource naming
  const componentName = components.length > 0 ? components[0].name : entry.code;
  const baseName = deployment.name;
  const componentSuffix = components.length > 1 ? `-${componentName}` : '';
  const namespace = `client-${deployment.clientId}`;
  const host = `${baseName}${componentSuffix}.${namespace}.svc.cluster.local`;

  return {
    host,
    port,
    database: config.MARIADB_DATABASE ? String(config.MARIADB_DATABASE)
      : config.MYSQL_DATABASE ? String(config.MYSQL_DATABASE)
      : config.POSTGRES_DB ? String(config.POSTGRES_DB)
      : null,
    username: config.MARIADB_USER ? String(config.MARIADB_USER)
      : config.MYSQL_USER ? String(config.MYSQL_USER)
      : config.POSTGRES_USER ? String(config.POSTGRES_USER)
      : null,
  };
}

export async function getDeploymentCredentials(
  db: Database,
  clientId: string,
  deploymentId: string,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));

  if (!entry) throw catalogEntryNotFound(deployment.catalogEntryId);

  const envVarsData = parseJsonField<{ generated?: string[]; fixed?: Record<string, string> }>(entry.envVars);
  const generatedKeys = envVarsData?.generated ?? [];
  const provides = parseJsonField<Record<string, unknown>>(entry.provides);

  const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};

  // Build credentials from generated keys only
  const credentials: Record<string, string> = {};
  for (const key of generatedKeys) {
    if (config[key] !== undefined && config[key] !== null) {
      credentials[key] = String(config[key]);
    }
  }

  const connectionInfo = buildConnectionInfo(deployment, entry, provides);

  return { credentials, connectionInfo, generatedKeys };
}

/**
 * @deprecated Credential regeneration is no longer supported. Credentials are
 * generated once at deployment time and treated as read-only by the platform.
 * Kept for potential rollback — do not call from new code.
 */
export async function regenerateDeploymentCredentials(
  db: Database,
  clientId: string,
  deploymentId: string,
  keys?: string[],
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));

  if (!entry) throw catalogEntryNotFound(deployment.catalogEntryId);

  const envVarsData = parseJsonField<{ generated?: string[]; fixed?: Record<string, string> }>(entry.envVars);
  const generatedKeys = envVarsData?.generated ?? [];

  if (generatedKeys.length === 0) {
    throw new ApiError(
      'NO_GENERATED_CREDENTIALS',
      'This deployment has no auto-generated credentials to regenerate',
      400,
      { deployment_id: deploymentId },
    );
  }

  // Determine which keys to regenerate
  const keysToRegenerate = (keys && keys.length > 0)
    ? keys.filter(k => generatedKeys.includes(k))
    : generatedKeys;

  if (keysToRegenerate.length === 0) {
    throw new ApiError(
      'INVALID_CREDENTIAL_KEYS',
      'None of the specified keys are auto-generated credentials',
      400,
      { requested_keys: keys, valid_keys: generatedKeys },
    );
  }

  const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};

  // Generate new values
  const newCredentials: Record<string, string> = {};
  for (const key of keysToRegenerate) {
    newCredentials[key] = generateSecurePassword(32);
  }

  const updatedConfiguration = {
    ...config,
    ...newCredentials,
  };

  await db
    .update(deployments)
    .set({ configuration: updatedConfiguration })
    .where(eq(deployments.id, deploymentId));

  return { credentials: newCredentials, regeneratedKeys: keysToRegenerate };
}

// ─── Storage Folder Listing ──────────────────────────────────────────────────

export async function listStorageFolders(
  db: Database,
  clientId: string,
  entryType: string,
  entryCode: string,
  k8s?: K8sClients,
  kubeconfigPath?: string,
) {
  const basePath = `${entryType}/${entryCode}`;

  // Get existing deployments for this client to mark folders as "in use"
  const existingDeployments = await db
    .select({ name: deployments.name, storagePath: deployments.storagePath, status: deployments.status })
    .from(deployments)
    .where(and(
      eq(deployments.clientId, clientId),
      ne(deployments.status, 'deleted'),
    ));

  // Build a map of storagePath -> deployment name
  const pathToDeployment = new Map<string, string>();
  for (const d of existingDeployments) {
    if (d.storagePath) {
      pathToDeployment.set(d.storagePath, d.name);
    }
  }

  // Try to list directories via file-manager sidecar
  const folders: Array<{ name: string; path: string; isEmpty: boolean; usedByDeployment: string | null }> = [];

  if (k8s) {
    const namespace = await getClientNamespace(db, clientId);
    try {
      const { fileManagerRequest } = await import('../file-manager/service.js');
      const FM_IMAGE = 'file-manager-sidecar:latest';
      const listing = await fileManagerRequest(k8s, kubeconfigPath, namespace, FM_IMAGE, '/ls', {
        query: { path: basePath, dirs_only: 'true' },
      });
      const entries = (JSON.parse(listing.body) as { entries?: Array<{ name: string; type: string; size?: number }> })?.entries ?? [];

      for (const entry of entries) {
        if (entry.type === 'directory') {
          const fullPath = `${basePath}/${entry.name}`;
          // Check if directory is empty by listing its contents
          let isEmpty = true;
          try {
            const subListing = await fileManagerRequest(k8s, kubeconfigPath, namespace, FM_IMAGE, '/ls', {
              query: { path: fullPath },
            });
            const subEntries = (JSON.parse(subListing.body) as { entries?: unknown[] })?.entries ?? [];
            isEmpty = subEntries.length === 0;
          } catch {
            // If we can't list, assume non-empty
            isEmpty = false;
          }

          folders.push({
            name: entry.name,
            path: fullPath,
            isEmpty,
            usedByDeployment: pathToDeployment.get(fullPath) ?? null,
          });
        }
      }
    } catch {
      // File manager not available or path doesn't exist yet — return empty list
    }
  }

  return { basePath, folders };
}
