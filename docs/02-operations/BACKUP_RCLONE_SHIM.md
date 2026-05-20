# Backup-rclone-shim operator runbook

> **Status:** R-X1–R-X8 + R-X11 (restore tooling) shipped. rclone-push callers (R-X9), UI (R-X10), restore
> tooling (R-X11), DR drill (R-X12), legacy archive (R-X13), perf
> benchmark (R-X14) follow. Operator-visible surfaces below are LIVE
> from R-X5.

## Restore tooling (R-X11)

Three per-subsystem restore scripts cover the critical SYSTEM + MAIL
paths. All read from the shim's buckets and use the HKDF-derived
shim creds — no separate restore credentials to manage.

| Script | Subsystem | Mode |
|---|---|---|
| `scripts/restore-postgres-from-shim.sh` | `SYSTEM.postgres` | `--latest` (newest base + WAL replay) / `--pitr <RFC3339>` (point-in-time recovery via WAL replay) |
| `scripts/restore-etcd-from-shim.sh` | `SYSTEM.etcd` | `--latest` (newest snapshot) / `--name <file>` / `--list` |
| `scripts/restore-mail-from-shim.sh` | `MAIL.stalwart-rocksdb` | `--latest` (newest restic snapshot) / `--snapshot <id>` / `--list` |

### Workflow safety

**Postgres**: the restore script spawns a NEW Cluster CR
(`system-db-restore-<ts>`) with its own PVC. The live `system-db`
is left intact. Operator manually swaps the Service / DNS / app
connection strings after validating the restored data — no automatic
cutover (too dangerous for a load-bearing DB).

**etcd**: must run as root on a control-plane node. Stops k3s, runs
`k3s etcd-snapshot restore`, restarts k3s. Verifies the snapshot's
sha256 against the `.meta` sidecar before applying. The on-disk
snapshot is left at `/var/lib/rancher/k3s/server/db/snapshots/restore-from-shim-<ts>.db`
for re-runs.

**Mail**: destructive — overwrites the running mail server's PVC.
Scales Stalwart to 0, runs `restic restore`, scales back. Requires
the operator to type `restore-mail` at the confirmation prompt.

### Cold-cluster sequence (lost-everything DR)

If both the platform-api and the running shim are gone (e.g.
hardware loss, region failure):

1. `bootstrap.sh` on a fresh cluster — installs k3s, CNPG, the shim
   DaemonSet, etc. Restore the BACKUP_TARGET_KEY from the Tier-1
   secrets bundle (`make secrets-restore`).
2. PUT `/admin/backup-rclone-shim/assignments/system` with the
   recovered SYSTEM target id. The shim reconciler renders
   ConfigMap + Secret + DaemonSet annotation; pods roll into place.
3. Run `restore-etcd-from-shim.sh --latest` on the control-plane
   node — gives you back the cluster state.
4. Wait ~5 min for the platform-api scheduler to materialise the
   ObjectStore CR (R-X6 reconciler).
5. Run `restore-postgres-from-shim.sh --latest` — creates a fresh
   `system-db-restore-<ts>` Cluster. Inspect, then rename to
   `system-db`.
6. PUT MAIL assignment + run `restore-mail-from-shim.sh --latest`.

End-to-end DR drill (R-X12) ships in a follow-up to validate this
sequence on a real cluster wipe.

---

## etcd snapshot upload via the shim (R-X7)

The CronJob `platform/etcd-snap-via-shim` runs hourly on a control-plane
node. It reads k3s's auto-snapshots from `/var/lib/rancher/k3s/server/db/snapshots/`
(hostPath read-only), uploads each fresh snapshot to the shim bucket
`s3://system/etcd/<host>-<ts>.db`, writes a `.meta` sidecar with the
sha256, and prunes to keep the newest 24 in the bucket.

`spec.suspend` is owned by `platform-api`'s `etcd-cronjob` reconciler:

- SYSTEM target bound → `suspend: false` (cron fires every hour)
- SYSTEM target unbound → `suspend: true` (no upload attempts; the
  shim has no bucket configured for an unassigned class, so noisy
  "bucket not found" failures are avoided)

5-min reconciler tick. Idempotent — patches only when the live
`spec.suspend` doesn't match the desired state.

