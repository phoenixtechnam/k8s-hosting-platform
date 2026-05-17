import { eq } from 'drizzle-orm';
import type { K8sClients } from './k8s-client.js';
import type { ProvisioningStep } from '@k8s-hosting/api-contracts';
import { toSafeText } from '@k8s-hosting/api-contracts';
import { tenants, provisioningTasks, hostingPlans } from '../../db/schema.js';
import { ensureFileManagerRunning } from '../file-manager/k8s-lifecycle.js';
import { getFileManagerImage } from '../file-manager/image.js';
import { translateOperatorError } from '../../shared/operator-error.js';
import type { Database } from '../../db/index.js';
import { JSON_PATCH, STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { start as startTask, finishByRef } from '../tasks/service.js';
import { tenantStoragePvcLabelsFromNamespace } from '../../lib/canonical-labels.js';
import { isNotFound } from '../../shared/k8s-errors.js';

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
  // Older tenant versions used statusCode property
  if (isNotFound(err)) return true;
  return false;
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  if ((err as { statusCode?: number }).statusCode === 409) return true;
  return false;
}

/**
 * Extract a single-line, human-readable message from a k8s tenant error.
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

/** Returns false if the tenant row was deleted — orchestrator should abort. */
async function tenantStillExists(db: Database, tenantId: string): Promise<boolean> {
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
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

// ─── System Service Reserves (DEPRECATED) ───────────────────────────────────
//
// Originally we padded each tenant ResourceQuota by a SYSTEM_*_RESERVE so
// file-manager (running in the tenant namespace) wouldn't eat into plan
// limits. That guesswork is replaced by the two-tier placement model:
//
//   - Storage-lifecycle Jobs (fsck) run in `platform-tenant-ops` namespace
//     (no quota at all).
//   - file-manager (must stay in tenant namespace because of PVC mount) is
//     tagged `priorityClassName: platform-tenant-overhead`. The quota's
//     `scopeSelector` matches only `tenant-default` priority — file-manager
//     is exempt.
//
// Constants are kept exported (= 0) for backwards compat with any caller
// computing plan-vs-quota, but applyResourceQuota no longer adds them.
export const SYSTEM_CPU_RESERVE = 0;
export const SYSTEM_MEMORY_RESERVE = 0;

/** PriorityClass that tenant ResourceQuotas count against (every Pod
 *  without an explicit priorityClassName gets this via globalDefault). */
/**
 * Namespace patterns produced by the integration test suite. Tenants
 * provisioned into a namespace matching one of these (case-insensitive)
 * get `longhorn-tenant-test` (reclaimPolicy=Delete) instead of
 * `longhorn-tenant` (reclaimPolicy=Retain), so their PVs auto-GC on
 * tenant delete.
 *
 * Why a regex on the namespace rather than a tenant attribute: the
 * namespace name is the only stable signal the provisioner has at PVC
 * creation time — tenant rows don't carry a "test" boolean and we
 * don't want one (operators shouldn't be able to flip a real tenant
 * into delete-on-deprovision mode by accident). The names are written
 * by the integration scripts themselves (see `integration-*.sh`) so
 * the contract lives at the test layer.
 *
 * Production tenant slugs are user-chosen via the admin UI / API —
 * they don't match these patterns unless an operator deliberately
 * creates a tenant with a name like `tenant-foo-passkey-e2e-…`.
 */
const TENANT_TEST_NAMESPACE_PATTERN = new RegExp(
  '^tenant-(' + [
    'integration-test',
    'lifecycle-e2e',
    'passkey-e2e',
    'pvc-test',
    'reaper-test',
    'bundle-test',
    'ingress-test',
    'drain-test',
    'tier-test',
    'grow-test',
    'mail-test',
    'provision-test',
    'mtls-test',
    'firewall-test',
  ].join('|') + ')-',
  'i',
);

/**
 * Pick the StorageClass for a tenant's PVC. Test namespaces (matching
 * `TENANT_TEST_NAMESPACE_PATTERN`) get a Delete-reclaim SC so they
 * don't leak PVs when the test exits. Everything else uses the
 * Retain SC that protects real customer data.
 *
 * The `TENANT_STORAGE_CLASS` env var still wins — non-Longhorn dev
 * clusters use it to swap in `local-path` etc. for both prod-mode and
 * test-mode tenants alike (those clusters typically only have one SC).
 * Exported for unit tests.
 */
export function selectTenantStorageClass(namespace: string): string {
  const override = process.env.TENANT_STORAGE_CLASS;
  if (override) return override;
  if (TENANT_TEST_NAMESPACE_PATTERN.test(namespace)) {
    return 'longhorn-tenant-test';
  }
  return 'longhorn-tenant';
}

export const TENANT_DEFAULT_PRIORITY_CLASS = 'tenant-default';
/** PriorityClass for platform-managed Pods that live in tenant
 *  namespaces but should NOT count against the tenant ResourceQuota. */
export const TENANT_OVERHEAD_PRIORITY_CLASS = 'platform-tenant-overhead';

// ─── K8s Resource Creators ───────────────────────────────────────────────────

/**
 * Pod Security Standards labels applied to every tenant namespace.
 *
 * Added in ADR-036 to harden the third deployment path (custom
 * container / compose). The labels apply to ALL pods in the
 * namespace, including catalog deployments, so the level was chosen
 * to avoid breaking existing catalog manifests:
 *
 *   - `enforce: baseline` — blocks the most-egregious escapes
 *     (hostNetwork, hostPID, hostIPC, privileged, hostPath volumes,
 *     hostPort, dangerous capability adds). Catalog images don't
 *     use any of these; tenant custom images cannot.
 *
 *   - `warn: restricted` — surfaces the stricter PSS profile in
 *     `kubectl` warnings (visible in CI/dev), so operators can see
 *     where workloads sit relative to the higher bar without
 *     enforcement. Restricted rejects e.g. `runAsNonRoot:false`
 *     and `allowPrivilegeEscalation:true`, both of which some legit
 *     catalog images still need.
 *
 *   - `audit: restricted` — writes a Kubernetes audit event for any
 *     pod that would violate restricted. Lets operators discover
 *     drift candidates over time without breaking workloads.
 *
 * Idempotent: `applyNamespace` runs this patch on every provisioning
 * call so newly added clusters / namespaces converge. There is no
 * separate backfill code path — re-running provisioning on every
 * tenant (e.g. `scripts/backfill-tenant-namespace-pss.sh` calling the
 * platform API) is the backfill.
 */
const TENANT_NAMESPACE_LABELS_BASE = {
  platform: 'k8s-hosting',
} as const;

/**
 * PSS labels for a tenant namespace. The enforce level depends on whether
 * the operator has enabled either of the `allow_host_ports_*` toggles in
 * system_settings:
 *
 *   - both off  → enforce=baseline (forbids hostPort, hostPath,
 *                                    hostNetwork, host PID/IPC, etc.)
 *   - either on → enforce=privileged (allows EVERYTHING, including
 *                                      hostPort which is the whole
 *                                      point of the toggle)
 *
 * baseline is preferred — it's the highest enforcement that still allows
 * common tenant workloads to run. PSA's discrete ladder (privileged →
 * baseline → restricted) has no "baseline + hostPort" level, so opting
 * into host ports for tenants means opting into the full privileged
 * profile for tenant namespaces. Operators who enable the toggle take on
 * that broader trust. `warn` and `audit` stay at `restricted` so kubectl
 * + audit log keep highlighting drift even when enforce is loosened.
 *
 * 2026-05-17: this was static `baseline` before. The firewall integration
 * test surfaced the broken contract — platform-api accepted the deploy
 * (allow_host_ports_* on), but k8s admission rejected the Pod because
 * PSA enforce=baseline still forbade `hostPort`. Now the enforce level
 * tracks the toggle so the gate decision is consistent at both layers.
 */
function buildPsaLabels(
  allowHostPorts: boolean,
): Record<string, string> {
  const enforceLevel = allowHostPorts ? 'privileged' : 'baseline';
  return {
    'pod-security.kubernetes.io/enforce': enforceLevel,
    'pod-security.kubernetes.io/enforce-version': 'latest',
    'pod-security.kubernetes.io/warn': 'restricted',
    'pod-security.kubernetes.io/warn-version': 'latest',
    'pod-security.kubernetes.io/audit': 'restricted',
    'pod-security.kubernetes.io/audit-version': 'latest',
  };
}

export async function applyNamespace(
  k8s: K8sClients,
  namespace: string,
  tenantId: string,
  // Caller passes the resolved settings so we don't query the DB on
  // every namespace touch. Default to most-restrictive (baseline) when
  // settings aren't available — fail-safe, the toggle can be re-applied
  // by a subsequent provisioning call once settings are wired.
  options?: { allowHostPorts?: boolean },
): Promise<void> {
  const labels = {
    ...TENANT_NAMESPACE_LABELS_BASE,
    ...buildPsaLabels(options?.allowHostPorts ?? false),
    tenant: tenantId,
  };

  // Check if namespace already exists. Either path (exists or 404)
  // must end with the PSS labels in place — this function is the
  // single source of truth for tenant-namespace labelling, and we
  // rely on it to backfill PSS labels onto pre-ADR-036 namespaces
  // on the next provisioning touch.
  try {
    await k8s.core.readNamespace({ name: namespace });
    // Already exists — patch labels so PSS coverage stays current.
    // strategic-merge-patch handles label maps by union, so this
    // never strips operator-set labels.
    await k8s.core.patchNamespace(
      {
        name: namespace,
        body: { metadata: { labels } },
      } as unknown as Parameters<typeof k8s.core.patchNamespace>[0],
      STRATEGIC_MERGE_PATCH,
    );
    return;
  } catch (err: unknown) {
    // @kubernetes/client-node v1.4 throws HttpException with "HTTP-Code: 404" in message
    const isNotFound = isK8s404(err);
    if (!isNotFound) throw err;
  }

  await k8s.core.createNamespace({
    body: {
      metadata: {
        name: namespace,
        labels,
      },
    },
  });
}

export async function applyResourceQuota(
  k8s: K8sClients,
  namespace: string,
  limits: { cpu: string; memory: string; storage: string },
): Promise<void> {
  // Asymmetric QoS model (ADR-037):
  //
  //   CPU is enforced on `requests.cpu` — pods declare a baseline request,
  //   omit CPU limits, and burst freely within the customer plan. cgroup
  //   `cpu.shares` arbitrates contention proportionally.
  //
  //   Memory is enforced on `limits.memory` AND `requests.memory` (set
  //   equal per container) — memory is incompressible, OOM-kill is
  //   non-graceful, and kubelet eviction can cross namespaces. Pods
  //   stay Guaranteed for memory; the quota caps both axes at the plan.
  //
  // K8s ResourceQuota constraint: PriorityClass scope applies ONLY to
  // Pod-level resources (cpu, memory, pods). Resource counts like
  // `requests.storage` (the per-namespace PVC budget) are NOT
  // scoped-selector-eligible and the API server returns 422
  // "unsupported scope applied to resource" if they appear in a
  // scoped quota. So we split into TWO quotas:
  //
  //   <ns>-quota          (scoped, counts only tenant-default Pods)
  //     requests.cpu, limits.memory, requests.memory
  //
  //   <ns>-storage-quota  (unscoped, namespace-wide)
  //     requests.storage
  //
  // Both quotas are sized to plan limits exactly (no padding).
  const quotaName = `${namespace}-quota`;
  const storageQuotaName = `${namespace}-storage-quota`;

  const podBody = {
    metadata: { name: quotaName, namespace },
    spec: {
      hard: {
        'requests.cpu': limits.cpu,
        'requests.memory': `${limits.memory}Gi`,
        'limits.memory': `${limits.memory}Gi`,
      },
      scopeSelector: {
        matchExpressions: [
          {
            scopeName: 'PriorityClass',
            operator: 'In',
            values: [TENANT_DEFAULT_PRIORITY_CLASS],
          },
        ],
      },
    },
  };

  const storageBody = {
    metadata: { name: storageQuotaName, namespace },
    spec: {
      hard: {
        'requests.storage': `${limits.storage}Gi`,
      },
    },
  };

  await upsertQuota(k8s, namespace, quotaName, podBody);
  await upsertQuota(k8s, namespace, storageQuotaName, storageBody);
}

async function upsertQuota(
  k8s: K8sClients,
  namespace: string,
  name: string,
  body: { metadata: { name: string; namespace: string }; spec: object },
): Promise<void> {
  try {
    await k8s.core.createNamespacedResourceQuota({ namespace, body });
  } catch (err: unknown) {
    if (!isK8s409(err)) throw err;
    try {
      await k8s.core.replaceNamespacedResourceQuota({ name, namespace, body } as Parameters<typeof k8s.core.replaceNamespacedResourceQuota>[0]);
    } catch (replaceErr: unknown) {
      if (!isQuotaScopeImmutable(replaceErr)) throw replaceErr;
      // ResourceQuota scope/scopeSelector is immutable after creation.
      // For pre-PR 2 quotas that lack our scopeSelector, drop+recreate
      // is the only way to add it. ~ms window where the namespace is
      // unbounded — acceptable on a one-shot upgrade.
      await k8s.core.deleteNamespacedResourceQuota({ name, namespace } as never);
      await k8s.core.createNamespacedResourceQuota({ namespace, body });
    }
  }
}

function isQuotaScopeImmutable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /scope.*immutable|scopeSelector.*immutable|spec\.scope/i.test(err.message);
}

