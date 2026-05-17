/**
 * Platform mail / webmail settings.
 *
 * Phase 2c.5 introduced this module for a single setting —
 * `default_webmail_url`. Phase 3.A.1 extends it with the mail server
 * hostname setting that drives Stalwart's certificate provisioning
 * and the Stalwart TOML config's `hostname = ...` line.
 *
 * Both settings live in the key-value `platform_settings` table. No
 * schema changes required for new keys — they're just rows.
 *
 * 2026-05-09: mail server hostname is editable post-bootstrap via
 * `SystemSettings.defaultHostname` (verified empirically — Bootstrap
 * is a transient install-only object that's gone post-install, but
 * SystemSettings is the runtime singleton that drives banners +
 * outbound EHLO uniformly). `applyMailServerHostnameToStalwart()`
 * pushes a name change through the JMAP API.
 */

import { eq, sql } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { readStalwartCredentials } from '../mail-admin/credentials.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

// In-cluster URL of Stalwart's management HTTP API. We call this
// directly (NOT through the K8s apiserver-proxy) because the proxy's
// `services/proxy` verb consumes the Authorization header for its own
// SA-token authentication — and we need to send Basic auth to
// Stalwart on the SAME header. The two collide and K8s returns 401.
// Direct in-cluster DNS sidesteps that: platform-api pod can reach
// stalwart-mgmt.mail.svc.cluster.local on port 8080 with a single
// Authorization header that goes straight to Stalwart untouched.
const STALWART_MGMT_URL = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
const STALWART_JMAP_TIMEOUT_MS = 10_000;

// JMAP method-response envelope. Each entry is a 3-tuple:
// [methodName, payload, callId]. We only consume `payload`; the call
// id and method name are echoed back as-is.
type JmapMethodResponse = readonly [string, Record<string, unknown>, string];

interface JmapResponse {
  readonly methodResponses: readonly JmapMethodResponse[];
}

/**
 * POST a JMAP request body to Stalwart's mgmt API. Authenticates via
 * the mounted Stalwart admin Secret (file or env via the canonical
 * readStalwartCredentials helper). Returns { status, body } so the
 * caller can do its own JSON validation.
 */
async function postJmap(body: string): Promise<{ status: number; body: string }> {
  const { username, password } = readStalwartCredentials(process.env);
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const url = new URL(`${STALWART_MGMT_URL}/jmap`);
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 8080,
        path: url.pathname,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body, 'utf8')),
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.setTimeout(STALWART_JMAP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Stalwart JMAP timed out after ${STALWART_JMAP_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse a JMAP response body, validating the shape we rely on
 * (`methodResponses[0][1]` exists and is an object). Throws an
 * Error with a truncated body excerpt when the response is not
 * valid JSON or doesn't match the expected envelope — kept short
 * so it doesn't leak entire HTML error pages from k8s apiserver
 * proxy failures into operator-visible messages.
 */
function parseJmapBody(body: string, ctx: string): JmapResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(
      `${ctx}: Stalwart returned non-JSON body (excerpt: ${body.slice(0, 80).replace(/\s+/g, ' ')}…)`,
    );
  }
  if (
    !raw
    || typeof raw !== 'object'
    || !('methodResponses' in raw)
    || !Array.isArray((raw as JmapResponse).methodResponses)
  ) {
    throw new Error(`${ctx}: Stalwart response missing methodResponses array`);
  }
  const responses = (raw as JmapResponse).methodResponses;
  if (responses.length === 0 || !Array.isArray(responses[0]) || responses[0].length < 2) {
    throw new Error(`${ctx}: Stalwart response had no method responses`);
  }
  const payload = responses[0][1];
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${ctx}: Stalwart response payload was not an object`);
  }
  // If Stalwart returned a method-level error envelope, surface it
  // with its declared type so the operator sees the real reason.
  const maybeErr = payload as { type?: string; description?: string };
  if (maybeErr.type && typeof maybeErr.type === 'string') {
    const detail = typeof maybeErr.description === 'string' ? `: ${maybeErr.description}` : '';
    throw new Error(`${ctx}: Stalwart returned ${maybeErr.type}${detail}`);
  }
  return raw as JmapResponse;
}

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

// Apex-derived defaults.
//
// Precedence:
//   1. explicit DB row (operator edited via admin panel)
//   2. legacy env var (WEBMAIL_URL / STALWART_HOSTNAME / MAIL_SERVER_HOSTNAME)
//   3. webmail.<apex> / mail.<apex> derived from platform_settings.ingress_base_domain
//   4. placeholder literal — only reached on a fresh install before the
//      apex has been configured
async function defaultWebmailUrl(db: Database): Promise<string> {
  if (process.env.WEBMAIL_URL) return process.env.WEBMAIL_URL;
  const apex = (await getSetting(db, 'ingress_base_domain'))?.trim().replace(/\.+$/, '');
  return apex ? `https://webmail.${apex}/` : 'https://webmail.example.com';
}

