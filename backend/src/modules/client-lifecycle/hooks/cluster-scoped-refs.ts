import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';
import { isHookAuthoritative } from '../registry/feature-flags.js';

/**
 * cluster-scoped-refs-cleanup hook.
 *
 * Deletes cluster-scoped K8s objects that reference the deleted
 * tenant namespace by name — the kube-apiserver namespace cascade
 * only reaps NAMESPACED resources, so anything cluster-scoped that
 * names the tenant ns survives indefinitely.
 *
 * Concrete targets:
 *   - ClusterRoleBindings whose subjects[*].namespace == ns
 *     (SFTP gateway pattern: per-tenant SA needs a CRB for
 *      per-namespace impersonation)
 *   - NetworkPolicies in OTHER namespaces whose
 *     spec.{ingress,egress}[*].from[*].namespaceSelector matches ns
 *     (cross-namespace allow-rules)
 *
 * NOT targeted (out of scope for this hook):
 *   - PromRules / ServiceMonitors — admin-curated, low volume,
 *     operator handles cleanup manually if needed
 *   - PriorityClasses — shared infra
 *   - Cluster-scoped CRDs that may reference the namespace
 *     (Longhorn volume CRs are handled by pv-cleanup-released)
 *
 * Ordering / blocking:
 *   - order=500 — after dns-zone-cleanup (400) and tenant-bundles-bundle-
 *     cleanup (410). These cluster-scoped removals are typically
 *     fast (one LIST + N DELETEs).
 *   - blocking=continue — a cluster-scoped leftover doesn't block the
 *     delete; the orphan-volumes scanner pattern (manual surfacing
 *     in admin UI) is the safety net.
 */

interface ClusterRoleBindingLite {
  readonly metadata?: { readonly name?: string };
  readonly subjects?: ReadonlyArray<{ readonly namespace?: string; readonly kind?: string }>;
}

interface NetworkPolicyLite {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly spec?: {
    readonly ingress?: ReadonlyArray<{ readonly from?: ReadonlyArray<{ readonly namespaceSelector?: { readonly matchLabels?: Record<string, string> } }> }>;
    readonly egress?: ReadonlyArray<{ readonly to?: ReadonlyArray<{ readonly namespaceSelector?: { readonly matchLabels?: Record<string, string> } }> }>;
  };
}

const HOOK_NAME = 'cluster-scoped-refs-cleanup';

async function listClusterRoleBindingsForNamespace(
  ctx: HookCtx,
): Promise<readonly string[]> {
  try {
    const resp = await ctx.k8s.custom.listClusterCustomObject({
      group: 'rbac.authorization.k8s.io',
      version: 'v1',
      plural: 'clusterrolebindings',
    } as unknown as Parameters<typeof ctx.k8s.custom.listClusterCustomObject>[0]) as { items?: readonly ClusterRoleBindingLite[] };
    const out: string[] = [];
    for (const crb of resp.items ?? []) {
      const name = crb.metadata?.name;
      if (!name) continue;
      const usesNs = (crb.subjects ?? []).some((s) => s.namespace === ctx.namespace);
      if (usesNs) out.push(name);
    }
    return out;
  } catch (err) {
    // Distinguish RBAC failures (operator must add list permission)
    // from transient errors (timeouts retry on the next tick). Empty
    // return on transient is fine; on 401/403 we MUST throw so the
    // hook surfaces a retry envelope rather than silently leaking
    // the orphan refs forever.
    const status = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (status === 401 || status === 403) throw err;
    return [];
  }
}

