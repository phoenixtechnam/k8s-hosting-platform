/**
 * Patch content-type middleware shims for `@kubernetes/client-node` v1.x.
 *
 * Why this exists
 * ───────────────
 * v1.4 generates one PATCH method per resource that picks its content-type
 * from the OpenAPI `consumes` list:
 *   ["application/json-patch+json",
 *    "application/merge-patch+json",
 *    "application/strategic-merge-patch+json",
 *    "application/apply-patch+yaml",
 *    "application/apply-patch+cbor"]
 *
 * `ObjectSerializer.getPreferredMediaType` always picks the FIRST entry, so
 * the default Content-Type is `application/json-patch+json` (RFC 6902 op
 * array). Any caller passing a merge-object body (`{ data: {...} }`,
 * `{ spec: {...} }`, etc.) without overriding the header gets
 *   error decoding patch: json: cannot unmarshal object into
 *   Go value of type []handlers.jsonPatchOp
 *
 * The v1 SDK exposes a middleware hook on the second positional arg of every
 * API method; pre()/post() must return an Observable-like stub. We wrap a
 * synchronous header override in that shape so callers can write:
 *
 *   await core.patchNamespacedSecret({ namespace, name, body }, MERGE_PATCH);
 *
 * Use one of:
 *   • MERGE_PATCH            — RFC 7396 merge object (null deletes, object replaces).
 *                              Preferred for arbitrary field updates.
 *   • STRATEGIC_MERGE_PATCH  — Strategic merge for k8s built-in types (Deployment
 *                              annotations, PVC labels, pod-spec list merging by key).
 *                              CRDs do NOT support strategic-merge — use MERGE_PATCH.
 *   • JSON_PATCH             — RFC 6902 op array. Use when you need
 *                              `add`/`replace`/`remove`/`test` semantics
 *                              (e.g. annotation key-by-key edits).
 *
 * One of these MUST accompany every patchNamespaced* / patchClusterCustomObject
 * call in this codebase. `scripts/ci-k8s-patch-check.sh` enforces this.
 */

import type { ConfigurationOptions } from '@kubernetes/client-node';

type RequestContextLike = {
  setHeaderParam(name: string, value: string): void;
};

/**
 * Observable-like stub that satisfies the SDK's `Observable<T>` structural
 * type without pulling rxjs as a direct dependency. The SDK's Observable
 * has a private `promise` field; we expose it as a public property so
 * structural-type checks see it. The SDK only ever calls `toPromise()` /
 * `pipe()` from this codebase's perspective, but the field has to be
 * present for the type checker to accept our shape.
 */
type ObservableLike<T> = {
  promise: Promise<T>;
  toPromise(): Promise<T>;
  pipe(): undefined;
};

type Middleware = {
  pre(ctx: RequestContextLike): ObservableLike<RequestContextLike>;
  post(ctx: RequestContextLike): ObservableLike<RequestContextLike>;
};

export type ContentTypeOverride = { middleware: Middleware[] };

/**
 * Tagged override exposes the chosen Content-Type as a runtime breadcrumb so
 * tests can introspect the override and the CI guard can grep for it.
 */
export type TaggedContentTypeOverride = ContentTypeOverride & {
  readonly _expectedContentType: string;
};

/**
 * Build a middleware override that pins the outgoing Content-Type.
 *
 * Exported for unit-testing — production callers use the
 * `MERGE_PATCH` / `STRATEGIC_MERGE_PATCH` / `JSON_PATCH` constants.
 */
export function buildContentTypeOverride(contentType: string): ContentTypeOverride {
  const stub = (ctx: RequestContextLike): ObservableLike<RequestContextLike> => {
    const promise = Promise.resolve(ctx);
    return { promise, toPromise: () => promise, pipe: () => undefined };
  };
  const mw: Middleware = {
    pre: (ctx) => {
      ctx.setHeaderParam('Content-Type', contentType);
      return stub(ctx);
    },
    post: stub,
  };
  return { middleware: [mw] };
}

