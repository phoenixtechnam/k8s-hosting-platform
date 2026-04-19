/**
 * Reconcile `platform-ingress` host rules from the admin/client panel URLs
 * configured in System Settings.
 *
 * The DB is the single source of truth. On startup and on every write to
 * admin_panel_url / client_panel_url, this reconciler rebuilds the Ingress's
 * spec.rules and spec.tls from the URLs' hostnames using a server-side apply
 * with fieldManager: platform-api, so subsequent `kubectl apply -k` runs
 * from kustomize can't overwrite the host list.
 *
 * Kustomize overlays no longer hardcode rules/tls — they only set class +
 * annotations. The initial spec comes entirely from this reconciler after
 * seed populates the URLs.
 */

import * as k8s from '@kubernetes/client-node';

// ─── Public types ────────────────────────────────────────────────────────

export interface IngressReconcileInput {
  readonly adminPanelUrl: string | null;
  readonly clientPanelUrl: string | null;
  readonly tlsSecretName: string;
}

export interface IngressReconcileResult {
  readonly changed: boolean;
}

export interface IngressCurrentSpec {
  readonly rules: ReadonlyArray<{ readonly host: string; readonly serviceName: string }>;
  readonly tlsHosts: ReadonlyArray<string>;
  readonly tlsSecret: string | null;
}

export interface IngressReconcileDeps {
  readCurrent(): Promise<IngressCurrentSpec | null>;
  serverSideApply(body: Record<string, unknown>): Promise<void>;
}

export interface IngressReconcileOptions {
  readonly kubeconfigPath?: string;
  readonly namespace?: string;
  readonly ingressName?: string;
  readonly ingressClassName?: string;
  readonly clusterIssuerName?: string;
}

const DEFAULTS = {
  namespace: 'platform',
  ingressName: 'platform-ingress',
  ingressClassName: 'nginx',
  fieldManager: 'platform-api',
};

const PANEL_SERVICES: Record<'admin' | 'client', string> = {
  admin: 'admin-panel',
  client: 'client-panel',
};

// ─── Pure helpers (exported for testability) ─────────────────────────────

/**
 * Extract a bare hostname from a URL string. Returns null for empty,
 * malformed, or unparseable input — caller must treat null as "skip this
 * rule", never as "omit the host field" in the Ingress spec.
 */
export function extractHost(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

// ─── Core reconciler ─────────────────────────────────────────────────────

export async function reconcileIngressHosts(
  input: IngressReconcileInput,
  deps?: IngressReconcileDeps,
  opts: IngressReconcileOptions = {},
): Promise<IngressReconcileResult> {
  const d = deps ?? defaultDeps(opts);

  const adminHost = extractHost(input.adminPanelUrl);
  const clientHost = extractHost(input.clientPanelUrl);

  // Never render an empty Ingress — without rules, k8s serves no traffic at
  // all. If we have nothing to work with, leave whatever is currently applied.
  if (!adminHost && !clientHost) {
    return { changed: false };
  }

  const desiredRules: Array<{ host: string; serviceName: string }> = [];
  if (adminHost) desiredRules.push({ host: adminHost, serviceName: PANEL_SERVICES.admin });
  if (clientHost) desiredRules.push({ host: clientHost, serviceName: PANEL_SERVICES.client });

  const current = await d.readCurrent();
  if (current) {
    const same =
      current.rules.length === desiredRules.length &&
      current.rules.every((r, i) => r.host === desiredRules[i].host && r.serviceName === desiredRules[i].serviceName) &&
      current.tlsSecret === input.tlsSecretName &&
      current.tlsHosts.length === desiredRules.length &&
      current.tlsHosts.every((h, i) => h === desiredRules[i].host);
    if (same) return { changed: false };
  }

  const ingressName = opts.ingressName ?? DEFAULTS.ingressName;
  const namespace = opts.namespace ?? DEFAULTS.namespace;
  const ingressClassName = opts.ingressClassName ?? DEFAULTS.ingressClassName;

  const body: Record<string, unknown> = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: ingressName,
      namespace,
      ...(opts.clusterIssuerName
        ? { annotations: { 'cert-manager.io/cluster-issuer': opts.clusterIssuerName } }
        : {}),
    },
    spec: {
      ingressClassName,
      rules: desiredRules.map(({ host, serviceName }) => ({
        host,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: { service: { name: serviceName, port: { number: 80 } } },
          }],
        },
      })),
      tls: [{
        hosts: desiredRules.map((r) => r.host),
        secretName: input.tlsSecretName,
      }],
    },
  };

  await d.serverSideApply(body);
  return { changed: true };
}

// ─── Default k8s-backed deps ─────────────────────────────────────────────

function defaultDeps(opts: IngressReconcileOptions): IngressReconcileDeps {
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) kc.loadFromFile(opts.kubeconfigPath);
  else kc.loadFromCluster();
  const networking = kc.makeApiClient(k8s.NetworkingV1Api);
  const namespace = opts.namespace ?? DEFAULTS.namespace;
  const ingressName = opts.ingressName ?? DEFAULTS.ingressName;

  return {
    readCurrent: async () => {
      try {
        const res = await networking.readNamespacedIngress({ namespace, name: ingressName });
        const rules = (res.spec?.rules ?? []).map((r) => ({
          host: r.host ?? '',
          serviceName: r.http?.paths?.[0]?.backend?.service?.name ?? '',
        }));
        const tls = res.spec?.tls?.[0];
        return {
          rules,
          tlsHosts: tls?.hosts ?? [],
          tlsSecret: tls?.secretName ?? null,
        };
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return null;
        throw err;
      }
    },
    serverSideApply: async (body) => {
      // Read-modify-replace: fetch the live Ingress, overlay our desired
      // rules/tls on top of it, then PUT it back. Server-Side Apply with
      // apply-patch content-type was the original design, but
      // @kubernetes/client-node v1.x doesn't set the content-type correctly
      // on either NetworkingV1Api.patchNamespacedIngress or
      // KubernetesObjectApi.patch (both send application/merge-patch+json
      // which rejects the `force` option). The kustomize overlay doesn't
      // set spec.rules or spec.tls anymore, so a full replace from the
      // reconciler doesn't conflict with anyone else's field ownership.
      const bodySpec = (body as { spec: Record<string, unknown> }).spec;
      let existing;
      try {
        existing = await networking.readNamespacedIngress({ namespace, name: ingressName });
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('HTTP-Code: 404')) {
          // Ingress doesn't exist — create it from scratch
          await networking.createNamespacedIngress({
            namespace,
            body: body as unknown as Parameters<typeof networking.createNamespacedIngress>[0]['body'],
          });
          return;
        }
        throw err;
      }
      // Clear the defaultBackend placeholder now that we have real rules.
      const mergedSpec = {
        ...existing.spec,
        rules: bodySpec.rules,
        tls: bodySpec.tls,
      };
      delete (mergedSpec as { defaultBackend?: unknown }).defaultBackend;
      const replaceBody = {
        ...existing,
        spec: mergedSpec,
      };
      await networking.replaceNamespacedIngress({
        namespace,
        name: ingressName,
        body: replaceBody as unknown as Parameters<typeof networking.replaceNamespacedIngress>[0]['body'],
      });
    },
  };
}
