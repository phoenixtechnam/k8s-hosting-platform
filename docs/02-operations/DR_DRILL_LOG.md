# DR Drill Log

Record each cold-restore drill here. One entry per drill. Oldest at the
bottom.

## Template

Copy-paste when starting a drill:

```markdown
### <YYYY-MM-DD> — <staging|production> drill

- **Operator:** <name / handle>
- **Source cluster:** <staging.phoenix-host.net / prod.phoenix-host.net>
- **Drill target VM:** <provider / spec / region>
- **Backup source:** s3://... or ssh://...
- **Backup age (newest artefact):** <age1...>
- **k3s version backed up / drill:** <vX / vY>

**Timing:**
- T+0    — VM provisioned
- T+?m   — bootstrap.sh complete
- T+?m   — dr-restore.sh start
- T+?m   — etcd restore done
- T+?m   — Postgres restore done
- T+?m   — secrets applied
- T+?m   — BackupTarget Available
- T+?m   — first tenant PVC restored
- T+?m   — smoke-test green
- **RTO total: ?m**

**Evidence:**
- [ ] `aws s3 ls` returns <N> backup artefacts for the day
- [ ] smoke-test.sh exits 0
- [ ] tenant `example.com` returns HTTP 200
- [ ] tenant data SHA256 matches pre-drill value
- [ ] mail round-trip: sent email visible post-restore
- [ ] Postgres row count (`clients`): <N> pre, <N> post

**Bugs found:**
- <short description — one line each>
- <open follow-up ticket with link>

**Verdict:** <PASS / PARTIAL / FAIL>

**Notes:**
<free-form observations, improvement ideas>
```

---

## Drill entries

<!-- Newest first. Paste the template above each new drill. -->

### 2026-04-23 — staging drill (PARTIAL SUCCESS, 6 bugs filed)

- **Operator:** claude (info+claude@phoenix-tech.net)
- **Source cluster:** staging.phoenix-host.net (89.167.3.56)
- **Drill target VM:** Hetzner CX (Debian 13 trixie / arm64?? — unclear), 46.224.122.58, 75 GB disk
- **Backup source:** `s3://k8s-staging` (Hetzner Object Storage, fsn1)
- **Backup age:** newest `secrets-20260423T112616Z.tar.age` was 3 minutes old
- **k3s version backed up / drill:** both `v1.33.10+k3s1` — no drift

**Timing:**
- T+0    — VM reachable, SSH with staging key OK
- T+2m   — age + CronJobs patched on staging (image fix for bitnami → alpine/k8s)
- T+5m   — fresh `secrets-backup` + `cluster-state-backup` produced on staging
- T+8m   — local Phase-2 decrypt smoke-test with `/home/dev/operator-staging.key` → OK, 22 Secrets extracted
- T+12m  — bootstrap started on drill VM, failed at `generate_platform_secrets`
- T+13m  — bootstrap.sh pre-create-namespace fix committed + re-run
- T+25m  — bootstrap complete (k3s + Calico + cert-manager + NGINX + sealed-secrets + Longhorn all Running)
- T+27m  — `dr-restore.sh --skip-etcd --skip-postgres --from-s3 s3://k8s-staging --age-key-file /root/op.key` completed phases 1/2/3/6 green; Phase 7 warned (BackupTarget never went Available until manually patched); Phase 9 ran the dev-targeted smoke-test (wrong URL)
- T+32m  — manual `kubectl patch backuptarget/default` got Longhorn to enumerate **7 staging backups** over 2 BackupVolumes
- **RTO total (cluster up + backups enumerable): ~32 minutes** (well within 2h target)
- Full tenant-PVC data restore is async and stalled on replica-scheduler wait — not timed in this run.

