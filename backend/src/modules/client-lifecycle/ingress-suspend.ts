import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Ingress suspend / resume — swap tenant Ingress backends to the
 * cluster-wide `platform-suspended` static service while a client is
 * suspended, then swap back on resume.
 *
 * Design:
 *   - We DON'T delete the Ingress object: keeping it preserves the
 *     cert-manager Certificate + DNS-bound ADDRESS and avoids a
 *     cert-reissue storm on resume.
 *   - We annotate the original backend into
 *     `platform.io/suspended-original-backends` as a JSON snapshot,
 *     then rewrite every `spec.rules[].http.paths[].backend.service`
 *     to point at `platform-suspended:80` in the `platform` namespace.
 *     NGINX's ExternalName workaround (`nginx.ingress.kubernetes.io/
 *     upstream-vhost`) handles the cross-namespace lookup.
 *
 * Idempotent: calling suspend on an already-suspended ingress is a
 * no-op; same for resume on an active one.
 */

const SUSPENDED_BACKENDS_ANNOTATION = 'platform.io/suspended-original-backends';
const SUSPENDED_MARKER_ANNOTATION = 'platform.io/suspended';
// Platform-wide suspended URL. The `platform-suspended` Deployment +
// Service + Ingress in the platform namespace host this page. Every
// tenant ingress gets `permanent-redirect: <this URL>` on suspend so
// visitors land on the centralized suspension page without needing a
// per-tenant backend Service.
const SUSPENDED_REDIRECT_URL_ENV = 'SUSPENDED_REDIRECT_URL';
const SUSPENDED_REDIRECT_URL_DEFAULT = 'https://suspended.platform.local/';

type IngressSpec = {
  readonly metadata?: {
    readonly name?: string;
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: {
    readonly rules?: Array<{
      readonly host?: string;
      readonly http?: {
        readonly paths?: Array<{
          readonly path?: string;
          readonly pathType?: string;
          readonly backend?: {
            readonly service?: {
              readonly name: string;
              readonly port?: { number?: number; name?: string };
            };
          };
        }>;
      };
    }>;
  };
};

interface NetworkingV1Api {
  listNamespacedIngress: (args: { namespace: string }) => Promise<{ items?: IngressSpec[] }>;
  readNamespacedIngress: (args: { name: string; namespace: string }) => Promise<IngressSpec>;
  replaceNamespacedIngress: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
}

/**
 * Read-modify-replace with retry-on-409. k8s uses optimistic concurrency
 * via `metadata.resourceVersion`; if two callers race (e.g. the admin
 * API and the expiry-checker cron both triggering applySuspended for
 * the same client), the second `replaceNamespacedIngress` returns 409.
 * Re-read and retry — the winner's annotations are preserved and the
 * loser just becomes a no-op iteration.
 */
async function readModifyReplaceIngress(
  networking: NetworkingV1Api,
  namespace: string,
  name: string,
  mutate: (current: IngressSpec) => IngressSpec,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = await networking.readNamespacedIngress({ name, namespace });
    const updated = mutate(current);
    try {
      await networking.replaceNamespacedIngress({ name, namespace, body: updated });
      return;
    } catch (err) {
      const status = (err as { statusCode?: number; code?: number; body?: { code?: number } }).statusCode
        ?? (err as { code?: number }).code
        ?? (err as { body?: { code?: number } }).body?.code;
      const isConflict = status === 409
        || String((err as Error).message ?? '').includes('HTTP-Code: 409')
        || String((err as Error).message ?? '').includes('"code":409');
      if (!isConflict || attempt === MAX_ATTEMPTS) throw err;
      console.warn(`[ingress-suspend] 409 conflict on ${namespace}/${name}, retry ${attempt}/${MAX_ATTEMPTS}`);
    }
  }
}

/**
 * Safely parse the `platform.io/suspended-original-backends` annotation.
 * Tolerates version skew: if the shape drifts across code versions the
 * parser returns `{null, null}` — same as "no pre-suspend state", which
 * is a safe default for resume (we just strip the suspend annotations
 * without restoring any operator-managed redirect).
 */
function parseSuspendedSnapshot(raw: string | undefined): { permanentRedirect: string | null; permanentRedirectCode: string | null } {
  if (!raw) return { permanentRedirect: null, permanentRedirectCode: null };
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object') return { permanentRedirect: null, permanentRedirectCode: null };
    const o = obj as Record<string, unknown>;
    const pr = o.permanentRedirect;
    const prc = o.permanentRedirectCode;
    return {
      permanentRedirect: typeof pr === 'string' ? pr : null,
      permanentRedirectCode: typeof prc === 'string' ? prc : null,
    };
  } catch {
    return { permanentRedirect: null, permanentRedirectCode: null };
  }
}


/**
 * Swap every tenant Ingress backend to `platform/platform-suspended:80`.
 * Stores the pre-suspend backend in an annotation so resume can restore.
 */
export async function suspendNamespaceIngresses(
  k8s: K8sClients,
  namespace: string,
): Promise<{ suspended: string[] }> {
  const redirectUrl = process.env[SUSPENDED_REDIRECT_URL_ENV] ?? SUSPENDED_REDIRECT_URL_DEFAULT;

  const networking = k8s.networking as unknown as NetworkingV1Api;
  const list = await networking.listNamespacedIngress({ namespace });
  const suspended: string[] = [];

  for (const ing of list.items ?? []) {
    const name = ing.metadata?.name;
    if (!name) continue;
    const annotations = ing.metadata?.annotations ?? {};
    if (annotations[SUSPENDED_MARKER_ANNOTATION] === 'true') {
      // Already suspended — skip.
      suspended.push(name);
      continue;
    }

    // Snapshot the annotation state so resume can remove exactly what
    // we added without stomping operator-managed annotations.
    const snapshot = {
      permanentRedirect: annotations['nginx.ingress.kubernetes.io/permanent-redirect'] ?? null,
      permanentRedirectCode: annotations['nginx.ingress.kubernetes.io/permanent-redirect-code'] ?? null,
    };

    // Read-modify-replace with retry-on-409. The `permanent-redirect`
    // annotation sends a 307 before any upstream is contacted, which
    // means we don't need a per-namespace Service — the existing
    // tenant backends stay exactly where they are, ready for resume.
    await readModifyReplaceIngress(networking, namespace, name, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        annotations: {
          ...(current.metadata?.annotations ?? {}),
          [SUSPENDED_MARKER_ANNOTATION]: 'true',
          [SUSPENDED_BACKENDS_ANNOTATION]: JSON.stringify(snapshot),
          'nginx.ingress.kubernetes.io/permanent-redirect': redirectUrl,
          'nginx.ingress.kubernetes.io/permanent-redirect-code': '307',
        },
      },
    }));
    suspended.push(name);
  }

  return { suspended };
}

/**
 * Reverse the suspend. Reads `platform.io/suspended-original-backends`
 * and restores each rule's backend. Removes the marker annotations on
 * success. If the annotation is missing we skip — the ingress was
 * likely never suspended.
 */
export async function resumeNamespaceIngresses(
  k8s: K8sClients,
  namespace: string,
): Promise<{ resumed: string[] }> {
  const networking = k8s.networking as unknown as NetworkingV1Api;
  const list = await networking.listNamespacedIngress({ namespace });
  const resumed: string[] = [];

  for (const ing of list.items ?? []) {
    const name = ing.metadata?.name;
    if (!name) continue;
    const annotations = ing.metadata?.annotations ?? {};
    if (annotations[SUSPENDED_MARKER_ANNOTATION] !== 'true') continue;

    // Parse the pre-suspend annotation snapshot with shape validation;
    // malformed / version-skewed data becomes a safe "no restore" default.
    const snapshot = parseSuspendedSnapshot(annotations[SUSPENDED_BACKENDS_ANNOTATION]);

    await readModifyReplaceIngress(networking, namespace, name, (current) => {
      const nextAnnotations: Record<string, string> = { ...(current.metadata?.annotations ?? {}) };
      delete nextAnnotations[SUSPENDED_MARKER_ANNOTATION];
      delete nextAnnotations[SUSPENDED_BACKENDS_ANNOTATION];
      // Also nuke the legacy service-upstream annotation the older
      // ExternalName-based suspend path left behind.
      delete nextAnnotations['nginx.ingress.kubernetes.io/service-upstream'];
      if (snapshot.permanentRedirect === null) {
        delete nextAnnotations['nginx.ingress.kubernetes.io/permanent-redirect'];
      } else {
        nextAnnotations['nginx.ingress.kubernetes.io/permanent-redirect'] = snapshot.permanentRedirect;
      }
      if (snapshot.permanentRedirectCode === null) {
        delete nextAnnotations['nginx.ingress.kubernetes.io/permanent-redirect-code'];
      } else {
        nextAnnotations['nginx.ingress.kubernetes.io/permanent-redirect-code'] = snapshot.permanentRedirectCode;
      }
      return {
        ...current,
        metadata: { ...current.metadata, annotations: nextAnnotations },
      };
    });
    resumed.push(name);
  }

  return { resumed };
}

/**
 * Is any ingress in this namespace currently suspended? Used by the
 * ingress reconciler to skip tenant namespaces during their suspend
 * window so it doesn't accidentally reset the swap.
 */
export async function isNamespaceIngressSuspended(
  k8s: K8sClients,
  namespace: string,
): Promise<boolean> {
  const networking = k8s.networking as unknown as NetworkingV1Api;
  const list = await networking.listNamespacedIngress({ namespace });
  return (list.items ?? []).some(
    (ing) => ing.metadata?.annotations?.[SUSPENDED_MARKER_ANNOTATION] === 'true',
  );
}
