# Cluster Upgrade Skeleton — Roadmap

**Status:** Planning approved 2026-05-15. Not yet implemented.
**Target:** Ship before first production cluster cutover (a few weeks out).
**Owner:** Platform team.

This document is the implementation plan for a full cluster-lifecycle upgrade
pipeline that goes beyond image-pin commits and Drizzle DB migrations. It is
the locked, reviewed plan; deviations during implementation require an explicit
amendment to this file.

---

## 1. Problem Statement

Today the platform can advance a running cluster along two axes:

1. **Image updates** — CI's `build-deploy` workflow pins new image tags in the
   `main` branch; `sync-staging` merges main→staging; Flux reconciles. Solved.
2. **Database schema** — Drizzle migrations run at backend startup against the
   in-cluster `system-db` CNPG cluster. Solved.

Everything else — host packages, kernel sysctls, k3s version, new CRDs, RBAC
changes, namespace renames, Helm chart bumps, new DaemonSets, new operators,
OS upgrades — is bespoke SSH work and does not converge. The first production
deployment is weeks away; we need a repeatable, observable, auditable upgrade
path before then.

Bootstrap-as-substrate has known fragility. The 2026-05-14 fresh-bootstrap
on `testing.phoenix-host.net` surfaced 6 bugs in `scripts/bootstrap.sh` that
must be fixed before any upgrade pipeline can sit on top.

## 2. Architecture Overview

Three layers, all gated by a single `platform_version` stamp:

| Layer | Mechanism | Triggered by | Scope |
|---|---|---|---|
| **L1: Host config drift** | Privileged DaemonSet reconciler | Continuous (60s loop) | sysctls, kernel modules, ulimits, fs.inotify, `/etc/security/limits.d/*` |
| **L2: Cluster-shaped changes** | Drizzle-style platform-migration registry, run at backend startup | Backend pod startup | CRDs, namespace renames, RBAC, Helm bumps, seed data, in-cluster reshaping |
| **L3: Host-imperative changes** | In-cluster ops-runner Job re-execs `bootstrap.sh --upgrade` with SSH fan-out | Admin UI click (or staging auto-trigger) | k3s version, apt packages, kernel upgrades, OS upgrades, anything kubectl cannot reach |

All three are version-stamped via `platform/VERSION` (single line of semver,
identical to the git tag). All three are gated by pre-flight checks, post-flight
health probes, mandatory pre-upgrade snapshot, audit logging, and a Postgres
advisory lock that makes concurrent upgrade runs impossible.

Rollback is **snapshot-restore-based**, not per-migration `down()` functions.
Each upgrade run captures a structured snapshot manifest; rollback re-uses
existing PITR + Longhorn + secrets-bundle primitives to restore from it.

## 3. Locked Decisions (do not re-litigate)

Decisions made during plan review (2026-05-14 / 2026-05-15):

1. **Rollback in v1**: in scope, snapshot-restore-based.
2. **SSH key**: per-cluster, generated at bootstrap. NOT reused operator key.
3. **Phase 0 bootstrap-bug fixes**: standalone PR, lands before the rest.
4. **`platform/VERSION`**: same value as the git `vX.Y.Z` tag.
5. **Migration `down()`**: absent. Rollback uses snapshot-restore.
6. **Host-config allow-list (v1)**: sysctls, kernel modules, ulimits,
   fs.inotify, `/etc/security/limits.d/*`. Nothing else under `/etc`.
7. **First seed migration**: host-config-reconciler manifests + baseline record.
8. **k3s skip-a-minor**: REFUSE. Hard pre-flight gate.
9. **Tenant join during upgrade**: hard-block with `UPGRADE_IN_PROGRESS`
   operatorError.
10. **First prod cluster**: bootstraps straight onto the skeleton-aware version.
11. **Snapshot retention**: last 5 upgrade snapshots per cluster
    (configurable via `platform_settings`). Same on staging and prod.
