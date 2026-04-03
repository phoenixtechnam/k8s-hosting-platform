/**
 * Deployment CRUD service.
 *
 * Manages the unified deployments table that replaces both workloads and application_instances.
 */

import { eq, and, ne, desc, asc, lt, gt, sql } from 'drizzle-orm';
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
      versionComponents = parseJsonField<readonly { name: string; image: string }[]>(version.components);
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
      versionComponents = parseJsonField<readonly { name: string; image: string }[]>(version.components);
      installedVersion = version.version;
    }
  }

  const components = resolveComponents(entry, versionComponents);
  const namespace = client.kubernetesNamespace;
  const volumes = (parseJsonField<unknown[]>(entry.volumes) ?? []) as Array<{ local_path: string; container_path: string }>;
  const resources = parseJsonField<{ recommended?: { cpu?: string; memory?: string; storage?: string }; minimum?: { cpu?: string; memory?: string; storage?: string } }>(entry.resources);
  const storageRequest = resources?.recommended?.storage ?? resources?.minimum?.storage ?? '1Gi';
  const catalogCpu = resources?.recommended?.cpu ?? resources?.minimum?.cpu ?? '0.1';
  const catalogMemory = resources?.recommended?.memory ?? resources?.minimum?.memory ?? '256Mi';

  // Generate secrets for env_vars.generated entries
  const envVarsData = parseJsonField<{ generated?: string[]; fixed?: Record<string, string> }>(entry.envVars);
  const generatedSecrets: Record<string, string> = {};
  if (envVarsData?.generated) {
    for (const key of envVarsData.generated) {
      generatedSecrets[key] = generateSecurePassword(32);
    }
  }

  // Merge: user config + generated secrets (generated cannot be overridden by user)
  const finalConfiguration: Record<string, unknown> = {
    ...(input.configuration ?? {}),
    ...generatedSecrets,
  };

  const id = crypto.randomUUID();
  const resourceSuffix = id.replace(/-/g, '').substring(0, 6);

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
    resourceSuffix,
    installedVersion,
    targetVersion: installedVersion,
    status: 'pending',
  });

  // Deploy to K8s if cluster is available
  if (k8s && namespace) {
    try {
      await deployCatalogEntry(k8s, {
        deploymentName: input.name,
        resourceSuffix,
        namespace,
        components,
        volumes,
        replicaCount: input.replica_count ?? 1,
        cpuRequest: input.cpu_request ?? catalogCpu,
        memoryRequest: input.memory_request ?? catalogMemory,
        storageRequest,
        configuration: finalConfiguration,
        envVars: envVarsData ?? undefined,
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
            await stopDeployment(k8s, namespace, deployment.name, deployment.resourceSuffix, components);
          } else if (input.status === 'running') {
            await startDeployment(k8s, namespace, deployment.name, deployment.resourceSuffix, components, deployment.replicaCount ?? 1);
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
          await stopDeployment(k8s, namespace, deployment.name, deployment.resourceSuffix, components);
        } catch {
          // K8s stop failed — still mark as deleted in DB
        }
      }
    }
  }

  await db.update(deployments)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(deployments.id, deploymentId));
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
          await startDeployment(k8s, namespace, deployment.name, deployment.resourceSuffix, components, deployment.replicaCount ?? 1);
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
          await deleteDeploymentResources(k8s, namespace, deployment.name, deployment.resourceSuffix, components);
        } catch {
          // K8s cleanup failed — still delete DB record
        }
      }
    }
  }

  await db.delete(deployments).where(eq(deployments.id, deploymentId));
}

// ─── Resource Adjustment + Restart (Issue 7) ────────────────────────────────

export async function updateDeploymentResources(
  db: Database,
  clientId: string,
  deploymentId: string,
  input: { cpu_request?: string; memory_request?: string },
  k8s?: K8sClients,
) {
  const deployment = await getDeploymentById(db, clientId, deploymentId);

  const updateValues: Record<string, unknown> = {};
  if (input.cpu_request) updateValues.cpuRequest = input.cpu_request;
  if (input.memory_request) updateValues.memoryRequest = input.memory_request;

  if (Object.keys(updateValues).length === 0) {
    return deployment;
  }

  await db.update(deployments).set(updateValues).where(eq(deployments.id, deploymentId));

  // Redeploy to K8s with updated resources
  if (k8s) {
    const namespace = await getClientNamespace(db, clientId);
    const [entry] = await db
      .select()
      .from(catalogEntries)
      .where(eq(catalogEntries.id, deployment.catalogEntryId));

    if (entry && namespace) {
      const components = resolveComponents(entry, null);
      const volumes = (parseJsonField<unknown[]>(entry.volumes) ?? []) as Array<{ local_path: string; container_path: string }>;
      const resources = parseJsonField<{ recommended?: { cpu?: string; memory?: string; storage?: string }; minimum?: { cpu?: string; memory?: string; storage?: string } }>(entry.resources);
      const storageRequest = resources?.recommended?.storage ?? resources?.minimum?.storage ?? '1Gi';
      const envVarsData = parseJsonField<{ generated?: string[]; fixed?: Record<string, string> }>(entry.envVars);
      const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};

      try {
        await deployCatalogEntry(k8s, {
          deploymentName: deployment.name,
          resourceSuffix: deployment.resourceSuffix,
          namespace,
          components,
          volumes,
          replicaCount: deployment.replicaCount ?? 1,
          cpuRequest: input.cpu_request ?? deployment.cpuRequest,
          memoryRequest: input.memory_request ?? deployment.memoryRequest,
          storageRequest,
          configuration: config,
          envVars: envVarsData ?? undefined,
        });
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
  readonly localPath: string;
  readonly containerPath: string;
  readonly k8sPath: string;
}

export function computeVolumePaths(
  deployment: { name: string; resourceSuffix: string },
  entry: { volumes: unknown; components: unknown },
): VolumePath[] {
  const volumes = parseJsonField<Array<{ local_path: string; container_path: string }>>(entry.volumes) ?? [];
  const components = parseJsonField<Array<{ name: string }>>(entry.components) ?? [];
  const componentCount = components.length;
  const k8sName = componentCount <= 1
    ? `${deployment.name}-${deployment.resourceSuffix}`
    : `${deployment.name}-${deployment.resourceSuffix}-${components[0]?.name}`;

  return volumes.map(v => {
    const parentDir = v.local_path.split('/').slice(0, -1).join('/');
    const k8sPath = parentDir ? `${parentDir}/${k8sName}` : k8sName;
    return {
      localPath: v.local_path,
      containerPath: v.container_path,
      k8sPath,
    };
  });
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
  const baseName = `${deployment.name}-${deployment.resourceSuffix}`;
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
