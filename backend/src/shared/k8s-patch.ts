/**
 * @kubernetes/client-node v1.4 silently ignores a `contentType`
 * parameter on patch calls and always sends
 * `application/json-patch+json` (RFC 6902 array-of-ops), which
 * rejects our object-shaped strategic-merge / merge-patch bodies
 * with:
 *   error decoding patch: json: cannot unmarshal object into
 *   Go value of type []handlers.jsonPatchOp
 *
 * The v1 library exposes a middleware hook on the second arg of
 * every API call; pre()/post() return an Observable-like stub.
 * We wrap a synchronous header override in that shape.
 *
 * Pattern lifted from modules/backup-config/longhorn-reconciler.ts
 * so every new caller uses the same middleware instead of copying
 * the rxjs-stub-shaped boilerplate.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildHeaderOverride(contentType: string) {
  return {
    middleware: [
      {
        pre: (ctx: any) => {
          ctx.setHeaderParam('Content-Type', contentType);
          return { toPromise: () => Promise.resolve(ctx), pipe: () => undefined };
        },
        post: (ctx: any) => ({ toPromise: () => Promise.resolve(ctx), pipe: () => undefined }),
      },
    ] as any,
  } as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const STRATEGIC_MERGE_PATCH = buildHeaderOverride('application/strategic-merge-patch+json');
export const MERGE_PATCH = buildHeaderOverride('application/merge-patch+json');