12. **Rescue snapshot retention**: indefinite until operator deletes.
13. **Rollback authorization**: super_admin only.
14. **Flux pinning during rollback**: suspend Kustomizations → apply pinned
    SHAs via raw kubectl → resume after `installed_platform_version` is
    rewritten. **Phase 6 begins with a spike to validate this works.**
15. **Tenant-write soft freeze during snapshot capture**: 60–120s window
    where POST/PUT/DELETE returns 503 `SNAPSHOT_IN_PROGRESS`; reads stay up.
16. **`platform-api` self-rollback**: ops-runner Job bakes
    `oldPlatformApiImageTag` into its spec at Job creation time, so it can
    roll the Deployment back even when the running `platform-api` is broken.
17. **Cancel-in-progress upgrade**: `POST /api/admin/platform/upgrade/:runId/cancel`
    in Phase 4, with **UI extra-confirmation**: modal challenge requiring
    operator to type the version OR check an explicit "I understand this may
    leave the cluster in a partially-upgraded state" checkbox before the
    button enables.
18. **Auto-trigger on staging**: off by default.
19. **Staging-soak warning**: 48h. Warn if `stable` advances to a version
    that hasn't been on `staging` for 48h.
20. **Migration `runOnLocal`**: default true, opt-out per migration.

## 4. Environment Matrix

| Environment | Trigger | Pre-flight | Post-flight | Rollback | Concurrency lock |
|---|---|---|---|---|---|
| **Production** | Explicit operator click | Hard-block | Hard-block (3 fails → abort) | Yes, snapshot-restore | Yes |
| **Staging** | Explicit click by default; optional auto-trigger toggle | Warn-but-proceed (CNPG/Longhorn/snapshot-age); hard-block (snapshot-failure, skip-minor, concurrency) | Hard-block (same as prod) | Yes (same code path) | Yes |
| **Local / DinD** | Out of scope for v1 | Skipped | Skipped | N/A — re-bootstrap from scratch | N/A |

Driven by `K8S_ENVIRONMENT_KIND` env var on `platform-api` and ops-runner
(`local | staging | production`).

Local clusters get a `platform-version` ConfigMap stamped at bootstrap
(`0.0.0-local-<git-sha>`) so the UI doesn't crash; upgrade route returns
`LOCAL_CLUSTER_UNSUPPORTED`; UI hides the upgrade button when prefix matches.

Staging-as-prod-canary is enforced at the **git-workflow level**, not as a
runtime cross-cluster gate: prod pre-flight reads the git log to derive
"first seen on staging" timestamp for the target version, and warns (does not
block) if < 48h.

## 5. Implementation Phases

Each phase is independently shippable and independently useful.

### Phase 0 — Stabilise the substrate

**Goal:** Bootstrap is reliable enough to be the upgrade pipeline's action
library. Standalone PR; lands before any other phase.

- Fix the 6 known bootstrap.sh bugs from 2026-05-14:
  1. SSH-drop during silent Stalwart wait kills `--remote` — wrap remote waits
     in `nohup … &` + reattach loop.
  2. `create_roundcube_db()` references stale `cluster/postgres` — change to
     `system-db`.
  3. `bootstrap_stalwart_v016` 200-skip bypasses `configure_stalwart_full()`,
     so listeners 587/143/80 never get created — split listener bootstrap
     into its own idempotent function called unconditionally, or drop the
     200-skip path.
  4. Heredoc unquoted backticks emit cosmetic `master.local: command not found`
     stderr — quote heredocs.
  5. Configure pod blocked by mail-namespace NetworkPolicy — run from
     `platform` namespace, or add explicit egress allowance.
  6. Smoke script hardcodes `*.staging.phoenix-host.net` cluster name `postgres`
     and multi-node expectations → 11/23 false fails on single-node testing
     installs. Parameterise domain, use `system-db`, detect single-node.