The legacy `etcd-snapshot-cronjob` (direct-to-S3 via aws-cli with the
`backup-credentials` Secret) ships alongside in `k8s/base/backup/`
during the transition. R-X13 archives it once shim coverage is
proven on staging.

### Recover from a shim-uploaded etcd snapshot

(Full restore tooling lands in R-X11.) Until then:

```bash
# Pick the newest etcd snapshot in the shim bucket.
kubectl -n platform exec -it deploy/backup-rclone-shim -- \
  rclone lsf :s3:system/etcd/ | tail -5

# Download it locally on the control-plane node.
rclone copyto :s3:system/etcd/<host>-<ts>.db /var/lib/rancher/k3s/server/db/snapshots/restore.db

# Stop k3s, restore, restart.
systemctl stop k3s
k3s etcd-snapshot restore --name restore /var/lib/rancher/k3s/server/db/snapshots/restore.db
systemctl start k3s
```

---

## Postgres backups via the plugin (R-X6)

The CNPG cluster `platform/system-db` ships with the
`barman-cloud.cloudnative-pg.io` plugin attached. The plugin Deployment
lives in `cnpg-system/` (`k8s/base/cnpg-system/plugin-barman-cloud-v0.12.0.yaml`,
vendored from upstream v0.12.0). When the operator binds the SYSTEM
shim class to a backup target, `platform-api`'s `postgres-objectstore`
reconciler materialises:

| Resource | Namespace | Purpose |
|---|---|---|
| `backup-rclone-shim-creds` Secret | `platform` | HKDF-derived `access_key` + `secret_key` the CNPG plugin sidecar uses to authenticate to the local-node shim |
| `system-postgres-objectstore` ObjectStore CR | `platform` | barman-cloud config: `s3://system/postgres` via `http://backup-rclone-shim.platform.svc:9000`, zstd compression, 30-day retention |
| `system-db-scheduled-backup` ScheduledBackup CR | `platform` | Daily 03:00 UTC base backup via plugin method; `suspend: true` when SYSTEM is unassigned |
| `system-db.spec.plugins[0].isWALArchiver` patch | `platform` | Reconciler patches `true` when SYSTEM is bound, `false` when unbound — prevents pg_wal accumulation on an unassigned cluster |

The Cluster CR in `database.yaml` declares the plugin entry but
**intentionally omits** `isWALArchiver`. The reconciler owns that
field (CI invariant 12 enforces this) — static `isWALArchiver: true`
would cause WAL archive_command failures every checkpoint when SYSTEM
is unassigned, silently filling `pg_wal/`. The reconciler toggles on
when SYSTEM is bound and off when not.

### Restoring postgres (preview — R-X11 ships the full tooling)

The plugin supports two recovery modes:
- **Volume snapshot bootstrap** — fastest path; CNPG creates a new
  Cluster from a barman-cloud `VolumeSnapshot`. ~30 s.
- **Backup recovery** — restore from base backup + WAL replay to a
  point-in-time. RPO bounded by `archive_command` cadence (≤5 min in
  steady state).

R-X11 will ship `scripts/restore-postgres.sh` with both modes wired
through a single wizard. Until then, manual recovery via:

```bash
kubectl -n platform get backups
kubectl -n platform get objectstore system-postgres-objectstore -o yaml
# Then create a new Cluster CR with spec.bootstrap.recovery.source set
# to the ObjectStore. See plugin-barman-cloud README.
```

### Plugin RBAC — known accepted risk

The upstream v0.12.0 manifest grants the `plugin-barman-cloud`
ServiceAccount a ClusterRole with cluster-wide `secrets:
[create, delete, get, list, watch]` and `roles + rolebindings:
[create, get, list, patch, update, watch]`. Documented in
`k8s/base/cnpg-system/kustomization.yaml`. Mitigations:

- Plugin image is pinned by digest in the vendored manifest.
- The plugin's only external trust is the operator-supplied ObjectStore
  creds Secret (HKDF-derived from BACKUP_TARGET_KEY; reconciled each
  tick).
- Future tightening (filed as follow-up): replace ClusterRole with a
  namespaced Role bound only to `platform`.

