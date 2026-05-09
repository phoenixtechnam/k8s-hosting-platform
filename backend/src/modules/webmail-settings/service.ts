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
import { proxyStalwartRequest } from '../mail-admin/service.js';

// JMAP method-response envelope. Each entry is a 3-tuple:
// [methodName, payload, callId]. We only consume `payload`; the call
// id and method name are echoed back as-is.
type JmapMethodResponse = readonly [string, Record<string, unknown>, string];

interface JmapResponse {
  readonly methodResponses: readonly JmapMethodResponse[];
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

export async function getWebmailSettings(db: Database) {
  const defaultWebmailUrlStored = await getSetting(db, 'default_webmail_url');
  const mailServerHostnameStored = await getSetting(db, 'mail_server_hostname');
  const rateLimitRaw = await getSetting(db, 'email_send_rate_limit_default');
  const emailSendRateLimitDefault = rateLimitRaw ? parseInt(rateLimitRaw, 10) : null;
  return {
    defaultWebmailUrl: defaultWebmailUrlStored ?? (await defaultWebmailUrl(db)),
    mailServerHostname: mailServerHostnameStored ?? (await defaultMailHostname(db)),
    emailSendRateLimitDefault: Number.isFinite(emailSendRateLimitDefault) ? emailSendRateLimitDefault : null,
  };
}

export async function updateWebmailSettings(
  db: Database,
  input: {
    defaultWebmailUrl?: string;
    mailServerHostname?: string;
    emailSendRateLimitDefault?: number | null;
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

export async function applyMailServerHostnameToStalwart(
  kubeconfigPath: string | undefined,
  hostname: string,
): Promise<{ defaultDomainId: string; previousHostname: string }> {
  const trimmed = hostname.trim();
  if (!trimmed) {
    throw new Error('hostname is required');
  }

  // Step 1: resolve the platform's primary Domain row by name. We
  // strip the `mail.` prefix (the canonical case) and treat what's
  // left as the apex. If the operator passes a hostname that doesn't
  // start with `mail.`, the apex IS the hostname itself and we do an
  // exact-name lookup.
  const apex = trimmed.toLowerCase().startsWith('mail.')
    ? trimmed.slice('mail.'.length)
    : trimmed;

  const queryBody = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [['x:Domain/query', {}, 'q']],
  });
  const queryRes = await proxyStalwartRequest(kubeconfigPath, 'POST', '/jmap', queryBody);
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
  const getRes = await proxyStalwartRequest(kubeconfigPath, 'POST', '/jmap', getBody);
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
  const domainRow = list.find((d) => d.name === apex);
  if (!domainRow) {
    throw new Error(
      `No Domain row matches '${apex}' — add it to Stalwart first via the email-domains UI.`,
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
  const beforeRes = await proxyStalwartRequest(kubeconfigPath, 'POST', '/jmap', beforeBody);
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
  const setRes = await proxyStalwartRequest(kubeconfigPath, 'POST', '/jmap', setBody);
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

  return { defaultDomainId: domainRow.id, previousHostname };
}
