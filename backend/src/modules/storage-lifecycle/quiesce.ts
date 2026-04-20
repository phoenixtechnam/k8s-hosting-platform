import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Quiesce / unquiesce helpers — scale every platform-managed workload
 * in a client namespace to 0 (and back) so that we can safely destroy
 * and recreate the PVC without races against mid-write workloads.
 *
 * Scope: `label platform.io/managed=true`. This matches what the deployer
 * stamps on every Deployment/StatefulSet/CronJob/Job it creates (see
 * `deploymentLabels` in k8s-deployer.ts). CronJob `.spec.suspend` is
 * preferred over scale-to-0 because CronJobs don't expose a replica count;
 * we also suspend them by patching `.spec.suspend = true`.
 */

export interface QuiesceSnapshot {
  readonly deployments: ReadonlyArray<{ name: string; replicas: number }>;
  readonly cronJobs: ReadonlyArray<{ name: string; wasSuspended: boolean }>;
}

/**
 * Scale all platform-managed Deployments to 0 and suspend all
 * platform-managed CronJobs. Returns the prior state so `unquiesce`
 * can restore exactly.
 *
 * Idempotent: calling on an already-quiesced namespace is a no-op.
 * Jobs (one-shot) are NOT touched — their pods finish their own work,
 * and a running Job during a resize would just fail its own retry
 * logic which is acceptable for one-shots.
 */
export async function quiesce(k8s: K8sClients, namespace: string): Promise<QuiesceSnapshot> {
  const deployments: Array<{ name: string; replicas: number }> = [];
  const cronJobs: Array<{ name: string; wasSuspended: boolean }> = [];

  // Scale every Deployment in the tenant namespace — tenant namespaces
  // are single-client dedicated, and every Deployment there
  // (`platform.io/managed` workloads, `platform.io/system` sidecars
  // like file-manager, etc.) can hold the tenant PVC's RWO lock. An
  // earlier revision narrowed this to `platform.io/managed=true` only,
  // which left file-manager holding the PVC and made `resize` fail
  // with "PVC still exists after 60000ms" when the subsequent delete
  // waited on a finalizer that couldn't release.
  const depList = await (k8s.apps as unknown as {
    listNamespacedDeployment: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string }; spec?: { replicas?: number } }> }>;
  }).listNamespacedDeployment({
    namespace,
  });
  for (const d of depList.items ?? []) {
    const name = d.metadata?.name;
    if (!name) continue;
    const replicas = d.spec?.replicas ?? 0;
    deployments.push({ name, replicas });
    if (replicas > 0) {
      // read-modify-replace instead of patch — some k8s clients
      // default to JSON-patch content-type which fails with merge-
      // shaped bodies (400 "cannot unmarshal object into []jsonPatchOp").
      const current = await (k8s.apps as unknown as {
        readNamespacedDeploymentScale: (args: { name: string; namespace: string }) => Promise<Record<string, unknown>>;
      }).readNamespacedDeploymentScale({ name, namespace });
      const scale = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
      await (k8s.apps as unknown as {
        replaceNamespacedDeploymentScale: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
      }).replaceNamespacedDeploymentScale({
        name, namespace,
        body: { ...scale, spec: { ...scale.spec, replicas: 0 } },
      });
    }
  }

  // CronJobs: suspend new triggers (existing Job children are handled
  // separately below).
  const cjList = await (k8s.batch as unknown as {
    listNamespacedCronJob: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string }; spec?: { suspend?: boolean } }> }>;
  }).listNamespacedCronJob({
    namespace,
  });
  for (const cj of cjList.items ?? []) {
    const name = cj.metadata?.name;
    if (!name) continue;
    const wasSuspended = cj.spec?.suspend ?? false;
    cronJobs.push({ name, wasSuspended });
    if (!wasSuspended) {
      // Same read-modify-replace shape as for Deployments above.
      const current = await (k8s.batch as unknown as {
        readNamespacedCronJob: (args: { name: string; namespace: string }) => Promise<Record<string, unknown>>;
      }).readNamespacedCronJob({ name, namespace });
      const cj = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
      await (k8s.batch as unknown as {
        replaceNamespacedCronJob: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
      }).replaceNamespacedCronJob({
        name, namespace,
        body: { ...cj, spec: { ...cj.spec, suspend: true } },
      });
    }
  }

  // In-flight Jobs (typically CronJob-spawned children, e.g. wp-cron)
  // would otherwise keep their pods alive past our scale-to-0 step and
  // block waitForQuiesced from ever seeing 0 pods. Delete the Job
  // objects with propagation=Background so their pods terminate. These
  // are NOT recorded in QuiesceSnapshot — we don't restore them;
  // CronJobs will re-spawn them after unquiesce.
  const jobList = await (k8s.batch as unknown as {
    listNamespacedJob: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
  }).listNamespacedJob({
    namespace,
    labelSelector: 'platform.io/managed=true',
  });
  for (const j of jobList.items ?? []) {
    if (!j.metadata?.name) continue;
    try {
      await (k8s.batch as unknown as {
        deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
      }).deleteNamespacedJob({
        name: j.metadata.name, namespace, propagationPolicy: 'Background',
      });
    } catch {
      // already gone — ignore
    }
  }

  return { deployments, cronJobs };
}

