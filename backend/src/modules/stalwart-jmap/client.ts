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
// Cut 3 follow-up (2026-05-04): Stalwart 0.16 implements its OWN
// extension namespace for principal management — `x:Account/*` for
// individual mailboxes / admin users and `x:Domain/*` for mail domains.
// Standard JMAP `Principal/*` (RFC 8620) is NOT implemented; calls
// against it return `urn:ietf:params:jmap:error:notRequest`. Use
// JMAP_STALWART for every Account/Domain operation.
const JMAP_STALWART = 'urn:stalwart:jmap';

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

// ── Stalwart x:Account / x:Domain primitives ────────────────────────────────
//
// Cut 3 follow-up (2026-05-04): Stalwart 0.16 implements its own JMAP
// extension namespace for principal management — `x:Account/*` for
// individual users (mailboxes, admins) and `x:Domain/*` for mail
// domains. RFC 8620 standard `Principal/*` is NOT implemented; calls
// against it return 400 with `notRequest`. The functions below are
// the on-the-wire-correct primitives; the legacy `principalGet/Set`
// helpers further down route through these.

/** Raw response shape from x:Account/get. */
interface XAccountGetResponse {
  readonly accountId: JmapAccountId;
  readonly state: string;
  readonly list: readonly Record<string, unknown>[];
  readonly notFound: readonly string[];
}

/** Raw response shape from x:Account/query. */
interface XQueryResponse {
  readonly accountId: JmapAccountId;
  readonly state: string;
  readonly ids: readonly string[];
  readonly position?: number;
  readonly total?: number;
}

async function _xCall<T>(
  capability: string,
  method: string,
  args: Record<string, unknown>,
  baseUrl: string = STALWART_MGMT_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const auth = adminBasicAuth(env);
  const callId = 'c0';
  const req: JmapRequest = {
    using: [JMAP_CORE, capability],
    methodCalls: [[method, args, callId]],
  };
  const res = await jmapPost(baseUrl, auth, req);
  return extractResponse<T>(res, method, callId);
}

/**
 * `x:Account/get` — fetch one or more accounts (users, admins) by ID.
 * Pass `ids: null` to list all accounts.
 */