The shim is a per-node `rclone serve s3` DaemonSet that mediates every
backup pipeline’s upstream storage. Three buckets (`system`, `tenant`,
`mail` — each with a `-raw` passthrough alias) front one operator-chosen
target type (S3, SFTP, CIFS, NFS) per class. One platform-wide
`BACKUP_TARGET_KEY` Secret drives every derived credential (rclone
`crypt`, restic password, the shim’s own S3 access/secret) via HKDF.

See [`docs/04-deployment/BACKUP_ARCHITECTURE_RFC.md`](../04-deployment/BACKUP_ARCHITECTURE_RFC.md)
for the full architecture (RFC §13a/§13b).

---

## Day-2 operations

### Inspect current state

| What | How |
|---|---|
| Class-to-target bindings | `GET /api/v1/admin/backup-rclone-shim/assignments` (super_admin) |
| Shim reconciler state | `GET /api/v1/admin/backup-rclone-shim/status` |
| Live ConfigMap | `kubectl -n platform get cm backup-rclone-shim-status -o yaml` |
| Live DaemonSet rollout | `kubectl -n platform get ds backup-rclone-shim` |
| In-flight shim consumers | `inflightConsumerCount` field on the `/status` response |

`STATE_OK` means inputs hashed cleanly and the DaemonSet annotation
was bumped (rolling restart in progress or complete).
`STATE_NO_ASSIGNMENTS` means every class has `targetId: null` — the
shim sleeps; no upstream IO happens. `STATE_MISSING_KEY` means the
`platform/backup-target-key` Secret is gone — re-run
`bootstrap.sh` or restore from the Tier-1 secrets bundle.
`STATE_ERROR` is followed by a free-form `errorMessage` and a
self-heal retry on the next 5-minute tick (no operator action
required unless the message repeats).

### Switch a class to a new target

```bash
curl -X PUT https://admin.<domain>/api/v1/admin/backup-rclone-shim/assignments/system \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "targetId": "<backup_configurations.id of the new target>",
    "force": false,
    "drainTimeoutSecondsOverride": 600
  }'
```

The endpoint returns immediately with `{data, taskId}`. The frontend
opens the `shim-target-switch` progress modal; the task-center chip
shows live progress through 6 phases:

1. **drain_immediate** / **drain_waiting** / **drain_timeout_forced** / **drain_skipped** — wait for in-flight backups using the OLD config to finish
2. **db_write** — replace-set the assignment row inside one transaction
3. **reconcile** — render the new `rclone.conf` and `buckets.txt`, materialise ConfigMap + Secret + SSH-keys Secret, bump the DaemonSet annotation
4. **verify_ready** — poll the DaemonSet until updated+available ≥ desired (120 s ceiling)
5. **done**

**Drain timeout** is per-target. Default 300 s. Bound 30..1800 s.
Override per-operation with `drainTimeoutSecondsOverride`. On
timeout the apply proceeds anyway and the operator gets a `warning`
notification in the bell:

> **Backup MAIL target switch: drain timeout**
> Waited 305s for 2 in-flight backup operations to complete;
> force-applied the new shim config with 1 still running.
> Inflight at force: 1 mail.archive. Retry any failed backups from
> Backups → Mail.

### Force a drain without changing config

When an upstream provider needs maintenance and you want to flush
in-flight uploads before scheduled work picks up:

```bash
curl -X POST https://admin.<domain>/api/v1/admin/backup-rclone-shim/drain-now \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"classes":["system"]}'   # or [] for all classes
```

Same chip + modal as the assignment switch (`backup.shim.drain` task
kind). No DB write, no DaemonSet roll.

### Force-apply through stuck backups

If a backup has been wedged for hours and you NEED to switch targets:

```bash
... -d '{"targetId":"<new-id>", "force":true}'
```

`force=true` short-circuits the drain wait. The new config takes
effect immediately; any backup in mid-upload over the old config
gets a connection abort. They will retry on the next schedule.

### Rotate `BACKUP_TARGET_KEY`

```bash
make backup-target-key-rotate
```

3-step confirmation gate. Rotating invalidates EVERY existing backup
artefact across every assigned target (rclone `crypt` password, restic
password, and shim S3 creds all derive from the same key). Operators
must have the offline bundle copy before proceeding — the prompt
verifies this explicitly.

