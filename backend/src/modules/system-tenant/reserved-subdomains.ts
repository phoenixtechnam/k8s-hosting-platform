/**
 * Reserved-subdomain computation (ADR-040 §3 Q5).
 *
 * Computes the set of FQDNs that no tenant — including SYSTEM in its
 * non-master role — may register as a `domains` row or target with a
 * CNAME/A/AAAA record. The set is *derived at runtime* from four
 * sources, so when an operator changes a platform URL via the admin
 * UI (Settings → Platform URLs), the reserved set updates within the
 * cache TTL without any code changes.
 *
 * Sources, in priority order:
 *   1. Static config helpers in `backend/src/config/domains.ts` —
 *      admin, tenant/client, mail, stalwart, dex, webmail labels
 *      computed against the resolved apex.
 *   2. Operator-configured URLs in `platform_settings`:
 *      `longhorn_url`, `stalwart_admin_url`, `default_webmail_url`,
 *      `mail_server_hostname` — parsed for their hostname; if it's a
 *      subdomain of the apex, the label becomes reserved.
 *   3. Static deny list of platform-managed labels not yet covered by
 *      the above: `traefik`, `master`, `tunnels`, `suspended`,
 *      `bulwark`, `roundcube`, `api`, `ingress`, `cluster`.
 *   4. The apex itself — only SYSTEM's bootstrap path may register it
 *      (via `ensureSystemApexDomain` with an internal bypass flag).
 *
 * The set is cached with a 5s TTL — matching `getSettings()` cache
 * shape — so domain-create flows don't pay a multi-source query cost
 * on every request. Cache scope is per-process; multi-replica
 * eventual consistency converges in 5s.
 *
 * NOTE on Phase 5 scope: the live cluster Ingress label scan
 * (`platform.phoenix-host.net/admin-ui=true`) is *deferred* to a
 * later phase. The operator-confirmed sources (config helpers +
 * platform_settings URL keys) cover every platform hostname today.
 * Adding the cluster scan later is purely additive — call sites only
 * see a larger reserved set.
 */

import { eq, inArray } from 'drizzle-orm';
import { platformSettings, systemSettings } from '../../db/schema.js';
import {
  adminHost,
  tenantHost,
  mailHost,
  stalwartHost,
  dexHost,
  webmailHost,
  resolveBaseDomain,
} from '../../config/domains.js';
import type { Database } from '../../db/index.js';

/** Returned by getReservedPlatformHostnames. Keys are normalized
 *  (lowercase, no trailing dot). The `apex` field carries the
 *  resolved platform base domain so callers can render hints. */
export interface ReservedHostnames {
  readonly apex: string;
  /** Every reserved FQDN, lowercased. The apex itself is INCLUDED. */
  readonly fqdns: ReadonlySet<string>;
  /** Map fqdn → source description, used for operator-friendly error
   *  messages ("admin.<apex> is reserved by the platform admin UI"). */
  readonly reasons: ReadonlyMap<string, string>;
}

const CACHE_TTL_MS = 5_000;
let cached: ReservedHostnames | null = null;
let cachedAt = 0;

/** Test helper — drops the cache so a test that mutates the source
 *  rows sees the new value immediately. */
export function _resetReservedHostnamesCache(): void {
  cached = null;
  cachedAt = 0;
}

function normalize(host: string): string {
  return host.trim().replace(/\.+$/, '').toLowerCase();
}

/** Pull the hostname out of an operator-set URL like `https://lh.example.com/`.
 *  Returns null if the value is empty, invalid, or not a subdomain of `apex`. */
function hostnameFromUrl(raw: string | null, apex: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Tolerate a bare hostname (no scheme) like `mail.example.com`.
  let host: string;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    host = url.hostname;
  } catch {
    return null;
  }
  const norm = normalize(host);
  if (!apex) return norm || null;
  // Only treat hosts that are subdomains of the platform apex as
  // reserved — a customer who CNAMEs `admin.acme.com` for their own
  // site should obviously be allowed.
  if (norm === apex) return norm;
  if (norm.endsWith(`.${apex}`)) return norm;
  return null;
}

/** Static deny list of labels the platform may use under its apex but
 *  which aren't covered by the live config sources. Added defensively so
 *  a customer can't grab `traefik.<apex>` or `master.<apex>` even
 *  before the operator wires the corresponding ingress. */
const STATIC_DENY_LABELS = [
  'traefik',
  'master',
  'tunnels',
  'suspended',
  'bulwark',
  'roundcube',
  'api',
  'ingress',
  'cluster',
  'longhorn',
] as const;

