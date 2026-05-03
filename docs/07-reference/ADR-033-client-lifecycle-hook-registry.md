# ADR-033: Client Lifecycle Hook Registry

**Status:** Accepted (2026-05-02)
**Author:** Sebastian Buchweitz
**Supersedes:** Inline `Promise.allSettled` cascade blocks in
`backend/src/modules/client-lifecycle/cascades.ts` (deleted in Phase 6).

## Context

Every client transition (`active`, `suspended`, `archived`, `restored`,
`deleted`) needs to mutate state across many subsystems:

* DB tables (domains, deployments, mailboxes, email_aliases, cron_jobs,
  clients itself for status + timestamps)
* Kubernetes resources (tenant namespace + every Ingress in it,
  ClusterRoleBindings + cross-ns NetworkPolicies, Released PVs +
  Longhorn volume CRs)
* External systems (DNS provider zones, S3/SSH backup-bundle stores)

The pre-2026-05 implementation buried these in `applyActive`,
`applySuspended`, `applyArchived`, and `applyDeleted` as inline
`Promise.allSettled` blocks. Three problems:

1. **Silent orphans on bulk delete.** `bulkDeleteClients` in the
   `/admin/clients/bulk` route bypassed `applyDeleted` entirely —
   wrote DB and namespace inline, skipped every external-cleanup
   call. DNS zones, backup bundles, Released PVs all leaked.
2. **No retry, no audit.** A failed cleanup printed `console.warn`
   and disappeared. Operators had no visibility, no way to retry,
   no audit trail.
3. **Hard to add new cleanup steps.** Each new external system
   (NetBird peers, Stalwart per-client config, OIDC client
   deregister) required editing `cascades.ts`, adding more inline
   `try`/`catch` chains, and hoping the order was right.

## Decision

Replace the inline cascade blocks with a **single in-process
registry** of `LifecycleHook`s. Each transition is dispatched through
a runtime that:

1. Writes a `client_lifecycle_transitions` row (parent).
2. Topo-sorts the hooks subscribed to that transition (by `order` +
   `after` graph).
3. Pre-inserts one `client_lifecycle_hook_runs` row per hook
   (state=`pending`).
4. Runs each hook sequentially, persisting `state` and `attempts`
   before/after.
5. Marks the parent transition `completed` / `failed_partial` /
   `failed_blocking` based on hook outcomes + blocking policy.

Failed hooks with `status='retry'` get `next_attempt_at = now() +
exponential_backoff(attempt)`. A 2-minute scheduler tick
(`startLifecycleHookRetryScheduler`) re-runs eligible rows. A
per-hook in-memory circuit breaker (5 consecutive failures within
10 min → 10 min cool-off) protects providers from runaway retries.

### Hook contract

```ts
interface LifecycleHook {
  name: string;                              // globally unique
  transitions: readonly Transition[];        // active|suspended|archived|restored|deleted
  order: number;                              // sparse; lower runs first
  blocking: 'abort' | 'continue';            // abort halts the dispatcher
  maxAttempts?: number;                      // default 5
  backoffMs?: (attempt: number) => number;   // default exponential 5s..5min
  after?: readonly string[];                 // hard ordering deps
  run(ctx: HookCtx): Promise<HookResult>;
}
```

### Idempotency contract

Every hook MUST be safe to re-run. The retry scheduler does not
distinguish "this hook has already been tried" from "this hook
should run again" — it just re-executes. Hooks should:

* Treat 404/not-found on delete operations as success (already gone).
* Treat already-correct state writes as success (`status='active'`
  on an already-active row is fine).
* Read fresh state at hook entry rather than caching at boot.

### Failure policy

* `blocking: 'abort'` — on failure, the dispatcher halts. Remaining
  hooks stay `pending`. Transition marked `failed_blocking`. Used
  for source-of-truth DB writes (DB-cascades hooks, status-stamp).
* `blocking: 'continue'` — on failure, the dispatcher carries on
  to the next hook. Transition ends `failed_partial`. Used for
  external-system cleanup that must not block the transition
  (DNS, backup bundles, cluster-scoped refs).

### Operator kill-switch

Hooks with no legacy fallback (DNS, backups-v2, cluster-scoped-refs)
accept an emergency disable via env:

```
LIFECYCLE_HOOK_DNS_ZONE_CLEANUP=disable
LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP=disable
LIFECYCLE_HOOK_CLUSTER_SCOPED_REFS=disable
```

