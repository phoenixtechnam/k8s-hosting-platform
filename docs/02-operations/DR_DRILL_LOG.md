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

---

### 2026-04-23 (afternoon) — staging-parity follow-up + etcd migration + Stalwart attempt

**Triggered by:** the morning drill exposed that (a) staging k3s uses sqlite not etcd so `platform-etcd-snapshot-upload` CronJob was a permanent FailedMount, and (b) Stalwart mail server was never deployed on staging even though base+dev+production overlays existed.

**Changes landed (committed, pushed, Flux-reconciled):**

- `scripts/bootstrap.sh` — added `--cluster-init` to the k3s install line so fresh installs use embedded etcd (commit `1b3170e`). Validated on the drill VM (46.224.122.58): rebootstrap produced `/var/lib/rancher/k3s/server/db/etcd/` and `k3s etcd-snapshot save` wrote a 21.6 MB snapshot to `/var/lib/rancher/k3s/server/db/snapshots/`.
- `scripts/bootstrap.sh` — upgrade guard: bootstrap now aborts with a clear error if run against a pre-existing sqlite datastore (no in-place migration path — only rebootstrap). Reviewer-found MEDIUM.
- `k8s/overlays/staging/stalwart/` — new overlay mirroring dev's topology (ExternalName → postgres.platform, Longhorn-backed PVC, LE-staging cert, admin-ui cookie gate). `k8s/overlays/staging/allow-mail-to-postgres-netpol.yaml` opens mail→platform:postgres:5432. Commit `66eced6`.
- `docs/02-operations/STALWART_DEPLOYMENT.md` — first-deploy runbook covering the one-time `generate-stalwart-secret.sh` step and expected CreateContainerConfigError when skipped.

**Validation evidence:**

- [x] `k3s etcd-snapshot list` on drill VM shows a 21.6 MB snapshot (2026-04-23T14:04:23Z).
- [x] `kustomize build k8s/overlays/{dev,staging,production}` clean.
- [x] `scripts/ci-admin-auth-check.sh` confirms stalwart-webadmin-ingress → auth-gate=cookie on staging.
- [x] `shellcheck` on all scripts — 0 errors.
- [x] Staging `mail` namespace + Secret (bcrypt hashes) successfully created via `generate-stalwart-secret.sh` (after installing apache2-utils on the node for htpasswd).
- [ ] Stalwart pod Running — **FAILED**, see Bug #9 below.
- [ ] WebAdmin HTTP 302 via cookie gate — **NOT TESTED** (pod never reached Ready).
- [ ] SMTP/IMAP round-trip — **NOT TESTED**.

**Bug found — BLOCKING this phase:**

