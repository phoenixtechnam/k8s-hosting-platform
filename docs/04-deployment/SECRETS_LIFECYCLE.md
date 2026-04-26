# Secrets Lifecycle

How platform-level secrets are generated, stored, retrieved, rotated, restored.

## TL;DR

- `bootstrap.sh` writes Tier-1 secrets to a single age-encrypted bundle on the first server. **Values are never printed.** Only file paths.
- The operator scp's the bundle + the operator-private key off the server with `make secrets-fetch HOST=...`.
- A daily K8s CronJob (`platform-secrets-backup`) re-bundles + uploads to S3 (or SSH target) — covers Tier-3 rotations automatically.
- Lost the admin password? `scripts/admin-password-reset.sh --email <addr> --random` resets it on-server in <1s.

## Where things live

| Artifact | Path on first server | Mode |
|---|---|---|
| Operator age private key | `/var/lib/hosting-platform/operator-key/operator-private.key` | 0600 |
| Operator age recipient (public) | `/var/lib/hosting-platform/operator-key/operator-recipient.pub` | 0644 |
| Bootstrap secrets bundle | `/var/lib/hosting-platform/bundles/bootstrap-secrets-<utc-stamp>.tar.age` | 0600 |
| Daily snapshots (S3) | `s3://<bucket>/<prefix>/secrets/secrets-<utc-stamp>.tar.age` | bucket-policy |
| `platform-operator-recipient` ConfigMap | `cm/platform-operator-recipient -n platform` | cluster |
| Platform Secrets | `Secret/* -n platform` (also `mail`, `longhorn-system`) | cluster |

## The 3-tier secret model

| Tier | Examples | Cadence after install | Coverage |
|---|---|---|---|
| **1 — Bootstrap-time** | operator-age private key, admin seed pwd, JWT signing key, postgres root pwd, S3 access keys, Dex client secret, oauth2-proxy cookie, sftp host keys, stalwart secrets | Once at install. Rotated only intentionally. | Captured by the bootstrap bundle (P1) AND by the daily backup CronJob (P3). |
| **2 — Runtime-issued** | Per-tenant DB passwords, per-client SFTP keys, mailbox app secrets | Continuous (every new client) | Captured by postgres pg_dump + Longhorn S3 backups + the daily secrets CronJob (every Secret in `client-*` namespaces). |
| **3 — Operator-rotated** | Admin password rotation, JWT secret rotation, S3 credential rotation | Rare (monthly-quarterly) | Captured by the daily secrets CronJob within ≤24h of rotation. For zero-RPO, run `make secrets-fetch` after every rotation. |

## Bootstrap output

`bootstrap.sh` (first server only) writes 3 things at the end:

```
Operator age key generated.
  private key:  /var/lib/hosting-platform/operator-key/operator-private.key  (mode 0600 — copy offline + delete)
  recipient:    /var/lib/hosting-platform/operator-key/operator-recipient.pub  (mode 0644 — safe to share)
  See docs/04-deployment/SECRETS_LIFECYCLE.md for retrieval steps.
...
Bootstrap secrets bundle written:
  /var/lib/hosting-platform/bundles/bootstrap-secrets-2026-04-26T13Z.tar.age  (7 item(s), age-encrypted to operator recipient)
  Retrieve via: make secrets-fetch HOST=root@<this-server>
```

**Key/recipient values are never printed** to stdout, stderr, or any log. Only file paths.

If the operator passed `--operator-age-recipient age1...` (their own pre-existing key), no private key is generated and no key file is written — only the bundle.

## Retrieval — `make secrets-fetch`

On the operator workstation:

```bash
make secrets-fetch HOST=root@46.224.122.58
# Optional overrides:
#   SSH_KEY=~/hosting-platform.key  (default)
#   DST=~/k8s-staging               (default)
```

Pulls every `*.tar.age` and `operator-key/*` file from `/var/lib/hosting-platform/` on the host to `~/k8s-staging/`. Once verified, **delete from the server**:

