/**
 * bulwark-settings-purge hook.
 *
 * On `archived` transition, deletes any Bulwark per-account settings
 * files (`/app/data/settings/<sha256(username:serverUrl)>.enc`) for
 * every mailbox the client owns.
 *
 * Implementation: HTTP DELETE to the bulwark-impersonator sidecar's
 * admin endpoint (`/__impersonator/settings`). The sidecar lives in
 * the Bulwark Pod so it has direct filesystem access to /app/data;
 * the platform-api does NOT need pods/exec RBAC. See ADR-039 Phase 8
 * for the design rationale.
 *
 * Auth: shared bearer token from
 *   bulwark-impersonator-secrets.IMPERSONATOR_ADMIN_TOKEN
 * mounted into platform-api as
 *   LIFECYCLE_HOOK_BULWARK_ADMIN_TOKEN.
 *
 * The matching `serverUrl` value comes from
 *   LIFECYCLE_HOOK_BULWARK_JMAP_URL  (defaults to
 *   https://stalwart.${PLATFORM_BASE_DOMAIN} — exactly what
 *   webmail-settings.JMAP_SERVER_URL gives Bulwark on /api/config).
 *
 * The impersonator Service is at
 *   http://bulwark-impersonator.mail.svc.cluster.local:80
 * (overridable via LIFECYCLE_HOOK_BULWARK_IMPERSONATOR_URL).
 *
 * Behaviour:
 *   - archived: enumerate mailboxes by clientId (BEFORE the
 *     mailboxes-status hook deletes the rows), DELETE each.
 *   - all other transitions: noop.
 *
 * Idempotent: the impersonator returns 200 for both `unlinked` and
 * `already_absent`; we accept both as success.
 *
 * blocking=continue: an impersonator outage SHOULD NOT block client
 * archival — the orphan files are small and harmless until cleaned
 * up by a later run. Failed runs land in client_lifecycle_hook_runs
 * and the scheduler retries.
 *
 * Kill switch: `LIFECYCLE_HOOK_BULWARK_SETTINGS_PURGE=disable`
 * short-circuits to noop. Use during impersonator outages.
 */
import { eq } from 'drizzle-orm';
import { mailboxes } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

const HOOK_NAME = 'bulwark-settings-purge';

interface PurgeResult {
  status: 'unlinked' | 'already_absent' | 'http_error' | 'transport_error';
  detail?: string;
}

async function purgeOneAccount(
  impersonatorUrl: string,
  adminToken: string,
  username: string,
  serverUrl: string,
  log?: HookCtx['log'],
): Promise<PurgeResult> {
  try {
    const r = await fetch(`${impersonatorUrl}/__impersonator/settings`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': adminToken,
      },
      body: JSON.stringify({ username, serverUrl }),
    });
    if (r.ok) {
      const body = await r.json().catch(() => ({})) as { status?: string };
      const s = body.status === 'unlinked' ? 'unlinked' : 'already_absent';
      log?.('bulwark-settings-purge.account', { username, status: s });
      return { status: s };
    }
    const text = await r.text().catch(() => '');
    log?.('bulwark-settings-purge.http_error', { username, code: r.status, body: text.slice(0, 200) });
    return { status: 'http_error', detail: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.('bulwark-settings-purge.transport_error', { username, err: msg });
    return { status: 'transport_error', detail: msg };
  }
}

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  // archived is the only transition that destroys mailbox accounts in
  // Stalwart (per mailboxes-status hook). The other transitions
  // (active/suspended/restored/deleted) keep accounts intact —
  // suspended just flips Stalwart auth off without touching state.
  if (ctx.transition !== 'archived') {
    return { status: 'noop', detail: `${HOOK_NAME}: not applicable for ${ctx.transition}` };
  }

  if (process.env.LIFECYCLE_HOOK_BULWARK_SETTINGS_PURGE === 'disable') {
    return { status: 'noop', detail: `${HOOK_NAME}: kill-switch active` };
  }

  const adminToken = process.env.LIFECYCLE_HOOK_BULWARK_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    // Soft-noop when not configured — operator may run a stack
    // without Bulwark (Roundcube-only). We MUST NOT fail the
    // transition for an unconfigured optional hook.
    return { status: 'noop', detail: `${HOOK_NAME}: LIFECYCLE_HOOK_BULWARK_ADMIN_TOKEN unset; treating as Bulwark-disabled stack` };
  }

  const impersonatorUrl = process.env.LIFECYCLE_HOOK_BULWARK_IMPERSONATOR_URL
    ?? 'http://bulwark-impersonator.mail.svc.cluster.local';
  const base = process.env.LIFECYCLE_HOOK_BULWARK_JMAP_URL
    ?? `https://stalwart.${process.env.PLATFORM_BASE_DOMAIN ?? 'example.com'}`;

  // Snapshot mailbox emails BEFORE the mailboxes-status hook
  // deletes them. The mailbox row still exists at this point — the
  // `archived` cascade orders mailboxes-status (order 220) AFTER
  // this hook (order 250 below).
  const rows = await ctx.db
    .select({ fullAddress: mailboxes.fullAddress })
    .from(mailboxes)
    .where(eq(mailboxes.clientId, ctx.clientId));

  if (rows.length === 0) {
    return { status: 'noop', detail: `${HOOK_NAME}: no mailboxes owned by client` };
  }

  let unlinked = 0;
  let absent = 0;
  const errors: string[] = [];
  for (const row of rows) {
    const fullAddress = row.fullAddress;
    if (!fullAddress) continue;
    const result = await purgeOneAccount(impersonatorUrl, adminToken, fullAddress, base, ctx.log);
    if (result.status === 'unlinked') unlinked++;
    else if (result.status === 'already_absent') absent++;
    else errors.push(`${fullAddress}: ${result.detail ?? result.status}`);
  }

  if (errors.length > 0) {
    return {
      status: 'failed',
      detail: `${HOOK_NAME}: ${errors.length}/${rows.length} accounts failed`,
      envelope: {
        title: 'Failed to purge Bulwark settings for one or more mailboxes',
        detail: errors.join('; '),
        remediation: [
          'Check the bulwark-impersonator pod is running and reachable.',
          'Verify LIFECYCLE_HOOK_BULWARK_ADMIN_TOKEN matches bulwark-impersonator-secrets.IMPERSONATOR_ADMIN_TOKEN.',
          'Set LIFECYCLE_HOOK_BULWARK_SETTINGS_PURGE=disable to skip on the next retry if the impersonator is intentionally offline.',
        ],
      },
    };
  }

  return {
    status: 'ok',
    detail: `${HOOK_NAME}: ${unlinked} unlinked, ${absent} already absent`,
  };
}

export const bulwarkSettingsPurgeHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['archived'],
  // After cluster-scoped-refs (200) — those don't touch mailbox state
  // — and BEFORE mailboxes-status (220 in the existing registry)
  // so we still see the mailbox rows.
  order: 210,
  // continue: Bulwark settings are operational state, not user data —
  // an outage shouldn't fail the whole archival cascade.
  blocking: 'continue',
  run: runImpl,
};

let _registered = false;
export function registerBulwarkSettingsPurgeHook(): void {
  if (_registered) return;
  registerLifecycleHook(bulwarkSettingsPurgeHook);
  _registered = true;
}