- Extract bootstrap into sourced phase functions in
  `scripts/lib/bootstrap-phases.sh` (`phase_k3s`, `phase_flux`, `phase_calico`,
  `phase_longhorn`, `phase_cnpg`, `phase_stalwart`, …). bootstrap.sh becomes
  a thin orchestrator. Each function is idempotent.

**Validation:** Re-run fresh-bootstrap on `testing.phoenix-host.net` end-to-end
with no manual fix-up.

**Risk:** Medium. Surgical fixes to the install path.

### Phase 1 — Version stamping

**Goal:** Single source of truth for the cluster's installed version.

- `platform/VERSION` — one line of semver, e.g. `0.6.0`.
- CI bakes value into backend image and `platform-version` ConfigMap.
- `bootstrap.sh` + `local.sh` + `docker-compose.local.yml` write the
  ConfigMap idempotently. Local writes `0.0.0-local-<git-sha>`.
- `platform-api` Deployment gets a `platform.phoenix-host.net/version` label
  with the same value (visible via plain `kubectl get`).
- Backend at startup persists `platform_settings.installed_platform_version`.
- `GET /api/admin/platform/version` returns `{ installed, available, running }`.

**Risk:** Low.

### Phase 2 — Platform-migration registry

**Goal:** Drizzle-style declarative cluster migrations, run at backend startup.

- DB migration `0XXX_platform_migrations.sql`:
  `(version, name, applied_at, duration_ms, checksum, applied_by, error_text)`.
  Checksum protects against silent edits.
- `backend/src/modules/platform-upgrades/migrations/` — each migration is
  a TypeScript file exporting `{ version, name, irreversible, irreversibleReason?, runOnLocal, up(ctx) }`.
  Context = `{ db, kc /* k8s client */, logger, dryRun }`.
- `runner.ts` — discover, sort by `(version, name)`, skip if applied,
  Postgres advisory lock, write row on success, halt on failure.
- Wired into `backend/src/index.ts` startup: runs **after** Drizzle migrations,
  **before** HTTP listen. Fail-fast.
- `PLATFORM_SKIP_MIGRATIONS=1` env-var escape hatch for emergency rollback boot.
- Dry-run mode that calls `up(ctx)` with a recording fake k8s client; refuses
  any `create` (must be `apply`).
- Seed migrations to prove the pattern:
  - `0001_v0_6_0_seed_host_config_reconciler.ts` — applies Phase 3 manifests
    (parity with fresh bootstrap).
  - `0002_v0_6_0_record_baseline.ts` — records k3s/calico/longhorn versions
    to a new `platform_baselines` table for diff-on-upgrade.

**Risk:** Medium. Startup-blocking; mitigated by dry-run + escape hatch.

### Phase 3 — Host-config reconciler DaemonSet

**Goal:** Continuous convergence of sysctls + kernel modules + ulimits, even
for nodes that join post-bootstrap. Delivered as the first real
platform-migration to dogfood Phase 2.

- `k8s/base/host-config-reconciler/{daemonset,rbac,kustomization}.yaml`.
- Shape modeled on `k8s/base/firewall-reconciler/`. Privileged, hostPID,
  hostNetwork, mounts `/etc`, `/proc/sys`, `/lib/modules` from host.
- Desired state lives in a single ConfigMap `host-config-desired`:
  sysctls map, kernel modules list, ulimits map, fs.inotify caps,
  `/etc/security/limits.d/*` contents.
- Reconcile loop every 60s. Drift emits events; only allow-listed paths
  are ever touched.
- bootstrap.sh continues to write `/etc/sysctl.d/99-platform.conf` at first
  boot for boot-time correctness. Runtime drift converges via the DS.
- Retires `bootstrap-net-tuning` runtime role.

**Risk:** High (cap_sys_admin blast radius). Mitigations:
- Allow-list enforced in code; integration test asserts non-allow-listed
  paths are never modified.
- Image signed via cosign.
- Nightly diff alert.
- Read-only mounts of anything outside the allow-list.

### Phase 4 — Ops-runner Job + `bootstrap.sh --upgrade`

