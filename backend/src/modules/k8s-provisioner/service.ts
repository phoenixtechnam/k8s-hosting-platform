import { eq } from 'drizzle-orm';
import type { K8sClients } from './k8s-client.js';
import type { ProvisioningStep } from '@k8s-hosting/api-contracts';
import { clients, provisioningTasks, hostingPlans } from '../../db/schema.js';
import { getDefaultStorageClass } from '../storage-settings/service.js';
import { ensureFileManagerRunning } from '../file-manager/k8s-lifecycle.js';
import type { Database } from '../../db/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Detect 404 errors from @kubernetes/client-node v1.4 */
function isK8s404(err: unknown): boolean {
  // v1.4 HttpException: message starts with "HTTP-Code: 404"
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  // Older client versions used statusCode property
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  if ((err as { statusCode?: number }).statusCode === 409) return true;
  return false;
}

/**
 * Extract a single-line, human-readable message from a k8s client error.
 * @kubernetes/client-node v1.4 throws HttpException whose `.message` embeds
 * the full response (code, headers, JSON body). Raw, this is useless in a UI —
 * we want just the `status.message` field when available, otherwise the first
 * line of the error message.
 */
export function formatK8sError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // @kubernetes/client-node v1.4 embeds the response body as
  // `Body: "<json-stringified-Status>"`. The body is double-escaped (a JSON
  // string wrapping a JSON string), so keys/values look like \"message\":\"...\".
  // Try progressively fewer escape levels until JSON.parse succeeds, then
  // read `.message`. This is more robust than a hand-rolled regex.
  const bodyMatch = raw.match(/Body:\s*(.+?)(?:\n|$)/s);
  if (bodyMatch) {
    let candidate = bodyMatch[1].trim();
    // Strip an outer set of quotes if present
    if (candidate.startsWith('"') && candidate.endsWith('"')) {
      candidate = candidate.slice(1, -1);
    }
    // Try up to 3 unescape levels
    for (let i = 0; i < 3; i++) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
          const body = parsed as { message: string; code?: number };
          const codeSuffix = typeof body.code === 'number' ? ` (HTTP ${body.code})` : '';
          return `${body.message}${codeSuffix}`;
        }
        // Parsed but not a Status body — stop
        break;
      } catch {
        // Not valid JSON at this level — unescape one level and retry
        candidate = candidate.replace(/\\(["\\/bfnrt])/g, (_, ch) => {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          return map[ch] ?? ch;
        });
      }
    }
  }

  // Fall back to first line — truncated to a sensible length.
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}…` : firstLine;
}

/** Returns false if the client row was deleted — orchestrator should abort. */
async function clientStillExists(db: Database, clientId: string): Promise<boolean> {
  const [row] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return !!row;
}

// ─── Step Definitions ────────────────────────────────────────────────────────

export const PROVISION_STEPS = [
  'Create Namespace',
  'Create ResourceQuota',
  'Create NetworkPolicy',
  'Create PVC',
  'Start File Manager',
] as const;

export const DEPROVISION_STEPS = [
  'Delete Namespace',
] as const;

// ─── Step Log Helpers ────────────────────────────────────────────────────────

export function buildStepsLog(steps: readonly string[]): ProvisioningStep[] {
  return steps.map(name => ({
    name,
    status: 'pending' as const,
    startedAt: null,
    completedAt: null,
  }));
}

export function updateStepStatus(
  log: ProvisioningStep[],
  stepName: string,
  status: ProvisioningStep['status'],
  error?: string,
): ProvisioningStep[] {
  return log.map(step => {
    if (step.name !== stepName) return step;
    return {
      ...step,
      status,
      startedAt: status === 'running' ? new Date().toISOString() : step.startedAt,
      completedAt: (status === 'completed' || status === 'failed') ? new Date().toISOString() : step.completedAt,
      error: error ?? step.error,
    };
  });
}

// ─── System Service Reserves ────────────────────────────────────────────────
// Extra CPU/memory headroom added to ResourceQuota to accommodate system pods
// (file-manager) so they don't count against the client's plan limits.
export const SYSTEM_CPU_RESERVE = 0.25;   // 250m for file-manager
export const SYSTEM_MEMORY_RESERVE = 0.25; // 256Mi

// ─── K8s Resource Creators ───────────────────────────────────────────────────

export async function applyNamespace(
  k8s: K8sClients,
  namespace: string,
  clientId: string,
): Promise<void> {
  // Check if namespace already exists
  try {
    await k8s.core.readNamespace({ name: namespace });
    return; // Already exists, skip
  } catch (err: unknown) {
    // @kubernetes/client-node v1.4 throws HttpException with "HTTP-Code: 404" in message
    const isNotFound = isK8s404(err);
    if (!isNotFound) throw err;
  }

  await k8s.core.createNamespace({
    body: {
      metadata: {
        name: namespace,
        labels: {
          platform: 'k8s-hosting',
          client: clientId,
        },
      },
    },
  });
}

export async function applyResourceQuota(
  k8s: K8sClients,
  namespace: string,
  limits: { cpu: string; memory: string; storage: string },
): Promise<void> {
  // Add system service headroom so file-manager doesn't eat into the client's quota
  const totalCpu = (parseFloat(limits.cpu) + SYSTEM_CPU_RESERVE).toFixed(2);
  const totalMemoryGi = (parseFloat(limits.memory) + SYSTEM_MEMORY_RESERVE).toFixed(2);

  const quotaName = `${namespace}-quota`;
  const body = {
    metadata: { name: quotaName, namespace },
    spec: {
      hard: {
        'limits.cpu': totalCpu,
        'limits.memory': `${totalMemoryGi}Gi`,
        'requests.storage': `${limits.storage}Gi`,
      },
    },
  };

  try {
    await k8s.core.createNamespacedResourceQuota({ namespace, body });
  } catch (err: unknown) {
    // Already exists — replace with updated values
    if (isK8s409(err)) {
      await k8s.core.replaceNamespacedResourceQuota({ name: quotaName, namespace, body } as Parameters<typeof k8s.core.replaceNamespacedResourceQuota>[0]);
    } else {
      throw err;
    }
  }
}

export async function applyNetworkPolicy(
  k8s: K8sClients,
  namespace: string,
): Promise<void> {
  // Two NetworkPolicies per tenant namespace:
  //
  // 1. default-deny-ingress — blanket deny for cross-namespace ingress,
  //    except from ingress-nginx (so the user's web app remains reachable
  //    from the load balancer).
  //
  // 2. allow-intra-namespace — pods within the same tenant namespace may
  //    freely reach each other. Required for multi-component apps (e.g.
  //    WordPress's wordpress pod connects to the mariadb sibling on :3306,
  //    Immich's immich-server calls immich-ml, etc). Without this, the
  //    default-deny rule blocks pod-to-pod traffic inside the tenant.
  //
  // Cross-tenant isolation is preserved — the podSelector/namespaceSelector
  // here scopes to the same namespace only.
  const policies: Array<{ name: string; body: Record<string, unknown> }> = [
    {
      name: 'default-deny-ingress',
      body: {
        metadata: { name: 'default-deny-ingress', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress'],
          ingress: [
            {
              _from: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
                  },
                },
              ],
            },
          ],
        },
      },
    },
    {
      name: 'allow-intra-namespace',
      body: {
        metadata: { name: 'allow-intra-namespace', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress'],
          ingress: [{ _from: [{ podSelector: {} }] }],
        },
      },
    },
    {
      // platform-api → tenant pods (file-manager sidecar, future
      // tenant-side admin operations). Without this, default-deny-
      // ingress blocks the cross-namespace HTTP call that
      // fileManagerRequest makes via the apiserver services/proxy
      // (the proxy runs in-apiserver but the destination tenant pod
      // sees the source as the cluster pod CIDR after vxlan re-source).
      // Scoped tightly: only platform-api pods, only the FM port.
      name: 'allow-platform-api',
      body: {
        metadata: { name: 'allow-platform-api', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress'],
          ingress: [{
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'platform' },
                },
                podSelector: {
                  matchLabels: { app: 'platform-api' },
                },
              },
              // ipBlock catches the host-network re-source case (when
              // platform-api sits on a different node than the FM pod
              // and Linux rewrites the source IP to vxlan.calico's
              // tunnel address inside the cluster pod CIDR). Mirrors
              // the same pattern in k8s/base/network-policies.yaml.
              { ipBlock: { cidr: '10.42.0.0/16' } },
            ],
            ports: [{ protocol: 'TCP', port: 8111 }],
          }],
        },
      },
    },
  ];

  for (const policy of policies) {
    try {
      await k8s.networking.createNamespacedNetworkPolicy({
        namespace,
        body: policy.body as Parameters<typeof k8s.networking.createNamespacedNetworkPolicy>[0]['body'],
      });
    } catch (err: unknown) {
      // Already exists — safe to ignore (policies are effectively immutable;
      // if their spec ever changes, operators can delete + recreate).
      if (!isK8s409(err)) throw err;
    }
  }
}

export async function applyPVC(
  k8s: K8sClients,
  namespace: string,
  storageGi: string,
  storageClass: string,
): Promise<void> {
  try {
    await k8s.core.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        metadata: {
          name: `${namespace}-storage`,
          namespace,
          labels: {
            // Opt this PVC into Longhorn's `default` RecurringJob group
            // so the daily/weekly backup schedule picks it up
            // automatically. Without this label a new tenant PVC would
            // silently fall outside the backup set — see
            // project_backup_restore_benchmarks.md and N6 audit.
            'recurring-job-group.longhorn.io/default': 'enabled',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'tenant-storage',
          },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: storageClass,
          resources: {
            requests: {
              storage: `${storageGi}Gi`,
            },
          },
        },
      },
    });
  } catch (err: unknown) {
    // Already exists — PVCs are immutable (can't resize in-place without CSI support)
    if (!isK8s409(err)) throw err;
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface ProvisionOptions {
  readonly overrides?: {
    readonly cpu_limit?: string;
    readonly memory_limit?: string;
    readonly storage_limit?: string;
  };
}

/**
 * Run the full namespace provisioning flow.
 * Updates the provisioning_tasks row with progress at each step.
 * This runs async (fire-and-forget from the route handler).
 */
export async function runProvisionNamespace(
  db: Database,
  k8s: K8sClients,
  taskId: string,
  clientId: string,
  options?: ProvisionOptions,
): Promise<void> {
  // Fetch client + plan
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, client.planId)).limit(1);
  if (!plan) throw new Error(`Plan ${client.planId} not found`);

  const namespace = client.kubernetesNamespace;
  const cpuLimit = options?.overrides?.cpu_limit ?? String(parseFloat(plan.cpuLimit));
  const memoryLimit = options?.overrides?.memory_limit ?? String(parseFloat(plan.memoryLimit));
  const storageLimit = options?.overrides?.storage_limit ?? String(parseFloat(plan.storageLimit));
  // M7: pick SC by storage tier. `local` → longhorn-tenant-local (1
  // replica, M2 default), `ha` → longhorn-tenant-ha (2 replicas). Fall
  // back to the operator-configured default for clients that haven't
  // been assigned a tier yet or for clusters that haven't applied the
  // M2 StorageClass manifests. The platform-managed SC names come
  // from k8s/base/longhorn/storageclasses.yaml.
  const storageClass = client.storageTier === 'ha'
    ? 'longhorn-tenant-ha'
    : client.storageTier === 'local'
      ? 'longhorn-tenant-local'
      : await getDefaultStorageClass(db);

  let stepsLog = buildStepsLog(PROVISION_STEPS);
  let completedSteps = 0;

  const updateProgress = async (stepName: string, status: ProvisioningStep['status'], error?: string) => {
    stepsLog = updateStepStatus(stepsLog, stepName, status, error);
    if (status === 'completed') completedSteps++;

    await db.update(provisioningTasks).set({
      currentStep: stepName,
      completedSteps,
      stepsLog,
      ...(status === 'failed' ? { status: 'failed' as const, errorMessage: error, completedAt: new Date() } : {}),
    }).where(eq(provisioningTasks.id, taskId));
  };

  // Mark task as running
  await db.update(provisioningTasks).set({
    status: 'running',
    startedAt: new Date(),
    stepsLog,
  }).where(eq(provisioningTasks.id, taskId));

  await db.update(clients).set({
    provisioningStatus: 'provisioning',
  }).where(eq(clients.id, clientId));

  // Abort early if the client was deleted before/while we started.
  // Protects against the "delete a failed client while retry is still
  // running in the background" race — without this guard the orchestrator
  // would happily recreate resources in a namespace that's being torn down.
  const guardClientExists = async (): Promise<boolean> => {
    if (await clientStillExists(db, clientId)) return true;
    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: 'Client deleted during provisioning — aborted',
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));
    return false;
  };

  try {
    // Step 1: Create Namespace
    if (!(await guardClientExists())) return;
    await updateProgress('Create Namespace', 'running');
    await applyNamespace(k8s, namespace, clientId);
    await updateProgress('Create Namespace', 'completed');

    // Step 2: Create ResourceQuota
    if (!(await guardClientExists())) return;
    await updateProgress('Create ResourceQuota', 'running');
    await applyResourceQuota(k8s, namespace, { cpu: cpuLimit, memory: memoryLimit, storage: storageLimit });
    await updateProgress('Create ResourceQuota', 'completed');

    // Step 3: Create NetworkPolicy
    if (!(await guardClientExists())) return;
    await updateProgress('Create NetworkPolicy', 'running');
    await applyNetworkPolicy(k8s, namespace);
    await updateProgress('Create NetworkPolicy', 'completed');

    // Step 4: Create shared PVC (all components use Deployment + subPath on this PVC)
    if (!(await guardClientExists())) return;
    await updateProgress('Create PVC', 'running');
    const sharedPvcSize = Math.min(10, Number(storageLimit) || 10);
    await applyPVC(k8s, namespace, String(sharedPvcSize), storageClass);
    await updateProgress('Create PVC', 'completed');

    // Step 5: Start file-manager sidecar (Deployment + Service)
    if (!(await guardClientExists())) return;
    await updateProgress('Start File Manager', 'running');
    const FM_IMAGE = 'file-manager-sidecar:latest';
    await ensureFileManagerRunning(k8s, namespace, FM_IMAGE);
    await updateProgress('Start File Manager', 'completed');

    // All done — mark task and client as provisioned
    await db.update(provisioningTasks).set({
      status: 'completed',
      completedSteps,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));

    await db.update(clients).set({
      provisioningStatus: 'provisioned',
    }).where(eq(clients.id, clientId));
  } catch (err: unknown) {
    const message = formatK8sError(err);

    // Also mark the currently-running step as failed so the UI surfaces
    // which step errored (previously only `errorMessage` was set).
    const runningStep = stepsLog.find(s => s.status === 'running');
    if (runningStep) {
      stepsLog = updateStepStatus(stepsLog, runningStep.name, 'failed', message);
    }

    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: message,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));

    // Client may have been deleted between the last guard and the throw —
    // don't let that turn a provisioning failure into an unhandled rejection.
    try {
      await db.update(clients).set({
        provisioningStatus: 'failed',
      }).where(eq(clients.id, clientId));
    } catch {
      // Swallow — row is gone, nothing to update.
    }
  }
}

// ─── Decommission Orchestrator ───────────────────────────────────────────────

/**
 * Delete the entire namespace (cascades all resources inside it).
 * Runs async, updates provisioning_tasks with progress.
 */
export async function runDeprovision(
  db: Database,
  k8s: K8sClients,
  taskId: string,
  clientId: string,
): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const namespace = client.kubernetesNamespace;
  let stepsLog = buildStepsLog(DEPROVISION_STEPS);
  let completedSteps = 0;

  const updateProgress = async (stepName: string, status: ProvisioningStep['status'], error?: string) => {
    stepsLog = updateStepStatus(stepsLog, stepName, status, error);
    if (status === 'completed') completedSteps++;
    await db.update(provisioningTasks).set({
      currentStep: stepName,
      completedSteps,
      stepsLog,
      ...(status === 'failed' ? { status: 'failed' as const, errorMessage: error, completedAt: new Date() } : {}),
    }).where(eq(provisioningTasks.id, taskId));
  };

  await db.update(provisioningTasks).set({
    status: 'running',
    startedAt: new Date(),
    stepsLog,
  }).where(eq(provisioningTasks.id, taskId));

  try {
    // Step 1: Delete Namespace (cascades everything inside)
    await updateProgress('Delete Namespace', 'running');
    try {
      await k8s.core.deleteNamespace({ name: namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
      // Already gone — that's fine
    }
    await updateProgress('Delete Namespace', 'completed');

    await db.update(provisioningTasks).set({
      status: 'completed',
      completedSteps,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));

    await db.update(clients).set({
      provisioningStatus: 'unprovisioned',
    }).where(eq(clients.id, clientId));
  } catch (err: unknown) {
    const message = formatK8sError(err);
    const runningStep = stepsLog.find(s => s.status === 'running');
    if (runningStep) {
      stepsLog = updateStepStatus(stepsLog, runningStep.name, 'failed', message);
    }
    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: message,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));
  }
}
