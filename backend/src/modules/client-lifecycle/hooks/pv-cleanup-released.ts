import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * Phase 2 hook — replaces the fire-and-forget `cleanupReleasedPvs`
 * launched from `cascades.applyDeleted`.
 *
 * Semantics:
 *   - Trigger: client `deleted` transition.
 *   - Blocking: `continue`. A failure to reap orphans should not
 *     abort the delete; the orphan-volumes scanner is the safety net.
 *   - Idempotent: re-running on a namespace whose PVs have already
 *     been deleted yields `noop`.
 *   - Late-binding aware: a PVC that was Pending when the dispatcher
 *     ran may bind moments later. Hook polls for up to 60 s, same as
 *     the legacy code, but the dispatcher's retry tick (Phase 5) can
 *     fire it again if the window closed before the PV materialised.
 *
 * Why blocking=continue instead of abort:
 *   The orphaned-volumes modal + the new manual Purge All button
 *   already provide a user-visible safety net. A transient k8s API
 *   blip during cleanup should not leave the operator unable to
 *   delete a client; better to mark the hook failed_partial and let
 *   the scheduler retry.
 *
 * Why we still keep the legacy `cleanupReleasedPvs` until Phase 6:
 *   The feature flag (LIFECYCLE_HOOK_PV_CLEANUP) defaults to `legacy`.
 *   When `legacy`, the hook still runs but the legacy code is also
 *   running — so the hook records observability data without changing
 *   behaviour. When operator flips to `hook`, the legacy path early-
 *   returns and the hook becomes the only cleaner.
 */

interface PvLite {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly claimRef?: { readonly namespace?: string } };
  readonly status?: { readonly phase?: string };
}

const POLL_WINDOW_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
// If no candidate PVs have appeared after this many consecutive polls,
// exit early as `noop`. PVC binding is async but typically completes
// within seconds — burning the full 60 s on a no-storage client just to
// confirm nothing claimed the namespace is wasteful.
//
// IMPORTANT timing risk: a PVC that binds AFTER this grace window but
// before the legacy 60 s window is missed when LIFECYCLE_HOOK_PV_CLEANUP=
// hook is set. The legacy poll catches it because it always burns the
// full 60 s. Until the Phase 5 scheduler retry tick lands, operators
// flipping the flag to `hook` accept a narrow miss window (~6 s to
// 60 s post-delete) for unusually slow PVC binding. The orphan-volumes
// scanner is the operator-visible safety net — anything missed shows
// up there for manual Purge.
const EMPTY_POLL_GRACE_CYCLES = 3;

async function reapPvsForNamespace(
  ctx: HookCtx,
): Promise<{ found: number; reaped: number; lhReaped: number; missed: string[] }> {
  const { k8s, namespace } = ctx;

  // Pre-snapshot — same logic as cleanupReleasedPvs.
  const tracked = new Set<string>();
  try {
    const pvsBefore = await k8s.core.listPersistentVolume({}) as { items?: readonly PvLite[] };
    for (const p of pvsBefore.items ?? []) {
      const name = p.metadata?.name;
      if (name && p.spec?.claimRef?.namespace === namespace) tracked.add(name);
    }
  } catch {
    // listPersistentVolume failures are diagnosed via the K8s probe;
    // not a fatal hook outcome.
  }

  const handled = new Set<string>();
  const startedAt = Date.now();
  let emptyPolls = 0;
  while (Date.now() - startedAt < POLL_WINDOW_MS) {
    const pvsNow = await k8s.core.listPersistentVolume({}).catch(() => null);
    if (!pvsNow) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const items = ((pvsNow as { items?: readonly PvLite[] }).items ?? []);
    const stillPresent = new Set<string>();
    for (const p of items) {
      const name = p.metadata?.name;
      if (!name) continue;
      stillPresent.add(name);
      if (p.spec?.claimRef?.namespace === namespace) tracked.add(name);
      if (!tracked.has(name) || handled.has(name)) continue;
      if (p.status?.phase === 'Released') handled.add(name);
    }
    for (const c of tracked) {
      if (!stillPresent.has(c)) handled.add(c);
    }
    if (tracked.size > 0 && handled.size >= tracked.size) break;
    // Late-binding grace: if nothing has appeared yet, keep polling
    // for a few cycles — but not the full 60 s — so a no-storage
    // client doesn't burn the full window for no reason.
    if (tracked.size === 0) {
      emptyPolls++;
      if (emptyPolls >= EMPTY_POLL_GRACE_CYCLES) break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  let reaped = 0;
  let lhReaped = 0;
  for (const pvName of handled) {
    try {
      await k8s.core.deletePersistentVolume({ name: pvName });
      reaped++;
    } catch (err) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status !== 404) throw err; // surface unexpected errors via hook envelope
    }
    try {
      await k8s.custom.deleteNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes', name: pvName,
      } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
      lhReaped++;
    } catch (err) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status !== 404) throw err;
    }
  }

  const missed: string[] = [];
  for (const t of tracked) if (!handled.has(t)) missed.push(t);

  return { found: tracked.size, reaped, lhReaped, missed };
}

export const pvCleanupReleasedHook: LifecycleHook = {
  name: 'pv-cleanup-released',
  transitions: ['deleted'],
  // Order 100 — runs early in the deleted transition so any subsequent
  // hook that needs the PVs gone (e.g. cluster-scoped-refs that
  // remove RBAC referencing a namespace) sees a clean slate.
  order: 100,
  blocking: 'continue',
  async run(ctx: HookCtx): Promise<HookResult> {
    try {
      const result = await reapPvsForNamespace(ctx);
      if (result.found === 0) {
        return { status: 'noop', detail: 'no PVs claimed this namespace at delete time' };
      }
      if (result.missed.length > 0) {
        return {
          status: 'retry',
          detail: `${result.missed.length}/${result.found} PV(s) did not reach Released within 60s`,
          envelope: {
            title: 'PV cleanup partially complete',
            detail: `${result.reaped} PV(s) reaped; ${result.missed.length} still in flight`,
            remediation: [
              'Wait for the scheduler retry tick to drain remaining PVs',
              'Or open the Orphaned Volumes modal and Purge All manually',
            ],
          },
        };
      }
      return {
        status: 'ok',
        detail: `reaped ${result.reaped} PV(s) + ${result.lhReaped} Longhorn volume(s)`,
      };
    } catch (err) {
      return {
        status: 'failed',
        envelope: {
          title: 'PV cleanup failed',
          detail: err instanceof Error ? err.message : String(err),
          remediation: [
            'Check Longhorn UI for stuck volumes',
            'Open the Orphaned Volumes modal — manual Purge All is safe',
          ],
          raw: err instanceof Error ? err.stack ?? err.message : String(err),
        },
      };
    }
  },
};

let _registered = false;
export function registerPvCleanupReleasedHook(): void {
  if (_registered) return;
  registerLifecycleHook(pvCleanupReleasedHook);
  _registered = true;
}
