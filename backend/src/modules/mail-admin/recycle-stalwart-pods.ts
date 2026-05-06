/**
 * Stalwart pod recycler — used by the admin password rotation flow to
 * force kubelet to recreate Stalwart pods with the freshly-patched
 * `stalwart-admin-creds` Secret value baked into env.
 *
 * BACKGROUND: Stalwart's `STALWART_RECOVERY_ADMIN` env var is sourced
 * via `valueFrom.secretKeyRef`. K8s resolves this at pod CREATE time —
 * changing the Secret afterward does NOT update the env of the running
 * process. Stakater Reloader normally rolls the Deployment when the
 * Secret changes, but the rollout is async and can lag (or fail
 * entirely if pods crash on startup). When the rotation flow's verify
 * step probes the rotated password against pods that still hold the
 * OLD env, every probe 401s → Stalwart's auth-attempt-rate-limit fills
 * with `BlockedIp` entries → operator iframe logins get silently
 * dropped.
 *
 * This module is the explicit "force the pods to be replaced now"
 * path. We delete each Stalwart pod with a 15s grace period and rely
 * on the existing Deployment's RS to recreate them. The rotation
 * flow's verify-loop (120s ceiling) then probes the FRESH pods.
 *
 * The grace period matters: Stalwart's `terminationGracePeriodSeconds`
 * is 90s in the manifest (in-flight SMTP/IMAP sessions get a chance
 * to finish), but we only need to wait long enough for the new RS
 * pod to begin spinning up. 15s is empirically sufficient — kubelet
 * starts pulling the (cached) image immediately.
 */

import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'mail-admin-recycle-pods' });

export interface RecycleStalwartPodsOptions {
  readonly kubeconfigPath: string | undefined;
  readonly namespace: string;
  readonly labelSelector: string;
  readonly gracePeriodSeconds: number;
}

export interface RecycleStalwartPodsResult {
  readonly deletedCount: number;
  readonly deletedNames: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Delete every pod matching the label selector in the given namespace.
 * Best-effort: per-pod delete failures are accumulated into `errors`
 * but do not abort the loop. The caller (rotate-jmap.ts) treats any
 * non-empty errors as a logged warning, not a rotation failure.
 */
export async function recycleStalwartPods(
  opts: RecycleStalwartPodsOptions,
): Promise<RecycleStalwartPodsResult> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) kc.loadFromFile(opts.kubeconfigPath);
  else kc.loadFromCluster();
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const list = await core.listNamespacedPod({
    namespace: opts.namespace,
    labelSelector: opts.labelSelector,
  });
  const pods = list.items ?? [];

  if (pods.length === 0) {
    log.info({ namespace: opts.namespace, labelSelector: opts.labelSelector },
      'no Stalwart pods to recycle (Deployment may be scaled to 0 or just-created)');
    return { deletedCount: 0, deletedNames: [], errors: [] };
  }

  const deletedNames: string[] = [];
  const errors: string[] = [];

  for (const pod of pods) {
    const name = pod.metadata?.name;
    if (!name) continue;
    try {
      await core.deleteNamespacedPod({
        namespace: opts.namespace,
        name,
        gracePeriodSeconds: opts.gracePeriodSeconds,
      });
      deletedNames.push(name);
    } catch (err) {
      // Best-effort: accumulate errors and continue. A single pod-delete
      // failure shouldn't block the others — kubelet will eventually GC
      // them via Reloader's rollout even if our explicit delete fails.
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      log.warn({ name, namespace: opts.namespace, err: msg },
        'delete pod failed (non-fatal — continuing with remaining pods)');
    }
  }

  log.info({
    namespace: opts.namespace,
    labelSelector: opts.labelSelector,
    deletedCount: deletedNames.length,
    failedCount: errors.length,
  }, 'recycled Stalwart pods');

  return {
    deletedCount: deletedNames.length,
    deletedNames,
    errors,
  };
}
