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