async function listNetworkPoliciesReferencingNamespace(
  ctx: HookCtx,
): Promise<ReadonlyArray<{ ns: string; name: string }>> {
  try {
    const resp = await ctx.k8s.custom.listClusterCustomObject({
      group: 'networking.k8s.io',
      version: 'v1',
      plural: 'networkpolicies',
    } as unknown as Parameters<typeof ctx.k8s.custom.listClusterCustomObject>[0]) as { items?: readonly NetworkPolicyLite[] };
    const out: Array<{ ns: string; name: string }> = [];
    for (const np of resp.items ?? []) {
      const name = np.metadata?.name;
      const ns = np.metadata?.namespace;
      if (!name || !ns || ns === ctx.namespace) continue; // only OTHER ns
      // Convention: namespaceSelector.matchLabels.['kubernetes.io/metadata.name'] == ctx.namespace
      const refs = [
        ...(np.spec?.ingress ?? []).flatMap((r) => r.from ?? []),
        ...(np.spec?.egress ?? []).flatMap((r) => r.to ?? []),
      ];
      const hits = refs.some((r) =>
        r.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === ctx.namespace,
      );
      if (hits) out.push({ ns, name });
    }
    return out;
  } catch (err) {
    const status = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (status === 401 || status === 403) throw err;
    return [];
  }
}

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition !== 'deleted') {
    return { status: 'noop', detail: 'only runs on deleted' };
  }
  if (!isHookAuthoritative(HOOK_NAME)) {
    return { status: 'noop', detail: 'hook disabled by feature flag' };
  }
  if (!ctx.namespace || !ctx.namespace.startsWith('client-')) {
    return { status: 'noop', detail: 'namespace is not a tenant namespace' };
  }

  const failures: string[] = [];
  let deleted = 0;

  let crbs: readonly string[] = [];
  try {
    crbs = await listClusterRoleBindingsForNamespace(ctx);
  } catch (err) {
    return {
      status: 'retry',
      detail: 'lacks LIST clusterrolebindings permission',
      envelope: {
        title: 'Cluster-scoped refs cleanup blocked',
        detail: err instanceof Error ? err.message : String(err),
        remediation: [
          "Grant the platform-api ServiceAccount 'list' on rbac.authorization.k8s.io/clusterrolebindings",
          'Then retry the hook from the lifecycle Settings page',
        ],
        raw: err instanceof Error ? err.stack ?? err.message : String(err),
      },
    };
  }
  for (const name of crbs) {
    try {
      await ctx.k8s.custom.deleteClusterCustomObject({
        group: 'rbac.authorization.k8s.io',
        version: 'v1',
        plural: 'clusterrolebindings',
        name,
      } as unknown as Parameters<typeof ctx.k8s.custom.deleteClusterCustomObject>[0]);
      deleted++;
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) failures.push(`crb/${name}: ${(err as Error).message}`);
    }
  }

  let nps: ReadonlyArray<{ ns: string; name: string }> = [];
  try {
    nps = await listNetworkPoliciesReferencingNamespace(ctx);
  } catch (err) {
    return {
      status: 'retry',
      detail: 'lacks LIST networkpolicies permission',
      envelope: {
        title: 'Cluster-scoped refs cleanup blocked',
        detail: err instanceof Error ? err.message : String(err),
        remediation: [
          "Grant the platform-api ServiceAccount 'list' on networking.k8s.io/networkpolicies cluster-wide",
          'Then retry the hook from the lifecycle Settings page',
        ],
        raw: err instanceof Error ? err.stack ?? err.message : String(err),
      },
    };
  }
  for (const np of nps) {
    try {
      await ctx.k8s.custom.deleteNamespacedCustomObject({
        group: 'networking.k8s.io',
        version: 'v1',
        namespace: np.ns,
        plural: 'networkpolicies',
        name: np.name,
      } as unknown as Parameters<typeof ctx.k8s.custom.deleteNamespacedCustomObject>[0]);
      deleted++;
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) failures.push(`netpol/${np.ns}/${np.name}: ${(err as Error).message}`);
    }
  }

  if (deleted === 0 && failures.length === 0) {
    return { status: 'noop', detail: 'no cluster-scoped refs touched this namespace' };
  }
  if (failures.length > 0) {
    return {
      status: 'retry',
      detail: `${deleted} deleted; ${failures.length} failure(s)`,
      envelope: {
        title: 'Cluster-scoped refs cleanup partial',
        detail: `${failures.length} cluster-scoped object(s) failed to delete`,
        remediation: [
          'Check kube-apiserver permissions for the platform-api SA',
          'Manually inspect: kubectl get clusterrolebinding,networkpolicy -A | grep <ns>',
        ],
        raw: failures.join('\n'),
      },
    };
  }
  return { status: 'ok', detail: `deleted ${deleted} cluster-scoped ref(s)` };
}

export const clusterScopedRefsCleanupHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['deleted'],
  order: 500,
  blocking: 'continue',
  maxAttempts: 3,
  after: ['dns-zone-cleanup', 'tenant-bundles-bundle-cleanup'],
  run: runImpl,
};

let _registered = false;
export function registerClusterScopedRefsCleanupHook(): void {
  if (_registered) return;
  registerLifecycleHook(clusterScopedRefsCleanupHook);
  _registered = true;
}
