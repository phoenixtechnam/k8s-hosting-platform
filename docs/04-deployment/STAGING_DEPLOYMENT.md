# Staging Deployment — First Real Server

**Status:** 2026-04-21 — first staging bootstrap procedure.

> **Related:**
> - [MULTI_NODE_ROADMAP.md](../05-infrastructure/MULTI_NODE_ROADMAP.md) — Phase 0 baseline
> - [HA_MIGRATION_RUNBOOK.md](../02-operations/HA_MIGRATION_RUNBOOK.md) — how to add workers / go HA later
> - [ADR-022](../07-reference/ARCHITECTURE_DECISION_RECORDS.md) — external services split
> - `scripts/bootstrap.sh` — the actual runner

---

## Goal

Bring up the first real (non-DinD) server as the staging environment. Single-node k3s + Longhorn + platform stack + Flux reconciling from the `staging` branch.

This document is the end-to-end procedure. It assumes no prior deployment — the server is fresh, the DB has no data, and destructive provisioning is acceptable.

---

## Prerequisites

### Server specs (minimum)

| Resource | Minimum | Recommended |
|---|---|---|
| vCPU | 4 | 8 |
| RAM | 8 GB | 16 GB |
| Disk | 80 GB SSD | 200 GB SSD |
| Kernel | Linux 5.10+ with `iscsi_tcp`, `nfs` modules | 6.x |
| Ports | 22/tcp (SSH), 80/tcp, 443/tcp, 6443/tcp (k3s API) | Plus 51820/udp (WireGuard) if mesh |

Longhorn requires iSCSI + NFS kernel support. Most Debian/Ubuntu/Rocky/AlmaLinux cloud images have both. Check with:

```bash
lsmod | grep -E 'iscsi|nfs'
apt-get install -y open-iscsi nfs-common  # Debian/Ubuntu — bootstrap.sh installs this but ensure no SELinux blocks
```

### DNS

Point your apex domain (e.g. `staging.example.com`) and wildcards at the server's public IP:

```
staging.example.com.       A     <server-public-ip>
*.staging.example.com.     A     <server-public-ip>
admin.staging.example.com. A     <server-public-ip>
client.staging.example.com. A    <server-public-ip>
```

The platform uses `admin.<base>`, `client.<base>`, `dex.<base>`, `webmail.<base>`, `mail.<base>`, `mail-admin.<base>` — a wildcard plus explicit A records is the cleanest setup.

### SSH access

- A non-root user with `sudo` (the bootstrap runs most steps as root internally but expects `sudo` to be passwordless for the invoking user if remote)
- SSH key in `~/.ssh/authorized_keys` for the operator

### GitHub / image access

- Images are public on `ghcr.io/phoenixtechnam/hosting-platform/...` — no auth needed for pulls
- Flux needs HTTPS access to GitHub to watch the `staging` branch

---

## Pipeline overview

```
  Developer push to main
    └─> ci-backend / ci-admin-panel / ci-client-panel / ci-infrastructure
    └─> build-deploy.yml — builds + pushes images to GHCR with tags:
          SHA, latest, YYYYMMDDHHmmss-SHA
    └─> Flux on DEV cluster picks up `latest`

  Merge main → staging  (manual or automated QA gate)
    └─> Flux on STAGING cluster picks up YYYYMMDDHHmmss-SHA pattern
    └─> Auto-reconciles new images onto staging

  Tag release (v1.2.3)
    └─> release.yml publishes semver-tagged images
    └─> release.yml opens PR to `stable` branch with pinned versions
    └─> Merge to `stable` → Flux on PRODUCTION reconciles
```

---

## Step-by-step bootstrap

### 1. Pre-flight locally

Run CI checks against the branch you're about to deploy:

```bash
# From your workstation
git fetch origin
git log origin/main..origin/staging --oneline   # what will land?
gh run list --workflow=build-deploy.yml --branch=main --limit=3  # confirm images exist
```

Verify the three kustomize overlays build cleanly (local sanity):

```bash
kubectl kustomize k8s/overlays/staging > /tmp/staging-manifests.yaml
wc -l /tmp/staging-manifests.yaml
grep -c '^kind: ' /tmp/staging-manifests.yaml   # rough resource count
```

If CI is green (all `ci-*` workflows succeeded for the last commit on `main`) and `build-deploy.yml` published images, you're safe to proceed.

### 2. Bootstrap the server

From your workstation:

```bash
# Remote (SSH-driven) bootstrap
./scripts/bootstrap.sh \
  --remote <server-public-ip> \
  --ssh-user <admin-user> \
  --ssh-key ~/.ssh/id_ed25519 \
  --domain staging.example.com \
  --email ops@example.com \
  --env staging
```

What this does:

1. Copies `bootstrap.sh` to `/tmp/` and executes it on the remote
2. **Phase 1** — hardens SSH, installs nftables/fail2ban, sets up WireGuard + NetBird (if mesh required)
3. **Phase 2** — installs k3s `v1.31.4+k3s1` server + Calico CNI
4. **Phase 3** — installs Helm, NGINX Ingress, cert-manager (with Let's Encrypt ClusterIssuer), Sealed Secrets, **Longhorn `v1.11.1` (pinned)**, Flux v2 watching the `staging` branch, and applies the platform Sealed Secrets
5. **Phase 4** — verifies everything is up, applies the staging overlay, prints a summary

Typical runtime: ~10–15 minutes.

### 3. Verify Longhorn

```bash
# On the server (or via kubectl from your laptop with fetched kubeconfig)
kubectl -n longhorn-system get pods
kubectl get storageclass
# Expected: longhorn (default), local-path (non-default fallback)

# Longhorn UI (optional — exposed via ingress only if you opt in)
kubectl -n longhorn-system port-forward svc/longhorn-frontend 8080:80
# Open http://localhost:8080
```

### 4. Verify Flux reconciliation

```bash
flux get kustomizations -A
# platform-staging — status should be Ready=True, last reconciled recently

flux get sources git -A
# flux-system — pulling from https://github.com/phoenixtechnam/k8s-hosting-platform branch=staging

flux get images all -A
# shows image policies + repositories Flux is tracking
```

Force an immediate reconcile if needed:

```bash
flux reconcile source git flux-system
flux reconcile kustomization platform-staging
```

### 5. Smoke test

```bash
# Platform API should respond at its ingress
curl -fsSL https://admin.staging.example.com/api/v1/healthz
# {"status":"ok","version":"..."}

# Login to admin panel in a browser
open https://admin.staging.example.com/
```

First-time login uses the seeded admin credentials printed at the end of `bootstrap.sh` (also written to `/etc/platform/admin-credentials` on the server — chmod 600, remove after setting up a real admin user).

### 6. Take your first client through the lifecycle

Exercise the platform to confirm the full storage path works with Longhorn:

```
Admin Panel → Clients → Add Client
  → provision a test client
  → deploy a small catalog workload (e.g. static-nginx)
  → verify PVC bound (kubectl get pvc -n client-...)
  → verify Longhorn volume has 1 replica (Longhorn UI or `kubectl -n longhorn-system get volumes.longhorn.io`)
  → suspend, resume, snapshot, restore, delete
```

If every state transition works and the snapshot tarball lands at `/var/lib/platform/snapshots/` on the node, staging is fully functional.

---

## CI verification checklist

Before the first deploy, confirm:

- [x] `ci-backend.yml` — lint + typecheck + test with postgres+redis services
- [x] `ci-admin-panel.yml`, `ci-client-panel.yml` — lint + typecheck + test + build
- [x] `ci-api-contracts.yml` — build + typecheck
- [x] `ci-infrastructure.yml` — **now builds all three overlays (base, dev, staging, production)** + shellcheck + catalog image builds
- [x] `build-deploy.yml` — publishes backend, admin-panel, client-panel to GHCR with `<sha>`, `latest`, and `<timestamp>-<sha>` tags on `main`
- [x] `ci-sftp-gateway.yml` + `ci-file-manager-sidecar.yml` — publish their own images with Trivy scans
- [x] `release.yml` — on `v*.*.*` tag: publishes semver-tagged images, creates GitHub Release, opens PR to `stable` branch

Gaps to fix before production rollout (not blocking staging):

- [ ] No image signing (cosign / SLSA provenance) — acceptable for staging, should be added before production
- [ ] No automated security scan on backend/panel images (only sftp-gateway + file-manager have Trivy)
- [ ] No integration test that exercises the Longhorn storage path end-to-end in CI (the platform test suite skips anything requiring a live k3s + Longhorn)

---

## First-staging rollout checklist

- [ ] Server provisioned with specs ≥ minimum
- [ ] DNS A records + wildcard pointing at server IP
- [ ] SSH access verified (`ssh admin@server uptime`)
- [ ] All GitHub Actions green on `main`, images exist in GHCR
- [ ] Local `kubectl kustomize k8s/overlays/staging` succeeds
- [ ] Run `bootstrap.sh --remote <ip> --domain <fqdn> --email <ops-email> --env staging`
- [ ] Longhorn v1.11.1 running (`kubectl -n longhorn-system get pods`)
- [ ] Flux reconciled the staging overlay (`flux get kustomizations`)
- [ ] Platform API responds at `https://admin.<domain>/api/v1/healthz`
- [ ] Admin login works; first seed user created
- [ ] Provision one test client end-to-end
- [ ] Take one snapshot, verify archive lands on disk + DB row `status=ready`
- [ ] Suspend + resume the test client; verify ingress redirect then restore
- [ ] Remove the `/etc/platform/admin-credentials` file after seeding real admins

---

## Known limitations of single-node staging

- Longhorn runs with `replicaCount=1` (HA requires ≥2 nodes)
- Platform services (backend, panels, redis) run with single replicas — no pod-anti-affinity effect until workers join
- A node reboot takes the whole staging env down for ~30 s–2 min
- Backups at this stage are hostpath-local; add an S3/SSH backup target before considering this "production-equivalent"

Adding workers or going HA → see `HA_MIGRATION_RUNBOOK.md`.

---

## Rollback procedure

If the bootstrap misbehaves and you need to reset:

```bash
# On the server, as root
/usr/local/bin/k3s-uninstall.sh 2>/dev/null || true
rm -rf /var/lib/rancher /etc/rancher /var/lib/platform /etc/platform
# Optional: wipe Longhorn state on disk
rm -rf /var/lib/longhorn
# Optional: clean up iptables/nftables
nft flush ruleset 2>/dev/null || true

# Then re-run bootstrap.sh
```

Destructive migration is acceptable on staging (no production data).