**Goal:** Imperative upgrade execution path for things kubectl alone cannot do.

- `scripts/bootstrap.sh` gains:
  - `--upgrade` mode
  - `--rollback` mode (Phase 6)
  - `--in-cluster` flag (skips first-install-only steps, uses in-cluster SA token)
  - `--from-version`, `--to-version`
- `scripts/upgrade-paths.yaml` — declarative per-version block listing the
  phase functions to re-run when advancing from version X to X+1.
  Each block declares:
  - `environments: [staging, production]` (local always refused).
  - `requiresMultiNode: bool` (topology check).
- `k8s/base/ops-runner/` — Job template + RBAC + ServiceAccount.
  - Job spec is created per-run by backend. Image = backend image (already
    has bootstrap.sh shipped in).
  - Mounts SSH key Secret + kubeconfig + repo at `/platform`.
  - Job spec bakes in `oldPlatformApiImageTag` from the snapshot manifest, so
    the ops-runner can roll back `platform-api` even after `platform-api`
    is broken.
- **Per-cluster SSH key**: generated at first bootstrap, stored as
  `ops-runner-ssh` Secret. Public half copied to a dedicated
  `platform-ops` user on every node (not root) with a restricted sudoers
  entry limited to `apt`, `systemctl`, `k3s`. Distinct from the operator's
  bootstrap key. Rotatable.
- RBAC: nodes get/patch/drain, deployments/patch in `platform-*` namespaces,
  helmreleases/patch. **No tenant namespace access.**
- DB: `platform_upgrade_runs` table.
- Endpoints (super_admin only):
  - `POST /api/admin/platform/upgrade` — takes lock, snapshots, creates Job,
    returns `runId`. Target task-center modal: `modal:platform-upgrade-apply`.
  - `GET /api/admin/platform/upgrade/:runId` — streams log + phase progress.
  - `POST /api/admin/platform/upgrade/:runId/cancel` — cancel in-progress
    run. **UI requires extra-confirmation** (type version OR confirm-checkbox
    before button enables).
- Multi-node coordination (v1): strictly serial. Drain → upgrade → uncordon,
  one node at a time. CNPG, Longhorn, Stalwart already tolerate
  single-node-down.
- Tenant create routes consult `platform_upgrade_runs.state='running'` and
  reject with `UPGRADE_IN_PROGRESS` operatorError.

**Risk:** High. SSH-with-elevated-privilege to every node is the largest
privilege escalation in the platform. Mitigations: per-cluster key,
dedicated `platform-ops` user (not root), restricted sudoers, hostkey
verification, audit log per run, documented rotation procedure.

### Phase 5 — Pre/post-flight gates + admin UI

**Goal:** Make upgrade runs observable, gated, and undoable from the UI.

- `backend/src/modules/platform-upgrades/preflight.ts`. Gates:
  - All CNPG clusters healthy (status, replica lag, WAL archiving).
  - Longhorn volumes have ≥2 healthy replicas.
  - No in-flight tenant migrations.
  - Flux suspended status known.
  - Recent system snapshot age < 24h, or take a fresh one.
  - Free disk per node > 20%.
  - One-minor-step-at-a-time check on k3s version (refuse skip-a-minor).
  - **Pre-upgrade snapshot capture itself succeeds** (the only pre-flight
    that mutates state).
  - Each failed gate returns a per-gate operatorError envelope.
  - Severity is `K8S_ENVIRONMENT_KIND`-driven: prod → all hard-block;
    staging → CNPG/Longhorn/snapshot-age downgrade to warnings;
    snapshot-failure, skip-minor, concurrency stay hard-block on both.
- `backend/src/modules/platform-upgrades/postflight.ts`. Runs after each
  phase:
  - Nodes Ready.
  - CNPG primary elected.
  - Stalwart `/admin/mail/health` green.
  - Ingress responds 200.
  - Backend deep-health green.
  - 3 consecutive fails → automatic phase abort.
  - Hard-block on staging AND prod (a broken staging upgrade IS the signal
    we want; warn-but-proceed defeats the purpose).
