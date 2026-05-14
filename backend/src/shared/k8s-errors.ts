/**
 * Shared @kubernetes/client-node error-shape helpers.
 *
 * Background — the SDK had a breaking v0 → v1 rewrite. The field
 * carrying the HTTP status moved:
 *
 *   v0.x: thrown error is `HttpError` with `.statusCode`
 *   v1.x: thrown error is `ApiException` with `.code` (and parsed
 *         `.body.code` when the apiserver returned a JSON Status object)
 *
 * Most "is this a 404?" call sites in this codebase only check
 * `.statusCode` — a leftover from the v0 SDK. On v1 that field is
 * `undefined`, so the 404→fall-through-to-create paths silently
 * re-throw and surface as 500s to operators.
 *
 * Use these helpers everywhere instead of inlining the check:
 *
 *   try { await core.readNamespacedSecret(…) }
 *   catch (err) {
 *     if (!isNotFound(err)) throw err;
 *     // 404 — proceed to create
 *   }
 *
 * For other status codes, use `httpStatusOf(err)` and compare.
 */

/**
 * Extract the HTTP status code from a @kubernetes/client-node thrown
 * error, checking both v0 and v1 SDK shapes.
 *
 * Returns `undefined` when the error is not an HTTP-shape error (e.g.
 * a network timeout, a deserialisation failure inside the SDK, etc).
 * Callers should treat `undefined` as "this is not a status-code
 * error — re-throw it" rather than as a specific status.
 */
export function httpStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as {
    code?: number | string;
    statusCode?: number;
    status?: number;
    body?: { code?: number };
    response?: { statusCode?: number; status?: number };
  };
  // v1.x ApiException → .code (number)
  // v0.x HttpError → .statusCode
  // Parsed Status object body → .body.code
  // Some axios-shape responses → .response.statusCode / .status
  const raw =
    e.code
    ?? e.statusCode
    ?? e.status
    ?? e.body?.code
    ?? e.response?.statusCode
    ?? e.response?.status;
  // .code can be a string ('ENOTFOUND') for socket errors — only return
  // when it's a number that smells like an HTTP status.
  if (typeof raw === 'number' && raw >= 100 && raw < 600) return raw;
  return undefined;
}

/** Is this error a Kubernetes 404 Not-Found from either SDK version? */
export function isNotFound(err: unknown): boolean {
  return httpStatusOf(err) === 404;
}

/** 409 Conflict — typically a resource-version mismatch on update. */
export function isConflict(err: unknown): boolean {
  return httpStatusOf(err) === 409;
}

/** 403 Forbidden — RBAC denied. */
export function isForbidden(err: unknown): boolean {
  return httpStatusOf(err) === 403;
}