```bash
ssh root@46.224.122.58 'shred -u /var/lib/hosting-platform/operator-key/operator-private.key /var/lib/hosting-platform/bundles/bootstrap-secrets-*.tar.age'
```

The recipient public file (`operator-recipient.pub`) can stay on the server — it's the public half and is also stored cluster-side as `cm/platform-operator-recipient`.

## Inspecting a bundle

```bash
# decrypt + list contents
age -d -i ~/k8s-staging/operator-private.key ~/k8s-staging/bootstrap-secrets-*.tar.age | tar -tvf -

# extract everything
mkdir extracted && cd extracted
age -d -i ~/k8s-staging/operator-private.key ~/k8s-staging/bootstrap-secrets-*.tar.age | tar -xf -
cat MANIFEST.txt
```

The bundle contains:
- One `<namespace>__<name>.yaml` per Secret (output of `kubectl get secret ... -o yaml`)
- `MANIFEST.txt` — cluster + creation metadata
- `operator-private.key` + `operator-recipient.pub` (only if bootstrap generated them)

## Restore — `make secrets-restore`

Use during DR (a wiped cluster needs its old Secrets back) or after an accidental delete.

```bash
KUBECONFIG=/tmp/k8s-staging/kubeconfig \
  make secrets-restore \
    BUNDLE=~/k8s-staging/bootstrap-secrets-2026-04-26T13Z.tar.age \
    KEY=~/k8s-staging/operator-private.key
```

Decrypts to a tmpdir, applies every `*.yaml` Secret manifest with `kubectl apply`, then shreds the tmpdir. Pods using restored Secrets need a rollout restart to pick up the new values.

## Rotation flow — admin password

The CLI is the canonical path. Two modes:

```bash
# A — interactive (password typed, never in shell history)
sudo /opt/k8s-hosting-platform/scripts/admin-password-reset.sh \
  --email admin@phoenix-host.net

# B — generate a strong random password (printed ONCE)
sudo /opt/k8s-hosting-platform/scripts/admin-password-reset.sh \
  --email admin@phoenix-host.net --random
```

Both modes:
- Hash the password with bcrypt cost 12 INSIDE the platform-api pod (cleartext never hits the worker host)
- Update `users.password_hash` via parameterized SQL
- Insert an `audit_logs` row with `action_type=admin_password_reset_via_cli`, `actorType=system`

After rotation, run `make secrets-fetch` to refresh your offline copy of `Secret/platform-admin-seed`. Or wait — the daily CronJob picks it up by 03:15 UTC the next morning.

### Other rotations

| Rotation | Procedure |
|---|---|
| JWT signing key | `kubectl delete secret -n platform platform-jwt-secret` → bootstrap.sh `generate_platform_secrets` regenerates → all sessions invalidated → users re-login |
| postgres root pwd | Out of scope — see runbook DEPLOYMENT_RUNBOOK.md |
| S3 backup credentials | `kubectl edit secret -n platform backup-credentials` → secrets-backup CronJob picks up next run |
| Operator age key | `bootstrap.sh --force-rotate-operator-key` — invalidates ALL pre-existing backups (no decryption path) — use only after exporting a fresh bundle |

## Daily backup CronJob

`k8s/base/backup/secrets-backup-cronjob.yaml` runs at 03:15 UTC. Backs up:
- All `Secret`s in `platform`, `mail`, every `client-*` namespace
- Tar + age-encrypt to `cm/platform-operator-recipient`
- Upload to whichever target is configured in `Secret/backup-credentials` (S3 or SSH)
- Retention controlled by S3 lifecycle policy (default: 90d; production: 1y)

Retrieve a daily snapshot:
```bash
aws s3 ls s3://$BUCKET/secrets/
aws s3 cp s3://$BUCKET/secrets/secrets-<latest>.tar.age - | age -d -i ~/k8s-staging/operator-private.key | tar -xf -
```

## Threat model + operational rules

