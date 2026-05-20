/**
 * Operator-managed trusted upstream-proxy CIDRs.
 *
 * Where the trust applies:
 *   1. admin-panel + tenant-panel nginx — `set_real_ip_from` lines
 *      injected via mounted ConfigMap (include glob in nginx.conf.template)
 *   2. Traefik DS — `--entryPoints.{web,websecure}.forwardedHeaders
 *      .trustedIPs=` arg, JSON-patched in place by the reconciler
 *
 * Trust semantics: when an inbound request arrives FROM one of these
 * CIDRs, its `X-Forwarded-For` header is honored — nginx and Traefik
 * will walk the chain to find the real client IP. Without the trust
 * entry, the upstream's claimed-source-IP via XFF is ignored and the
 * immediate TCP peer becomes the source IP — which breaks
 * src-IP-aware features (CrowdSec L4 enforcement guard, audit logs,
 * rate-limiting).
 *
 * Three sources, surfaced in the UI but not all editable:
 *   - `system`    — baked into the static nginx template (RFC1918 +
 *                   IPv6 ULA + k3s default pod/svc CIDRs). Shown
 *                   in the UI for visibility; no DB row needed.
 *   - `bootstrap` — k3s cluster CIDRs detected at bootstrap and
 *                   stored in platform_settings. Auto-seeded into
 *                   the DB by the reconciler on every tick. UI
 *                   shows them as "auto-detected", Delete disabled.
 *   - `operator`  — added via the admin UI. Full CRUD by super_admin.
 *                   THIS is the row type for CDN/LB/floating-IP ranges.
 */

import { z } from 'zod';

// ─── CIDR validation ──────────────────────────────────────────────────────
//
// IPv4: octet-bounded (0-255 per octet, NOT just [0-9]{1,3}). The looser
// pattern in cluster-network.ts accepts `999.999.999.999/16` which fails
// silently at nginx-reload time; here we reject at the API boundary so
// the operator gets a clear 400 instead of a silent reconcile loop.
const ipv4Octet = '(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)';
const ipv4CidrPattern = new RegExp(
  `^${ipv4Octet}(?:\\.${ipv4Octet}){3}\\/([1-9]|[12]\\d|3[0-2])$`,
);
const ipv4BarePattern = new RegExp(`^${ipv4Octet}(?:\\.${ipv4Octet}){3}$`);

// IPv6: require at least one "::" or seven "::" segments, with hex
// groups of 1-4 chars. Rejects `:::::` and `zz::` (the bare pattern
// in cluster-network.ts let those through). nginx/k3s both want
// canonical RFC 4291 form; this regex covers the common shapes
// (full, compressed with ::, embedded IPv4). For exhaustive
// validation we'd need a parser, but this is tight enough to
// reject the common garbage inputs.
const ipv6Group = '[0-9a-fA-F]{1,4}';
const ipv6Full = `(?:${ipv6Group}:){7}${ipv6Group}`;
const ipv6Compressed =
  `(?:(?:${ipv6Group}:){1,7}:)|` +
  `(?:(?:${ipv6Group}:){1,6}:${ipv6Group})|` +
  `(?:(?:${ipv6Group}:){1,5}(?::${ipv6Group}){1,2})|` +
  `(?:(?:${ipv6Group}:){1,4}(?::${ipv6Group}){1,3})|` +
  `(?:(?:${ipv6Group}:){1,3}(?::${ipv6Group}){1,4})|` +
  `(?:(?:${ipv6Group}:){1,2}(?::${ipv6Group}){1,5})|` +
  `(?:${ipv6Group}:(?::${ipv6Group}){1,6})|` +
  `(?::(?::${ipv6Group}){1,7})|` +
  `(?:::)`;
const ipv6Address = `(?:${ipv6Full}|${ipv6Compressed})`;
const ipv6CidrPattern = new RegExp(
  `^${ipv6Address}\\/([1-9]|[1-9]\\d|1[01]\\d|12[0-8])$`,
);
const ipv6BarePattern = new RegExp(`^${ipv6Address}$`);

/**
 * Accept IPv4/v6 single addr or CIDR. /0 prefixes are REJECTED — a
 * `0.0.0.0/0` trust entry would let any source IP spoof XFF, which
 * is exactly the security boundary this feature protects.
 */
const cidrOrIpString = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (s) =>
      ipv4CidrPattern.test(s) ||
      ipv4BarePattern.test(s) ||
      ipv6CidrPattern.test(s) ||
      ipv6BarePattern.test(s),
    {
      message:
        'must be IPv4/v6 address or CIDR (e.g. 1.2.3.4, 10.0.0.0/16, 2001:db8::1, fd00::/8); /0 prefix is not allowed',
    },
  );

// ─── Contract shapes ─────────────────────────────────────────────────────────

export const trustedProxySourceSchema = z.enum(['system', 'bootstrap', 'operator']);
export type TrustedProxySource = z.infer<typeof trustedProxySourceSchema>;

export const trustedProxyRangeSchema = z.object({
  /** UUID — null for synthetic system rows (no DB backing). */
  id: z.string().uuid().nullable(),
  cidr: z.string(),
  description: z.string(),
  source: trustedProxySourceSchema,
  createdAt: z.string().datetime().nullable(),
  /** Email of the user who added the row; null for system / bootstrap. */
  createdByEmail: z.string().nullable(),
});
export type TrustedProxyRange = z.infer<typeof trustedProxyRangeSchema>;

export const createTrustedProxyRangeRequestSchema = z.object({
  cidr: cidrOrIpString,
  description: z.string().min(1).max(200),
});
export type CreateTrustedProxyRangeRequest = z.infer<
  typeof createTrustedProxyRangeRequestSchema
>;

export const listTrustedProxyRangesResponseSchema = z.object({
  ranges: z.array(trustedProxyRangeSchema),
  /** Last successful reconcile time. Null until first run. */
  lastReconciledAt: z.string().datetime().nullable(),
  /** Last reconcile state. */
  lastReconcileError: z.string().nullable(),
  /** Number of admin-panel + tenant-panel pods rolled to the current
   * ConfigMap-hash annotation. Helps the UI show "rollout in progress". */
  panelPodsRolled: z.number().int().nonnegative(),
  panelPodsTotal: z.number().int().nonnegative(),
});
export type ListTrustedProxyRangesResponse = z.infer<
  typeof listTrustedProxyRangesResponseSchema
>;
