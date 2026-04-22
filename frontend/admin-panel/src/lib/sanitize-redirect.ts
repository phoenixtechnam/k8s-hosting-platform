/**
 * Sanitize a `rd=` (redirect) query parameter supplied by nginx
 * auth-signin or a manual browser link. Returns a path or absolute URL
 * that is safe to navigate to after a successful login.
 *
 * Accepts:
 *   - Relative same-origin path, e.g. `/dashboard`
 *   - Absolute URL whose host is the same apex or any subdomain of it,
 *     e.g. admin.<apex>, longhorn.<apex>, <apex> itself
 *
 * Rejects (returns `fallback`):
 *   - null / empty
 *   - Protocol-relative (`//evil.com/...`) and backslash-prefixed inputs
 *     (IE/legacy browsers treat `\\\\evil.com` as protocol-relative)
 *   - Non-http/https schemes (javascript:, data:, file:, etc)
 *   - Absolute URLs targeting a host outside the apex allow-list
 *   - Malformed URLs
 *
 * Allow-list semantics: the URL's hostname must equal `apex` exactly, or
 * end with `'.' + apex`. The leading-dot check prevents apex-as-suffix
 * spoofing (attacker host `staging.phoenix-host.net.evil.com` endsWith
 * `staging.phoenix-host.net` but NOT `.staging.phoenix-host.net`).
 *
 * @param rd        Raw value of `?rd=...` (URL-decoded by URLSearchParams)
 * @param origin    The current page origin, used as the base for parsing
 *                  relative paths (e.g. `https://admin.staging.phoenix-host.net`)
 * @param apex      The platform apex domain (e.g. `staging.phoenix-host.net`)
 * @param fallback  Returned when rd is absent or rejected. Default `/`.
 */
export function sanitizeRedirect(
  rd: string | null | undefined,
  origin: string,
  apex: string,
  fallback: string = '/',
): string {
  if (!rd) return fallback;

  // Reject backslash-prefixed inputs up-front. Modern browsers treat
  // \\host/path as //host/path (protocol-relative) because of WHATWG
  // URL parsing; a leading backslash is never something we generated.
  if (rd.startsWith('\\')) return fallback;

  // Protocol-relative: URLSearchParams will hand us `//evil.com/...`
  // verbatim. Node's and browser's URL parsers resolve it against the
  // base but inherit the base's protocol — giving us https://evil.com
  // which then might slip through endsWith. Reject explicitly.
  if (rd.startsWith('//')) return fallback;

  // Relative paths — must start with `/`. Anything else ("dashboard",
  // "../whatever") is ambiguous and rejected.
  if (rd.startsWith('/')) return rd;

  // Anything remaining must parse as an absolute URL.
  let parsed: URL;
  try {
    parsed = new URL(rd, origin);
  } catch {
    return fallback;
  }

  // Scheme gate: http(s) only. URL() happily accepts javascript:,
  // data:, file:, chrome: etc; all of those are rejection-worthy.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fallback;
  }

  // Apex gate. Must be exact match or strict subdomain. hostname is
  // already lowercased by WHATWG URL.
  const host = parsed.hostname;
  const lowerApex = apex.toLowerCase();
  if (host === lowerApex || host.endsWith(`.${lowerApex}`)) {
    return parsed.toString();
  }

  return fallback;
}