export async function applyNetworkPolicy(
  k8s: K8sClients,
  namespace: string,
): Promise<void> {
  // Two NetworkPolicies per tenant namespace:
  //
  // 1. default-deny-ingress — blanket deny for cross-namespace ingress,
  //    except from traefik (so the user's web app remains reachable
  //    from the ingress controller).
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
                    matchLabels: { 'kubernetes.io/metadata.name': 'traefik' },
                  },
                },
                // Traefik runs hostPort (not hostNetwork); when it
                // forwards cross-node to a tenant pod, Linux re-sources
                // the packet via vxlan.calico — the tenant pod sees a
                // source IP in the cluster pod CIDR (10.42.0.0/16),
                // NOT the traefik namespace. Without this ipBlock the
                // namespaceSelector above never matches for cross-node
                // traffic, and tenant HTTP (including LE HTTP-01
                // challenges via Traefik's ingress-acme path) times out
                // at 504. Same fix shape as k8s/base/network-policies.
                // yaml: allow-ingress-to-platform. (Migrated from
                // namespace=ingress-nginx to namespace=traefik
                // 2026-05-15; the ipBlock fallback masked the dead
                // selector during the migration window.)
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
    // backup-coverage: captured-by:files
    // (canonical tenant data PVC `${namespace}-storage`; the files
    // component tarballs every path under its mount.)
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
            // Canonical labels — mirrored to the bound PV by the
            // storage-policy reconciler so `kubectl get pv` and the
            // Longhorn UI can show meaningful names alongside the
            // CSI-generated PV UUID.
            ...tenantStoragePvcLabelsFromNamespace(namespace),
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
  // Step 1: PVC → bound PV name. With volumeBindingMode=Immediate the
  // PVC binds quickly, but Longhorn's PV provisioning is async — the
  // spec.volumeName isn't populated until the bind completes. Poll up
  // to 30s rather than failing on the first read; HA tier needs the
  // replica count patched and dropping it leaves the volume at the
  // SC's default of 1 replica.
  let pvName: string | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }) as { spec?: { volumeName?: string } };
    pvName = pvc?.spec?.volumeName;
    if (pvName) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!pvName) {
    throw new Error(`PVC ${namespace}/${pvcName} has no bound volume after 30s`);
  }
  // Step 2: JSON-patch the Volume CR. Use replace; Longhorn rebuilds
  // replicas async after the spec changes.
  await k8s.custom.patchNamespacedCustomObject({
    group: 'longhorn.io', version: 'v1beta2',
    namespace: 'longhorn-system', plural: 'volumes', name: pvName,
    body: [{ op: 'replace', path: '/spec/numberOfReplicas', value: targetReplicas }],
  } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0],
    JSON_PATCH);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface ProvisionOptions {
  readonly overrides?: {
    readonly cpu_limit?: string;
    readonly memory_limit?: string;
    readonly storage_limit?: string;
  };
}

