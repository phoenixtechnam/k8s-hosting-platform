# Staging Pre-Flight Checklist

> **Use**: fill this out *before* running `./scripts/bootstrap.sh --remote`. Every unchecked box is a reason the deploy could fail at 3am.
>
> **Companion docs**: [`STAGING_DEPLOYMENT.md`](./STAGING_DEPLOYMENT.md) — full procedure. This doc is the distilled go/no-go.

---

## Server

- [ ] Server provisioned, public IP: `_______._______._______._______`
- [ ] Apex domain: `staging._____________`
- [ ] Operator email (ACME registration): `____________@____________`
- [ ] Minimum specs met: ≥ 4 vCPU / 8 GB RAM / 80 GB SSD
- [ ] OS is a supported distro: Ubuntu 22.04+/24.04, Debian 12, Rocky/AlmaLinux 9
- [ ] Kernel ≥ 5.10 with iSCSI + NFS modules (`lsmod | grep -E 'iscsi|nfs'`)
- [ ] SSH access verified: `ssh <user>@<ip> uptime` returns cleanly
- [ ] SSH user has passwordless sudo OR root login is enabled for bootstrap
- [ ] Firewall allows: `22/tcp`, `80/tcp`, `443/tcp`, `6443/tcp` inbound

## DNS (propagated, verified from public resolver)

Run from your workstation — **every line must return the server IP**:

```bash
for host in staging.example.com \
            admin.staging.example.com \
            client.staging.example.com \
            dex.staging.example.com \
            mail.staging.example.com \
            webmail.staging.example.com \
            mail-admin.staging.example.com \
            some-wildcard-test.staging.example.com; do
  printf "%-45s → " "$host"
  dig +short "$host" @1.1.1.1 | head -1
done
```

- [ ] Apex `staging.<domain>` → server IP
- [ ] Wildcard `*.staging.<domain>` → server IP (tested with random subdomain)
- [ ] `admin.`, `client.`, `dex.`, `mail.`, `webmail.`, `mail-admin.` all resolve
- [ ] TTL is short enough to fix mistakes fast (≤ 5 min recommended during bootstrap)

## Code / CI

- [ ] `main` branch commit: `_______________` (git sha, 7 chars)
- [ ] All CI workflows green on that commit (`gh run list --branch=main --limit=5`)
- [ ] Images published to GHCR with that sha tag (`gh api /users/phoenixtechnam/packages?package_type=container | jq ...`)
- [ ] `staging` branch is either pointing at same sha OR will be fast-forwarded as part of bootstrap
- [ ] `kubectl kustomize k8s/overlays/staging` builds cleanly locally (no unresolved refs)

## Operator readiness

- [ ] [`STAGING_DEPLOYMENT.md`](./STAGING_DEPLOYMENT.md) read end-to-end in the last 7 days
- [ ] [Rollback procedure](./STAGING_DEPLOYMENT.md#rollback-procedure) understood
- [ ] Estimated window: ___ hours blocked out (typical cold bootstrap: 15-30 min + verification)
- [ ] Out-of-band channel ready (phone, Signal, etc.) in case the deploy breaks the SSH session itself

## Secrets & config

Bootstrap auto-generates all platform secrets — see [STAGING_DEPLOYMENT.md § Secrets](./STAGING_DEPLOYMENT.md#secrets-all-auto-generated-by-bootstrapsh). No pre-work required, but confirm:

- [ ] No existing `/etc/platform/` or `/var/lib/rancher/k3s/` state on the server (fresh OS install or prior rollback completed)
- [ ] You have a plan for the seeded admin credentials — capture them the moment `bootstrap.sh` prints them, then remove `/etc/platform/admin-credentials` after creating real admins
- [ ] You know which backup backend staging will use eventually (hostpath initial → S3/SSH later)

## Post-bootstrap readiness

Have these commands/URLs ready to run the second bootstrap finishes:

- [ ] `kubectl get nodes` — expect 1 node `Ready`
- [ ] `kubectl get pods -A | grep -v Running` — expect empty (or only Completed)
- [ ] `flux get kustomizations -A` — expect `platform-staging` `Ready=True`
- [ ] `curl -fsSLk https://admin.<apex>/api/v1/healthz` — expect `{"status":"ok"}`
- [ ] Open `https://admin.<apex>/` and log in with seeded credentials
- [ ] Provision one throwaway test client end-to-end (create → deploy → snapshot → suspend → resume → delete)

---

## Go / No-Go

**All boxes checked AND no unresolved concerns?** → run:

```bash
./scripts/bootstrap.sh \
  --remote <server-ip> \
  --ssh-user <admin-user> \
  --ssh-key ~/.ssh/id_ed25519 \
  --domain staging.<apex> \
  --acme-email <operator-email> \
  --env staging
```

**Anything unchecked or uncertain?** → stop. Cost of waiting is minutes. Cost of a broken staging at the wrong time is hours of rollback + re-bootstrap.

---

## After the fact

- [ ] Record bootstrap runtime in `docs/05-infrastructure/MULTI_NODE_ROADMAP.md` benchmarks section
- [ ] Note any deviations from this checklist in the runbook/session-summary
- [ ] Flip TLS to LE-prod in `k8s/overlays/staging/ingress-patch.yaml` once the setup is proven stable
- [ ] Delete `/etc/platform/admin-credentials` after creating real admin users
- [ ] Configure a proper backup target (S3/SSH) via Admin Panel → Settings → Backup
