import { readFileSync as fsReadFileSync } from 'node:fs';

/**
 * Typed JMAP client for Stalwart 0.16+.
 *
 * Stalwart 0.16 dropped its legacy REST API — all programmatic
 * provisioning goes through JMAP (RFC 8620). This module wraps the
 * subset of JMAP operations that the platform-api needs:
 *
 *   Principal/get        — read admin-account or mailbox state
 *   Principal/set        — create/update/delete mailboxes and domains
 *   Principal/changes    — track state-changes for polling sync
 *   Domain/dnsZoneFile   — fetch the DNS records Stalwart wants published
 *                          (used by dns-sync.ts)
 *
 * Authentication: HTTP Basic (admin:password) via the same credentials
 * resolution chain as the rest of the mail-admin module
 * (STALWART_ADMIN_CREDS_DIR > STALWART_ADMIN_PASSWORD > ADMIN_SECRET_PLAIN).
 *
 * Transport: native `fetch` (Node 22, no keep-alive pooling needed for
 * the infrequent provisioning calls this module makes).
 *
 * Base URL: STALWART_MGMT_URL (default:
 *   http://stalwart-mgmt-v016.mail.svc.cluster.local:8080)
 */

// ── JMAP protocol types (RFC 8620) ─────────────────────────────────────────

/** RFC 8620 §3.6 — account ID string */
export type JmapAccountId = string;

/** RFC 8620 §3 — per-method invocation: [name, args, clientId] */
export type JmapInvocation = [string, Record<string, unknown>, string];

export interface JmapRequest {
  readonly using: readonly string[];
  readonly methodCalls: readonly JmapInvocation[];
}

export interface JmapResponse {
  readonly methodResponses: readonly JmapInvocation[];
  readonly sessionState: string;
}

/** RFC 8620 §5.1 — /get response arguments */
export interface JmapGetResponse<T> {
  readonly accountId: JmapAccountId;
  readonly state: string;
  readonly list: readonly T[];
  readonly notFound: readonly string[];
}

/** RFC 8620 §5.2 — /set request arguments */
export interface JmapSetRequest<T> {
  readonly accountId?: JmapAccountId;
  readonly ifInState?: string | null;
  readonly create?: Record<string, T> | null;
  readonly update?: Record<string, Record<string, unknown>> | null;
  readonly destroy?: readonly string[] | null;
}

/** RFC 8620 §5.2 — /set response arguments */
export interface JmapSetResponse<T> {
  readonly accountId: JmapAccountId;
  readonly oldState: string | null;
  readonly newState: string;
  readonly created: Record<string, T> | null;
  readonly updated: Record<string, T | null> | null;
  readonly destroyed: readonly string[] | null;
  readonly notCreated: Record<string, JmapSetError> | null;
  readonly notUpdated: Record<string, JmapSetError> | null;
  readonly notDestroyed: Record<string, JmapSetError> | null;
}

/** RFC 8620 §5.3 — /changes response arguments */
export interface JmapChangesResponse {
  readonly accountId: JmapAccountId;
  readonly oldState: string;
  readonly newState: string;
  readonly hasMoreChanges: boolean;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly destroyed: readonly string[];
}

export interface JmapSetError {
  readonly type: string;
  readonly description?: string | null;
  readonly properties?: readonly string[] | null;
}

// ── Stalwart Principal types ────────────────────────────────────────────────

/** Principal types recognized by Stalwart 0.16 */
export type PrincipalType = 'individual' | 'domain' | 'group' | 'list' | 'resource';

export interface PrincipalQuota {
  /** Quota in bytes. 0 = unlimited. */
  readonly messages?: number | null;
  readonly storage?: number | null;
}

/**
 * Stalwart Principal object (subset of fields the platform needs).
 *
 * The full schema has many more fields (members, roles, data, etc).
 * We include only what provisioning and DNS sync require; unknown
 * fields from the server are accepted and passed through.
 */