// ─── Task Tracker mirror ─────────────────────────────────────────────────────

/**
 * Sync a `provisioning_tasks` row into the canonical `tasks` table so
 * the Task Center chip surfaces it. Idempotent on
 * `(kind=tenant.provision|tenant.deprovision, ref_id=taskId)` —
 * multiple progress updates within a single run just refresh the
 * existing task row.
 *
 * The `kind` is derived from `provisioningTasks.type`:
 *   - `provision_namespace` → `tenant.provision`
 *   - `deprovision`         → `tenant.deprovision`
 * This keeps deprovision rows from upserting onto the original
 * provision row (they share `ref_id` only when the orchestrator
 * re-uses ids, but separate kinds let both rows coexist anyway).
 *
 * Skips system-initiated provisioning rows (no `started_by`) the same
 * way storage-lifecycle skips cron-driven snapshot ops: `scope='admin'`
 * tasks need a real user_id to surface in any chip.
 *
 * Best-effort. Failures are logged by the caller — never block the
 * underlying provisioning flow.
 */
export async function mirrorProvisioningToTaskTracker(
  db: Database,
  taskId: string,
): Promise<void> {
  const [task] = await db
    .select({
      id: provisioningTasks.id,
      tenantId: provisioningTasks.tenantId,
      type: provisioningTasks.type,
      status: provisioningTasks.status,
      currentStep: provisioningTasks.currentStep,
      totalSteps: provisioningTasks.totalSteps,
      completedSteps: provisioningTasks.completedSteps,
      errorMessage: provisioningTasks.errorMessage,
      startedBy: provisioningTasks.startedBy,
    })
    .from(provisioningTasks)
    .where(eq(provisioningTasks.id, taskId))
    .limit(1);
  if (!task || !task.startedBy) return;

  // Look up tenant for the modal label. ProvisioningProgressModal
  // takes `tenantId` + `tenantName` (name) as its required
  // props — keep them in modalProps so the chip's reopen path doesn't
  // need a follow-up fetch.
  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, task.tenantId))
    .limit(1);
  const tenantName = tenant?.name ?? task.tenantId.slice(0, 8);

  // pending|running → 'running'; completed → 'succeeded'; failed → 'failed'.
  const isTerminal = task.status === 'completed' || task.status === 'failed';
  const taskStatus: 'running' | 'succeeded' | 'failed' =
    !isTerminal ? 'running'
    : task.status === 'failed' ? 'failed'
    : 'succeeded';

  const progressPct = task.totalSteps > 0
    ? Math.round((task.completedSteps / task.totalSteps) * 100)
    : null;

  // Branch on the underlying op type so deprovision tasks don't get
  // upserted onto the same row as a previous provision. The frontend
  // modal-registry maps both kinds via `target.modal = 'provisioning'`
  // (the modal renders the same step list in either direction).
  const isDeprovision = task.type === 'deprovision';
  const kind = isDeprovision ? 'tenant.deprovision' : 'tenant.provision';
  const labelVerb = isDeprovision ? 'Decommission' : 'Provision';

  const target = {
    type: 'modal' as const,
    modal: 'provisioning',
    modalProps: {
      tenantId: task.tenantId,
      tenantName,
    },
  };

  // toSafeText throws on forbidden patterns (e.g., a company name
  // containing "token=..." would trip the secret-leak guard). Falling
  // back to a guaranteed-safe string keeps the mirror running and the
  // chip lit up — operators always have the modal target to recover
  // the full tenant name.
  const safeLabel = (() => {
    try {
      return toSafeText(`${labelVerb}: ${tenantName}`);
    } catch {
      return toSafeText(`${labelVerb}: ${task.tenantId.slice(0, 8)}`);
    }
  })();
  const safeProgressText = task.currentStep
    ? (() => {
        try {
          return toSafeText(task.currentStep!);
        } catch {
          return null;
        }
      })()
    : null;

  // start() upserts on (kind, ref_id). Re-running it on every progress
  // tick is the documented pattern for refreshing label/progress fields
  // while a task is still running (matches storage-lifecycle).
  if (taskStatus === 'running') {
    await startTask(db, {
      kind,
      refId: task.id,
      scope: 'admin',
      userId: task.startedBy,
      tenantId: task.tenantId,
      label: safeLabel,
      target,
      progressPct,
      progressText: safeProgressText,
      details: {
        type: task.type,
        totalSteps: task.totalSteps,
        completedSteps: task.completedSteps,
        currentStep: task.currentStep,
      },
    });
    return;
  }

  // Terminal — also call start() once so the chip has a row to
  // finalize even if no `running` mirror happened (e.g., the op
  // completed in a single tick before the orchestrator's first
  // mirror call landed). Matches storage-lifecycle's pattern.
  await startTask(db, {
    kind,
    refId: task.id,
    scope: 'admin',
    userId: task.startedBy,
    tenantId: task.tenantId,
    label: safeLabel,
    target,
    progressPct,
    progressText: safeProgressText,
    details: {
      type: task.type,
      totalSteps: task.totalSteps,
      completedSteps: task.completedSteps,
      currentStep: task.currentStep,
    },
  });
  await finishByRef(db, kind, task.id, {
    status: taskStatus,
    text: safeProgressText,
    error: taskStatus === 'failed' ? (task.errorMessage ?? `${labelVerb} failed`) : null,
  });
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
  tenantId: string,
  options?: ProvisionOptions,
): Promise<void> {
  // Fetch tenant + plan
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error(`Client ${tenantId} not found`);

  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, tenant.planId)).limit(1);
  if (!plan) throw new Error(`Plan ${tenant.planId} not found`);

  const namespace = tenant.kubernetesNamespace;
  const cpuLimit = options?.overrides?.cpu_limit ?? String(parseFloat(String(tenant.cpuLimitOverride ?? plan.cpuLimit)));
  const memoryLimit = options?.overrides?.memory_limit ?? String(parseFloat(String(tenant.memoryLimitOverride ?? plan.memoryLimit)));
  const storageLimit = options?.overrides?.storage_limit ?? String(parseFloat(String(tenant.storageLimitOverride ?? plan.storageLimit)));
  // Unified tenant SC. PVC.spec.storageClassName is immutable on a
  // bound PVC, so splitting tier semantics across two SCs forced a
  // snapshot+restore migration to change tier. We now use ONE SC and
  // patch Volume.spec.numberOfReplicas live (1 for Local, 2 for HA)
  // after the PVC binds. Tier change is also live (applyTenantTier).
  //
  // TENANT_STORAGE_CLASS env override exists so non-Longhorn environments
  // (local DinD k3s, ad-hoc clusters running on RKE/EKS without Longhorn)
  // can swap in `local-path` or another in-cluster SC. The replica-patching
  // code below is Longhorn-specific and silently no-ops on other SCs (the
  // patch() call fails — we treat that as "non-Longhorn cluster, skip"
  // so the deployer doesn't crash on plain SCs).
  //
  // Test-namespace auto-select: namespaces matching the integration-test
  // naming patterns get longhorn-tenant-test (reclaimPolicy=Delete) so
  // their PVs auto-GC when the tenant is deleted. See
  // selectTenantStorageClass for the matched patterns + rationale.
  // Production tenants are NEVER matched.
  const storageClass = selectTenantStorageClass(namespace);

  // Auto-pick worker for Local tier when the operator chose "Auto"
  // (nodeName=null). Local tier MUST run on a specific node
  // because the single replica only exists there — without a pin,
  // the next pod reschedule could land on a node with no replica
  // and Longhorn would have to migrate the volume (slow + risky).
  // HA tier with Auto stays null: the scheduler picks freely and
  // dataLocality=best-effort drifts the primary toward the chosen
  // node naturally.
  if (!tenant.nodeName && tenant.storageTier !== 'ha') {
    try {
      const { autoPickWorkerNode } = await import('../tenants/storage-placement-service.js');
      const picked = await autoPickWorkerNode(db, k8s);
      if (picked) {
        await db.update(tenants).set({ nodeName: picked }).where(eq(tenants.id, tenantId));
        tenant.nodeName = picked;
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
    // Best-effort mirror to the chip. A tracker error must not break
    // the provisioning flow — the underlying op continues regardless.
    await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
      console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // Mark task as running
  await db.update(provisioningTasks).set({
    status: 'running',
    startedAt: new Date(),
    stepsLog,
  }).where(eq(provisioningTasks.id, taskId));
  await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
    console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  });

  await db.update(tenants).set({
    provisioningStatus: 'provisioning',
  }).where(eq(tenants.id, tenantId));

  // Abort early if the tenant was deleted before/while we started.
  // Protects against the "delete a failed tenant while retry is still
  // running in the background" race — without this guard the orchestrator
  // would happily recreate resources in a namespace that's being torn down.
  const guardTenantExists = async (): Promise<boolean> => {
    if (await tenantStillExists(db, tenantId)) return true;
    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: 'Client deleted during provisioning — aborted',
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));
    await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
      console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return false;
  };

  try {
    // Step 1: Create Namespace
    if (!(await guardTenantExists())) return;
    await updateProgress('Create Namespace', 'running');
    // Pick the namespace PSA enforce level based on the cluster-wide
    // `allow_host_ports_*` toggles. When either is on, the tenant
    // namespace gets enforce=privileged so deployments declaring
    // `hostPort` actually admit (the platform-api gate alone isn't
    // enough — k8s admission rejects the Pod independently). See
    // buildPsaLabels in this file for the full rationale.
    const { getSettings } = await import('../system-settings/service.js');
    const settings = await getSettings(db).catch(() => null);
    const allowHostPorts = !!(settings?.allowHostPortsServer || settings?.allowHostPortsWorker);
    await applyNamespace(k8s, namespace, tenantId, { allowHostPorts });
    await updateProgress('Create Namespace', 'completed');

    // Step 2: Create ResourceQuota
    if (!(await guardTenantExists())) return;
    await updateProgress('Create ResourceQuota', 'running');
    await applyResourceQuota(k8s, namespace, { cpu: cpuLimit, memory: memoryLimit, storage: storageLimit });
    await updateProgress('Create ResourceQuota', 'completed');

    // Step 3: Create NetworkPolicy
    if (!(await guardTenantExists())) return;
    await updateProgress('Create NetworkPolicy', 'running');
    await applyNetworkPolicy(k8s, namespace);
    await updateProgress('Create NetworkPolicy', 'completed');

    // Step 4: Create shared PVC (all components use Deployment + subPath on this PVC)
    if (!(await guardTenantExists())) return;
    await updateProgress('Create PVC', 'running');
    const sharedPvcSize = Math.min(10, Number(storageLimit) || 10);
    await applyPVC(k8s, namespace, String(sharedPvcSize), storageClass);

    // Patch the freshly-bound Volume CR to the tier-specific replica
    // count. The unified `longhorn-tenant` SC ships with replicas=1
    // by default; HA tenants need replicas=2. Patching after bind is
    // safe (Longhorn rebuilds replicas async). Idempotent — a re-
    // provision with the same tier flips to a no-op.
    const targetReplicas = tenant.storageTier === 'ha' ? 2 : 1;
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
    if (!(await guardTenantExists())) return;
    await updateProgress('Start File Manager', 'running');
    await ensureFileManagerRunning(k8s, namespace, getFileManagerImage());
    await updateProgress('Start File Manager', 'completed');

    // All done — mark task and tenant as provisioned
    await db.update(provisioningTasks).set({
      status: 'completed',
      completedSteps,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));

    await db.update(tenants).set({
      provisioningStatus: 'provisioned',
    }).where(eq(tenants.id, tenantId));
    await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
      console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
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
      await db.update(tenants).set({
        provisioningStatus: 'failed',
      }).where(eq(tenants.id, tenantId));
    } catch {
      // Swallow — row is gone, nothing to update.
    }
    await mirrorProvisioningToTaskTracker(db, taskId).catch((mirErr) => {
      console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${mirErr instanceof Error ? mirErr.message : String(mirErr)}`);
    });
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
  tenantId: string,
): Promise<void> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error(`Client ${tenantId} not found`);

  const namespace = tenant.kubernetesNamespace;
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
    await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
      console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  await db.update(provisioningTasks).set({
    status: 'running',
    startedAt: new Date(),
    stepsLog,
  }).where(eq(provisioningTasks.id, taskId));
  await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
    console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  });

  try {
    // Phase A2 follow-up: dispatch a 'deleted' transition through the
    // lifecycle registry BEFORE we touch the namespace. This fires
    // the orphan-prevention hooks (dns-zone-cleanup, tenant-bundles-bundle-
    // cleanup, cluster-scoped-refs-cleanup) while domains + backup_jobs
    // rows are still readable. Decommission keeps the tenant row, so
    // the dispatch records the action in tenant_lifecycle_transitions
    // for the audit trail; detail.preservedTenant=true distinguishes
    // it from a hard delete.
    try {
      const { runTransition } = await import('../tenant-lifecycle/registry/index.js');
      await runTransition(db, k8s, {
        tenantId,
        namespace,
        transition: 'deleted',
        toStatus: 'suspended', // status doesn't change on decommission
        detail: { preservedTenant: true, source: 'decommission-orchestrator' },
      });
    } catch (err) {
      console.warn(`[deprovision] lifecycle dispatch failed for ${tenantId}: ${(err as Error).message}`);
    }

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
    // deletes a PVC). After tenant deletion the operator has already
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

    await db.update(tenants).set({
      provisioningStatus: 'unprovisioned',
    }).where(eq(tenants.id, tenantId));
    await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
      console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    });
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
    await mirrorProvisioningToTaskTracker(db, taskId).catch((mirErr) => {
      console.warn(`[k8s-provisioner] task tracker mirror failed for ${taskId}: ${mirErr instanceof Error ? mirErr.message : String(mirErr)}`);
    });
  }
}
