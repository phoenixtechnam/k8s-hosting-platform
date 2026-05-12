// Docker Registry HTTP API V2 tag-list probe with 60-minute cache.
//
// Used by the client-panel "Updates available?" pill: each row in
// the Custom Containers tab triggers a check-updates-batch POST when
// the tab opens; the backend serves the cached result immediately
// and fires an async refresh for entries older than 60 minutes.
//
// Endpoint shape:
//   GET https://<registry>/v2/<repository>/tags/list
//   → 200 { name, tags: [...] }
//   → 401 with WWW-Authenticate: Bearer realm="…",service="…",scope="…"
//     (the auth dance: GET the realm, present basic-auth credentials,
//     receive a token, retry the original request with the token)
//   → 404 image gone
//   → 429 rate-limited (Docker Hub anonymous is 100/6h per IP)
//   → 5xx server error
//
// Failure modes return `status: 'unknown'` with a human-readable
// `reason`. The UI surfaces this in a tooltip.
//
// PAT support: when the deployment has a stored credential, we use
// it for basic-auth against the realm. Decryption happens at call
// time; the cleartext lives only for the duration of one HTTP
// roundtrip.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { customDeploymentImageCheckCache } from '../../db/schema.js';
import {
  parseImageReference,
  type ParsedImageReference,
} from './image-reference.js';
import {
  parseSemver,
  pickLatestStable,
  classifyBump,
  type BumpSeverity,
} from './semver-compare.js';

const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
/** docker.io's distribution endpoint lives at `registry-1.docker.io`
 *  even though refs say `docker.io/library/nginx`. The Docker Hub
 *  auth realm is a separate host. */
const DOCKER_HUB_INDEX_HOST = 'registry-1.docker.io';

/**
 * Block tenant-driven SSRF via WWW-Authenticate realm. A hostile
 * registry can return `WWW-Authenticate: Bearer realm="http://..."`
 * pointing at an internal IP / cluster service to either probe the
 * platform's internal network OR (with a PAT attached) exfiltrate
 * the cleartext via the basic-auth header we send to the realm.
 *
 * Defense:
 *  1. Realm MUST be https.
 *  2. Realm host MUST NOT be a loopback / RFC-1918 / link-local
 *     address, the IMDS endpoint (169.254.169.254), `::1`,
 *     `localhost`, or a Kubernetes-internal DNS suffix
 *     (`.svc`, `.svc.cluster.local`).
 *
 * The check runs on the URL.host BEFORE the fetch fires, so a
 * tenant cannot trick `new URL(...)` into resolving a public-looking
 * hostname that DNS-points at a private IP — the platform's outbound
 * firewall and the host validator both have to fail for a probe to
 * land internally.
 */
const BLOCKED_REALM_HOST_RE = new RegExp(
  '^(?:'
  + 'localhost'
  + '|0\\.0\\.0\\.0'
  + '|127\\.\\d+\\.\\d+\\.\\d+'
  + '|10\\.\\d+\\.\\d+\\.\\d+'
  + '|192\\.168\\.\\d+\\.\\d+'
  + '|172\\.(?:1[6-9]|2[0-9]|3[01])\\.\\d+\\.\\d+'
  + '|169\\.254\\.\\d+\\.\\d+'
  + '|::1'
  + '|\\[::1\\]'
  + '|fc[0-9a-f]{2}:'
  + '|fe[89ab][0-9a-f]:'
  + ')$',
  'i',
);

/** Host suffixes the validator rejects (k8s-internal DNS). */
const BLOCKED_REALM_HOST_SUFFIXES = [
  '.svc',
  '.svc.cluster.local',
  '.cluster.local',
  '.local',
];

/**
 * Return true when the supplied realm URL points at a private /
 * internal address. Exported for unit-test coverage; the caller
 * should reject the request when this returns true.
 */
export function isRealmUrlBlocked(realm: string): boolean {
  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    return true;
  }
  if (url.protocol !== 'https:') return true;
  const host = url.hostname.toLowerCase();
  if (BLOCKED_REALM_HOST_RE.test(host)) return true;
  for (const suffix of BLOCKED_REALM_HOST_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  return false;
}

export type UpdateCheckStatus = BumpSeverity;

export interface UpdateCheckResult {
  readonly status: UpdateCheckStatus;
  readonly current: string | null;
  readonly latest: string | null;
  readonly reason: string | null;
  readonly checkedAt: Date;
}