- Auto-trigger controller (`auto-trigger.ts`). When
  `platform_settings.upgrade.auto_trigger_on_version_pin_advance=true`,
  watches `platform-version-target` ConfigMap (written by Flux from the
  branch's `platform/VERSION`); when it advances AND pre-flight passes,
  POSTs the upgrade route on behalf of `system:upgrade-auto` principal.
  **Default off everywhere, including staging.** Bell-icon notification
  fires on every auto-triggered run.
- Admin UI:
  - Version banner across all admin pages when `available > installed`.
    Shows environment kind (`Production` / `Staging` / `Local`) with a
    colour chip.
  - `/platform/upgrades` page: installed/available versions, pending
    platform-migrations, pending host-config drift, phase plan, pre-flight
    results. Soft-warning rows in yellow vs hard-block in red.
  - Run modal: opens immediately on Confirm, hooks into task-center via
    target `modal:platform-upgrade-apply`, drill-down per phase, log tail,
    cancel button (with extra-confirmation as described).
  - On prod: "Staging soak status" row showing `stable` vs `staging`
    branch versions and first-seen-on-staging timestamp (git-derived,
    read-only).

**Risk:** Medium.

### Phase 6 — Rollback

**Goal:** Operator can roll back a completed or failed upgrade run while its
snapshot still exists.

**Phase 6 starts with a spike** to validate Flux Kustomization
suspend-then-pinned-apply-then-resume behaviour. If Flux re-asserts newer
SHAs on resume, the design needs adjustment before implementation continues.

- `UpgradeSnapshotManifest` (TypeScript shape):
  ```
  {
    runId, fromVersion, toVersion, capturedAt,
    components: {
      systemDb: { pgDumpKey, walLsn, cnpgBackupName },
      longhornVolumes: [{ pvc, snapshotName, namespace }],
      platformVersionConfigMap: { resourceVersion, dataHash },
      platformApiDeployment: { imageTag, generation, resourceVersion },
      fluxKustomizations: [{ name, namespace, sourceRevision, suspended: false }],
      hostPackageState: [{ node, k3sVersion, kernelVersion, packageHashesKey }],
      secretsBundleKey,
    },
    irreversibleNotes: string[],
    checksums_jsonb: { pgDumpSha256, secretsBundleSha256 },
  }
  ```
- Migration `0107_platform_upgrade_snapshots.sql`. Blob written to system
  backup PVC under `upgrade-snapshots/<runId>.json`.
- One snapshot per upgrade run, by construction. Captured by ops-runner as
  Phase 4's first step (mandatory; not operator-controlled).
- Reuses existing primitives:
  - `backend/src/modules/system-backup/pg-dump-orchestrator.ts` — system-db dump
  - `backend/src/modules/system-backup/wal-archive.ts` — WAL LSN pin
  - `backend/src/modules/postgres-restore/service.ts` — CNPG PITR
  - `backend/src/modules/system-backup/secrets-bundle.ts` — Secrets/ConfigMaps
  - New `backend/src/modules/platform-upgrades/longhorn-snapshot.ts` —
    VolumeSnapshot per PVC in platform/system-db/mail; tenant namespaces
    use group-snapshot-per-namespace to bound count.
- Retention: last 5 (configurable). Daily CronJob GCs older snapshots.
  WAL retention temporarily bumped during the upgrade window (Phase 4
  first step, restored at end).
- **Soft freeze** during snapshot capture: tenant mutating endpoints (POST/
  PUT/DELETE) return 503 `SNAPSHOT_IN_PROGRESS` for the 60–120s capture
  window. Reads stay up.
- `bootstrap.sh --rollback --rollback-snapshot-id <id> --in-cluster` sequence:
  1. Take **rescue snapshot** of current state (recorded with `kind='rescue'`,
     retained indefinitely).
  2. Suspend all platform Flux Kustomizations (record current revisions).
  3. Serial node drain.
  4. Restore CNPG via PITR pinned to snapshot's WAL LSN.
  5. Restore Longhorn volumes from VolumeSnapshots (parallel within ns,
     serial across ns).
  6. Restore Secrets/ConfigMaps from secrets bundle. Skip Secrets labelled
     `platform.phoenix-host.net/rotated-after-snapshot=true` (explicit
     opt-out for emergency-rotated credentials).
  7. Reverse host-package upgrades to recorded `k3sVersion` /
     `kernelVersion`. Re-apply kernel/sysctl baseline by rewriting the
     `host-config-desired` ConfigMap to the snapshot's `resourceVersion`;
     Phase 3 reconciler applies.
  8. Resume Flux Kustomizations pinned to snapshot's per-Kustomization
     `sourceRevision` via raw `kubectl apply -k` against the pinned Git SHA,
     then re-enable Flux.
  9. Restore `platform-version` ConfigMap and `installed_platform_version`.
  10. Last step: restore `platform-api` Deployment to snapshot's `imageTag`.
      Ops-runner Job has the **old** image baked in at upgrade-time, not
      the new one — this avoids the chicken-and-egg problem.
  11. Post-flight loop. 3 consecutive fails → `paused`, operator inspects.
- DB: `platform_rollback_runs` table.
  `(id, upgrade_run_id, snapshot_id, started_at, finished_at, status,
   rescue_snapshot_id, phase_log_jsonb, operator_user_id, reason)`.
- Endpoints:
  - `POST /api/admin/platform/upgrade/:runId/rollback` — body `{ reason }`,
    super_admin only, returns `rollbackRunId`.
    Refuses with `UPGRADE_RUN_NOT_TERMINAL` if any upgrade or rollback
    is currently running.
  - `GET /api/admin/platform/upgrade/rollback/:rollbackRunId`.
- Migrations declare `irreversible: boolean` + `irreversibleReason?: string`.
  Surfaced in pre-flight modal as a checkbox-confirm; **advisory only**,
  never blocking. Rollback is always snapshot-restore.
- UI:
  - Upgrade-run modal gains "Rollback this upgrade" button visible when
    run is `failed | partial_success | succeeded` AND snapshot exists.
  - `/platform/upgrades` page: each run row shows "rollback to before this".
  - `/platform/upgrades/rollback/:id` view, same drill-down shape.
  - Task-center target `modal:platform-rollback-apply`.
  - Local clusters: rollback API returns `LOCAL_CLUSTER_UNSUPPORTED`.

**Safety gates (all must hold):**
- Shared advisory lock with Phase 2 (no concurrent upgrade ↔ rollback).
- Tenant joins blocked with `UPGRADE_IN_PROGRESS` (reused).
- Rescue snapshot must succeed before any destructive step.
- Snapshot integrity check (SHA-256) before restoring.
- Per-PVC `VolumeSnapshot.status.readyToUse=true` required.
- Audit log entry per rollback with operator id + reason.

**Risks:**
- **Snapshot+upgrade race** — mitigated by soft freeze.
- **Longhorn replica drift mid-rollback** — pre-flight readiness check.
- **CNPG WAL retention exceeded** — snapshot includes full base backup,
  not just LSN pointer; WAL retention bumped during upgrade window.
- **`platform-api` self-rollback** — old image baked into ops-runner Job
  at Job-creation time.
- **Flux Kustomization pinning** — Phase 6 starts with a spike to validate
  suspend-pinned-apply-resume cycle does not have Flux re-asserting newer
  SHAs on resume.
- **Rollback succeeds but cluster broken in new way** — automated
  post-flight fails the rollback into `paused`; rescue snapshot enables
  "rollback the rollback" using the same code path.

## 6. Risk Register (aggregate)

| Risk | Severity | Mitigation |
|---|---|---|
| Privileged host-config DS attack surface | HIGH | Allow-listed paths, signed image, nightly diff alert |
| Ops-runner SSH-with-sudo to every node | HIGH | Per-cluster key, `platform-ops` user (not root), restricted sudoers, hostkey verification, audit log, documented rotation |
| Migration N+1 fails mid-fleet | HIGH | Idempotent migrations, runner halts on failure, prior rows preserved, mandatory pre-snapshot |
| Concurrent upgrade runs | HIGH | Postgres advisory lock + DB state machine |
| No prod battle-testing (first cutover) | HIGH | Rehearse v0.6→v0.7 on prod-shaped staging clone twice before any real prod upgrade. Freeze upgrades two weeks after first prod cutover. |
| Snapshot+upgrade race | MEDIUM | Soft freeze of tenant writes during snapshot capture |
| Longhorn replica drift mid-rollback | MEDIUM | Pre-flight readiness check |
| CNPG WAL retention exceeded | MEDIUM | Full base backup in snapshot + retention bump during window |
| `platform-api` self-rollback | MEDIUM | `oldPlatformApiImageTag` baked into Job at creation |
| Flux pinning behaviour unverified | MEDIUM | Phase 6 spike before implementation |
| Skip-a-minor k3s | MEDIUM | Hard pre-flight refuse |
| Tenant joins mid-upgrade | MEDIUM | `UPGRADE_IN_PROGRESS` hard-block |
| Migration authors use non-idempotent kubectl | MEDIUM | Lint rule + dry-run refuses on `create` |
| Staging auto-trigger surprises operator | LOW-MEDIUM | Off by default; bell-icon notification per auto-run |
| Soft-warning fatigue on staging | LOW | Yellow vs red UI, auto-dismiss after 24h green post-flight |
| Staging-prod topology divergence | LOW | `upgrade-paths.yaml` declares minimum topology; mismatch warns on staging, blocks on prod |
| "Rollback succeeded but broken in new way" | LOW (acknowledged limitation) | Rescue snapshot enables un-rollback |

## 7. Out of Scope (v1)

- Automatic rollback to N-1 without operator click (rollback button is
  manual).
- Multi-cluster fan-out (one upgrade, many clusters).
- Skip-a-minor k3s jumps.
- Cross-cloud cluster migration.
- Tenant workload graceful drain during host-package upgrades. Worker
  reboots evict Pods; Longhorn/replicas handle continuity.
- Local/DinD upgrade path. Local stays "destroy and rebuild".
- Cross-cluster runtime staging-soak gate. Staging-soak is git-log-derived
  only.
- Per-migration `down()` functions.

## 8. Success Criteria

- [ ] Fresh-bootstrap on a single-node Debian 13 host succeeds end-to-end
      with no manual fix-up.
- [ ] `platform/VERSION` value is identical in: repo file, image env,
      `platform-version` ConfigMap, `platform-api` Deployment label, and DB.
- [ ] Backend startup runs unfulfilled platform-migrations in order and
      refuses to listen on HTTP if any fail.
- [ ] Host-config-reconciler DS converges sysctl drift on a manually-broken
      `/etc/sysctl.d/99-platform.conf` within 60s.
- [ ] Super_admin can trigger an upgrade run from the admin UI, see
      task-center progress, view per-phase logs, run completes with all
      pre/post-flight gates green.
- [ ] Cancel-in-progress upgrade endpoint works; UI requires extra
      confirmation before enabling.
- [ ] Tenant create returns `UPGRADE_IN_PROGRESS` while a run is active.
      Concurrent upgrade attempt returns the same.
- [ ] Every upgrade run captures a manifest-described snapshot before any
      destructive phase.
- [ ] Rollback API + UI button works for `succeeded`, `failed`,
      `partial_success` runs while snapshot exists.
- [ ] Rescue snapshot is always taken before rollback destructive steps.
- [ ] Concurrent upgrade ↔ rollback impossible.
- [ ] Irreversible-migration notes surface in pre-flight; user must confirm.
- [ ] Staging upgrade exercises the same code path as prod, with
      `K8S_ENVIRONMENT_KIND`-driven gate severity.
- [ ] Local/DinD surfaces sensible `platform-version`, does not crash UI,
      upgrade button hidden.
- [ ] Staging-soak status visible on prod's upgrade page (read-only,
      git-derived).