async function defaultMailHostname(db: Database): Promise<string> {
  if (process.env.STALWART_HOSTNAME) return process.env.STALWART_HOSTNAME;
  if (process.env.MAIL_SERVER_HOSTNAME) return process.env.MAIL_SERVER_HOSTNAME;
  const apex = (await getSetting(db, 'ingress_base_domain'))?.trim().replace(/\.+$/, '');
  return apex ? `mail.${apex}` : 'mail.example.com';
}

export type WebmailEngine = 'roundcube' | 'bulwark';

/**
 * Read the platform-wide default webmail engine.
 *
 * **Fresh-install default (2026-05-17 onward): bulwark.** Bulwark
 * v1.6.7 stable ships native master-user impersonation (upstream
 * issue #296). New clusters land on Bulwark out of the box —
 * JMAP-native, calendar/contacts/files in one SPA, single shared
 * Deployment.
 *
 * Existing clusters that explicitly stored `default_webmail_engine`
 * keep their explicit setting — only the unset/never-touched case
 * changed.
 *
 * Operators can flip to Roundcube via the admin UI
 * (PATCH /admin/webmail-settings). The mutex reconciler swaps
 * Ingress + Pod replicas in one transaction.
 *
 * Per-tenant override is out of scope for v1 — all tenants share the
 * platform default. The setting is super_admin only.
 */
export async function getDefaultWebmailEngine(db: Database): Promise<WebmailEngine> {
  const raw = (await getSetting(db, 'default_webmail_engine'))?.trim().toLowerCase();
  if (raw === 'roundcube') return 'roundcube';
  // 'bulwark' OR unset (fresh install) OR any unknown value → bulwark
  return 'bulwark';
}

export async function getWebmailSettings(db: Database) {
  const defaultWebmailUrlStored = await getSetting(db, 'default_webmail_url');
  const mailServerHostnameStored = await getSetting(db, 'mail_server_hostname');
  const rateLimitRaw = await getSetting(db, 'email_send_rate_limit_default');
  const emailSendRateLimitDefault = rateLimitRaw ? parseInt(rateLimitRaw, 10) : null;
  return {
    defaultWebmailUrl: defaultWebmailUrlStored ?? (await defaultWebmailUrl(db)),
    mailServerHostname: mailServerHostnameStored ?? (await defaultMailHostname(db)),
    emailSendRateLimitDefault: Number.isFinite(emailSendRateLimitDefault) ? emailSendRateLimitDefault : null,
    defaultWebmailEngine: await getDefaultWebmailEngine(db),
  };
}

export async function updateWebmailSettings(
  db: Database,
  input: {
    defaultWebmailUrl?: string;
    mailServerHostname?: string;
    emailSendRateLimitDefault?: number | null;
    defaultWebmailEngine?: WebmailEngine;
  },
) {
  if (input.defaultWebmailUrl !== undefined) {
    await setSetting(db, 'default_webmail_url', input.defaultWebmailUrl);
  }
  if (input.mailServerHostname !== undefined) {
    await setSetting(db, 'mail_server_hostname', input.mailServerHostname);
  }
  if (input.emailSendRateLimitDefault !== undefined) {
    if (input.emailSendRateLimitDefault === null) {
      // Clear the setting (Stalwart will have no global throttle rule)
      await setSetting(db, 'email_send_rate_limit_default', '');
    } else {
      await setSetting(db, 'email_send_rate_limit_default', String(input.emailSendRateLimitDefault));
    }
  }
  if (input.defaultWebmailEngine !== undefined) {
    if (input.defaultWebmailEngine !== 'roundcube' && input.defaultWebmailEngine !== 'bulwark') {
      throw new Error(`Invalid webmail engine: ${input.defaultWebmailEngine}`);
    }
    await setSetting(db, 'default_webmail_engine', input.defaultWebmailEngine);
  }
  return getWebmailSettings(db);
}