/**
 * Wait until all pods matching `platform.io/managed=true` have actually
 * terminated. Scale-to-0 returns immediately but pods can take 30+s
 * to drain — proceeding before they're gone would mean the PVC's RWO
 * lock prevents our snapshot Job from mounting.
 *
 * Polls every 2 s, gives up after `timeoutMs` (default 120 s) and
 * throws; orchestrator treats that as a quiesce failure and rolls
 * back. Returns the number of pods remaining if successful (should be 0).
 */
export async function waitForQuiesced(
  k8s: K8sClients,
  namespace: string,
  timeoutMs = 120_000,
): Promise<number> {
  const start = Date.now();
  const listPods = async (): Promise<number> => {
    // Tenant namespaces are single-client dedicated — every non-Job
    // pod here could hold the PVC's RWO lock. The earlier label
    // filter (`platform.io/managed=true`) excluded system sidecars
    // like file-manager, which made waitForQuiesced return 0 even
    // with file-manager still running, triggering a PVC-delete while
    // the mount was still bound. Include ALL non-succeeded,
    // non-completed pods.
    const pods = await k8s.core.listNamespacedPod({ namespace });
    const items = (pods as { items?: Array<{ status?: { phase?: string } }> }).items ?? [];
    // Completed Jobs are a no-op for PVC lock — exclude them so we
    // don't hang forever on finished snapshot/restore Jobs.
    return items.filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed').length;
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const count = await listPods();
    if (count === 0) return 0;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`quiesce: ${count} pod(s) still running after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Restore pre-quiesce replica counts and unsuspend CronJobs.
 *
 * Best-effort on each workload: if a Deployment was deleted between
 * quiesce and unquiesce (e.g. platform removed it as part of the op),
 * we skip silently. We don't want one missing workload to block the
 * other 99 % of the namespace from coming back up.
 */
export async function unquiesce(
  k8s: K8sClients,
  namespace: string,
  snap: QuiesceSnapshot,
): Promise<void> {
  for (const d of snap.deployments) {
    if (d.replicas === 0) continue;
    try {
      const current = await (k8s.apps as unknown as {
        readNamespacedDeploymentScale: (args: { name: string; namespace: string }) => Promise<Record<string, unknown>>;
      }).readNamespacedDeploymentScale({ name: d.name, namespace });
      const scale = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
      await (k8s.apps as unknown as {
        replaceNamespacedDeploymentScale: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
      }).replaceNamespacedDeploymentScale({
        name: d.name, namespace,
        body: { ...scale, spec: { ...scale.spec, replicas: d.replicas } },
      });
    } catch { /* gone — ignore */ }
  }
  for (const cj of snap.cronJobs) {
    if (cj.wasSuspended) continue;
    try {
      const current = await (k8s.batch as unknown as {
        readNamespacedCronJob: (args: { name: string; namespace: string }) => Promise<Record<string, unknown>>;
      }).readNamespacedCronJob({ name: cj.name, namespace });
      const obj = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
      await (k8s.batch as unknown as {
        replaceNamespacedCronJob: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
      }).replaceNamespacedCronJob({
        name: cj.name, namespace,
        body: { ...obj, spec: { ...obj.spec, suspend: false } },
      });
    } catch { /* gone — ignore */ }
  }
}