function withTag(override: ContentTypeOverride, tag: string): TaggedContentTypeOverride {
  return Object.assign(override, { _expectedContentType: tag });
}

// Single boundary cast: SDK's `ConfigurationOptions.middleware` is typed
// against the SDK's internal Middleware (with `RequestContext` instead of our
// duck-typed `RequestContextLike`). Our shape is structurally compatible at
// runtime — duck-typing satisfies `setHeaderParam` — but TypeScript can't
// narrow `RequestContextLike` to `RequestContext`. The cast is confined to
// these three exports so call sites remain type-safe.
type SDKOverride = TaggedContentTypeOverride & ConfigurationOptions;

export const STRATEGIC_MERGE_PATCH = withTag(
  buildContentTypeOverride('application/strategic-merge-patch+json'),
  'application/strategic-merge-patch+json',
) as unknown as SDKOverride;

export const MERGE_PATCH = withTag(
  buildContentTypeOverride('application/merge-patch+json'),
  'application/merge-patch+json',
) as unknown as SDKOverride;

export const JSON_PATCH = withTag(
  buildContentTypeOverride('application/json-patch+json'),
  'application/json-patch+json',
) as unknown as SDKOverride;

/**
 * Server-Side Apply patch — `application/apply-patch+yaml`.
 *
 * Use this (NOT JSON_PATCH / MERGE_PATCH) when patching a Flux-managed
 * resource AND you want the operator's claim on the field to coexist
 * with Flux's manifest. With this content-type, the apiserver records
 * the request's `fieldManager` as a co-owner of the mutated fields,
 * so a subsequent Flux reconcile with `kustomize.toolkit.fluxcd.io/ssa:
 * merge` (non-force apply) will preserve those fields instead of
 * reverting them to the manifest.
 *
 * Body shape: a *partial* object containing only the fields you want
 * to own (e.g. `{ spec: { template: { spec: { nodeSelector: {...} } } } }`).
 * Apply-patch is declarative — anything you omit is NOT cleared from
 * the live object (that's what makes it co-ownership-friendly).
 *
 * The `fieldManager` query parameter MUST be set on the request — the
 * apiserver uses it to attribute ownership.
 *
 * `force` parameter:
 *   false (default) — co-ownership only; conflicts with other managers
 *                     reject the apply with 409.
 *   true            — steal ownership of the fields from whichever
 *                     manager(s) currently own them. Use for the FIRST
 *                     operator-patch against a Flux-shipped resource
 *                     where Flux ships the field with a default value
 *                     it owns; after the steal, Flux's ssa:merge will
 *                     respect the new owner. Use sparingly — every
 *                     `force=true` field becomes an operator's
 *                     permanent responsibility to manage.
 */
export function applyPatch(fieldManager: string, opts: { force?: boolean } = {}): SDKOverride {
  const force = opts.force ?? false;
  const stub = (ctx: RequestContextLike): ObservableLike<RequestContextLike> => {
    const promise = Promise.resolve(ctx);
    return { promise, toPromise: () => promise, pipe: () => undefined };
  };
  const mw: Middleware = {
    pre: (ctx) => {
      ctx.setHeaderParam('Content-Type', 'application/apply-patch+yaml');
      // The SDK exposes setQueryParam via the same context interface
      // when it exists; gracefully no-op when it doesn't (test harness).
      const c = ctx as unknown as { setQueryParam?: (name: string, value: string) => void };
      if (typeof c.setQueryParam === 'function') {
        c.setQueryParam('fieldManager', fieldManager);
        c.setQueryParam('force', force ? 'true' : 'false');
      }
      return stub(ctx);
    },
    post: stub,
  };
  const override = withTag(
    { middleware: [mw] },
    'application/apply-patch+yaml',
  );
  return override as unknown as SDKOverride;
}