export interface StalwartPrincipal {
  readonly id?: string;
  readonly type: PrincipalType;
  readonly name: string;
  readonly description?: string | null;
  readonly emails?: readonly string[];
  /** Tenant / org string — unused in single-tenant installs */
  readonly tenant?: string | null;
  readonly quota?: PrincipalQuota | null;
  /** Password hash or plain password when creating (write-only) */
  readonly secrets?: readonly string[];
  /**
   * For type=domain: the full zone-file text Stalwart wants published.
   * Server-set — not sent on create/update.
   */
  readonly dnsZoneFile?: string | null;
}

/** Minimal shape for creating an individual mailbox */
export interface CreateMailboxInput {
  readonly type: 'individual';
  readonly name: string;
  readonly description?: string;
  readonly emails: readonly string[];
  readonly secrets?: readonly string[];
  readonly quota?: PrincipalQuota;
}

/** Minimal shape for registering a domain */
export interface CreateDomainInput {
  readonly type: 'domain';
  readonly name: string;
  readonly description?: string;
}

// ── JMAP session ────────────────────────────────────────────────────────────

export interface JmapSession {
  /** All capabilities advertised by the server */
  readonly capabilities: Record<string, unknown>;
  /**
   * Map of accountId → account info.
   * Stalwart exposes separate namespaces:
   *   - mail account (RFC 8620 core)
   *   - principal management account (urn:ietf:params:jmap:principals)
   */
  readonly accounts: Record<string, { readonly name: string; readonly accountCapabilities: Record<string, unknown> }>;
  readonly primaryAccounts: Record<string, JmapAccountId>;
  readonly apiUrl: string;
  readonly state: string;
}

// ── Client implementation ───────────────────────────────────────────────────

const STALWART_MGMT_URL =
  process.env.STALWART_MGMT_URL ?? 'http://stalwart-mgmt-v016.mail.svc.cluster.local:8080';

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_PRINCIPALS = 'urn:ietf:params:jmap:principals';

/**
 * Resolve admin Basic-Auth credentials using the same priority order
 * as the rest of the mail-admin module.
 *
 * We read env at call-time (not module-load-time) so that unit tests
 * can set process.env overrides after import.
 */
function adminBasicAuth(env: NodeJS.ProcessEnv = process.env): string {
  // Resolution chain (first match wins):
  //   1. Secret volume mount at STALWART_ADMIN_CREDS_DIR (default
  //      /etc/stalwart-creds). Canonical path: kubelet refreshes the
  //      mounted file within ~60s of a rotation, so platform-api
  //      picks up the new password without a pod restart.
  //   2. STALWART_ADMIN_PASSWORD / STALWART_ADMIN_SECRET_PLAIN /
  //      ADMIN_SECRET_PLAIN env vars (legacy, dev-mode only).
  // Cut 3 follow-up (2026-05-04): the file-based path was missing here
  // even though the doc-comment promised it. Symptom: the staging
  // /admin/mail/rotate-admin-password 500'd with "STALWART_ADMIN_PASSWORD
  // not configured" because only the env-var fallback was implemented.
  const password =
    readPasswordFromCredsDir(env) ??
    env.STALWART_ADMIN_PASSWORD ??
    env.STALWART_ADMIN_SECRET_PLAIN ??
    env.ADMIN_SECRET_PLAIN ??
    '';
  const trimmed = password.trim();
  if (!trimmed) {
    throw new Error(
      'Stalwart admin password is not configured '
      + '(STALWART_ADMIN_CREDS_DIR/ADMIN_SECRET_PLAIN file or '
      + 'STALWART_ADMIN_PASSWORD / STALWART_ADMIN_SECRET_PLAIN / ADMIN_SECRET_PLAIN env)',
    );
  }
  const username = (env.STALWART_ADMIN_USER?.trim()) || 'admin';
  return `Basic ${Buffer.from(`${username}:${trimmed}`).toString('base64')}`;
}

function readPasswordFromCredsDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.STALWART_ADMIN_CREDS_DIR?.trim();
  if (!dir) return undefined;
  try {
    // Sync read — ~64-byte file, well under 1ms per call. An async
    // path would require threading awaits through every JMAP call site
    // for no measurable benefit.
    const content = fsReadFileSync(`${dir}/ADMIN_SECRET_PLAIN`, 'utf8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export class JmapError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'JmapError';
  }
}