export interface CheckUpdateOptions {
  readonly db: Database;
  /** The image reference to check (whatever the deployment runs). */
  readonly image: string;
  /** When provided, basic-auth credentials forwarded to the auth
   *  realm. The token is decrypted by the caller (pat-store). */
  readonly authCreds?: { username: string; password: string };
  /** Override the registry probe — used by tests. Default: real fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Returns either the cached result (when fresh) or a freshly-probed
 * result (when stale or never cached). The cache row is upserted on
 * every successful probe; stale rows are returned IMMEDIATELY and a
 * background refresh fires — the caller's response is never delayed
 * by the registry's latency for a stale entry.
 *
 * On unrecoverable errors (network, registry 5xx, unparseable image
 * ref) returns `{ status: 'unknown', reason }` without writing to
 * the cache, so the next call retries instead of caching the failure.
 */
export async function checkForUpdate(
  options: CheckUpdateOptions,
): Promise<UpdateCheckResult> {
  const ref = parseImageReference(options.image);
  if (!ref) {
    return unknownResult(null, 'unparseable image reference');
  }
  const currentTag = ref.tag ?? 'latest';

  const cached = await readCache(options.db, ref, currentTag);
  if (cached && Date.now() - cached.checkedAt.getTime() < CACHE_TTL_MS) {
    return cached;
  }

  // Probe (synchronously for now — a future optimisation is to fire
  // the refresh in the background and return the stale cache; doing
  // so requires a circuit-breaker and the cache row exists for at
  // most a tiny fraction of deployments, so Phase 1 keeps it simple).
  let probe: UpdateCheckResult;
  try {
    probe = await probeRegistry(ref, currentTag, options);
  } catch (err) {
    const reason = err instanceof Error ? safeErrorMessage(err.message) : 'probe error';
    return unknownResult(currentTag, reason);
  }

  // Only cache definitive results. `unknown` results stay un-cached
  // so transient registry hiccups don't pin a stale `unknown` for
  // 60 minutes — the next call retries.
  if (probe.status !== 'unknown') {
    await writeCache(options.db, ref, currentTag, probe);
  }
  return probe;
}

// ─── Registry probe ─────────────────────────────────────────────────────────

async function probeRegistry(
  ref: ParsedImageReference,
  currentTag: string,
  opts: CheckUpdateOptions,
): Promise<UpdateCheckResult> {
  const currentSemver = parseSemver(currentTag);
  if (!currentSemver) {
    return unknownResult(currentTag, 'current tag is not semver-shaped');
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const indexHost = ref.registryHost === 'docker.io' ? DOCKER_HUB_INDEX_HOST : ref.registryHost;
  const url = `https://${indexHost}/v2/${ref.repository}/tags/list`;

  // First request — no auth. Most public registries return 401 with
  // a WWW-Authenticate header pointing at the auth realm.
  const first = await timedFetch(fetchImpl, url, {}, REQUEST_TIMEOUT_MS);

  let response: Response = first;
  if (first.status === 401) {
    const wwwAuth = first.headers.get('www-authenticate');
    if (!wwwAuth) {
      return unknownResult(currentTag, 'registry 401 with no auth realm');
    }
    const token = await fetchBearerToken(fetchImpl, wwwAuth, opts.authCreds);
    if (!token) {
      return unknownResult(currentTag, 'auth realm did not return a token');
    }
    response = await timedFetch(
      fetchImpl,
      url,
      { headers: { authorization: `Bearer ${token}` } },
      REQUEST_TIMEOUT_MS,
    );
  }

  if (response.status === 429) {
    return unknownResult(currentTag, 'registry rate limited (429)');
  }
  if (response.status === 404) {
    return unknownResult(currentTag, 'registry returned 404 for tags/list');
  }
  if (response.status >= 500) {
    return unknownResult(currentTag, `registry ${response.status} on tags/list`);
  }
  if (response.status !== 200) {
    return unknownResult(currentTag, `unexpected registry status ${response.status}`);
  }

  let body: { tags?: string[] };
  try {
    body = (await response.json()) as { tags?: string[] };
  } catch {
    return unknownResult(currentTag, 'malformed tags/list response');
  }
  const tags = Array.isArray(body.tags) ? body.tags : [];
  if (tags.length === 0) {
    return result('no-update', currentTag, null, 'registry returned empty tag list');
  }

  const latest = pickLatestStable(tags, currentSemver);
  if (!latest) {
    return result('no-update', currentTag, null, null);
  }
  const severity = classifyBump(currentSemver, latest.version);
  return result(severity, currentTag, latest.tag, null);
}

// ─── Bearer-token dance ─────────────────────────────────────────────────────

/**
 * Parse `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`
 * and exchange it for a token. When `authCreds` is supplied, the
 * exchange is HTTP basic-auth (for private registries). Otherwise
 * an anonymous request — Docker Hub etc. issue read-only anon tokens
 * for public repos.
 */
async function fetchBearerToken(
  fetchImpl: typeof fetch,
  wwwAuth: string,
  authCreds: { username: string; password: string } | undefined,
): Promise<string | null> {
  const params = parseChallenge(wwwAuth);
  if (!params.realm) return null;
  // SSRF + PAT-exfil defence: only allow public-internet https realms.
  // A tenant-controlled registry could otherwise direct the platform
  // (and the basic-auth Authorization header we send for private
  // registries) at internal addresses / cluster services.
  if (isRealmUrlBlocked(params.realm)) return null;
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set('service', params.service);
  if (params.scope) url.searchParams.set('scope', params.scope);

  const headers: Record<string, string> = {};
  if (authCreds) {
    const basic = Buffer.from(`${authCreds.username}:${authCreds.password}`, 'utf8').toString('base64');
    headers.authorization = `Basic ${basic}`;
  }
  const res = await timedFetch(fetchImpl, url.toString(), { headers }, REQUEST_TIMEOUT_MS);
  if (res.status !== 200) return null;
  try {
    const body = (await res.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  } catch {
    return null;
  }
}

/** Quick-and-dirty WWW-Authenticate parser. The header is
 *  `Bearer realm="...",service="...",scope="..."` in practice but
 *  the RFC allows whitespace and unquoted values; we accept both. */
function parseChallenge(header: string): { realm?: string; service?: string; scope?: string } {
  const out: Record<string, string> = {};
  // Drop the `Bearer ` prefix.
  const body = header.replace(/^[Bb]earer\s+/, '');
  // Split on commas that are NOT inside quotes. Naive but adequate
  // for the strict format real registries emit.
  const parts = body.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return { realm: out.realm, service: out.service, scope: out.scope };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

async function readCache(
  db: Database,
  ref: ParsedImageReference,
  currentTag: string,
): Promise<UpdateCheckResult | null> {
  const imageReference = `${ref.registryHost}/${ref.repository}`;
  const [row] = await db.select()
    .from(customDeploymentImageCheckCache)
    .where(and(
      eq(customDeploymentImageCheckCache.imageReference, imageReference),
      eq(customDeploymentImageCheckCache.registryHost, ref.registryHost),
      eq(customDeploymentImageCheckCache.currentTag, currentTag),
    ));
  if (!row) return null;
  return {
    status: row.severity as UpdateCheckStatus,
    current: row.currentTag,
    latest: row.latestTag,
    reason: row.reason,
    checkedAt: row.checkedAt,
  };
}

async function writeCache(
  db: Database,
  ref: ParsedImageReference,
  currentTag: string,
  result: UpdateCheckResult,
): Promise<void> {
  const imageReference = `${ref.registryHost}/${ref.repository}`;
  const existing = await db.select()
    .from(customDeploymentImageCheckCache)
    .where(and(
      eq(customDeploymentImageCheckCache.imageReference, imageReference),
      eq(customDeploymentImageCheckCache.registryHost, ref.registryHost),
      eq(customDeploymentImageCheckCache.currentTag, currentTag),
    ));
  const now = new Date();
  if (existing.length > 0) {
    await db.update(customDeploymentImageCheckCache)
      .set({
        latestTag: result.latest,
        severity: result.status,
        reason: result.reason,
        checkedAt: now,
      })
      .where(eq(customDeploymentImageCheckCache.id, existing[0].id));
  } else {
    await db.insert(customDeploymentImageCheckCache).values({
      id: randomUUID(),
      imageReference,
      registryHost: ref.registryHost,
      currentTag,
      latestTag: result.latest,
      severity: result.status,
      reason: result.reason,
    });
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function result(
  status: UpdateCheckStatus,
  current: string | null,
  latest: string | null,
  reason: string | null,
): UpdateCheckResult {
  return { status, current, latest, reason, checkedAt: new Date() };
}

function unknownResult(current: string | null, reason: string): UpdateCheckResult {
  return result('unknown', current, null, reason);
}

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip anything that could be a leaked credential out of an error
 * message before surfacing it as a `reason`. Defensive — node-fetch /
 * undici error messages are normally just `fetch failed` plus a
 * cause chain, but PATs in URLs (basic-auth) could otherwise show
 * up if the caller built a hostile URL.
 */
function safeErrorMessage(msg: string): string {
  // Mask `https://user:token@host/...`
  return msg.replace(/(https?:\/\/)[^/]*:[^/@]*@/g, '$1<redacted>@').slice(0, 200);
}