---

## Troubleshooting

### Shim DaemonSet doesn't roll after `PUT /assignments`

1. Check the task-center entry — did `verify_ready` succeed or time out?
2. `kubectl -n platform get ds backup-rclone-shim -o yaml | grep -A2 config-hash`
   — does the `spec.template.metadata.annotations.config-hash` reflect a recent value?
3. `kubectl -n platform describe ds backup-rclone-shim` — look for
   `FailedCreate` events (PSA admission, image pull, etc.)
4. Read the status CM: `kubectl -n platform get cm backup-rclone-shim-status -o yaml`
   — if `state: STATE_ERROR`, the `errorMessage` field names the root cause.

### `STATE_ERROR` repeats on every tick

The reconciler persists `inputHash: ''` on STATE_ERROR so the next tick
re-attempts (CI guard invariant 3 enforces this). If the same error
keeps appearing, the underlying cause is real — common cases:

- Decryption failure on a target row → `PLATFORM_ENCRYPTION_KEY`
  mismatch between platform-api Pod and the row that wrote the
  encrypted column. Check the platform-api Deployment env.
- DB write failure on the status CM itself → apiserver overload,
  RBAC drift. `kubectl auth can-i patch configmap backup-rclone-shim-status -n platform --as system:serviceaccount:platform:platform-api`
- DaemonSet patch failure → check RBAC on the platform-api SA.

### Drain never completes

If `drain_waiting` runs to timeout, the inflight task list in the
task-center modal names the culprit. Common cases:

- A `backup.run` task pinned by a wedged CNPG WAL archive job →
  `kubectl -n cnpg-system get backup` + inspect the long-running
  Backup CR.
- A `mail.archive` task pinned by a Stalwart export Job that lost
  its Pod → `kubectl -n mail get jobs | grep mail-archive`
- A `backup.bundle` orchestrator that crash-looped → check the task
  row's `error_message`.

Clean the dead task by clearing it from the bell (the orphan reaper
also runs hourly) or set `cleared_at = NOW()` directly. The drain
poll picks up the change on the next tick.

### Verify-ready times out (DaemonSet did not settle)

The DB write + reconcile succeeded; only the post-roll Pod readiness
check timed out. Causes:

- A node went `NotReady` mid-rollout → fix the node, the DS converges
  automatically.
- New rclone config rejected by the upstream → Pod readiness probe
  fails. `kubectl -n platform logs ds/backup-rclone-shim` shows the
  rclone error.
- ConfigMap drift between the static placeholder and the reconciler's
  managed keys → `kubectl -n platform get cm backup-rclone-shim-config -o yaml`
  and compare against expectations (launcher.sh = operator-owned,
  buckets.txt = reconciler-owned).

---

## CI guards

`scripts/ci-backup-rclone-shim-check.sh` enforces 8 invariants:

1. Routes are super_admin-only.
2. `SHIM_CLASSES` locked to `['system','tenant','mail']`.
3. Reconciler writes `inputHash: ''` on `STATE_ERROR` paths (self-heal).
4. `SHIM_CONSUMER_TASK_KINDS` covers all documented kinds.
5. Migration 0016 CHECK constraint allows the 3 shim classes.
6. Every `SHIM_CONSUMER_TASK_KINDS` entry is registered in `TASK_KIND_REGISTRY`.
7. Migration 0017 enforces `drain_timeout_seconds BETWEEN 30 AND 1800`.
8. `routes.ts` invokes `buildK8sClients()` lazily per-request.

Wired into Infrastructure CI.

---

## E2E coverage

`scripts/integration-backup-rclone-shim.sh` exercises:

- Preflight (super_admin reachability, migration 0017, DaemonSet, key Secret)
- List + status (read-only)
- Full PUT → reconcile → verify-ready cycle (assign + unassign)
- Drain-now (all classes + class-filtered)
- Six negative paths (no bearer, unknown target, bound override, invalid class)

Bundled into `scripts/integration-all.sh` PARALLEL bucket. Runs against
DinD + dev minio locally, or staging against the operator-assigned S3.
