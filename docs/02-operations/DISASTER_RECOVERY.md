# Disaster Recovery Runbook

> Audience: the on-call operator at 03:00 UTC when `staging` (or, heaven
> forbid, production) is gone. This document walks the full cold-restore
> from nothing-but-backups back to a working cluster.

## What this runbook covers

- **Total cluster loss** (fresh VM, no surviving nodes).
- **Control-plane failure** where etcd is unrecoverable but backups exist.
- **Accidental destructive operation** (`helm uninstall`, bad `kubectl apply`)
  that needs rolling back past Longhorn's PVC-level snapshots.

What it does **not** cover:

- **DNS loss** — DNS/NetBird/IAM are external (ADR-022). Use the
  PowerDNS / NetBird / Dex runbooks in their respective repos.
- **Application-level data corruption** with intact infra — use the
  admin panel's per-PVC snapshot restore button instead.

## Recovery time & recovery point objectives

| Objective | Target | Actual (last measured) |
|---|---|---|
| RTO (cluster back up) | ≤ 2 hours | _measured during Phase 5 drill — record in DR_DRILL_LOG.md_ |
| RPO (data loss window) | ≤ 24 hours | bounded by Longhorn `daily-backup` + `secrets-backup` (both daily) |

## Prerequisites (BEFORE you start)

You need:

1. **Operator age private key** — `AGE-SECRET-KEY-1…`. Stored in 1Password
   / Bitwarden / paper vault per `docs/02-operations/OPERATOR_KEY_SETUP.md`.
   Without this, **backups are not decryptable and this runbook does not apply.**

2. **Backup target credentials:**
   - S3: access key + secret + bucket + endpoint + region.
   - SSH: private SSH key + destination `user@host:/path`.

3. **A freshly-bootstrapped k3s VM.** Run `./scripts/bootstrap.sh
   --domain <FQDN> --env production --operator-age-recipient <age1…>`
   FIRST. Bootstrap is a prerequisite, not scope of this runbook.

4. **Binaries on the restore host:** `age kubectl tar gzip aws` (or
   `scp ssh rsync` for SSH target), `pg_restore`. The `dr-restore.sh`
   preflight check lists anything missing.

## The script

```bash
# S3 source
./scripts/dr-restore.sh \
  --from-s3 s3://phoenix-host-backups-staging/staging \
  --s3-endpoint https://fsn1.your-objectstorage.com \
  --s3-region eu-central \
  --age-key-file ~/operator-staging.key

# SSH source
./scripts/dr-restore.sh \
  --from-ssh backupuser@backup.example.com:/srv/backups/staging \
  --ssh-key ~/.ssh/backup_ed25519 \
  --age-key-file ~/operator-staging.key
```

Required environment:

```bash
export AWS_ACCESS_KEY_ID=...         # only for S3 source
export AWS_SECRET_ACCESS_KEY=...     # only for S3 source
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml  # usually already set
```

The script is idempotent — re-run after fixing a mid-restore failure
and it picks up where it failed.

## Phase-by-phase

### Phase 1: Prerequisites

Binaries, cluster reachable, age key shape sensible. Fails fast if any
of these are wrong. Nothing written.

### Phase 2: Decrypt smoke-test ← CRITICAL GATE

Pulls the newest `secrets-*.tar.age` from the backup target and
`age -d -i <key>` it. If this fails, **stop** — either the key doesn't
match or the artefact is corrupt. Running any subsequent destructive
phase with a bad key guarantees a broken restore.

Common failure modes:

| Error | Meaning | Fix |
|---|---|---|
| `age: decryption failed: no identity matched` | Wrong key for this bucket | Find the right key, or restore from a different backup |
| `tar: This does not look like a tar archive` | Decrypt passed, but artefact corrupt | Use the second-newest artefact (`ls -1t … \| tail -n +2 \| head -1`) |
| `aws: SignatureDoesNotMatch` | Wrong S3 credentials | Verify AWS_* env vars |
| `scp: Permission denied` | Wrong SSH key or host | Verify `--ssh-key` path + `ssh-copy-id` |

### Phase 3: Pull artefacts

`aws s3 sync` / `rsync -az` pulls everything from the target into
`/var/lib/dr-restore/<timestamp>/raw/`. Longhorn backup-store data is
**excluded** (Longhorn pulls it directly from S3 in Phase 7).

### Phase 4: etcd restore

The k3s control plane is stopped, the snapshot is copied into
`/var/lib/rancher/k3s/server/db/snapshots/`, `k3s server --cluster-reset
--cluster-reset-restore-path=…` runs, k3s starts back up.

The script sleeps 10s before starting this phase so you can Ctrl-C if
you realise you're pointing at the wrong cluster.

### Phase 5: Postgres restore

