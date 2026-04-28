import { eq } from 'drizzle-orm';
import type { K8sClients } from './k8s-client.js';
import type { ProvisioningStep } from '@k8s-hosting/api-contracts';
import { clients, provisioningTasks, hostingPlans } from '../../db/schema.js';
import { ensureFileManagerRunning } from '../file-manager/k8s-lifecycle.js';
import { translateOperatorError } from '../../shared/operator-error.js';
import type { Database } from '../../db/index.js';

/**
 * Render a raw provisioning error into either a JSON-stringified
 * OperatorError envelope (when the translator recognized it — quota,
 * scheduling, image pull, etc.) or the plain k8s string (UNKNOWN
 * fallback). The frontend ProvisioningProgressModal auto-detects
 * the JSON form and renders <ErrorPanel> with title + remediation.
 */
function formatProvisionErrorForStorage(message: string): string {
  const envelope = translateOperatorError(message, { kind: 'provision' });
  if (envelope.code === 'UNKNOWN') return message;
  return JSON.stringify(envelope);
}

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
                // ingress-nginx runs hostNetwork=true. When it forwards
                // cross-node to a tenant pod, Linux re-sources the
                // packet via vxlan.calico — the tenant pod sees a
                // source IP in the cluster pod CIDR (10.42.0.0/16),
                // NOT the ingress-nginx namespace. Without this
                // ipBlock the namespaceSelector above never matches
                // for cross-node traffic, and tenant HTTP
                // (including LE HTTP-01 challenges to the
                // cm-acme-http-solver pod) times out at 504.
                // Same fix shape as k8s/base/network-policies.yaml:
                // allow-ingress-to-platform.
                {
                  ipBlock: { cidr: '10.42.0.0/16' },
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
  const pvcName = `${namespace}-storage`;

  // Read-before-create. The naive create-then-409-fallback pattern
  // doesn't work here: when the PVC already exists, ResourceQuota
  // admission fires BEFORE the name-uniqueness check and returns 403
  // (would-exceed-quota: existing 10Gi already consumed). The 409 catch
  // never sees it. Re-provision then dies on "Create PVC" forever.
  // Reading first short-circuits cleanly.
  try {
    await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    return; // Already exists — PVCs are immutable, leave it alone.
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }

  try {
    await k8s.core.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        metadata: {
          name: pvcName,
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
    // Defense-in-depth: if a parallel re-provision raced past the read
    // and inserted the PVC, swallow the 409. PVCs are immutable so
    // there's nothing to update. Genuine 403 (quota) still throws.
    if (!isK8s409(err)) throw err;
  }
}

/**
 * Patch the tenant's Longhorn Volume CR to the desired replica count.
 *
 * Volume name == bound PV name (CSI convention); we resolve it via the
 * PVC's `volumeName`. Idempotent: a no-op when the volume already has
 * the target replica count. Used at provision time (initial setup) and
 * by applyTenantTier (live tier flip).
 *
 * Throws on transient errors (Longhorn CRD missing, API unreachable,
 * volume not bound yet) — caller decides whether to log + continue or
 * fail loudly.
 */
export async function patchTenantVolumeReplicas(
  k8s: K8sClients,
  namespace: string,
  targetReplicas: number,
): Promise<void> {
  const pvcName = `${namespace}-storage`;
  // Step 1: PVC → bound PV name.
  const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }) as { spec?: { volumeName?: string } };
  const pvName = pvc?.spec?.volumeName;
  if (!pvName) {
    throw new Error(`PVC ${namespace}/${pvcName} has no bound volume yet`);
  }
  // Step 2: JSON-patch the Volume CR. Use replace; Longhorn rebuilds
  // replicas async after the spec changes.
  await k8s.custom.patchNamespacedCustomObject({
    group: 'longhorn.io', version: 'v1beta2',
    namespace: 'longhorn-system', plural: 'volumes', name: pvName,
    body: [{ op: 'replace', path: '/spec/numberOfReplicas', value: targetReplicas }],
  } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0],
    { headers: { 'Content-Type': 'application/json-patch+json' } } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[1]);
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
  // Unified tenant SC. PVC.spec.storageClassName is immutable on a
  // bound PVC, so splitting tier semantics across two SCs forced a
  // snapshot+restore migration to change tier. We now use ONE SC and
  // patch Volume.spec.numberOfReplicas live (1 for Local, 2 for HA)
  // after the PVC binds. Tier change is also live (applyTenantTier).
  const storageClass = 'longhorn-tenant';

  // Auto-pick worker for Local tier when the operator chose "Auto"
  // (workerNodeName=null). Local tier MUST run on a specific node
  // because the single replica only exists there — without a pin,
  // the next pod reschedule could land on a node with no replica
  // and Longhorn would have to migrate the volume (slow + risky).
  // HA tier with Auto stays null: the scheduler picks freely and
  // dataLocality=best-effort drifts the primary toward the chosen
  // node naturally.
  if (!client.workerNodeName && client.storageTier !== 'ha') {
    try {
      const { autoPickWorkerNode } = await import('../clients/storage-placement-service.js');
      const picked = await autoPickWorkerNode(db, k8s);
      if (picked) {
        await db.update(clients).set({ workerNodeName: picked }).where(eq(clients.id, clientId));
        client.workerNodeName = picked;
      }
    } catch (err) {
      console.warn(`[k8s-provisioner] auto-pick worker failed for ${namespace}: ${(err as Error).message}`);
    }
  }

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

    // Patch the freshly-bound Volume CR to the tier-specific replica
    // count. The unified `longhorn-tenant` SC ships with replicas=1
    // by default; HA tenants need replicas=2. Patching after bind is
    // safe (Longhorn rebuilds replicas async). Idempotent — a re-
    // provision with the same tier flips to a no-op.
    const targetReplicas = client.storageTier === 'ha' ? 2 : 1;
    try {
      await patchTenantVolumeReplicas(k8s, namespace, targetReplicas);
    } catch (err) {
      // Non-fatal: Volume CR may not exist yet (Longhorn race) or the
      // CRD may be unreachable. Tier reconciler / next applyTenantTier
      // call will repair. Surfaced via console for diagnostics.
      console.warn(`[k8s-provisioner] tenant Volume replica patch failed for ${namespace}:`, (err as Error).message);
    }

    await updateProgress('Create PVC', 'completed');

    // Step 5: Start file-manager sidecar (Deployment + Service)
    if (!(await guardClientExists())) return;
    await updateProgress('Start File Manager', 'running');
    // Same FM_IMAGE resolution as file-manager/routes.ts — env var
    // first (set from the platform-config ConfigMap), fall back to
    // the bare local-dev tag. The bare tag resolves to
    // docker.io/library/file-manager-sidecar:latest in production,
    // which doesn't exist (ImagePullBackOff). The env var has to win.
    const FM_IMAGE = process.env.FILE_MANAGER_IMAGE ?? 'file-manager-sidecar:latest';
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
    const persistedError = formatProvisionErrorForStorage(message);

    // Also mark the currently-running step as failed so the UI surfaces
    // which step errored (previously only `errorMessage` was set).
    // The step-level error stays as the raw k8s string — the UI shows
    // it inline next to the step icon, so a structured envelope there
    // would be visual noise. The top-level errorMessage is the
    // ErrorPanel surface.
    const runningStep = stepsLog.find(s => s.status === 'running');
    if (runningStep) {
      stepsLog = updateStepStatus(stepsLog, runningStep.name, 'failed', message);
    }

    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: persistedError,
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

    // Step 1.5: Delete Released PVs whose claimRef points at this
    // namespace. The tenant SC is `reclaimPolicy: Retain` (intentional
    // — protects against accidental data loss when the operator
    // deletes a PVC). After client deletion the operator has already
    // signed off on losing the data, so we purge the leftover PVs to
    // free Longhorn capacity AND remove the conflict surface for
    // future re-provisioning. Caught by integration-staging.sh
    // reprovision scenario when 3+ Released PVs accumulated from
    // earlier test runs.
    //
    // CRITICAL ORDERING: `deleteNamespace()` returns immediately while
    // the namespace is still Terminating. The PVC still exists then,
    // so its PV is still Bound — not Released. If we list PVs at this
    // moment we find zero candidates and the cleanup is a no-op. The
    // first integration-staging run after the cascade fix shipped
    // surfaced this: namespace deleted, BUT a fresh orphan PV remained
    // because the cleanup raced ahead of the PVC cascade.
    //
    // Fix: snapshot which PVs claim this namespace BEFORE deletion,
    // then poll up to 60s for them to transition to Released (or
    // disappear entirely if the SC happened to be Delete reclaim).
    try {
      interface PvLite { metadata?: { name?: string }; spec?: { claimRef?: { namespace?: string } }; status?: { phase?: string } }

      // Snapshot the PVs bound to PVCs in this namespace at delete-time.
      const pvsBefore = await k8s.core.listPersistentVolume({});
      const candidatesByName = new Map<string, PvLite>();
      for (const p of ((pvsBefore as { items?: PvLite[] }).items ?? [])) {
        const name = p.metadata?.name;
        if (!name) continue;
        if (p.spec?.claimRef?.namespace === namespace) {
          candidatesByName.set(name, p);
        }
      }

      const releasedNames = new Set<string>();
      const startedAt = Date.now();
      // Poll: PVCs cascade-delete during namespace termination, then
      // the PV transitions Bound → Released. Empirically <10s for
      // tenant PVCs but allow 60s to absorb worst-case Longhorn delay.
      while (Date.now() - startedAt < 60_000 && releasedNames.size < candidatesByName.size) {
        const pvsNow = await k8s.core.listPersistentVolume({});
        for (const p of ((pvsNow as { items?: PvLite[] }).items ?? [])) {
          const name = p.metadata?.name;
          if (!name || !candidatesByName.has(name)) continue;
          if (p.status?.phase === 'Released') releasedNames.add(name);
        }
        if (releasedNames.size >= candidatesByName.size) break;
        // Also tolerate the case where a candidate disappeared on its
        // own (Delete reclaim) — count it as "handled" so we don't
        // poll forever waiting for it to become Released.
        const stillPresent = new Set(((pvsNow as { items?: PvLite[] }).items ?? [])
          .map((p) => p.metadata?.name).filter((n): n is string => !!n));
        for (const candidate of candidatesByName.keys()) {
          if (!stillPresent.has(candidate)) releasedNames.add(candidate);
        }
        if (releasedNames.size >= candidatesByName.size) break;
        await new Promise((r) => setTimeout(r, 2_000));
      }

      let cleanedCount = 0;
      for (const pvName of candidatesByName.keys()) {
        // Only act on PVs we actually saw transition (avoid deleting
        // a PV that's in some unexpected state we don't understand).
        if (!releasedNames.has(pvName)) continue;
        try {
          await k8s.core.deletePersistentVolume({ name: pvName });
          cleanedCount++;
        } catch (err) {
          if (!isK8s404(err)) {
            console.warn(`[deprovision] failed to delete Released PV ${pvName}:`, (err as Error).message);
          }
        }
        // Cascade to Longhorn volume — PV deletion alone does NOT
        // delete the volume.longhorn.io CR (Longhorn Retain semantics
        // keep it as a "detached" orphan). Without this, every
        // re-provision accumulates ghost volumes that count against
        // storageScheduled until Longhorn refuses new replicas with
        // "precheck new replica failed: insufficient storage".
        // Volume name == PV name (CSI convention). 404 is OK — the
        // volume may already be gone if reclaimPolicy was Delete.
        try {
          await k8s.custom.deleteNamespacedCustomObject({
            group: 'longhorn.io', version: 'v1beta2',
            namespace: 'longhorn-system', plural: 'volumes', name: pvName,
          } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
        } catch (err) {
          if (!isK8s404(err)) {
            console.warn(`[deprovision] failed to delete Longhorn volume ${pvName}:`, (err as Error).message);
          }
        }
      }
      if (cleanedCount > 0) {
        console.log(`[deprovision] cleaned up ${cleanedCount} Released PV(s) + Longhorn volume(s) for namespace ${namespace}`);
      }
      if (candidatesByName.size > releasedNames.size) {
        console.warn(`[deprovision] ${candidatesByName.size - releasedNames.size} PV(s) for ${namespace} did not reach Released within 60s — leaving for manual cleanup`);
      }
    } catch (err) {
      console.warn('[deprovision] Released PV cleanup failed:', (err as Error).message);
    }

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
    const persistedError = formatProvisionErrorForStorage(message);
    const runningStep = stepsLog.find(s => s.status === 'running');
    if (runningStep) {
      stepsLog = updateStepStatus(stepsLog, runningStep.name, 'failed', message);
    }
    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: persistedError,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));
  }
}
