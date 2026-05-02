/**
 * Feature flags that gate which lifecycle hooks are AUTHORITATIVE.
 *
 * Migration model:
 *   1. Phase 2-N adds a hook that does the same work as a legacy
 *      fire-and-forget code path.
 *   2. Both run in parallel — the legacy path writes to the same K8s
 *      objects (idempotent: a 404 from one side after the other
 *      reaped is harmless), the hook records its outcome to
 *      `client_lifecycle_hook_runs` for observability.
 *   3. After staging shows the hook is reliable for ≥1 cycle, the
 *      operator flips the flag and the legacy path becomes a no-op
 *      (early-returns with a one-line log).
 *   4. Phase 6 deletes the now-unreachable legacy code.
 *
 * Flag values come from process.env.* with a sensible default so a
 * forgotten flag in production doesn't silently double-cleanup. A
 * future config-table backed model can replace this without changing
 * call sites.
 */

interface FlagDef {
  readonly env: string;
  /**
   * Default when the env var is unset/empty.
   *   `legacy` = run the legacy code path; the hook records its
   *             outcome but is purely observational.
   *   `hook`   = the hook is authoritative; legacy early-returns.
   */
  readonly default: 'legacy' | 'hook';
}

const FLAGS: Record<string, FlagDef> = {
  /**
   * Phase 2: pv-cleanup-released.
   * Default `legacy` so a fresh deploy keeps shipping cleanup via
   * `cleanupReleasedPvs` (the in-process fire-and-forget poll) until
   * an operator opts in via LIFECYCLE_HOOK_PV_CLEANUP=hook.
   *
   * Operator note before flipping to `hook`: until Phase 5 (scheduler
   * retry tick) is deployed, the hook's empty-poll grace (~6 s) means
   * unusually slow PVC binding may be missed. The orphan-volumes
   * scanner catches any miss for manual Purge — but the legacy 60 s
   * window catches more by design.
   */
  'pv-cleanup-released': { env: 'LIFECYCLE_HOOK_PV_CLEANUP', default: 'legacy' },

  /**
   * Phase 3: db-cascades. SINGLE meta-flag that gates the entire set
   * of DB+ingress hooks (domains-status, cronjobs-enable, mailboxes-
   * status, email-aliases-enable, deployments-status, clients-status-
   * stamp + ingress-suspend/resume/reconcile).
   *
   * Default `legacy` so the inline DB updates in cascades.applyActive/
   * Suspended/Archived continue to be the source of truth. The hooks
   * still run on every transition (purely observational — every write
   * is idempotent), recording outcomes to client_lifecycle_hook_runs.
   *
   * When flipped to `hook` via LIFECYCLE_HOOK_DB_CASCADES=hook:
   *   - cascades.applyActive/Suspended/Archived skip their inline DB
   *     blocks (the hooks become authoritative)
   *   - the dispatcher's hook_runs table is the operator-visible
   *     record of every cascade
   */
  'db-cascades': { env: 'LIFECYCLE_HOOK_DB_CASCADES', default: 'legacy' },
};

const _testOverrides = new Map<string, 'legacy' | 'hook'>();

export function isHookAuthoritative(name: string): boolean {
  const override = _testOverrides.get(name);
  if (override) return override === 'hook';
  const def = FLAGS[name];
  if (!def) return false;
  const raw = (process.env[def.env] ?? '').trim().toLowerCase();
  if (raw === 'hook') return true;
  if (raw === 'legacy') return false;
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