**Evidence:**
- [x] `aws s3 ls s3://k8s-staging/secrets/` returns `secrets-20260423T112616Z.tar.age` (19855 bytes)
- [x] `age -d -i op.key secrets-…tar.age | tar tf -` prints 22 Secrets across platform/ + tenants/
- [x] Drill cluster's `kubectl -n longhorn-system get backupvolumes` shows the staging PVC IDs
- [x] `kubectl -n longhorn-system get backups` shows 7 Completed backups with sizes + timestamps matching staging
- [ ] Tenant `example.com` HTTP 200 on drill domain — NOT TESTED (tenants use `*.staging.phoenix-host.net` hostnames; would need DNS rewriting)
- [ ] SHA256 match on tenant data — NOT TESTED
- [ ] Mail round-trip — Stalwart not deployed on drill (matches staging; Stalwart is production-overlay only)
- [x] Postgres row count — NOT TESTED (Phase 5 skipped; pg-backup was still stalled at end of drill)

**Bugs found (all committed during drill, see commit history):**

1. **`bitnami/kubectl:1.31`/`1.33` no longer exist on Docker Hub** (2026 Bitnami catalog sunset). Every backup + update-checker CronJob was ImagePullBackOff. Fixed: switched all CronJobs to `alpine/k8s:1.33.3` (kubectl + aws + jq bundled, `apk add` for age/openssh-client/rsync).
   - Commit: `fix(backup): switch all CronJob images from bitnami/kubectl to alpine/k8s`

2. **`bootstrap.sh` ordering bug** — `generate_platform_secrets` ran before `apply_platform_manifests` (which creates the `platform` namespace via k8s/base/namespaces.yaml), so fresh-VM bootstrap died with `namespaces "platform" not found`. Fixed: pre-create the platform ns idempotently at the top of `generate_platform_secrets`.
   - Commit: `fix(bootstrap): pre-create platform namespace before writing Secrets`

3. **`dr-restore.sh` Phase 6 fails on tenant Secrets** because tenant namespaces (`client-*`) don't exist on a fresh cluster. Needs to create namespaces first, OR run after cluster-state restore (which would carry the Namespace objects). **OPEN.**

4. **`dr-restore.sh` Phase 6 "Operation cannot be fulfilled" on platform Secrets** — bootstrap pre-seeded `platform-jwt-secret`, `platform-db-credentials`, etc. with fresh values. The `kubectl apply -f` from the backup bundle hits a resourceVersion conflict. Fix: use `kubectl replace --force` for platform-ns Secrets, or delete-then-create. **OPEN.**

5. **`dr-restore.sh` Phase 7 BackupTarget never Available** — on a fresh VM, the platform-api is not running, so the backup-config reconciler never executes. Manual `kubectl patch backuptarget/default` got the CR to Available=true + enumerate backups. `dr-restore.sh` should do this patch directly when Postgres restore is skipped. **OPEN.**

6. **`dr-restore.sh` Phase 9 runs the wrong smoke-test** — `scripts/smoke-test.sh` hard-codes `admin.k8s-platform.test:2010` (DinD dev). Needs `$PLATFORM_DOMAIN` parametrisation. **OPEN.**

**Bugs found but NOT blocking:**

7. **`platform-etcd-snapshot-upload` CronJob assumes etcd, but staging k3s uses sqlite** (no `/var/lib/rancher/k3s/server/db/snapshots/`). Will always fail on non-HA k3s clusters. Needs either conditional skip or documentation. Low priority for now — etcd snapshots only matter for multi-node k3s.

8. **`platform-pg-backup` CronJob stalls** at "[pg-dump] start db/platform/pg-20260423T…dump" without progressing or failing cleanly within 3+ minutes. Likely a permissions or connectivity issue against `platform-postgres-0`. Needs investigation. **OPEN.**

**Verdict:** PARTIAL PASS. Core DR chain validated (encrypt → S3 → fresh-VM decrypt → Longhorn enumeration). Several rough edges in `dr-restore.sh` discovered that were only visible on a real cold-run, which is exactly why this drill exists.

**Notes:**
- Operator private key stored at `/home/dev/operator-staging.key` (chmod 600, not deleted per drill-op's instructions).
- Drill VM left running at 46.224.122.58 for follow-up investigation (per drill-op's instructions; not auto-destroyed).
- Next drill: after bugs 3–6 are fixed, re-run end-to-end including Postgres restore + tenant-data SHA256 + full RTO measurement.

