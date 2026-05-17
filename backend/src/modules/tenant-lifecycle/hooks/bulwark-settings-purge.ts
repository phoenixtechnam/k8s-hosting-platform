/**
 * bulwark-settings-purge hook (RETIRED 2026-05-17).
 *
 * Original purpose: on `archived` transition, delete Bulwark
 * per-account settings files (`/app/data/settings/<sha256>.enc`) for
 * every mailbox the tenant owns. It relied on the
 * bulwark-impersonator sidecar's `/__impersonator/settings` admin
 * endpoint.
 *
 * Why retired: the bulwark-impersonator sidecar was removed when
 * Bulwark's upstream `/api/auth/impersonate` route shipped (issue
 * #296). The hook's external dependency no longer exists.
 *
 * Why it's safe to retire: orphan `.enc` files are small (KB range),
 * encrypted with `SESSION_SECRET` (so unreadable without the running
 * Bulwark pod), and only read when a user logs into Bulwark with
 * matching `sha256(username:serverUrl)`. Archived tenants have their
 * Stalwart accounts destroyed elsewhere in the cascade, so the
 * hashes never match again — the files are inert.
 *
 * Follow-up: a Kubernetes Job that mounts the bulwark-data PVC and
 * deletes the files is the long-term fix. Tracked in
 * docs/06-features/BULWARK_DEFERRED_WORK.md.
 *
 * Behaviour now: ALWAYS returns `noop`. Kept in the registry so
 * existing audit/run-log queries don't break on a missing hook name.
 */
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

const HOOK_NAME = 'bulwark-settings-purge';

async function runImpl(_ctx: HookCtx): Promise<HookResult> {
  return {
    status: 'noop',
    detail: `${HOOK_NAME}: retired — bulwark-impersonator sidecar removed (upstream issue #296)`,
  };
}

export const bulwarkSettingsPurgeHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['archived'],
  order: 210,
  blocking: 'continue',
  run: runImpl,
};

let _registered = false;
export function registerBulwarkSettingsPurgeHook(): void {
  if (_registered) return;
  registerLifecycleHook(bulwarkSettingsPurgeHook);
  _registered = true;
}