export async function getDefaultWebmailUrl(db: Database): Promise<string> {
  const settings = await getWebmailSettings(db);
  return settings.defaultWebmailUrl;
}


export async function getMailServerHostname(db: Database): Promise<string> {
  const settings = await getWebmailSettings(db);
  return settings.mailServerHostname;
}

/**
 * Push a hostname change to Stalwart via JMAP.
 *
 * Stalwart 0.16's `SystemSettings.defaultHostname` field drives:
 *   - Inbound listener banners (SMTP `220 <hostname>` greeting,
 *     `250-<hostname>` EHLO ack, IMAP greeting, etc.) for every
 *     listener that doesn't carry its own per-protocol override.
 *   - Outbound EHLO when an `MtaConnectionStrategy` doesn't
 *     override it (the default strategy ships with `ehloHostname=null`
 *     and `sourceIps={}`, which means it falls through to
 *     defaultHostname).
 *   - MTA report generators ("hostname needed but not specified"
 *     surface, per the Stalwart docs).
 *
 * The field requires `defaultDomainId` to be set alongside (JMAP
 * validation rejects the partial update otherwise), so we look up
 * the platform's primary Domain row by name and pass both fields.
 *
 * NOTE: this updates the *config* hostname only. It does NOT
 * automatically:
 *   - Re-issue the TLS cert with the new hostname as a SAN — Stalwart
 *     keeps serving the existing cert until the operator updates the
 *     Domain row's `subjectAlternativeNames` and the ACME loop fires.
 *   - Update DNS MX/A records — that's the operator's responsibility.
 *   - Update reverse DNS at the IP-provider level.
 *
 * Returns nothing on success; throws ApiError-shaped errors on JMAP
 * validation rejection or transport failure so the calling route can
 * surface them to the operator without leaking the entire stalwart
 * response into the API envelope.
 */
// Stable hash for the pg_advisory_xact_lock key. We pick a constant so
// every instance/replica of platform-api takes the same lock when
// updating the mail hostname — the lock ensures only one PATCH at a
// time can step through the (Stalwart apply → DB write) sequence,
// closing the TOCTOU window where two concurrent renames could
// commit out of order. The number is arbitrary; just needs to be
// distinct from other advisory-lock keys in the codebase. Picked
// from sha256('mail-server-hostname-rename')[0..7].
const MAIL_HOSTNAME_LOCK_KEY = 0x7e3a4109;

/**
 * Run `fn` with the mail-hostname rename advisory lock held. Two
 * concurrent PATCH /admin/webmail-settings (or /admin/platform-urls)
 * requests now serialize through this lock — only one steps through
 * the (Stalwart apply → DB write) sequence at a time. Cross-replica
 * safe because pg_advisory_xact_lock is database-scoped, not
 * connection-scoped. Lock auto-releases at transaction end so a
 * crashing handler can't pin it.
 */