- [ ] Auto-trigger off by default; super_admin notification fires on every
      auto-triggered run.
- [ ] Staged v0.5→v0.6 upgrade in DinD produces cluster diff-clean against
      a fresh v0.6 install.
- [ ] `scripts/integration-platform-upgrade.sh` v0.5→v0.6→rollback cycle
      leaves cluster diff-clean within allow-list (audit_events,
      `platform_upgrade_*` metadata, CNPG WAL LSN advanced,
      Pod restartCount/age).
- [ ] Audit log records every upgrade: start, each phase, snapshot taken,
      pre-flight results, completion, who triggered, cancel reason if
      applicable.
- [ ] No regression in existing fresh-bootstrap timings (within +20%).

## 9. Testing Strategy

- **Unit:** migration runner ordering + idempotency + checksum drift;
  preflight gate evaluators; semver comparison; advisory-lock contention;
  bootstrap-phase function selection; snapshot manifest shape;
  rollback-service mock paths; irreversible-flag surfacing.
- **Integration (DinD):**
  - Scripted `bootstrap.sh --upgrade` from v0.5 fixture → v0.6 current,
    asserting CRDs land, DS rolls, platform-migrations record one row each.
  - Failure-injection mid-migration leaves DB in recoverable state; re-run
    succeeds.