/**
 * Extract the first method-response of the expected type from a
 * JmapResponse, throwing JmapError on protocol-level errors.
 */
function extractResponse<T>(
  response: JmapResponse,
  expectedMethod: string,
  callId: string,
): T {
  for (const [method, args, id] of response.methodResponses) {
    if (id !== callId) continue;
    if (method === 'error') {
      const err = args as { type: string; description?: string };
      throw new JmapError(
        `JMAP error: ${err.description ?? err.type}`,
        err.type,
        args,
      );
    }
    if (method === expectedMethod) {
      return args as T;
    }
  }
  throw new JmapError(
    `Expected JMAP response '${expectedMethod}' (call=${callId}) not found in response`,
    'missingResponse',
    response.methodResponses,
  );
}

/**
 * Default per-request timeout. A hung Stalwart pod or network partition
 * would otherwise block the caller indefinitely; the scheduler's
 * `running = true` guard means a single stuck cycle blocks all future
 * cycles. Override via JMAP_TIMEOUT_MS env var when needed (e.g. for
 * long-running snapshot/apply operations).
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Raw JMAP request/response cycle */
async function jmapPost(
  baseUrl: string,
  auth: string,
  body: JmapRequest,
): Promise<JmapResponse> {
  const url = `${baseUrl}/jmap/`;
  const timeoutMs = Number(process.env.JMAP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new JmapError(
      `JMAP request to ${url} failed: HTTP ${res.status} ${res.statusText}`,
      'httpError',
      { status: res.status, body: text.slice(0, 500) },
    );
  }

  // Code-review L1 fix (2026-05-04): guard the network boundary.
  // A 200 response from a reverse-proxy error page (Cloudflare, nginx
  // landing page, etc.) would JSON.parse fine but lack the expected
  // shape — extractResponse would then throw a confusing TypeError on
  // .methodResponses. Validate the minimal shape before returning.
  const data = (await res.json()) as unknown;
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { methodResponses?: unknown }).methodResponses)
  ) {
    throw new JmapError(
      `JMAP response from ${url} did not match the protocol shape (missing methodResponses array)`,
      'malformedResponse',
      data,
    );
  }
  return data as JmapResponse;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch the JMAP session object.
 *
 * Returns the account IDs and capability URIs. The principal-management
 * account ID is under `primaryAccounts[JMAP_PRINCIPALS]`.
 */
