# Stalwart Deployment Runbook

> Applies to the dedicated Stalwart overlays under `k8s/overlays/{dev,staging,production}/stalwart/`.
> First-deploy friction is real — miss the secret-generation step and the pod
> enters CrashLoopBackOff. The Kustomize manifests cannot declaratively
> bootstrap the Secret (random passwords + bcrypt hashes) so an operator
> must run the helper script once per environment.

## First-deploy checklist (per environment)

Run these **before** Flux reconciles the Stalwart overlay, or alongside the
first reconcile. The Secret must exist before `stalwart-mail-0` starts,
otherwise the StatefulSet will CrashLoopBackOff on missing env vars.

### 1 — Verify prerequisites

```bash
# cert-manager ClusterIssuer you plan to use (staging: letsencrypt-staging-http01)
kubectl get clusterissuers

# Postgres reachable + stalwart schema + stalwart_reader role exist
kubectl -n platform exec postgres-0 -- \
  psql -U platform -d hosting_platform -c "\dt stalwart.*"

# Platform DB password (needed for --db-password below)
kubectl -n platform get secret platform-db-credentials \
  -o jsonpath='{.data.password}' | base64 -d
```

### 2 — Generate stalwart-secrets

From a workstation that can `kubectl` against the target cluster:

```bash
./scripts/generate-stalwart-secret.sh \
  --hostname=mail.staging.phoenix-host.net \
  --db-password="$(kubectl -n platform get secret platform-db-credentials \
     -o jsonpath='{.data.password}' | base64 -d)"
```

The script:
- Generates random admin + master passwords (32-char URL-safe).
- Bcrypts them (cost=12) via `htpasswd` or Docker fallback.
- Writes `mail/stalwart-secrets` (hashes + cleartext admin pass for the
  backup CronJob) and a platform-ns mirror `platform/platform-stalwart-creds`.
- Prints the cleartext passwords to stderr **once**. Save them — they
  are also retrievable from the admin panel's "Show Stalwart Credentials"
  button.

Idempotent: re-runs are no-ops unless `--force` is set.

### 3 — Reconcile (Flux) or apply (manual)

- **Flux**: commit + push the overlay. Flux reconciles on the next poll
  (~1 min default interval).
- **Manual**: `kubectl apply -k k8s/overlays/staging/stalwart/`

### 4 — Wait for pod Ready

```bash
kubectl -n mail rollout status statefulset/stalwart-mail --timeout=5m
kubectl -n mail logs stalwart-mail-0 --tail=30
```

Expected first-boot log:
```
Stalwart starting with config:
[server]
hostname = "mail.staging.phoenix-host.net"
...
Stalwart Mail Server v0.16.0 started
```

### 5 — Smoke-test the WebAdmin

```bash
# The webadmin is gated by platform_session cookie — you'll be 302'd
# to admin.<env>.phoenix-host.net/login unless you have that cookie.
curl -ILks https://mail-admin.staging.phoenix-host.net/ | head -5

# Expected: HTTP/2 302 ; location: https://admin.staging.phoenix-host.net/login?...
```

## What goes wrong if you skip step 2

Stalwart's StatefulSet `envFrom` references `stalwart-secrets`. Without
it, kubelet keeps the pod in `CreateContainerConfigError`. Symptoms:

```bash
kubectl -n mail get pod stalwart-mail-0
# STATUS: CreateContainerConfigError

kubectl -n mail describe pod stalwart-mail-0 | grep -i 'secret'
# Warning: couldn't find key ADMIN_SECRET in Secret mail/stalwart-secrets
```

Fix: run step 2. Pod will auto-heal within 30 seconds.

## Post-deploy operational tasks

- **Cert reload after cert-manager rotation**: the `stalwart-cert-reload`
  CronJob runs daily at 04:20 UTC and invokes `stalwart-cli server
  reload-certificates`. Nothing to do manually.
- **Backup verification**: `stalwart-backup` CronJob fires at 01:45 UTC,
  writes `/opt/stalwart/backups/<ts>.tar` + `BACKUP_OK_<ts>` freshness
  marker. Longhorn's daily-backup at 02:00 UTC captures both in the
  S3 snapshot. Verify on the first day:
  ```bash
  kubectl -n mail exec stalwart-mail-0 -- ls -lt /opt/stalwart/backups/
  ```
- **DB role rotation**: when rotating the `stalwart_reader` password in
  Postgres, also re-run `./scripts/generate-stalwart-secret.sh --force
  --db-password=<new>` and `kubectl rollout restart statefulset/
  stalwart-mail -n mail`.

## Stalwart version pin: why v0.15.5?

We pin `stalwartlabs/stalwart:v0.15.5` in `k8s/base/stalwart/statefulset.yaml` — NOT `latest` or `v0.16`. Upstream v0.16.0 (Apr 2026) replaced the monolithic TOML config with a "declarative deployments" model:

- `config.json` on disk contains **only** a DataStore object (e.g. `{"@type":"RocksDb","path":"/opt/stalwart/data"}`).
- Everything else (listeners, auth, directory SQL queries, spam filter rules) lives in a DB-backed config store populated via `stalwart apply <plan.json>` or the JMAP API / WebAdmin UI.

Our current `k8s/base/stalwart/configmap.yaml` is written for the v0.13–v0.15 monolithic-TOML style. Booting v0.16.0 with it fails within 2s of startup with:

```
⚠️ Startup failed: Failed to parse data store settings at
/opt/stalwart/etc/config.toml: expected value at line 1 column 1
```

Reproduced on 2026-04-23 staging rebootstrap. v0.15.5 accepts the exact same config and boots cleanly (verified on the drill VM at 46.224.122.58).

**To migrate to v0.16 later:**
1. Shrink `configmap.yaml` to just a tiny `config.json` with the DataStore pointer.
2. Author a `plan.json` declarative deployment covering listeners, PostgreSQL directory, auth, etc.
3. Add a post-start Job (or init container) that runs `stalwart apply /plans/plan.json` on first boot, keyed on a marker file so it's idempotent.
4. Strip the TOML-specific env-var substitution (`%{env:VAR}%`) in favour of whatever v0.16 uses for templating its declarative plans.
5. Bump the image pin.

Tracked as task #183 (kept open until the rewrite lands).

## Staging-specific gaps vs production

- **Postgres TLS**: staging ships with `[store.pg.tls].enable = false` (per
  base config). Production's `stalwart-config-cert.toml` overlay flips
  it on and mounts a CA bundle. Staging does not install a
  `platform-internal-ca` ClusterIssuer; adding one is a prerequisite for
  Stalwart↔Postgres TLS parity.
- **Stalwart TLS**: Let's Encrypt **staging** issuer used — browsers will
  show a warning. Swap to `letsencrypt-prod-http01` in
  `webadmin-ingress.yaml` when staging moves to real-client testing.
- **MX records**: DNS (PowerDNS — separate project per ADR-022) must
  have `mail.staging.phoenix-host.net` pointing at the staging IP and
  an MX record if external mail delivery is desired. Internal testing
  (pod → SMTP service) works without external DNS.
