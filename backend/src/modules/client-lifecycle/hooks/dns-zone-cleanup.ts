import { eq } from 'drizzle-orm';
import { domains } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';
import { getActiveServersForDomain } from '../../dns-servers/service.js';
import { getProviderForServer } from '../../dns-servers/service.js';
import { isHookAuthoritative } from '../registry/feature-flags.js';

/** Production-grade encryption key sourced from env. Logs once if
 * missing so a misconfiguration surfaces in the platform-api log
 * rather than silently decrypting credentials with the zero key
 * (which produces auth failures the operator must root-cause). */
let _envKeyMissingLogged = false;
function resolveEncryptionKey(): string {
  const k = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!k) {
    if (!_envKeyMissingLogged) {
      console.warn(
        '[dns-zone-cleanup] PLATFORM_ENCRYPTION_KEY not set — falling back to zero key. DNS provider credentials will likely fail to decrypt; check the platform deployment.',
      );
      _envKeyMissingLogged = true;
    }
    return '0'.repeat(64);
  }
  return k;
}

/**
 * dns-zone-cleanup hook.
 *
 * Deletes the external DNS zone for every domain owned by the client
 * being deleted. Mirrors the per-domain `deleteZone` call that
 * `domains/service.ts:deleteDomain` already makes when the operator
 * deletes a single domain — but `applyDeleted` on the client side
 * never invokes it, leaving zones live in PowerDNS / Cloudflare /
 * Hetzner / Route53 / RNDC / ClouDNS indefinitely.
 *
 * NEW behaviour (no legacy parallel path): there is no inline
 * deleteZone call in cascades.applyDeleted today, so this hook is
 * authoritative from day one. The feature flag exists for emergency
 * disable only (default `hook`).
 *
 * Ordering / blocking:
 *   - order=400 — runs after the namespace + PV cleanup hooks so
 *     a DNS provider hiccup doesn't delay the namespace teardown.
 *   - blocking=continue — a DNS provider 5xx must not abort the
 *     client delete; the orphan zone will be cleaned up on the
 *     scheduler retry tick or surfaced via OperatorError envelope.
 */

interface DnsLite {
  readonly id: string;
  readonly domainName: string;
}

const HOOK_NAME = 'dns-zone-cleanup';

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition !== 'deleted') {
    return { status: 'noop', detail: 'only runs on deleted' };
  }
  if (!isHookAuthoritative(HOOK_NAME)) {
    // Operator kill-switch via LIFECYCLE_HOOK_DNS_ZONE_CLEANUP=disable.
    return { status: 'noop', detail: 'hook disabled by feature flag' };
  }

  // List every domain owned by this client BEFORE the FK cascade
  // removes the rows. cascades.applyDeleted dispatches the registry
  // BEFORE the `db.delete(clients)`, so domains rows are still
  // present here.
  const rows = (await ctx.db.select({
    id: domains.id,
    domainName: domains.domainName,
  })
    .from(domains)
    .where(eq(domains.clientId, ctx.clientId))) as readonly DnsLite[];

  if (rows.length === 0) {
    return { status: 'noop', detail: 'client has no domains' };
  }

  const encryptionKey = resolveEncryptionKey();
  const failures: Array<{ domain: string; server: string; error: string }> = [];
  let zonesDeleted = 0;

  for (const row of rows) {
    let servers: Awaited<ReturnType<typeof getActiveServersForDomain>>;
    try {
      servers = await getActiveServersForDomain(ctx.db, row.id);
    } catch (err) {
      failures.push({
        domain: row.domainName,
        server: '(server-lookup-failed)',
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const server of servers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        await provider.deleteZone(row.domainName);
        zonesDeleted++;
      } catch (err) {
        failures.push({
          domain: row.domainName,
          server: server.displayName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (failures.length === 0) {
    return {
      status: 'ok',
      detail: `deleted ${zonesDeleted} zone(s) across ${rows.length} domain(s)`,
    };
  }

  // Partial success — surface as `retry` so the scheduler tick can
  // re-attempt; envelope lists every failure for operator visibility.
  return {
    status: 'retry',
    detail: `${zonesDeleted} zone(s) deleted; ${failures.length} failure(s)`,
    envelope: {
      title: 'DNS zone cleanup partial',
      detail: `${failures.length} provider call(s) failed; will retry on the next scheduler tick`,
      remediation: [
        'Check provider credentials in Settings → DNS Servers',
        'Verify network reachability to each provider',
        'Manually run `dig <domain>` to confirm whether the zone is live',
      ],
      raw: failures.map((f) => `${f.domain} @ ${f.server}: ${f.error}`).join('\n'),
    },
  };
}

export const dnsZoneCleanupHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['deleted'],
  // Order 400 — after PV cleanup (100) + DB hooks (200-250). The
  // domains rows are still present at this point because the FK
  // cascade in cascades.applyDeleted runs AFTER the registry dispatch.
  order: 400,
  blocking: 'continue',
  // Each provider call is allowed up to 3 attempts. After that the
  // hook is failed_partial and the orphan zone is expected to be
  // surfaced via the operator-facing audit trail or manual cleanup.
  maxAttempts: 3,
  run: runImpl,
};

let _registered = false;
export function registerDnsZoneCleanupHook(): void {
  if (_registered) return;
  registerLifecycleHook(dnsZoneCleanupHook);
  _registered = true;
}
