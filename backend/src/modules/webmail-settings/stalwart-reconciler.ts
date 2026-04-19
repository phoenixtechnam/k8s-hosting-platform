/**
 * Propagate a mail-server hostname change from the admin panel into the
 * running Stalwart StatefulSet.
 *
 * Stalwart reads `STALWART_HOSTNAME` from the `stalwart-secrets` Secret at
 * pod startup (via `%{env:STALWART_HOSTNAME}%` in config.toml). Changing the
 * value in the database alone is not enough — we must also patch the Secret
 * and restart the pod so the new hostname appears in SMTP/IMAP banners.
 *
 * The shape mirrors `mail-admin/rotate.ts`: the same JSON-patch idiom for
 * Secret updates + rollout-restart annotation on the StatefulSet. Kept small
 * and dependency-injectable so unit tests don't need a live cluster.
 */

import * as k8s from '@kubernetes/client-node';

export interface StalwartHostnameReconcileOptions {
  readonly kubeconfigPath?: string;
  readonly namespace?: string;
  readonly secretName?: string;
  readonly statefulSetName?: string;
}

export interface StalwartHostnameReconcileDeps {
  readSecretHostname(req: { namespace: string; name: string }): Promise<string | null>;
  patchSecret(req: { namespace: string; name: string; stringData: Record<string, string> }): Promise<void>;
  restartStatefulSet(req: { namespace: string; name: string }): Promise<void>;
}

const DEFAULT_OPTS: Required<Omit<StalwartHostnameReconcileOptions, 'kubeconfigPath'>> = {
  namespace: 'mail',
  secretName: 'stalwart-secrets',
  statefulSetName: 'stalwart-mail',
};

/**
 * If `newHostname` differs from what the Secret currently holds, patch the
 * Secret and rollout-restart the StatefulSet. Returns `true` if a restart
 * was triggered, `false` if the value was already current.
 */
export async function reconcileStalwartHostname(
  newHostname: string,
  opts: StalwartHostnameReconcileOptions = {},
  deps?: StalwartHostnameReconcileDeps,
): Promise<boolean> {
  const resolved = { ...DEFAULT_OPTS, ...opts };
  const d = deps ?? defaultDeps(opts.kubeconfigPath);

  const current = await d.readSecretHostname({ namespace: resolved.namespace, name: resolved.secretName });
  if (current === newHostname) return false;

  await d.patchSecret({
    namespace: resolved.namespace,
    name: resolved.secretName,
    stringData: { STALWART_HOSTNAME: newHostname },
  });
  await d.restartStatefulSet({
    namespace: resolved.namespace,
    name: resolved.statefulSetName,
  });
  return true;
}

function defaultDeps(kubeconfigPath: string | undefined): StalwartHostnameReconcileDeps {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);

  return {
    readSecretHostname: async ({ namespace, name }) => {
      try {
        const res = await core.readNamespacedSecret({ namespace, name });
        const b64 = res.data?.STALWART_HOSTNAME;
        return b64 ? Buffer.from(b64, 'base64').toString('utf8') : null;
      } catch (err: unknown) {
        // Missing secret = can't reconcile; caller decides what to do.
        if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return null;
        throw err;
      }
    },
    patchSecret: async ({ namespace, name, stringData }) => {
      // `add` works whether the key exists or not (JSON Patch semantics).
      // `replace` would 422 on a fresh secret missing the key.
      const ops = Object.entries(stringData).map(([k, v]) => ({
        op: 'add' as const,
        path: `/data/${k}`,
        value: Buffer.from(v, 'utf8').toString('base64'),
      }));
      await core.patchNamespacedSecret({ namespace, name, body: ops as unknown as object });
    },
    restartStatefulSet: async ({ namespace, name }) => {
      const now = new Date().toISOString();
      const body = [
        { op: 'add', path: '/spec/template/metadata/annotations', value: {} },
        { op: 'add', path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt', value: now },
      ];
      await apps.patchNamespacedStatefulSet({ namespace, name, body: body as unknown as object });
    },
  };
}
