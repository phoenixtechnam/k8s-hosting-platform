/**
 * Lightweight IPv4 / IPv6 validators for client-side form inputs.
 *
 * Not a replacement for server-side Zod validation (the backend also
 * enforces these via z.ipv4() / z.ipv6() since Zod 4) — this exists
 * purely to give users immediate feedback instead of waiting for a
 * 400 round-trip.
 */

/**
 * Match a single IPv4 dotted-quad. Each octet must be 0-255 with no
 * leading zeros (matches common convention; strict RFC allows leading
 * zeros but treats them as octal, which is a footgun).
 */
export function isValidIpv4(input: string): boolean {
  if (!input) return false;
  const parts = input.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false;
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * Match an IPv6 address in standard or compressed form (`::`), with
 * optional IPv4-mapped tail (e.g. `::ffff:1.2.3.4`). Not exhaustive
 * against RFC 4291 edge cases — covers the shapes users actually
 * type into platform config forms.
 */
export function isValidIpv6(input: string): boolean {
  if (!input) return false;
  // Strip optional zone index (e.g. fe80::1%eth0) — we accept but
  // don't validate zone names.
  const withoutZone = input.split('%')[0];
  if (!withoutZone) return false;

  // Parse via `new URL('http://[addr]')` — the URL parser rejects
  // invalid IPv6 (double `::`, bad hex, > 8 groups) and normalizes
  // valid addresses. We accept any address the URL parser accepts.
  try {
    // Additional guard: URL silently accepts some weird inputs like
    // bare dotted-quad IPv4 inside brackets. Require at least one
    // colon so we don't conflate IPv4 with IPv6.
    if (!withoutZone.includes(':')) return false;
    const url = new URL(`http://[${withoutZone}]`);
    // A valid parse returns hostname still in bracketed form.
    return url.hostname.startsWith('[') && url.hostname.endsWith(']');
  } catch {
    return false;
  }
}