export async function getJmapSession(
  baseUrl: string = STALWART_MGMT_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JmapSession> {
  const timeoutMs = Number(env.JMAP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const res = await fetch(`${baseUrl}/jmap/session`, {
    headers: {
      Authorization: adminBasicAuth(env),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new JmapError(
      `JMAP session fetch failed: HTTP ${res.status}`,
      'httpError',
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  // Same protocol-shape guard as jmapPost — see L1 comment there.
  const data = (await res.json()) as unknown;
  if (
    !data ||
    typeof data !== 'object' ||
    typeof (data as { primaryAccounts?: unknown }).primaryAccounts !== 'object'
  ) {
    throw new JmapError(
      `JMAP session from ${baseUrl} did not match the protocol shape (missing primaryAccounts object)`,
      'malformedResponse',
      data,
    );
  }
  return data as JmapSession;
}

/**
 * `Principal/get` — fetch one or more principals by ID.
 *
 * Pass `ids: null` to list ALL principals (use with caution on large
 * installs; Stalwart applies a server-side limit and paginates).
 * Pass `ids: [id1, id2]` to fetch specific entries.
 *
 * The `properties` array controls which fields are returned; omit for
 * all fields.
 */
export async function principalGet(params: {
  accountId: JmapAccountId;
  ids: readonly string[] | null;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapGetResponse<StalwartPrincipal>> {
  const {
    accountId,
    ids,
    properties,
    baseUrl = STALWART_MGMT_URL,
    env = process.env,
  } = params;

  const auth = adminBasicAuth(env);
  const callId = 'c0';

  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_PRINCIPALS],
    methodCalls: [
      [
        'Principal/get',
        {
          accountId,
          ids: ids ?? null,
          ...(properties ? { properties } : {}),
        },
        callId,
      ],
    ],
  };

  const res = await jmapPost(baseUrl, auth, req);
  return extractResponse<JmapGetResponse<StalwartPrincipal>>(res, 'Principal/get', callId);
}

/**
 * `Principal/get` shorthand — fetch a single principal by ID.
 *
 * Returns `null` when the server reports the ID in `notFound`.
 */
export async function principalGetOne(params: {
  accountId: JmapAccountId;
  id: string;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal | null> {
  const result = await principalGet({ ...params, ids: [params.id] });
  if (result.notFound.includes(params.id)) return null;
  return result.list[0] ?? null;
}

/**
 * `Principal/set` — create, update, or destroy principals.
 *
 * This is the low-level entry point. Use the typed helpers
 * `createMailbox`, `createDomain`, `updatePrincipal`, and
 * `destroyPrincipal` for the common cases.
 */
export async function principalSet<T extends Partial<StalwartPrincipal>>(params: {
  accountId: JmapAccountId;
  request: JmapSetRequest<T>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartPrincipal>> {
  const {
    accountId,
    request,
    baseUrl = STALWART_MGMT_URL,
    env = process.env,
  } = params;

  const auth = adminBasicAuth(env);
  const callId = 'c0';

  const jmapReq: JmapRequest = {
    using: [JMAP_CORE, JMAP_PRINCIPALS],
    methodCalls: [
      [
        'Principal/set',
        { accountId, ...request },
        callId,
      ],
    ],
  };

  const res = await jmapPost(baseUrl, auth, jmapReq);
  return extractResponse<JmapSetResponse<StalwartPrincipal>>(res, 'Principal/set', callId);
}

/**
 * Create an individual mailbox (email account).
 *
 * Throws `JmapError` if the server rejects the create (e.g. duplicate
 * address, quota policy, etc).
 *
 * Returns the created principal as the server assigned it (with `id`).
 */
export async function createMailbox(params: {
  accountId: JmapAccountId;
  input: CreateMailboxInput;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal> {
  const { accountId, input, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      create: { 'new-mailbox': input },
    },
  });

  const notCreated = result.notCreated?.['new-mailbox'];
  if (notCreated) {
    throw new JmapError(
      `Failed to create mailbox '${input.name}': ${notCreated.description ?? notCreated.type}`,
      notCreated.type,
      notCreated,
    );
  }

  const created = result.created?.['new-mailbox'];
  if (!created) {
    throw new JmapError(
      `Principal/set create returned no result for mailbox '${input.name}'`,
      'missingResult',
      result,
    );
  }
  return created;
}

/**
 * Register a domain in Stalwart.
 *
 * After this call, Stalwart will start accepting mail for the domain
 * and will populate `dnsZoneFile` with the DNS records it needs
 * published (MX, SPF, DKIM, etc). The dns-sync module polls that field.
 *
 * Returns the created principal (with server-assigned `id` and
 * `dnsZoneFile`).
 */
export async function createDomain(params: {
  accountId: JmapAccountId;
  input: CreateDomainInput;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal> {
  const { accountId, input, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      create: { 'new-domain': input },
    },
  });

  const notCreated = result.notCreated?.['new-domain'];
  if (notCreated) {
    throw new JmapError(
      `Failed to create domain '${input.name}': ${notCreated.description ?? notCreated.type}`,
      notCreated.type,
      notCreated,
    );
  }

  const created = result.created?.['new-domain'];
  if (!created) {
    throw new JmapError(
      `Principal/set create returned no result for domain '${input.name}'`,
      'missingResult',
      result,
    );
  }
  return created;
}

/**
 * Update an existing principal by ID (partial patch).
 *
 * `patch` is a JSON patch-like map of property-paths to new values
 * (Stalwart uses the JMAP /set update semantics, not RFC 6902).
 */
export async function updatePrincipal(params: {
  accountId: JmapAccountId;
  id: string;
  patch: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, id, patch, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      update: { [id]: patch },
    },
  });

  const notUpdated = result.notUpdated?.[id];
  if (notUpdated) {
    throw new JmapError(
      `Failed to update principal '${id}': ${notUpdated.description ?? notUpdated.type}`,
      notUpdated.type,
      notUpdated,
    );
  }
}

/**
 * Destroy a principal (mailbox or domain) by ID.
 *
 * Throws `JmapError` if the server refuses (e.g. domain still has
 * active mailboxes).
 */
export async function destroyPrincipal(params: {
  accountId: JmapAccountId;
  id: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, id, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      destroy: [id],
    },
  });

  const notDestroyed = result.notDestroyed?.[id];
  if (notDestroyed) {
    throw new JmapError(
      `Failed to destroy principal '${id}': ${notDestroyed.description ?? notDestroyed.type}`,
      notDestroyed.type,
      notDestroyed,
    );
  }
}

/**
 * `Principal/changes` — detect which principals changed since a
 * known state token.
 *
 * Use the `state` field from a previous `Principal/get` or
 * `Principal/set` response as `sinceState`. A new `state` from
 * the session object is also valid.
 *
 * If `hasMoreChanges` is true in the response, call again with the
 * returned `newState` until it is false.
 */
export async function principalChanges(params: {
  accountId: JmapAccountId;
  sinceState: string;
  maxChanges?: number;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapChangesResponse> {
  const {
    accountId,
    sinceState,
    maxChanges = 256,
    baseUrl = STALWART_MGMT_URL,
    env = process.env,
  } = params;

  const auth = adminBasicAuth(env);
  const callId = 'c0';

  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_PRINCIPALS],
    methodCalls: [
      [
        'Principal/changes',
        { accountId, sinceState, maxChanges },
        callId,
      ],
    ],
  };

  const res = await jmapPost(baseUrl, auth, req);
  return extractResponse<JmapChangesResponse>(res, 'Principal/changes', callId);
}

/**
 * Fetch the DNS zone-file text for a single domain principal.
 *
 * Stalwart populates `dnsZoneFile` on the Domain principal object with
 * all the DNS records it needs published (MX, SPF, DKIM, DMARC, etc)
 * in standard zone-file format. This is the authoritative source for
 * M5 DNS sync — we fetch this and diff it against the platform's
 * `dns_records` table.
 *
 * Returns `null` when the domain does not exist or `dnsZoneFile` is
 * empty (e.g. the domain was just created and Stalwart hasn't populated
 * the field yet).
 */
export async function getDomainDnsZoneFile(params: {
  accountId: JmapAccountId;
  domainPrincipalId: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const principal = await principalGetOne({
    ...params,
    id: params.domainPrincipalId,
    properties: ['id', 'name', 'type', 'dnsZoneFile'],
  });
  if (!principal) return null;
  return principal.dnsZoneFile ?? null;
}

/**
 * Find a domain principal by name (e.g. "example.com").
 *
 * Stalwart doesn't have a server-side filter for Principal/get by name,
 * so we fetch ALL domain principals and filter client-side. This is
 * acceptable for the expected number of domains per install (<1000).
 *
 * Returns `null` if not found.
 */
export async function findDomainByName(params: {
  accountId: JmapAccountId;
  domainName: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal | null> {
  const { accountId, domainName, baseUrl, env } = params;
  const result = await principalGet({
    accountId,
    ids: null,
    properties: ['id', 'name', 'type', 'dnsZoneFile'],
    baseUrl,
    env,
  });
  return result.list.find(
    (p) => p.type === 'domain' && p.name === domainName,
  ) ?? null;
}

/**
 * Find an individual mailbox principal by email address.
 *
 * Fetches all individual principals and filters by the `emails` array.
 * Returns `null` if not found.
 */
export async function findMailboxByEmail(params: {
  accountId: JmapAccountId;
  email: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal | null> {
  const { accountId, email, baseUrl, env } = params;
  const result = await principalGet({
    accountId,
    ids: null,
    properties: ['id', 'name', 'type', 'emails'],
    baseUrl,
    env,
  });
  return result.list.find(
    (p) => p.type === 'individual' && p.emails?.includes(email),
  ) ?? null;
}
