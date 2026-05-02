/**
 * Feature flags that gate which lifecycle hooks are AUTHORITATIVE.
 *
 * Phase 6: the legacy fire-and-forget code in cascades.ts is gone,
 * so the Phase 2 (`pv-cleanup-released`) and Phase 3 (`db-cascades`)
 * meta-flags are no longer wired anywhere — they were removed when
 * the matching legacy blocks went. The flag map below now lists only
 * the hooks that have an operator-facing kill-switch:
 *
 *   - dns-zone-cleanup           — disable when a DNS provider is
 *                                  flapping and every delete is
 *                                  slow-failing through retries.
 *   - backups-v2-bundle-cleanup  — disable when an S3/SSH target is
 *                                  unreachable.
 *
 * Both default to `hook` (authoritative). The kill-switch value is
 * `disable` (NOT `legacy` — there is no legacy parallel path):
 *   LIFECYCLE_HOOK_DNS_ZONE_CLEANUP=disable
 *   LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP=disable
 *
 * When disabled the hook short-circuits with status='noop' and the
 * operator can clean up manually (e.g. via
 * DELETE /api/v1/admin/backups/bundles/:id or PowerDNS's own UI).
 *
 * Why DB-only hooks (domains-status, mailboxes-status, etc.) have no
 * kill-switch: their failure mode is local — a failed Drizzle update
 * is the operator's problem to fix in code, not a transient external
 * outage to ride out. A kill-switch would just leave the platform DB
 * in an inconsistent state; the right escape hatch for a regression
 * is a code revert + redeploy.
 */

interface FlagDef {
  readonly env: string;
  /** Default when env unset. `hook` = authoritative; `legacy` = retired. */
  readonly default: 'hook' | 'legacy';
}

const FLAGS: Record<string, FlagDef> = {
  'dns-zone-cleanup': { env: 'LIFECYCLE_HOOK_DNS_ZONE_CLEANUP', default: 'hook' },
  'backups-v2-bundle-cleanup': { env: 'LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP', default: 'hook' },
};

const _testOverrides = new Map<string, 'legacy' | 'hook'>();

export function isHookAuthoritative(name: string): boolean {
  const override = _testOverrides.get(name);
  if (override) return override === 'hook';
  const def = FLAGS[name];
  if (!def) return false;
  const raw = (process.env[def.env] ?? '').trim().toLowerCase();
  if (raw === 'hook') return true;
  // `legacy` and `disable` both resolve to "the hook is NOT authoritative".
  // The two values document different operator intent but result in
  // the same short-circuit.
  if (raw === 'legacy' || raw === 'disable') return false;
  return def.default === 'hook';
}

/** Test-only: flip a single flag without poking process.env. */
export function _setHookFlagForTests(
  name: string,
  value: 'legacy' | 'hook' | undefined,
): void {
  if (value == null) _testOverrides.delete(name);
  else _testOverrides.set(name, value);
}

/**
 * Phase 6 retired LIFECYCLE_HOOK_PV_CLEANUP and LIFECYCLE_HOOK_DB_CASCADES.
 * Operators who set them in deployment env will see no effect — log a
 * one-time warning at module load so the misconfiguration surfaces in
 * the platform-api startup log instead of going silent.
 */
const RETIRED_ENV_VARS = ['LIFECYCLE_HOOK_PV_CLEANUP', 'LIFECYCLE_HOOK_DB_CASCADES'];
for (const name of RETIRED_ENV_VARS) {
  if (process.env[name] !== undefined && process.env[name] !== '') {
    // eslint-disable-next-line no-console
    console.warn(
      `[lifecycle-flags] env var ${name} is RETIRED (Phase 6) and has no effect. ` +
      `Both Phase 2 (pv-cleanup-released) and Phase 3 (db-cascades) hooks are now unconditionally authoritative. ` +
      `Remove this var from your deploy config to silence this warning.`,
    );
  }
}