/**
 * Strategic-Merge Patch with explicit field-manager attribution.
 *
 * `STRATEGIC_MERGE_PATCH` (the bare constant) doesn't claim SSA
 * field ownership — the apiserver attributes the patch to whatever
 * user-agent makes the request, which doesn't help against a
 * Flux-owned manifest. Use this helper to claim ownership via a
 * stable fieldManager name. With the target resource carrying
 * `kustomize.toolkit.fluxcd.io/ssa: merge`, Flux's reconciler then
 * uses non-force SSA and gets 409 on fields owned by another
 * fieldManager — leaving the operator's claim intact.
 *
 * Used for the Stalwart Deployment `containers[].ports` mutation in
 * port-exposure.ts. The `$patch: replace` directive (first list
 * element) tells strategic-merge to wholesale-replace the list
 * instead of merging by `containerPort` — that's what lets us drop
 * the `hostPort` sub-field, which `mergeKey=containerPort` semantics
 * would otherwise preserve.
 *
 * Example body for atomic list replacement:
 *   {
 *     spec: { template: { spec: { containers: [{
 *       name: 'stalwart',
 *       ports: [
 *         { $patch: 'replace' },        // directive — must be first
 *         { containerPort: 25, name: 'smtp', protocol: 'TCP' },
 *         ...
 *       ],
 *     }] } } },
 *   }
 */
export function strategicMergePatch(fieldManager: string): SDKOverride {
  const stub = (ctx: RequestContextLike): ObservableLike<RequestContextLike> => {
    const promise = Promise.resolve(ctx);
    return { promise, toPromise: () => promise, pipe: () => undefined };
  };
  const mw: Middleware = {
    pre: (ctx) => {
      ctx.setHeaderParam('Content-Type', 'application/strategic-merge-patch+json');
      const c = ctx as unknown as { setQueryParam?: (name: string, value: string) => void };
      if (typeof c.setQueryParam === 'function') {
        c.setQueryParam('fieldManager', fieldManager);
      }
      return stub(ctx);
    },
    post: stub,
  };
  const override = withTag(
    { middleware: [mw] },
    'application/strategic-merge-patch+json',
  );
  return override as unknown as SDKOverride;
}

/**
 * Raw Server-Side Apply via direct fetch to the kube-apiserver.
 *
 * The SDK's typed `patchNamespacedDeployment` (and friends) runs every
 * body through ObjectSerializer which silently drops fields whose types
 * it can't reconstruct from a plain object — notably the polymorphic
 * `V1Volume.persistentVolumeClaim` / `configMap` / `secret` union. The
 * port-exposure SSA-apply happens to work because every field it
 * claims (`containers[].ports[].hostPort` etc.) is a primitive that
 * the serializer preserves; the migration cutover claim of
 * `volumes[].persistentVolumeClaim.claimName` does NOT survive the
 * serializer.
 *
 * Use this helper for any SSA-apply that needs to claim ownership of
 * nested object fields. The kubectl equivalent is:
 *
 *   kubectl apply --server-side --force-conflicts \
 *     --field-manager=$fieldManager -f -
 *
 * Caller passes a typed `KubeConfig` so we can extract the apiserver
 * URL + auth (Bearer token OR client cert). Body is plain JSON with
 * apiVersion + kind + metadata.{name,namespace}, exactly as you'd
 * write the YAML.
 *
 * Returns the apiserver's response body on 2xx; throws on non-2xx.
 *
 * The fetch goes through Node's native fetch (Node 18+), so this
 * helper is dependency-free and doesn't introduce a new client.
 */
export interface RawApplyTarget {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  /** Resource path component, e.g. 'deployments'. Plural, lowercase. */
  resource: string;
  /** API group prefix: '' for core (/api/v1), or 'apis/apps/v1' for apps. */
  apiPath: string;
}

