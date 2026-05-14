# Traefik migration — throwaway-VPS staging test runbook

**Purpose**: validate the `feat/traefik-migration` branch against a real-
world single-node cluster BEFORE merging to `main` (which auto-syncs to
the actual staging cluster via `.github/workflows/sync-staging.yml`).

**Why a throwaway VPS and not the real staging cluster**: merging to
`main` triggers the production staging deploy. We want to exercise the
LE cert-manager path (which DinD can't with self-signed CAs), the
real-DNS A-record flow, and the bootstrap.sh full installer — all
without contaminating the actual staging cluster.

**Cost**: ~€4 for a week on a Hetzner CX22 (2 vCPU / 4 GB RAM / 40 GB
disk, Debian 13). Single-server install. Can be torn down the moment
the test finishes.

**Acceptance criteria** (Migration is ready to merge when):

- [ ] `scripts/bootstrap.sh --env staging` completes cleanly (exit 0)
      against a fresh Debian 13 node.
- [ ] `kubectl get pods -A` shows: Traefik DaemonSet 1/1 Ready,
      CrowdSec LAPI 1/1 Ready, ModSec-CRS Deployment 2/2 Ready,
      tenant-errors 2/2 Ready, no nginx-ingress namespace.
- [ ] `kubectl logs -n traefik daemonset/traefik | grep 'Plugins
      loaded'` shows `["crowdsec","modsecurity"]`.
- [ ] Browser-open `https://admin.<test-domain>` resolves to the
      admin panel with a valid Let's Encrypt certificate (NOT
      Traefik's snake-oil fallback).
- [ ] Admin login works (cookie session via platform_session).
- [ ] Create a test tenant, deploy a catalog entry (e.g. vaultwarden),
      get a working route at `https://app.<tenant-domain>`. Confirm
      cert provisioning via cert-manager + LE HTTP-01.
- [ ] curl with an SQLi payload (`?q=1' OR '1'='1`) on a route with
      `wafEnabled=1` returns 403. Same payload on a `wafEnabled=0`
      route returns 200.
- [ ] curl from a CrowdSec-known-bad source IP gets rejected at the
      Traefik perimeter. (Hard to reproduce without spoofing; check
      via `kubectl logs -n crowdsec deploy/crowdsec` for community
      blocklist refresh + at least 1 cached decision.)
- [ ] Tear down the test cluster with `hcloud server delete` or
      equivalent.

## Step 0 — Provision the node

Pick any provider. Hetzner is cheap + Debian 13 has a current image:

```bash
hcloud server create \
  --type cx22 \
  --image debian-13 \
  --location nbg1 \
  --name traefik-migration-test \
  --ssh-key <your-ssh-key>
```

Note the public IPv4. Set an A record in DNS:

```
test-traefik.<your-domain>. A <public-ipv4>
*.test-traefik.<your-domain>. A <public-ipv4>
```

Wait for DNS propagation (1–5 min depending on TTL).

## Step 1 — Clone + bootstrap

SSH in, install git, clone the branch, run bootstrap:

```bash
ssh root@test-traefik.<your-domain>

apt-get update && apt-get install -y git curl

git clone https://github.com/phoenixtechnam/hosting-platform.git /opt/platform
cd /opt/platform
git checkout feat/traefik-migration

# Inspect what's about to run.
less scripts/bootstrap.sh

# Single command — bootstrap.sh handles everything: nft, k3s, Calico,
# helm install Traefik (with both WAF plugins), cert-manager,
# CNPG, SealedSecrets, Longhorn, monitoring, Flux. Run with --remote
# in nohup so an SSH drop doesn't kill it (a known issue caught in
# the 2026-05-14 testing bootstrap — bug #1 in
# project_testing_bootstrap_2026_05_14.md memory).
nohup ./scripts/bootstrap.sh \
  --env staging \
  --domain test-traefik.<your-domain> \
  --acme-email you@example.com \
  > /var/log/bootstrap.log 2>&1 &

# Tail the log; the process keeps running if you drop SSH.
tail -f /var/log/bootstrap.log
```

Expected duration: 8–15 minutes depending on network speed.

## Step 2 — Smoke-validate Traefik + WAF

After bootstrap exits 0:

```bash
# All system pods Ready (or Completed for one-shot Jobs).
kubectl get pods -A | grep -vE "Running|Completed"
# Should be empty (all healthy).

# Traefik DaemonSet ready, both plugins loaded.
kubectl get daemonset -n traefik traefik
kubectl logs -n traefik daemonset/traefik | grep -E "Loading plugins|Plugins loaded"
# Expected: ["crowdsec","modsecurity"]

# CrowdSec LAPI healthy.
kubectl get pods -n crowdsec
kubectl logs -n crowdsec deploy/crowdsec | tail -20

# ModSec-CRS Deployment ready.
kubectl get pods -n traefik -l app.kubernetes.io/name=modsec-crs
kubectl logs -n traefik deploy/modsec-crs | grep -E "rules loaded|nginx"
# Expected: "ModSecurity-nginx v1.0.4 (rules loaded inline/local/remote: 0/847/0)"

# tenant-errors Deployment ready.
kubectl get pods -n platform-system -l app.kubernetes.io/name=tenant-errors
```

## Step 3 — Functional verification

### Admin panel login

Browser-open `https://admin.test-traefik.<your-domain>`. Confirm:

- Valid Let's Encrypt certificate in the address bar (NOT Traefik's
  internal "TRAEFIK DEFAULT CERT" fallback).