export async function withMailHostnameLock<T>(
  db: Database,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${MAIL_HOSTNAME_LOCK_KEY})`);
    return fn();
  });
}

/**
 * Roll the stalwart-mail Deployment by patching the pod-template's
 * `kubectl.kubernetes.io/restartedAt` annotation — same trick
 * `kubectl rollout restart` uses. K8s sees the spec change, builds a
 * new ReplicaSet, and rolling-replaces the pods. The new pods read
 * the live SystemSettings row at boot, so the banner reflects the
 * new hostname within ~30s.
 *
 * The new ReplicaSet inherits the existing image so this is just a
 * pod cycle, not a code change. RBAC required: patch verb on
 * deployments in the mail namespace (granted via the platform-api-
 * mail-rollout ClusterRoleBinding).
 *
 * Failure here is non-fatal — Stalwart's SystemSettings was already
 * persisted in the prior step, so the next natural pod restart (or
 * any future cycle) will pick up the new hostname. Logging gives the
 * operator a hint to roll manually if this returned an error.
 */
async function rolloutStalwartMail(k8s: K8sClients): Promise<void> {
  const restartedAt = new Date().toISOString();
  await k8s.apps.patchNamespacedDeployment({
    namespace: 'mail',
    name: 'stalwart-mail',
    body: {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': restartedAt,
            },
          },
        },
      },
    },
  } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0], MERGE_PATCH);
}

/**
 * Add the new hostname's prefix to the platform Domain's
 * subjectAlternativeNames so Stalwart's ACME loop re-issues the
 * cert covering it. Idempotent: existing entries are preserved
 * (we MERGE the new key in rather than replacing the map).
 *
 * Stalwart 0.16's SAN map is keyed by host-prefix relative to the
 * Domain.name (the canonical entry `{mail: true}` means `mail.<domain>`).
 * For hostname `<prefix>.<domain.name>`, we add `{<prefix>: true}`.
 * If the hostname IS the Domain.name (no prefix), we add `{'@': true}`
 * which is Stalwart's apex sentinel.
 */
async function addHostnameToDomainSANs(
  domainId: string,
  domainName: string,
  hostname: string,
): Promise<void> {
  const lower = hostname.toLowerCase();
  const domainLower = domainName.toLowerCase();
  let sanKey: string;
  if (lower === domainLower) {
    sanKey = '@';
  } else if (lower.endsWith(`.${domainLower}`)) {
    sanKey = lower.slice(0, -1 - domainLower.length);
  } else {
    throw new Error(
      `Cannot derive SAN key: hostname '${hostname}' is not under Domain '${domainName}'`,
    );
  }

  // Read current SANs so we don't clobber.
  const getBody = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [
      [
        'x:Domain/get',
        {
          ids: [domainId],
          properties: ['certificateManagement'],
        },
        'g',
      ],
    ],
  });
  const getRes = await postJmap(getBody);
  if (getRes.status >= 400) {
    throw new Error(`Domain/get failed (${getRes.status}): ${getRes.body.slice(0, 200)}`);
  }
  const getParsed = parseJmapBody(getRes.body, 'Domain/get (SAN)');
  const list = (getParsed.methodResponses[0][1] as { list?: unknown }).list;
  const row = Array.isArray(list) && list[0] && typeof list[0] === 'object' ? list[0] : null;
  const cm = row && (row as { certificateManagement?: unknown }).certificateManagement;
  const cmObj = cm && typeof cm === 'object' ? (cm as { subjectAlternativeNames?: unknown }) : null;
  const existing =
    cmObj && cmObj.subjectAlternativeNames && typeof cmObj.subjectAlternativeNames === 'object'
      ? (cmObj.subjectAlternativeNames as Record<string, boolean>)
      : {};

  // Idempotency — if the entry is already there, no write.
  if (existing[sanKey]) return;

  const merged: Record<string, boolean> = { ...existing, [sanKey]: true };

  // certificateManagement is a discriminated union (@type: Automatic
  // | Manual | Disabled). We MERGE_PATCH only the SANs by submitting
  // the full sub-object with the same @type. Stalwart accepts this
  // as an in-place update.
  const cmType =
    cmObj && '@type' in cmObj && typeof (cmObj as { '@type'?: unknown })['@type'] === 'string'
      ? (cmObj as { '@type': string })['@type']
      : 'Automatic';
  const acmeProviderId =
    cmObj
    && 'acmeProviderId' in cmObj
    && typeof (cmObj as { acmeProviderId?: unknown }).acmeProviderId === 'string'
      ? (cmObj as { acmeProviderId: string }).acmeProviderId
      : undefined;

  const setBody = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [
      [
        'x:Domain/set',
        {
          update: {
            [domainId]: {
              certificateManagement: {
                '@type': cmType,
                ...(acmeProviderId ? { acmeProviderId } : {}),
                subjectAlternativeNames: merged,
              },
            },
          },
        },
        's',
      ],
    ],
  });
  const setRes = await postJmap(setBody);
  if (setRes.status >= 400) {
    throw new Error(`Domain/set SAN failed (${setRes.status}): ${setRes.body.slice(0, 200)}`);
  }
  const parsed = parseJmapBody(setRes.body, 'Domain/set (SAN)');
  const payload = parsed.methodResponses[0][1] as {
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, { type?: unknown; description?: unknown }>;
  };
  if (payload.notUpdated && payload.notUpdated[domainId]) {
    const err = payload.notUpdated[domainId];
    const errType = typeof err.type === 'string' ? err.type : 'unknown';
    const errDesc =
      typeof err.description === 'string' ? err.description.slice(0, 200) : 'no detail';
    throw new Error(`Stalwart rejected SAN update: ${errType} — ${errDesc}`);
  }
}

export async function applyMailServerHostnameToStalwart(
  hostname: string,
  k8s?: K8sClients,
): Promise<{
  defaultDomainId: string;
  previousHostname: string;
  rolloutTriggered: boolean;
  sanAdded: boolean;
}> {
  const trimmed = hostname.trim();
  if (!trimmed) {
    throw new Error('hostname is required');
  }

  // Step 1: resolve the Stalwart Domain row that owns this hostname.
  // We strip the `mail.` prefix (the canonical case) AND, if no
  // exact match is found, fall back to the longest Domain whose name
  // is a SUFFIX of the hostname. This lets E2E tests use temporary
  // hostnames like `mail-e2e-1234.staging.phoenix-host.net` without
  // requiring a fresh Domain row — the existing
  // `staging.phoenix-host.net` row covers them.
  const lower = trimmed.toLowerCase();
  const exactApex = lower.startsWith('mail.') ? lower.slice('mail.'.length) : lower;

  const queryBody = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [['x:Domain/query', {}, 'q']],
  });
  const queryRes = await postJmap(queryBody);
  if (queryRes.status >= 400) {
    throw new Error(
      `Stalwart JMAP Domain/query failed (${queryRes.status}): ${queryRes.body.slice(0, 200)}`,
    );
  }
  const queryParsed = parseJmapBody(queryRes.body, 'Domain/query');
  const queryPayload = queryParsed.methodResponses[0][1] as { ids?: unknown };
  const domainIds = Array.isArray(queryPayload.ids) ? queryPayload.ids.filter((x): x is string => typeof x === 'string') : [];
  if (domainIds.length === 0) {
    throw new Error('No Domain rows found in Stalwart — was the cluster bootstrapped?');
  }

  const getBody = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [
      ['x:Domain/get', { ids: domainIds, properties: ['id', 'name'] }, 'g'],
    ],
  });
  const getRes = await postJmap(getBody);
  if (getRes.status >= 400) {
    throw new Error(
      `Stalwart JMAP Domain/get failed (${getRes.status}): ${getRes.body.slice(0, 200)}`,
    );
  }
  const getParsed = parseJmapBody(getRes.body, 'Domain/get');
  const getList = (getParsed.methodResponses[0][1] as { list?: unknown }).list;
  const list: Array<{ id: string; name: string }> = Array.isArray(getList)
    ? getList.flatMap((row) => {
        if (
          row && typeof row === 'object'
          && typeof (row as { id?: unknown }).id === 'string'
          && typeof (row as { name?: unknown }).name === 'string'
        ) {
          return [{ id: (row as { id: string }).id, name: (row as { name: string }).name }];
        }
        return [];
      })
    : [];
  // Exact match first (canonical case: hostname `mail.<domain>`,
  // Domain row name `<domain>`). Fall back to longest-suffix match
  // for E2E test hostnames.
  let domainRow = list.find((d) => d.name === exactApex);
  if (!domainRow) {
    const suffixMatches = list
      .filter((d) => lower === d.name.toLowerCase() || lower.endsWith(`.${d.name.toLowerCase()}`))
      .sort((a, b) => b.name.length - a.name.length);
    domainRow = suffixMatches[0];
  }
  if (!domainRow) {
    throw new Error(
      `No Domain row matches '${exactApex}' — add it to Stalwart first via the email-domains UI.`,
    );
  }

  // Step 2: read existing SystemSettings.defaultHostname so we can
  // return it for audit/log purposes, AND so we can short-circuit a
  // no-op (caller may want to suppress the rolling restart in that
  // case).
  const beforeBody = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [
      [
        'x:SystemSettings/get',
        { ids: ['singleton'], properties: ['defaultHostname'] },
        'a',
      ],
    ],
  });
  const beforeRes = await postJmap(beforeBody);
  if (beforeRes.status >= 400) {
    throw new Error(
      `Stalwart JMAP SystemSettings/get failed (${beforeRes.status}): ${beforeRes.body.slice(0, 200)}`,
    );
  }
  const beforeParsed = parseJmapBody(beforeRes.body, 'SystemSettings/get');
  const beforeList = (beforeParsed.methodResponses[0][1] as { list?: unknown }).list;
  const beforeRow =
    Array.isArray(beforeList) && beforeList[0] && typeof beforeList[0] === 'object'
      ? (beforeList[0] as { defaultHostname?: unknown })
      : undefined;
  const previousHostname =
    typeof beforeRow?.defaultHostname === 'string' ? beforeRow.defaultHostname : '';

  // Step 3: apply the update. Both fields are required by the
  // singleton's validation — passing only defaultHostname produces
  // "validationFailed: Required: defaultDomainId" even when the
  // existing row already holds a valid value.
  const setBody = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [
      [
        'x:SystemSettings/set',
        {
          update: {
            singleton: {
              defaultHostname: trimmed,
              defaultDomainId: domainRow.id,
            },
          },
        },
        'set',
      ],
    ],
  });
  const setRes = await postJmap(setBody);
  if (setRes.status >= 400) {
    throw new Error(
      `Stalwart JMAP SystemSettings/set failed (${setRes.status}): ${setRes.body.slice(0, 300)}`,
    );
  }
  const setParsed = parseJmapBody(setRes.body, 'SystemSettings/set');
  const setPayload = setParsed.methodResponses[0][1] as {
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, { type?: unknown; description?: unknown }>;
  };
  if (setPayload.notUpdated && setPayload.notUpdated.singleton) {
    const err = setPayload.notUpdated.singleton;
    const errType = typeof err.type === 'string' ? err.type : 'unknown';
    // Cap the description at 200 chars before interpolating into the
    // operator-facing ApiError. Stalwart descriptions are normally
    // terse, but this enforces the same truncation as the other
    // body-excerpt paths in this module so a future verbose error
    // can't leak unbounded internal detail.
    const errDescRaw = typeof err.description === 'string' ? err.description : 'no detail';
    const errDesc = errDescRaw.slice(0, 200);
    throw new Error(`Stalwart rejected hostname update: ${errType} — ${errDesc}`);
  }
  if (!setPayload.updated || !('singleton' in setPayload.updated)) {
    throw new Error(`Stalwart JMAP set returned an unexpected shape: ${setRes.body.slice(0, 200)}`);
  }

  // Step 4: ensure the new hostname is in the Domain's
  // subjectAlternativeNames so Stalwart's ACME loop re-issues a cert
  // that covers it. Failure here doesn't roll back the SystemSettings
  // write — operators can re-issue manually if ACME is misbehaving.
  let sanAdded = false;
  if (previousHostname !== trimmed) {
    try {
      await addHostnameToDomainSANs(domainRow.id, domainRow.name, trimmed);
      sanAdded = true;
    } catch (err) {
      // Surface the error in the response so the operator can
      // intervene, but don't throw — the hostname rename itself
      // succeeded (banners will reflect the new name); only the
      // cert reissue is delayed.
      throw new Error(
        `Hostname updated but cert SAN sync failed: ${
          err instanceof Error ? err.message : String(err)
        }. The cert will not auto-reissue until the Domain row's subjectAlternativeNames is updated manually.`,
      );
    }
  }

  // Step 5: cycle the Stalwart pods so the new defaultHostname takes
  // effect immediately on the running listeners. Stalwart reads
  // SystemSettings on startup and caches; without a roll, the
  // running pods keep announcing the old hostname until their next
  // natural restart. Failure is non-fatal — caller may not have
  // passed a k8s tenant (unit tests, or platform-api degraded mode).
  let rolloutTriggered = false;
  if (k8s && previousHostname !== trimmed) {
    try {
      await rolloutStalwartMail(k8s);
      rolloutTriggered = true;
    } catch {
      // Swallow — operator can `kubectl rollout restart` manually.
      // We log at the call site (route handler) where the request
      // logger is available.
    }
  }

  return { defaultDomainId: domainRow.id, previousHostname, rolloutTriggered, sanAdded };
}
