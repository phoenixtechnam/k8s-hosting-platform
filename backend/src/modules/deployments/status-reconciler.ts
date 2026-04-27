/**
 * Deployment status reconciler.
 *
 * Checks actual K8s Deployment/CronJob status and updates DB accordingly.
 * Detects CrashLoopBackOff, OOMKilled, ImagePullBackOff.
 */

import { eq, inArray } from 'drizzle-orm';
import { deployments, catalogEntries, clients } from '../../db/schema.js';
import { getDeploymentStatus } from './k8s-deployer.js';
import type { DeployComponentInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  readonly checked: number;
  readonly updated: number;
  readonly errors: readonly string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max time a deployment can stay in pending/deploying before escalating to failed */
const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// ─── Map K8s phase to DB status ─────────────────────────────────────────────

function phaseToDbStatus(phase: string): 'running' | 'stopped' | 'pending' | 'failed' {
  switch (phase) {
    case 'running': return 'running';
    case 'stopped': return 'stopped';
    case 'failed': return 'failed';
    case 'starting': return 'pending';
    case 'not_deployed': return 'pending';
    default: return 'pending';
  }
}

// ─── Component Resolution (duplicated from service.ts to avoid circular deps) ─

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return null; } }
  return value as T;
}

function resolveComponentsForReconcile(
  entry: typeof catalogEntries.$inferSelect,
): DeployComponentInput[] {
  const baseComponents = (parseJson<unknown[]>(entry.components) ?? []) as Array<{
    name: string;
    type: 'deployment' | 'statefulset' | 'cronjob' | 'job';
    image: string;
    ports?: Array<{ port: number; protocol: string; ingress?: boolean }>;
    optional?: boolean;
    schedule?: string;
  }>;

  if (baseComponents.length === 0) {
    return [{
      name: entry.code,
      type: 'deployment',
      image: entry.image ?? `${entry.code}:latest`,
      ports: [{ port: 8080, protocol: 'tcp', ingress: true }],
      optional: false,
    }];
  }

  return baseComponents.map(comp => ({
    name: comp.name,
    type: comp.type,
    image: comp.image,
    ports: comp.ports ?? [],
    optional: comp.optional ?? false,
    schedule: comp.schedule,
  }));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Reconcile all deployments that are in a non-terminal DB state
 * (running, pending, deploying) against actual K8s cluster state.
 */
export async function reconcileDeploymentStatuses(
  db: Database,
  k8s: K8sClients,
): Promise<ReconcileResult> {
  let checked = 0;
  let updated = 0;
  const errors: string[] = [];

  // Include `failed` so a deployment that recovers (e.g. after an RBAC
  // patch or a dependency coming up late) can flip back to `running`
  // without manual intervention. Without this, once a row is marked
  // failed the reconciler ignores it forever and the UI shows it as
  // broken even though the pods are healthy.
  const activeDeployments = await db
    .select()
    .from(deployments)
    .where(inArray(deployments.status, ['running', 'pending', 'deploying', 'failed']));

  if (activeDeployments.length === 0) {
    return { checked: 0, updated: 0, errors: [] };
  }

  // Group deployments by client for namespace lookup
  const clientIds = [...new Set(activeDeployments.map(d => d.clientId))];
  const clientRows = await db
    .select({ id: clients.id, kubernetesNamespace: clients.kubernetesNamespace })
    .from(clients)
    .where(inArray(clients.id, clientIds));

  const namespaceMap = new Map<string, string>();
  for (const c of clientRows) {
    if (c.kubernetesNamespace) {
      namespaceMap.set(c.id, c.kubernetesNamespace);
    }
  }

  // Pre-fetch all catalog entries needed
  const catalogEntryIds = [...new Set(activeDeployments.map(d => d.catalogEntryId))];
  const entryRows = await db
    .select()
    .from(catalogEntries)
    .where(inArray(catalogEntries.id, catalogEntryIds));

  const entryMap = new Map<string, typeof catalogEntries.$inferSelect>();
  for (const e of entryRows) {
    entryMap.set(e.id, e);
  }

  for (const deployment of activeDeployments) {
    const namespace = namespaceMap.get(deployment.clientId);
    if (!namespace) continue;

    const entry = entryMap.get(deployment.catalogEntryId);
    if (!entry) continue;

    checked++;

    try {
      const components = resolveComponentsForReconcile(entry);
      const k8sStatus = await getDeploymentStatus(k8s, namespace, deployment.name, components);
      let newDbStatus = phaseToDbStatus(k8sStatus.phase);
      let timeoutMessage: string | null = null;

      // Staleness timeout: if deployment has been in pending/deploying for too long, escalate to failed
      if (newDbStatus === 'pending' && (deployment.status === 'pending' || deployment.status === 'deploying')) {
        const age = Date.now() - deployment.updatedAt.getTime();
        if (age > STALE_TIMEOUT_MS) {
          newDbStatus = 'failed';
          const startingComponent = k8sStatus.components.find(c => c.phase === 'starting' || c.phase === 'not_deployed');
          const detail = startingComponent?.message ?? 'No progress detected';
          timeoutMessage = `Timed out after 60 minutes: ${detail}`;
        }
      }

      // Store status message for transitioning states (shown in UI tiles)
      const statusMessage = newDbStatus === 'pending'
        ? (k8sStatus.components.find(c => c.message)?.message ?? null)
        : null;

      // Capture host node — first scheduled node across all components.
      // The "Node" column on the admin Deployments / Installed Applications
      // tables reads this. Multi-replica deployments report the first
      // observed node only (see k8s-deployer.ts comment).
      const observedNode = k8sStatus.components
        .map((c) => c.nodeName)
        .find((n): n is string => Boolean(n)) ?? null;

      const nodeChanged = observedNode !== (deployment.currentNodeName ?? null);

      if (newDbStatus !== deployment.status
        || statusMessage !== (deployment.statusMessage ?? null)
        || nodeChanged) {
        const updateValues: Record<string, unknown> = { status: newDbStatus, statusMessage };
        if (nodeChanged) updateValues.currentNodeName = observedNode;

        // Store user-friendly error message when status changes to failed
        if (newDbStatus === 'failed') {
          if (timeoutMessage) {
            updateValues.lastError = timeoutMessage;
          } else {
            const failedComponent = k8sStatus.components.find(c => c.phase === 'failed');
            if (failedComponent?.message) {
              const raw = failedComponent.message;
              // Translate common K8s error messages to user-friendly text
              if (raw.includes('OOMKilled') || raw.includes('exit code 137') || raw.includes('exit code: 137')) {
                updateValues.lastError = 'This app ran out of memory and was shut down. Please assign more memory.';
              } else if (raw.includes('CrashLoopBackOff')) {
                updateValues.lastError = 'This app is crashing repeatedly. Check the logs for details.';
              } else if (raw.includes('ImagePullBackOff') || raw.includes('ErrImagePull')) {
                updateValues.lastError = 'Failed to download the app image. The image may not exist or the registry is unreachable.';
              } else if (raw.includes('not found')) {
                updateValues.lastError = raw;
              } else {
                updateValues.lastError = raw;
              }
            }
          }
          updateValues.statusMessage = null;
        } else if (newDbStatus === 'running') {
          // Clear errors when status recovers
          updateValues.lastError = null;
          updateValues.statusMessage = null;
        }

        await db.update(deployments).set(updateValues).where(eq(deployments.id, deployment.id));
        updated++;
      }
    } catch (err) {
      errors.push(`${deployment.name} (${deployment.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { checked, updated, errors };
}
