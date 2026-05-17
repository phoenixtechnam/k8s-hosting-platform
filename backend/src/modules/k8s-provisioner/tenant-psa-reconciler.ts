/**
 * Tenant-namespace PSA reconciler.
 *
 * Trigger: the operator flips `allowHostPortsServer` or
 * `allowHostPortsWorker` in system_settings. Either toggle going from
 * OFF→ON (or ON→OFF) means every existing tenant namespace's
 * `pod-security.kubernetes.io/enforce` label MUST be updated to match
 * the new cluster-wide policy:
 *
 *   - toggle ON  → enforce=privileged (admits hostPort pods)
 *   - toggle OFF → enforce=baseline (refuses hostPort pods)
 *
 * Without this catch-up reconciliation, a fresh tenant created AFTER
 * the toggle flip gets the new label (via `applyNamespace` reading
 * settings), but every PRE-EXISTING tenant namespace keeps the stale
 * label until its next provisioning touch — which may be never. The
 * firewall integration test caught exactly this on 2026-05-17: toggle
 * flipped from off→on, deploy was accepted by platform-api, but k8s
 * still refused the pod because the namespace label was stale.
 *
 * The reconciler patches each tenant namespace via strategic-merge
 * (label-only patch — never strips operator-set labels) so the
 * operation is safe to re-run any number of times. Errors are logged
 * but do not fail the toggle write — the operator's setting persists
 * regardless of cluster-side success.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { tenants } from '../../db/schema.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { CoreV1Api } from '@kubernetes/client-node';

interface ReconcileResult {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: string[];
}

/**
 * Patch every tenant namespace's PSA enforce label to match the
 * supplied `allowHostPorts` decision. Returns a count summary so the
 * caller can log/observe convergence.
 *
 * Uses a fresh K8sClients via the in-cluster service account — the
 * trigger sites (settings PATCH route, dev/test) don't currently pass
 * a client instance through.
 */
export async function reconcileTenantNamespacePsa(
  db: Database,
  allowHostPorts: boolean,
): Promise<ReconcileResult> {
  const enforceLevel = allowHostPorts ? 'privileged' : 'baseline';
  const result: ReconcileResult = { attempted: 0, succeeded: 0, failed: [] };

  // List every provisioned tenant. Unprovisioned tenants (no namespace
  // yet) are skipped — their namespace will be created with the correct
  // label by the next provisioning call.
  const rows = await db
    .select({ id: tenants.id, kubernetesNamespace: tenants.kubernetesNamespace })
    .from(tenants)
    .where(sql`${tenants.kubernetesNamespace} IS NOT NULL AND ${tenants.kubernetesNamespace} != ''`);

  if (rows.length === 0) {
    console.log('[tenant-psa-reconciler] no tenant namespaces to patch');
    return result;
  }

  const core = await loadCoreV1Api();
  // Mutable counters local to this scope so we can return readonly.
  let succeeded = 0;
  const failed: string[] = [];

  for (const row of rows) {
    const ns = row.kubernetesNamespace;
    if (!ns) continue;
    try {
      await core.patchNamespace(
        {
          name: ns,
          body: {
            metadata: {
              labels: {
                'pod-security.kubernetes.io/enforce': enforceLevel,
                'pod-security.kubernetes.io/enforce-version': 'latest',
                'pod-security.kubernetes.io/warn': 'restricted',
                'pod-security.kubernetes.io/warn-version': 'latest',
                'pod-security.kubernetes.io/audit': 'restricted',
                'pod-security.kubernetes.io/audit-version': 'latest',
              },
            },
          },
        } as unknown as Parameters<typeof core.patchNamespace>[0],
        STRATEGIC_MERGE_PATCH,
      );
      succeeded++;
    } catch (err) {
      failed.push(`${ns}: ${(err as Error).message}`);
    }
  }

  console.log(
    `[tenant-psa-reconciler] enforce=${enforceLevel} succeeded=${succeeded}/${rows.length} failed=${failed.length}`,
  );
  return { attempted: rows.length, succeeded, failed };
}

/**
 * Load the CoreV1Api client on demand. Returns the narrowly-typed
 * client (not the broader K8sClients) because this reconciler only
 * needs `patchNamespace` — typing it tightly avoids the `as unknown
 * as K8sClients` cast that would silently break if anything in the
 * reconciler ever called `k8s.apps` / `k8s.networking` / etc. and
 * hit a runtime `undefined`.
 *
 * Kept lazy so the settings-write path doesn't pull k8s SDK + auth
 * at module-import time (the SDK is lazy-loaded throughout the
 * platform-api for the same reason — see provisionTenant). When
 * in-cluster auth isn't available (dev / unit tests), the import
 * throws and the caller logs it.
 */
async function loadCoreV1Api(): Promise<CoreV1Api> {
  const { KubeConfig, CoreV1Api: CoreCtor } = await import('@kubernetes/client-node');
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc.makeApiClient(CoreCtor);
}