export async function accountGet(params: {
  accountId: JmapAccountId;
  ids: readonly string[] | null;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XAccountGetResponse> {
  const { accountId, ids, properties, baseUrl, env } = params;
  return _xCall<XAccountGetResponse>(
    JMAP_STALWART,
    'x:Account/get',
    { accountId, ids: ids ?? null, ...(properties ? { properties } : {}) },
    baseUrl, env,
  );
}

/**
 * `x:Account/query` — search accounts by filter.
 * Stalwart accepts `{ name }`, `{ domainId }`, etc. on the filter.
 */
export async function accountQuery(params: {
  accountId: JmapAccountId;
  filter?: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XQueryResponse> {
  const { accountId, filter, baseUrl, env } = params;
  return _xCall<XQueryResponse>(
    JMAP_STALWART,
    'x:Account/query',
    { accountId, ...(filter ? { filter } : {}) },
    baseUrl, env,
  );
}

/**
 * `x:Account/set` — create / update / destroy accounts.
 * The `create` payload requires `@type: "User"` and uses
 * `domainId` (not `emails`) to bind the account to its domain.
 * Password updates use the `credentials` map shape:
 *   `{ "credentials/0/secret": "<new>" }`
 * for partial updates, or full replace via
 *   `{ "credentials": { "0": { "@type": "Password", "secret": ... } } }`.
 */
export async function accountSet(params: {
  accountId: JmapAccountId;
  request: JmapSetRequest<Record<string, unknown>>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<Record<string, unknown>>> {
  const { accountId, request, baseUrl, env } = params;
  return _xCall<JmapSetResponse<Record<string, unknown>>>(
    JMAP_STALWART,
    'x:Account/set',
    { accountId, ...request },
    baseUrl, env,
  );
}

/** `x:Domain/get` — fetch one or more domains by ID. */
export async function domainGet(params: {
  accountId: JmapAccountId;
  ids: readonly string[] | null;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XAccountGetResponse> {
  const { accountId, ids, properties, baseUrl, env } = params;
  return _xCall<XAccountGetResponse>(
    JMAP_STALWART,
    'x:Domain/get',
    { accountId, ids: ids ?? null, ...(properties ? { properties } : {}) },
    baseUrl, env,
  );
}

/** `x:Domain/query` — search domains by filter (typically `{ name }`). */
export async function domainQuery(params: {
  accountId: JmapAccountId;
  filter?: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XQueryResponse> {
  const { accountId, filter, baseUrl, env } = params;
  return _xCall<XQueryResponse>(
    JMAP_STALWART,
    'x:Domain/query',
    { accountId, ...(filter ? { filter } : {}) },
    baseUrl, env,
  );
}

/** `x:Domain/set` — create / update / destroy domains. */
export async function domainSet(params: {
  accountId: JmapAccountId;
  request: JmapSetRequest<Record<string, unknown>>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<Record<string, unknown>>> {
  const { accountId, request, baseUrl, env } = params;
  return _xCall<JmapSetResponse<Record<string, unknown>>>(
    JMAP_STALWART,
    'x:Domain/set',
    { accountId, ...request },
    baseUrl, env,
  );
}

// ── Legacy Principal/* compatibility shims ──────────────────────────────────
//
// `principalGet` / `principalSet` keep their old signatures (a unified
// "type": individual|domain shape) so existing callers compile without
// change. Internally they fan out to x:Account + x:Domain. Eventually
// every call site should move to the typed x:* helpers above; until
// then, the shim ensures we never hit the unsupported standard
// `Principal/*` methods on the wire.

/**
 * Map an x:Account/get list entry to the legacy `StalwartPrincipal`
 * shape (with `type: 'individual'`).
 */
function _accountToPrincipal(raw: Record<string, unknown>): StalwartPrincipal {
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const description = typeof raw.description === 'string' ? raw.description : null;
  // x:Account binds to a single domainId; the platform-side legacy
  // shape stores email addresses. Synthesize the email from the
  // emails array if present, else leave undefined and let the caller
  // backfill via domainGet if needed.
  const emails = Array.isArray(raw.emails)
    ? (raw.emails as string[]).filter((e) => typeof e === 'string')
    : undefined;
  return { id, type: 'individual', name, description, emails };
}

function _domainToPrincipal(raw: Record<string, unknown>): StalwartPrincipal {
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const description = typeof raw.description === 'string' ? raw.description : null;
  const dnsZoneFile = typeof raw.dnsZoneFile === 'string' ? raw.dnsZoneFile : null;
  return { id, type: 'domain', name, description, dnsZoneFile };
}

/**
 * `principalGet` (legacy) — fetches individuals and/or domains and
 * returns them as a unified list. Routes through x:Account/get and
 * x:Domain/get under the hood.
 *
 * Pass `ids: null` to list ALL principals across both namespaces.
 * Pass `ids: [...]` and we'll try x:Account first, then x:Domain for
 * any IDs that came back in `notFound`.
 */
export async function principalGet(params: {
  accountId: JmapAccountId;
  ids: readonly string[] | null;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapGetResponse<StalwartPrincipal>> {
  const { accountId, ids, properties, baseUrl, env } = params;

  // List all → query both namespaces in parallel.
  if (ids === null) {
    const [accounts, domains] = await Promise.all([
      accountGet({ accountId, ids: null, properties, baseUrl, env }),
      domainGet({ accountId, ids: null, properties, baseUrl, env }),
    ]);
    return {
      accountId,
      state: `${accounts.state}|${domains.state}`,
      list: [
        ...accounts.list.map(_accountToPrincipal),
        ...domains.list.map(_domainToPrincipal),
      ],
      notFound: [],
    };
  }

  // Specific IDs — try x:Account first; anything in notFound retry on x:Domain.
  const accountResp = await accountGet({ accountId, ids, properties, baseUrl, env });
  const stillMissing = accountResp.notFound;
  let domainList: StalwartPrincipal[] = [];
  let trulyNotFound: readonly string[] = [];
  if (stillMissing.length > 0) {
    const domainResp = await domainGet({
      accountId,
      ids: stillMissing,
      properties,
      baseUrl,
      env,
    });
    domainList = domainResp.list.map(_domainToPrincipal);
    trulyNotFound = domainResp.notFound;
  }
  return {
    accountId,
    state: accountResp.state,
    list: [
      ...accountResp.list.map(_accountToPrincipal),
      ...domainList,
    ],
    notFound: trulyNotFound,
  };
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
 * `principalSet` (legacy compatibility shim) — dispatches each
 * `create` entry to x:Account/set or x:Domain/set based on the
 * `type` field, and `update` / `destroy` IDs are sent to x:Account
 * first with x:Domain as the fallback.
 *
 * The Stalwart 0.16 server doesn't support a unified `Principal/set`
 * method — it expects calls split per principal kind. This shim
 * keeps the legacy callers (mailboxes/email-domains/principals-sync)
 * working without forcing them to know which namespace each ID lives
 * in.
 */
export async function principalSet<T extends Partial<StalwartPrincipal>>(params: {
  accountId: JmapAccountId;
  request: JmapSetRequest<T>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartPrincipal>> {
  const { accountId, request, baseUrl, env } = params;

  // Split create into account creates vs domain creates by `type`.
  const accountCreates: Record<string, Record<string, unknown>> = {};
  const domainCreates: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(request.create ?? {})) {
    const principal = v as unknown as StalwartPrincipal & {
      readonly emails?: readonly string[];
      readonly secrets?: readonly string[];
    };
    if (principal.type === 'individual') {
      // Map legacy → x:Account/User shape.
      const credentials: Record<string, unknown> = {};
      const secrets = principal.secrets ?? [];
      secrets.forEach((s, i) => {
        credentials[String(i)] = {
          '@type': 'Password',
          secret: s,
          allowedIps: {},
          expiresAt: null,
        };
      });
      // x:Account requires `domainId`, but the legacy callers only
      // pass `emails`. The mailboxes/service.ts caller now resolves
      // domainId before calling createMailbox; older paths still
      // passing `emails` will fail with a clear server error.
      const accountPayload: Record<string, unknown> = {
        '@type': 'User',
        name: principal.name,
      };
      if (principal.description) accountPayload.description = principal.description;
      if (principal.emails && principal.emails.length > 0) {
        accountPayload.emails = principal.emails;
      }
      if (Object.keys(credentials).length > 0) accountPayload.credentials = credentials;
      accountCreates[k] = accountPayload;
    } else if (principal.type === 'domain') {
      domainCreates[k] = { name: principal.name };
    }
  }

  // Updates / destroys: dispatch by trying x:Account first.
  const updates = request.update ?? {};
  const destroys = request.destroy ?? [];

  // Run x:Account/set with the account-side slices.
  const accountResp = await accountSet({
    accountId,
    request: {
      ...(Object.keys(accountCreates).length > 0 ? { create: accountCreates } : {}),
      ...(Object.keys(updates).length > 0 ? { update: updates as Record<string, Record<string, unknown>> } : {}),
      ...(destroys.length > 0 ? { destroy: destroys } : {}),
      ifInState: request.ifInState,
    },
    baseUrl,
    env,
  });

  // Anything not-{updated|destroyed} on x:Account because of `notFound`
  // → retry on x:Domain. Stalwart's `notUpdated` / `notDestroyed`
  // payloads include `type: 'notFound'` for IDs in the wrong namespace.
  const domainUpdates: Record<string, Record<string, unknown>> = {};
  for (const [id, err] of Object.entries(accountResp.notUpdated ?? {})) {
    if (err.type === 'notFound' && updates[id]) {
      domainUpdates[id] = updates[id] as Record<string, unknown>;
    }
  }
  const domainDestroys: string[] = [];
  for (const [id, err] of Object.entries(accountResp.notDestroyed ?? {})) {
    if (err.type === 'notFound') domainDestroys.push(id);
  }

  if (
    Object.keys(domainCreates).length === 0 &&
    Object.keys(domainUpdates).length === 0 &&
    domainDestroys.length === 0
  ) {
    // Pure-account operation; map the response directly.
    return {
      accountId: accountResp.accountId,
      oldState: accountResp.oldState,
      newState: accountResp.newState,
      created: accountResp.created
        ? Object.fromEntries(
            Object.entries(accountResp.created).map(([k, v]) => [k, _accountToPrincipal(v)]),
          )
        : null,
      updated: accountResp.updated as Record<string, StalwartPrincipal | null> | null,
      destroyed: accountResp.destroyed,
      notCreated: accountResp.notCreated,
      notUpdated: accountResp.notUpdated,
      notDestroyed: accountResp.notDestroyed,
    };
  }

  const domainResp = await domainSet({
    accountId,
    request: {
      ...(Object.keys(domainCreates).length > 0 ? { create: domainCreates } : {}),
      ...(Object.keys(domainUpdates).length > 0 ? { update: domainUpdates } : {}),
      ...(domainDestroys.length > 0 ? { destroy: domainDestroys } : {}),
      ifInState: request.ifInState,
    },
    baseUrl,
    env,
  });

  // Merge the two responses. Account-side notUpdated/notDestroyed
  // entries that were resolved on x:Domain are removed from the
  // notFound bucket.
  const mergedNotUpdated: Record<string, JmapSetError> = { ...(accountResp.notUpdated ?? {}) };
  for (const id of Object.keys(domainUpdates)) {
    if (domainResp.updated && id in domainResp.updated) delete mergedNotUpdated[id];
    if (domainResp.notUpdated && id in domainResp.notUpdated) {
      mergedNotUpdated[id] = domainResp.notUpdated[id];
    }
  }
  const mergedNotDestroyed: Record<string, JmapSetError> = { ...(accountResp.notDestroyed ?? {}) };
  for (const id of domainDestroys) {
    if (domainResp.destroyed?.includes(id)) delete mergedNotDestroyed[id];
    if (domainResp.notDestroyed && id in domainResp.notDestroyed) {
      mergedNotDestroyed[id] = domainResp.notDestroyed[id];
    }
  }

  const created: Record<string, StalwartPrincipal> = {};
  if (accountResp.created) {
    for (const [k, v] of Object.entries(accountResp.created)) created[k] = _accountToPrincipal(v);
  }
  if (domainResp.created) {
    for (const [k, v] of Object.entries(domainResp.created)) created[k] = _domainToPrincipal(v);
  }

  return {
    accountId,
    oldState: accountResp.oldState,
    newState: `${accountResp.newState}|${domainResp.newState}`,
    created: Object.keys(created).length > 0 ? created : null,
    updated: { ...(accountResp.updated as object | null ?? {}), ...(domainResp.updated as object | null ?? {}) } as Record<string, StalwartPrincipal | null> | null,
    destroyed: [...(accountResp.destroyed ?? []), ...(domainResp.destroyed ?? [])],
    notCreated: { ...(accountResp.notCreated ?? {}), ...(domainResp.notCreated ?? {}) },
    notUpdated: Object.keys(mergedNotUpdated).length > 0 ? mergedNotUpdated : null,
    notDestroyed: Object.keys(mergedNotDestroyed).length > 0 ? mergedNotDestroyed : null,
  };
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
  const { accountId, sinceState, maxChanges = 256, baseUrl, env } = params;
  // Stalwart 0.16: split the call across x:Account/changes and
  // x:Domain/changes; merge the deltas into the legacy unified shape.
  const sinceStates = sinceState.split('|', 2);
  const sinceAccount = sinceStates[0] ?? '';
  const sinceDomain = sinceStates[1] ?? sinceStates[0] ?? '';
  const [accountChanges, domainChanges] = await Promise.all([
    _xCall<JmapChangesResponse>(
      JMAP_STALWART, 'x:Account/changes',
      { accountId, sinceState: sinceAccount, maxChanges },
      baseUrl, env,
    ),
    _xCall<JmapChangesResponse>(
      JMAP_STALWART, 'x:Domain/changes',
      { accountId, sinceState: sinceDomain, maxChanges },
      baseUrl, env,
    ),
  ]);
  return {
    accountId,
    oldState: sinceState,
    newState: `${accountChanges.newState}|${domainChanges.newState}`,
    hasMoreChanges: accountChanges.hasMoreChanges || domainChanges.hasMoreChanges,
    created: [...accountChanges.created, ...domainChanges.created],
    updated: [...accountChanges.updated, ...domainChanges.updated],
    destroyed: [...accountChanges.destroyed, ...domainChanges.destroyed],
  };
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
  // x:Domain/query supports server-side `name` filtering — no need to
  // list-and-filter client-side anymore.
  const queryRes = await domainQuery({
    accountId,
    filter: { name: domainName },
    baseUrl,
    env,
  });
  if (queryRes.ids.length === 0) return null;
  const getRes = await domainGet({
    accountId,
    ids: [queryRes.ids[0]],
    properties: ['id', 'name', 'description', 'dnsZoneFile'],
    baseUrl,
    env,
  });
  const raw = getRes.list[0];
  return raw ? _domainToPrincipal(raw) : null;
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
  // Server-side filter via x:Account/query, then x:Account/get for the
  // matching IDs. Stalwart 0.16 indexes accounts by email; one query
  // returns at most one match.
  const queryRes = await accountQuery({
    accountId,
    filter: { email },
    baseUrl,
    env,
  });
  if (queryRes.ids.length === 0) return null;
  const getRes = await accountGet({
    accountId,
    ids: [queryRes.ids[0]],
    properties: ['id', 'name', 'description', 'emails'],
    baseUrl,
    env,
  });
  const raw = getRes.list[0];
  return raw ? _accountToPrincipal(raw) : null;
}