`kubectl cp` the dump into `platform-postgres-0`, `pg_restore
--clean --if-exists` there. Drops + recreates every table, so
Phase 5 **destroys whatever was in the Postgres at this point**. This is
expected — the cluster at this point is a fresh bootstrap with empty
schemas.

### Phase 6: Secrets re-apply

Age-decrypt the `secrets-*.tar.age` bundle, `kubectl apply` each YAML.
This restores platform Secrets (JWT, DB creds, OIDC config, TLS certs)
and tenant Secrets in `client-*` namespaces.

### Phase 7: Longhorn BackupTarget reactivate

Waits up to 2 minutes for `BackupTarget/default.status.available=true`.
The platform-api pod's own reconciler does the actual Secret write when
it starts; this phase just asserts it worked.

If the BackupTarget doesn't become available: `kubectl describe
backuptarget default -n longhorn-system` — common cause is S3 creds
didn't make it into `longhorn-backup-credentials` Secret. Re-activate
the backup config from the admin panel to trigger the reconciler.

### Phase 8: Longhorn volume restore

For each BackupVolume CR Longhorn has enumerated from the bucket, issue
a Longhorn `Volume` CR with `fromBackup: "bs://<vol>?backup=<name>"`.
Longhorn performs the actual data restore asynchronously — expect this
phase to return before restore completes. Track with:

```bash
watch kubectl get volume -n longhorn-system
```

Binding restored volumes to specific PVCs is a separate step — easiest
via Longhorn UI (Volume → Attach → Create PV & PVC).

### Phase 9: Smoke test

`./scripts/smoke-test.sh` — hits `/api/v1/health` and a couple of
tenant-visible endpoints. If any fail, the restore isn't complete.

## Verification after the run

Beyond the smoke-test:

1. **Tenant site check.** Pick a known tenant, visit their domain. Compare
   SHA256 of the rendered `index.html` pre-disaster vs. post-restore.
2. **Mail round-trip.** Send a test email to a known mailbox, verify it
   arrives AND that old pre-disaster emails are intact.
3. **Database row count.** Compare `SELECT count(*) FROM clients`
   pre- vs. post-restore.
4. **Longhorn backup integrity.** Trigger a fresh backup (`admin-panel
   → Backups → Trigger Backup Now`) and confirm it completes.

## When something goes wrong mid-restore

| Failure | Action |
|---|---|
| Decrypt smoke-test fails | STOP. Do not continue. Confirm key + pick a different artefact. |
| etcd restore timeout | `journalctl -u k3s -n 200`. Usually a k3s version mismatch between bootstrap and the snapshot; bootstrap with the same `--k3s-version` as the backed-up cluster. |
| Postgres pod not running | `kubectl -n platform logs platform-postgres-0`. If PVC is stuck pending, Longhorn BackupTarget isn't up yet — restart the CronJob-driven restore after Phase 7. |
| BackupTarget not Available | Admin panel → Backups → re-activate the S3 config. Triggers the reconciler manually. |
| Volume restore stuck | Longhorn UI → Volume → check status. Often bandwidth-bound; patience. |
| Smoke test fails on /api/v1/health | Check `platform-api` pod logs — usually a missing env var; re-apply secrets. |

## Rollback: restore went sideways and you want to start over

```bash
# Stop k3s
systemctl stop k3s
# Blow away the state (THIS IS DESTRUCTIVE)
k3s-uninstall.sh
# Re-bootstrap from scratch, same --operator-age-recipient so the
# existing backups stay decryptable.
./scripts/bootstrap.sh --domain <FQDN> --env production \
  --operator-age-recipient "$(head -1 ~/operator.key | awk ...)"
# Re-run dr-restore.
```

## Annual drill

The restore script is only trustworthy if it's exercised. Schedule a
drill:

- **Staging: quarterly.** Provision a throwaway Hetzner VM, `dr-restore`
  from the real staging backups, smoke-test, destroy.
- **Production: annually.** Same flow, same throwaway VM. Log in
  `DR_DRILL_LOG.md`.

Each drill must record: date, operator, wall-clock RTO, bugs found,
follow-up tickets opened.

## Risk & mitigation reference

| Risk | Mitigation |
|---|---|
| Operator loses age key | 1Password + offline paper (see OPERATOR_KEY_SETUP.md). |
| Backup bucket becomes unreachable (Hetzner outage) | Dual-target setup — keep a secondary SSH target if the regulatory cost justifies it. Current setup is single-target S3. |
| Wrong age key used in a drill | Phase 2 smoke-test catches this before anything destructive runs. |
| k3s version drift between bootstrap and backup | Pin `bootstrap.sh --k3s-version` to match the backed-up cluster's version. Recorded in the backup's `cluster-state` dump (look for `k3sVersion` in the cluster ConfigMap). |
| Restore succeeds but old tenant PVC data is gone | Longhorn Volume restore is async — check Longhorn UI after Phase 8. |