/**
 * Get the runtime-computed reserved hostnames set, cached for 5 s.
 *
 * Idempotent: safe to call from any number of concurrent requests.
 * On the first call after a cache miss, performs a small number of
 * DB reads (one for system_settings, four for platform_settings keys)
 * — total ~5 ms uncached, near-zero cached.
 */
export async function getReservedPlatformHostnames(db: Database): Promise<ReservedHostnames> {
  const now = Date.now();
  if (cached && (now - cachedAt) < CACHE_TTL_MS) {
    return cached;
  }

  // Resolve apex: prefer system_settings.ingress_base_domain (canonical
  // post-bootstrap), fall back to env (pre-bootstrap install).
  // No .limit(1) — system_settings.id is the primary key, so at most
  // one row matches. Keeps the Drizzle chain compatible with the
  // existing dns-records unit-test mocks that don't proxy .limit().
  const [settingsRow] = await db
    .select({ ingressBaseDomain: systemSettings.ingressBaseDomain })
    .from(systemSettings)
    .where(eq(systemSettings.id, 'system'));
  const apex = normalize(
    (settingsRow?.ingressBaseDomain && settingsRow.ingressBaseDomain.trim())
      || resolveBaseDomain(process.env),
  );

  const fqdns = new Map<string, string>();

  // Source 1: static platform subdomains from config helpers.
  if (apex) {
    const cfgEnv = { PLATFORM_BASE_DOMAIN: apex } as const;
    const staticHostnames: Array<readonly [string, string]> = [
      [normalize(adminHost(cfgEnv)), 'platform admin panel'],
      [normalize(tenantHost(cfgEnv)), 'platform tenant panel'],
      [normalize(mailHost(cfgEnv)), 'platform mail SMTP/IMAP server'],
      [normalize(stalwartHost(cfgEnv)), 'platform Stalwart web-admin'],
      [normalize(dexHost(cfgEnv)), 'platform Dex OIDC issuer'],
      [normalize(webmailHost(cfgEnv)), 'platform webmail'],
    ];
    for (const [host, reason] of staticHostnames) {
      if (host && !fqdns.has(host)) fqdns.set(host, reason);
    }
  }

  // Source 2: operator-configured URLs in platform_settings. Each is
  // a full URL or bare hostname; we parse for hostname only. Use
  // inArray() so the query has a .where() clause — keeps test mocks
  // that only proxy `select → from → where → Promise` working.
  const urlKeys = [
    { key: 'longhorn_url', reason: 'platform Longhorn dashboard' },
    { key: 'stalwart_admin_url', reason: 'platform Stalwart web-admin' },
    { key: 'default_webmail_url', reason: 'platform webmail' },
    { key: 'mail_server_hostname', reason: 'platform mail server hostname' },
  ];
  const urlRows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(inArray(platformSettings.key, urlKeys.map((u) => u.key)));
  // Defensive: handle the case where the mock returns a non-array
  // chain object instead of rows (legacy mocks that don't tail the
  // `.where()` with a Promise resolver). Empty array = no operator
  // URLs configured = static sources only.
  const safeUrlRows = Array.isArray(urlRows) ? urlRows : [];
  const urlMap = new Map(safeUrlRows.map((r) => [r.key, r.value]));
  for (const { key, reason } of urlKeys) {
    const host = hostnameFromUrl(urlMap.get(key) ?? null, apex);
    if (host && !fqdns.has(host)) fqdns.set(host, reason);
  }

  // Source 3: static deny list expanded against the apex.
  if (apex) {
    for (const label of STATIC_DENY_LABELS) {
      const host = `${label}.${apex}`;
      if (!fqdns.has(host)) fqdns.set(host, `platform-reserved label '${label}'`);
    }
  }

  // Source 4: the apex itself. Only SYSTEM may own it (and only via
  // the internal bootstrap bypass — see ensureSystemApexDomain).
  if (apex) {
    fqdns.set(apex, 'platform apex domain (owned by SYSTEM)');
  }

  const result: ReservedHostnames = {
    apex,
    fqdns: new Set(fqdns.keys()),
    reasons: fqdns,
  };
  cached = result;
  cachedAt = now;
  return result;
}

/** Convenience: true if `hostname` is in the reserved set. Lowercases
 *  + strips trailing dot before comparison. */
export async function isReservedPlatformHostname(
  db: Database,
  hostname: string,
): Promise<boolean> {
  const reserved = await getReservedPlatformHostnames(db);
  return reserved.fqdns.has(normalize(hostname));
}