- Login form renders. Use the seeded admin credentials (printed at
  the end of bootstrap.sh, or in `/etc/k8s-platform/seed-credentials`).
- After login the admin panel loads.

### Tenant deploy + WAF block test

In the admin panel:

1. Create a test client (any name).
2. Add a domain like `app.test-traefik.<your-domain>` (DNS must point
   at the cluster IP — same A record works if you used wildcard above).
3. Deploy a catalog entry (vaultwarden is simple + has a clear web UI).
4. Wait for cert-manager to issue the LE cert (1–5 min). Browser-open
   the URL; confirm vaultwarden loads via HTTPS.
5. Edit the route in the admin panel: toggle WAF on. Save.
6. From your laptop:
   ```bash
   curl -i 'https://app.test-traefik.<your-domain>/?q=1%27%20OR%20%271%27=%271'
   # Expect: HTTP/2 403
   curl -i 'https://app.test-traefik.<your-domain>/'
   # Expect: HTTP/2 200 (vaultwarden UI)
   ```
7. Toggle WAF off. Save. Re-run the SQLi curl — should now return 200.

### CrowdSec community-blocklist

```bash
kubectl exec -n crowdsec deploy/crowdsec -- cscli decisions list
# Expect: hundreds-to-thousands of community-blocklist IPs cached.
```

If empty, CrowdSec hasn't refreshed yet (1-hour interval on first
boot). Check `kubectl logs -n crowdsec deploy/crowdsec` for the
"Online API" sync line.

## Step 4 — Tear down

```bash
hcloud server delete traefik-migration-test
# Remove the DNS records.
```

## What to log

Capture for the merge PR:

- bootstrap.sh log (`/var/log/bootstrap.log`)
- `kubectl get events -A` output during the test
- Screenshot of admin login showing valid LE cert
- curl output showing 403 on SQLi, 200 on clean request, with WAF
  toggled on then off
- `kubectl logs -n traefik deploy/modsec-crs` showing the CRS rule
  match for the SQLi block

## Known gotchas (caught in prior bootstraps — fixed but worth checking)

These were caught in the 2026-05-14 `testing.phoenix-host.net` fresh
bootstrap (see `project_testing_bootstrap_2026_05_14.md` memory entry):

1. **SSH-drop kills `bootstrap.sh --remote`** — use `nohup` as shown
   above. The Stalwart configure step (~3 min silent wait) gives the
   SSH session time to time out.
2. **`create_roundcube_db()` references stale `cluster/postgres`** —
   the CNPG cluster is now `system-db`. If bootstrap fails here, the
   bug is fixed in `feat/traefik-migration` (or merge upstream main
   into the branch first).
3. **Stalwart 200-skip bypass** — if the bootstrap detects an existing
   Stalwart admin password it skips `configure_stalwart_full()`,
   leaving the SMTP/IMAP listeners unconfigured. Workaround: delete
   the `stalwart-admin-creds` Secret before re-running bootstrap, or
   manually call `configure_stalwart_full` after.
4. **Smoke harness false fails on single-node** —
   `scripts/integration-stalwart-mail-ha.sh` and similar hardcode
   `*.staging.phoenix-host.net` + multi-node expectations. Skip these
   for the single-node throwaway test.

## After successful test

- [ ] Note the bootstrap.log uplink time + total duration in the PR
      description.
- [ ] Capture the `kubectl get events -A` output for the PR.
- [ ] Tear down the VPS.
- [ ] Merge `feat/traefik-migration` → `main`. The sync-staging
      workflow handles the actual staging deploy.