Disabled hooks return `noop` immediately; operator handles cleanup
manually until the underlying provider outage clears. DB-only hooks
have no kill-switch by design — their failure mode is local code,
not transient external outage.

## Consequences

### Positive

* **Discoverable.** `grep registerLifecycleHook` finds every hook
  in one shot; reviewers can confirm coverage per transition.
* **Observable.** Every transition leaves a queryable trail in
  `client_lifecycle_transitions` + `client_lifecycle_hook_runs`.
  Admin UI at Settings → Lifecycle Hooks renders per-hook last-7d
  success rate, recent transitions with hook_runs detail, Retry-now
  + Reset-breaker buttons.
* **Durable.** Failed hooks retry on a 2-minute scheduler tick. A
  pod restart mid-transition no longer leaves orphan PVs.
* **Bulk-safe.** `/admin/clients/bulk` (POST + DELETE) routes through
  the cascade, so every per-client transition triggers all hooks.
  Each transition is tagged with `detail.bulkOpId` so the UI can
  fan out queries.
* **Operator UX.** PATCH /clients/:id/status from the admin panel
  opens a `TransitionProgressModal` that polls per-hook state at
  1.5s intervals and renders failed hook envelopes inline.
  Bulk operations open a `BulkProgressModal` showing N rows with
  per-client transition + hook_runs detail.

### Negative

* **In-memory state.** The circuit breaker map is per-replica.
  Resetting a breaker via `POST /admin/lifecycle/breakers/:hook/reset`
  only clears the breaker on the pod that handled the request.
  Response includes `replicaHostname` so operators can re-issue.
  A future enhancement could persist breaker state in Redis.
* **At-most-once retry guarantee.** The scheduler retries until
  `attempts >= maxAttempts`; after that the row is permanent
  `failed`. The transition stays `failed_partial`. Operators must
  manually intervene via Retry-now or fix root cause + Reset
  breaker.

## Adding a hook

1. New file `backend/src/modules/client-lifecycle/hooks/my-hook.ts`.
   Export a `LifecycleHook` and a `registerMyHook()` function with
   a module-local `_registered` guard.
2. Add the register call to
   `backend/src/modules/client-lifecycle/hooks/index.ts:registerAllLifecycleHooks()`.
3. Unit-test with the established pattern: mock `vi.hoisted` spies
   for K8s/db, drive the hook with a stub `HookCtx`, assert on
   result status + envelope fields.
4. Add an integration assertion to `scripts/integration-lifecycle-e2e.sh`
   that the hook fires on the expected transition kind.
5. If the hook depends on cluster-scoped K8s resources, update
   `k8s/base/rbac.yaml` with the necessary `verbs` and confirm via
   the E2E that no 401/403 surfaces.

## Out of scope

* Refactoring `storage_operations` (snapshot/restore/quiesce
  orchestration) into hooks — kept as the existing parallel
  pattern. Future work could collapse them.
* Cross-client locking. Per-client serialization via the existing
  `clients.active_storage_op_id` is sufficient.
* Hook plugin loading from external packages — registry stays
  in-tree.

## Reference implementation

* Registry + dispatcher: `backend/src/modules/client-lifecycle/registry/`
* Scheduler + retry: `backend/src/modules/client-lifecycle/scheduler.ts`
* Hooks (today): `backend/src/modules/client-lifecycle/hooks/`
  * `pv-cleanup-released.ts` — Released PVs + Longhorn volume CRs
  * `db-domains.ts`, `db-cronjobs.ts`, `db-mailboxes.ts`,
    `db-email-aliases.ts`, `db-deployments.ts`, `db-clients-stamp.ts`
  * `k8s-ingress.ts` — suspend/resume/reconcile
  * `dns-zone-cleanup.ts` — provider.deleteZone() on every domain
  * `backups-v2-cleanup.ts` — store.delete() on every backup_jobs row
  * `cluster-scoped-refs.ts` — ClusterRoleBindings + cross-ns NetworkPolicies
* UI: `frontend/admin-panel/src/components/{TransitionProgressModal,BulkProgressModal}.tsx`,
  `frontend/admin-panel/src/pages/LifecycleHooksSettings.tsx`
* Schema: `backend/src/db/migrations/{0069,0071}_*.sql`