- **Operator-private key is the only thing protecting backups.** Treat as the highest-sensitivity artifact. Store offline (password manager + paper backup).
- **The on-server private key file is a compromise window.** It must be scp'd offline + shredded within minutes of bootstrap. The Phase 1 design relies on operator discipline; we do not auto-delete (would risk losing the only copy if the operator hasn't fetched yet).
- **Bundles are encrypted at rest.** Even if `/var/lib/hosting-platform/bundles/*.tar.age` leaks, the attacker still needs the operator key to read.
- **age provides confidentiality, NOT integrity/authenticity.** A bundle file's age encryption proves only that whoever encrypted it had the recipient's PUBLIC key. An attacker with write access to the operator workstation OR the S3 bucket can decrypt with a stolen private key, tamper with Secret YAMLs (e.g. swap a JWT signing key), re-encrypt to the same recipient, and `make secrets-restore` will silently apply the tampered values. Mitigations:
  - Treat the bundle storage path (workstation + S3 bucket) as in-scope for tamper-detection. Use bucket Object Lock or filesystem ACLs.
  - For high-value restores: extract first, diff against `kubectl get secret -o yaml` from a trusted reference, THEN apply.
- **First-connect SSH host key for `make secrets-fetch` uses `accept-new`.** A first connection to a new server IP is trusted on first use (TOFU). Subsequent connections will fail loudly if the host key changes (defense against MITM). For paranoid retrievals, pin the expected fingerprint and pass `-o HostKeyAlias=<known-name>`.
- **`/home/dev/` is the operator's workstation.** It does NOT exist on the cluster servers (this is correct — bundles + keys are NEVER persisted long-term on the cluster). If you SSH to a server and look for `/home/dev/`, you'll find nothing — that's by design.

## Common operations

| Task | Command |
|---|---|
| Show bootstrap-generated bundle paths | `ssh root@<server> 'ls /var/lib/hosting-platform/bundles/ /var/lib/hosting-platform/operator-key/'` |
| Pull all artifacts to workstation | `make secrets-fetch HOST=root@<server>` |
| Decrypt + list a bundle | `age -d -i ~/k8s-staging/operator-private.key <bundle.tar.age> \| tar -tvf -` |
| Extract a single Secret YAML | `age -d -i ~/k8s-staging/operator-private.key <bundle.tar.age> \| tar -xf - platform__platform-admin-seed.yaml` |
| Restore from bundle | `KUBECONFIG=... make secrets-restore BUNDLE=<path> KEY=~/k8s-staging/operator-private.key` |
| Reset admin password | `sudo /opt/k8s-hosting-platform/scripts/admin-password-reset.sh --email <addr> --random` |
| Rotate operator key (rare) | `bootstrap.sh --force-rotate-operator-key` (after exporting current bundle) |
| Force a fresh daily snapshot | `kubectl create job --from=cronjob/platform-secrets-backup -n platform manual-backup-$(date +%s)` |

## Failure modes

| Symptom | Diagnosis | Fix |
|---|---|---|
| `make secrets-fetch` returns no files | bootstrap was run with `--operator-age-recipient` (no key generated) OR bundle was already shredded from server | Generate from current state: `kubectl create job --from=cronjob/platform-secrets-backup -n platform fetch-now-$(date +%s)`, then pull from S3 |
| `age -d` errors "no identity matched" | Bundle was encrypted to a different recipient (e.g. previous bootstrap's key) | Use the matching key file. If lost, the bundle is unrecoverable. |
| `scripts/admin-password-reset.sh` "user not found" | Email doesn't match a row in `users` table | Check email; this script does NOT create users. Use the admin panel "Add user" flow instead. |
| Daily CronJob shows `RECIPIENT empty` in logs | `cm/platform-operator-recipient` was deleted | Re-create from local copy: `kubectl create cm platform-operator-recipient -n platform --from-literal=recipient=$(cat ~/k8s-staging/operator-recipient.pub)` |