- **E2E (staging):**
  - `scripts/integration-platform-upgrade.sh` — full upgrade against
    testing cluster with live admin UI, asserting task-center entry,
    audit-log entries, snapshot taken, tenants answer HTTP 200 throughout.
    Shaped like `scripts/integration-stalwart-mail-ha.sh`.
  - `scripts/integration-platform-rollback.sh`:
    - R1: baseline v0.5.x fingerprint.
    - R2: upgrade to v0.6.0 via real ops-runner.
    - R3: trigger rollback API.
    - R4: diff vs R1 within allow-list.
    - R5 (negative): induce CNPG restore failure mid-rollback by deleting
      VolumeSnapshot before step 4; assert rollback enters `paused` and
      rescue snapshot intact.
- **Fresh-bootstrap parity:** CI matrix job — fresh-install v0.5, then
  upgrade-install to v0.6 — assert cluster diff vs direct fresh-install of
  v0.6 is empty.

## 10. Open Questions

None blocking implementation as of 2026-05-15. Outstanding items that
surface during implementation must be raised as amendments to this
document.

## 11. Related Documents

- `docs/04-deployment/DEPLOYMENT_PROCESS.md` — current image-pin pipeline
- `docs/04-deployment/STAGING_DEPLOYMENT.md` — staging branch semantics
- `docs/04-deployment/INCIDENT_RESPONSE_RUNBOOK.md` — restore runbook linked
  from the no-rollback notice on local clusters
- `docs/07-reference/ADR-028-backup-architecture.md` — system-backup
  primitives reused by snapshot manifest
- `docs/07-reference/ADR-029-secrets-and-dr.md` — secrets-bundle primitives
- `docs/07-reference/ADR-032-backupstore-interface-and-bundle-orchestration.md`
- `docs/07-reference/ADR-034-restore-execution-model-and-cart-pattern.md`
- `docs/07-reference/NODE_ROLE_TAXONOMY.md` — node-role placement constraints
  for ops-runner Job affinity
- `scripts/bootstrap.sh` — substrate
- `k8s/base/firewall-reconciler/daemonset.yaml` — shape template for Phase 3

## 12. Change Log

- 2026-05-15 — Initial roadmap committed after two planning rounds and
  20 locked decisions.