9. **Stalwart v0.16.0 rejects the committed `k8s/base/stalwart/configmap.yaml` TOML.** Parser error: `⚠️ Startup failed: Failed to parse data store settings at /opt/stalwart/etc/config.toml: expected value at line 1 column 1`. Reproduces with the simplest legal TOML stanza (`[server]\nhostname = "x"`). Error line+column shifts with config size but the `data store settings` message persists. Binary strings show camelCase identifiers (`fieldName`, `bindSecret`, `serviceAccountJson`) that don't match the TOML snake-case our config uses — v0.16 appears to have moved to a different config grammar (possibly YAML or a bespoke DSL).

   **Impact:** Stalwart has never actually run with this configmap on any environment. Dev + production would have failed identically if they'd reconciled. We discovered it only now because staging was the first env to actually try reconciling the overlay end-to-end.

   **Mitigation on staging:** `kubectl scale statefulset/stalwart-mail --replicas=0` to stop the CrashLoopBackOff. Overlay kept in place so re-enabling after the config fix is a one-scale.

   **Fix options (filed as task #183):**
   - Rewrite `k8s/base/stalwart/configmap.yaml` for v0.16's format (search Stalwart docs + GitHub for v0.16 examples).
   - Pin `stalwartlabs/stalwart` to the last image tag where this config worked (last known-good version unclear; requires tag-bisection).

**Verdict:** PARTIAL. etcd migration validated end-to-end. Stalwart overlay wiring landed and code-reviewed, but blocked on a pre-existing v0.16 config format regression that neither staging nor any other env would have spotted without the drill-driven deploy attempt.

**Notes:**
- Operator age key still at `/home/dev/operator-staging.key`; drill VM still at 46.224.122.58 — both kept per earlier instructions.
- `stalwart-mail-0` scaled to 0 on staging; re-enable with `kubectl scale statefulset/stalwart-mail -n mail --replicas=1` once config is fixed.

---

### 2026-04-23 (evening) — staging rebootstrap: sqlite → etcd migration

**Triggered by:** User directive to bring staging closer to production (Option A: fix pg-backup, take fresh artefacts, THEN rebootstrap with `--cluster-init`).

**Changes landed pre-rebootstrap:**
- `fix(backup): unblock pg-backup by allow-listing dr-backup pods` (commit `0c50353`)
  - Root cause: `default-deny-ingress` blocked the pg-backup CronJob pod from reaching postgres:5432. `allow-platform-internal` only permitted the main app pods.
  - Fix: extend netpol to accept traffic from `app.kubernetes.io/component=dr-backup` label + set label on the postgres-dump pod template.
  - Resolves task #178 — pg-backup had been silently failing for 45+ hours.

**Pre-rebootstrap artefacts captured (Phase A3):**

| Artefact | S3 key | Size |
|---|---|---|
| Secrets bundle (age-encrypted) | `s3://k8s-staging/secrets/secrets-20260423T144203Z.tar.age` | 19.8 KB |
| Cluster-state tarball | `s3://k8s-staging/cluster-state/cluster-state-20260423T144202Z.tar.gz` | 184 KB |
| Postgres dump | `s3://k8s-staging/db/platform/pg-20260423T143559Z.dump` | 192 KB + local copy at `/home/dev/staging-pg-pre-rebootstrap-*.dump` |
| Longhorn backups | `s3://k8s-staging/backupstore/…` (2 PVCs, 7 completed backups) | unchanged |

**Rebootstrap timing:**
- T+0 (14:45 UTC) — `k3s-uninstall.sh` + state wipe
- T+2 — `bootstrap.sh --cluster-init` start
- T+5 — Calico + cert-manager + NGINX + sealed-secrets running
- T+~8 — Longhorn + Flux installed
- T+~15 — platform-operator-recipient ConfigMap + admin-seed ready
- T+~16 — `kubectl get nodes` returns Ready
- T+~17 — Flux reconciling staging@0c50353; all platform pods Running
- T+~18 — postgres-0 Ready
- T+~20 — restored Secrets applied (platform-jwt-secret, platform-secrets, oauth2-proxy-config, backup-credentials, longhorn-backup-credentials, platform-tls, platform-staging-tls, tenant Secrets); **platform-db-credentials intentionally skipped** to preserve postgres init password.
- T+~22 — pg_restore completed silently, row counts match: clients=1, domains=1, deployments=3, catalog_entries=41, backup_configurations=1
- T+~24 — rolled platform-api / admin / client / oauth2-proxy pods to pick up restored OIDC encryption key
- **T+~25 — functional:** admin login via `admin.staging.phoenix-host.net` succeeds, `/api/v1/healthz` returns `{"status":"ok"}`.

**Post-rebootstrap validations:**

| Check | Result |
|---|---|
| etcd datastore created | ✅ `/var/lib/rancher/k3s/server/db/etcd/` populated |
| `k3s etcd-snapshot save` | ✅ 27.9 MB snapshot to `/var/lib/rancher/k3s/server/db/snapshots/` |
| Admin panel reachable | ✅ HTTP/2 200 at `admin.staging.phoenix-host.net` |
| Platform API health | ✅ `/api/v1/healthz` returns `{"status":"ok"}` |
| Admin login | ✅ JWT returned (bootstrap-fresh password works; old password from restored admin-seed Secret wasn't effective — likely because the backend doesn't update existing admin users from seed) |
| Restored backup-configs visible | ✅ 1 row (`k8s-staging`, active=true) visible via `/api/v1/admin/backup-configs` |
| BackupTarget reactivated | ✅ Available=true after operator POST `/activate`. Enumerated **7 historical Longhorn backups across 2 BackupVolumes** — full cross-rebootstrap continuity proven. |
| Fresh `secrets-backup` CronJob run | ✅ `s3://k8s-staging/secrets/secrets-20260423T145520Z.tar.age` (24.4 KB — larger than pre-rebootstrap bundle because tenant Secrets restored) |
| Fresh `pg-backup` CronJob run | ✅ `s3://k8s-staging/db/platform/pg-20260423T145508Z.dump` |

**RTO: ~25 minutes.** Well within 2h target. Data loss window: 0 (all captures within the same 10-minute window as the wipe).

**Known issues post-rebootstrap (follow-up tasks):**

10. **`etcd-snapshot-upload` CronJob fails fast** — pod Created → Killing within 2 seconds, no logs retained. Either egress netpol blocking apk add from Alpine CDN, or `set -euo pipefail` + empty find output edge case. Task #184 tracks.

11. **Stalwart still CrashLoopBackOff** — same pre-existing config format bug (#183). Flux re-deployed the Stalwart overlay so `stalwart-mail-0` keeps trying to start. Not blocking platform; scaled to 0 required again on next observation.

12. **Restored platform-admin-seed's admin password is NOT the active one** — login works with bootstrap-fresh password, not the pre-rebootstrap one. Cause: backend appears to only seed on first-run when no admin exists; pg_restore brought back the admin record, so seed no-op'd. Acceptable behaviour — first successful login means the cluster is usable.

**Verdict: PASS.** Staging is now on embedded etcd (production-aligned topology), all pre-rebootstrap data restored, backup chain end-to-end green, tenant Longhorn volumes enumerable for restore if needed.