export async function applyRaw(
  kc: import('@kubernetes/client-node').KubeConfig,
  target: RawApplyTarget,
  body: Record<string, unknown>,
  opts: { fieldManager: string; force?: boolean },
): Promise<unknown> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) {
    throw new Error('k8s-patch.applyRaw: no current cluster in kubeconfig');
  }
  const server = cluster.server.replace(/\/$/, '');

  // Compose URL: $server/$apiPath/namespaces/$ns/$resource/$name?fieldManager=...&force=...
  const url = new URL(
    `${server}/${target.apiPath}/namespaces/${target.namespace}/${target.resource}/${target.name}`,
  );
  url.searchParams.set('fieldManager', opts.fieldManager);
  url.searchParams.set('force', opts.force ? 'true' : 'false');

  // Source of the Bearer token, in order:
  //   1. KubeConfig's `user.token` — populated by `loadFromFile` for
  //      static kubeconfigs.
  //   2. `/var/run/secrets/kubernetes.io/serviceaccount/token` — the
  //      in-cluster ServiceAccount path. The k8s SDK's
  //      `loadFromCluster()` does NOT populate `user.token` from this
  //      file (it wires the file into the HTTPS client at request time
  //      via a different code path), so we must read it ourselves.
  //   3. Otherwise: 401. Throw a clear error.
  const user = kc.getCurrentUser();
  let token = user?.token;
  if (!token) {
    try {
      const { readFileSync } = await import('node:fs');
      const inClusterTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
      token = readFileSync(inClusterTokenPath, 'utf8').trim();
    } catch {
      /* fall through to throw below */
    }
  }
  if (!token) {
    throw new Error(
      'k8s-patch.applyRaw: no Bearer token in KubeConfig.user nor at '
      + '/var/run/secrets/kubernetes.io/serviceaccount/token. '
      + 'exec-plugin / client-cert auth not yet supported via this raw path.',
    );
  }

  // Use node:https directly so we can pass the cluster CA via the
  // standard `ca` option — Node's native fetch doesn't accept `ca`
  // (only undici's Agent does, and undici isn't bundled in the prod
  // Docker image's pruned node_modules). https is in Node core.
  const { request: httpsRequest } = await import('node:https');
  const { readFileSync } = await import('node:fs');

  // CA source: KubeConfig.caData/caFile first, then the in-cluster
  // ServiceAccount ca.crt as fallback. Same rationale as the token
  // fallback above — loadFromCluster() doesn't always propagate the
  // CA file path into cluster.caFile.
  let ca: string | Buffer | undefined;
  if (cluster.caData) {
    ca = Buffer.from(cluster.caData, 'base64');
  } else if (cluster.caFile) {
    ca = readFileSync(cluster.caFile);
  } else if (!cluster.skipTLSVerify) {
    try {
      ca = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    } catch {
      /* fall through — system CA may already trust the apiserver */
    }
  }

  const bodyJson = JSON.stringify(body);
  // One-time debug log so the next staging run shows the actual
  // body length + a hash so we can confirm the JSON is intact.
  // Remove after the migration cutover is verified working.
  // eslint-disable-next-line no-console
  console.log(`[applyRaw debug] ${target.kind}/${target.name} body length=${bodyJson.length} body[0..400]=${bodyJson.slice(0, 400)}`);

  return await new Promise<unknown>((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'PATCH',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        ca,
        rejectUnauthorized: !cluster.skipTLSVerify,
        headers: {
          'Content-Type': 'application/apply-patch+yaml',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try { resolve(JSON.parse(text)); }
            catch (err) { reject(new Error(`k8s-patch.applyRaw: bad JSON response (${(err as Error).message})`)); }
            return;
          }
          reject(new Error(
            `k8s-patch.applyRaw: ${target.kind}/${target.name} → HTTP ${status}: ${text.slice(0, 500)}`,
          ));
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(bodyJson);
    req.end();
  });
}
