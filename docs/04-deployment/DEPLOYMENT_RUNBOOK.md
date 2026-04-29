# Deployment Runbook

**Status:** Phase 1
**Last Updated:** April 11, 2026
**Owner:** Platform Team

This document provides step-by-step instructions for first-time deployment of the K8s hosting platform on a Hetzner VPS running k3s. All provisioning and installation is handled by a single script: `scripts/bootstrap.sh`.

---

## 1. Prerequisites

Before starting, ensure the following are in place:

### Infrastructure Requirements

| Requirement | Specification |
|-------------|---------------|
| **VPS Provider** | Hetzner Cloud |
| **Server Type** | CPX31 or higher (4 vCPU, 8 GB RAM, 160 GB NVMe) |
| **OS** | Debian 13 (Trixie) or Ubuntu 24.04 LTS |
| **Domain** | A registered domain with DNS management access |
| **SSH Access** | Root or sudo-capable user with SSH key authentication |
| **Budget** | ~EUR 50/month (single-node Phase 1) |

### External Services (per ADR-022)

These services must be running before deployment. They are managed by the separate infrastructure project:

- **PowerDNS** -- authoritative DNS (ns1 primary + ns2 secondary)
- **NetBird** -- WireGuard VPN mesh for admin access
- **Dex** -- OIDC identity provider for authentication

### DNS Records to Create

Before proceeding, create these DNS records pointing to your VPS IP:

```
A    api.your-domain.com        -> <VPS_IP>
A    admin.your-domain.com      -> <VPS_IP>
A    client.your-domain.com     -> <VPS_IP>
A    webmail.your-domain.com    -> <VPS_IP>
MX   your-domain.com            -> mail.your-domain.com (priority 10)
A    mail.your-domain.com       -> <VPS_IP>
```

### Required Tools (Local Machine)

For **remote mode** (Option B below), you only need SSH access. For post-deployment management:

```bash
# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && sudo mv kubectl /usr/local/bin/

# Install kubeseal (Sealed Secrets CLI)
KUBESEAL_VERSION=0.27.0
curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
tar -xvzf kubeseal-*.tar.gz kubeseal && sudo mv kubeseal /usr/local/bin/
```

---

## 2. Deployment

`scripts/bootstrap.sh` is the single entry point for all deployment tasks. It handles server hardening (SSH, firewall, fail2ban), k3s + Calico CNI installation, Helm charts (NGINX Ingress, cert-manager, Sealed Secrets), Flux v2 GitOps, platform secrets, and Kustomize manifest application.

Run `./scripts/bootstrap.sh --help` for the full list of options.

### Option A: Run directly on the server

```bash
ssh root@<VPS_IP>

# Either clone and run:
git clone https://github.com/phoenixtechnam/k8s-hosting-platform.git
cd k8s-hosting-platform
./scripts/bootstrap.sh --domain phoenix-host.net --env production

# Or one-liner:
curl -fsSL https://raw.githubusercontent.com/phoenixtechnam/k8s-hosting-platform/main/scripts/bootstrap.sh \
  | bash -s -- --domain phoenix-host.net --env production
```

### Option B: Run from your workstation (remote mode)

```bash
./scripts/bootstrap.sh \
  --remote <VPS_IP> \
  --ssh-key ~/.ssh/id_rsa \
  --domain phoenix-host.net \
  --env production
```

This copies the script to the server via SCP and executes it over SSH.

### Adding a worker node

```bash
./scripts/bootstrap.sh \
  --remote <worker-ip> \
  --ssh-key ~/.ssh/id_rsa \
  --role worker \
  --server <control-plane-ip> \
  --token <k3s-token>
```

Retrieve the join token from the control plane: `cat /var/lib/rancher/k3s/server/node-token`

### Copy kubeconfig to your local machine

After bootstrap completes, copy the kubeconfig for remote `kubectl` access. **Important:** `:6443` is firewalled to the cluster's private/mesh CIDR — see [CLUSTER_NETWORK.md](./CLUSTER_NETWORK.md). Substitute the **mesh / private** IP (NetBird `wt0`, Tailscale, VLAN), not the public IP:

```bash
scp root@<VPS_IP>:/etc/rancher/k3s/k3s.yaml ./kubeconfig.yaml
sed -i "s/127.0.0.1/<MESH_OR_PRIVATE_IP>/g" kubeconfig.yaml
export KUBECONFIG=./kubeconfig.yaml
kubectl get nodes
```

If your workstation isn't on the cluster's network, SSH-tunnel instead:
```bash
ssh -L 6443:127.0.0.1:6443 root@<VPS_IP>   # in one shell
KUBECONFIG=./kubeconfig.yaml kubectl get nodes
```

---

## 3. Configure DNS

### Option A: PowerDNS via API (Recommended)

If PowerDNS is already running (provided by the infrastructure project):

```bash
# Verify PowerDNS API is reachable
curl -s -H "X-API-Key: $PDNS_API_KEY" http://<powerdns-host>:8081/api/v1/servers/localhost/zones

# The platform backend will manage DNS records via the PowerDNS API.
# Configure the DNS server connection in the admin panel after deployment.
```

### Option B: External DNS Provider

If using an external DNS provider (Cloudflare, Route53, Hetzner DNS):

1. Create the required A/CNAME records manually (see Prerequisites section above)
2. After deployment, configure the DNS server in the admin panel under Settings > DNS Servers

---

## 4. Run Database Migrations

```bash
kubectl -n platform exec deployment/platform-api -- npm run db:migrate

# Verify migration status
kubectl -n platform exec deployment/platform-api -- npm run db:migrate -- --status
```

---

## 5. Verify Deployment

### 5.1 Run Smoke Tests

```bash
./scripts/smoke-test.sh
```

The smoke test script validates:
- API health endpoint responds with 200
- Admin panel is accessible
- Client panel is accessible
- Database connectivity
- Redis connectivity

### 5.2 Manual Verification

```bash
# Check all pods are running
kubectl -n platform get pods

# Check ingress is configured
kubectl -n platform get ingress

# Check TLS certificates
kubectl -n platform get certificates

# Test API health
curl -s https://api.your-domain.com/api/v1/health | jq .

# Test admin panel
curl -s -o /dev/null -w "%{http_code}" https://admin.your-domain.com/

# Test client panel
curl -s -o /dev/null -w "%{http_code}" https://client.your-domain.com/
```

---

## 6. Create First Admin User

### Option A: Via CLI (Recommended for First Setup)

```bash
# Exec into the API pod and create an admin user
kubectl -n platform exec -it deployment/platform-api -- node -e "
const { createAdminUser } = require('./dist/modules/users/service');
createAdminUser({
  email: 'admin@your-domain.com',
  fullName: 'Platform Admin',
  password: 'CHANGE_ME_IMMEDIATELY',
  roleName: 'admin'
}).then(u => console.log('Admin created:', u.id));
"
```

### Option B: Via Database Seed

```bash
kubectl -n platform exec deployment/platform-api -- npm run db:seed
```

After creating the admin user, log in at `https://admin.your-domain.com` and change the password immediately.

---

## 7. Configure OIDC (Optional)

If Dex OIDC is running (provided by the infrastructure project), configure it in the admin panel:

1. Navigate to **Settings > Authentication > OIDC Providers**
2. Click **Add Provider**
3. Fill in:
   - **Display Name:** Company SSO
   - **Issuer URL:** `https://dex.your-domain.com`
   - **Client ID:** `platform-admin` (from Dex static client config)
   - **Client Secret:** (from Dex config)
   - **Panel Scope:** Admin
4. Click **Save** and **Test Connection**

Repeat for the client panel if needed with a separate Dex client ID.

---

## 8. Deploy Email Stack (Stalwart + Roundcube)

### 8.1 Deploy Stalwart Mail Server

```bash
# Apply the Stalwart StatefulSet, Service, and ConfigMap
kubectl apply -f k8s/base/stalwart-deployment.yaml

# Wait for Stalwart to be ready
kubectl -n platform-system wait --for=condition=ready pod -l app=stalwart-mail --timeout=180s

# Verify mail ports are accessible
kubectl -n platform-system get svc stalwart-mail
```

### 8.2 Configure DNS for Email

Add the following DNS records for each email domain:

```
MX    example.com           -> mail.your-domain.com (priority 10)
TXT   example.com           -> "v=spf1 mx a:mail.your-domain.com ~all"
TXT   default._domainkey    -> (DKIM public key from admin panel)
TXT   _dmarc.example.com   -> "v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain.com"
```

### 8.3 Deploy Roundcube Webmail

```bash
# Apply the Roundcube Deployment, Service, and Ingress
kubectl apply -f k8s/base/roundcube-deployment.yaml

# Wait for Roundcube to be ready
kubectl -n platform-system wait --for=condition=ready pod -l app=roundcube --timeout=120s

# Verify webmail is accessible
curl -s -o /dev/null -w "%{http_code}" https://webmail.your-domain.com/
```

### 8.4 Test Email Flow

```bash
# Send a test email (from the VPS or a machine with SMTP access)
swaks --to test@example.com \
  --from admin@your-domain.com \
  --server mail.your-domain.com \
  --port 587 \
  --tls \
  --auth-user admin@your-domain.com \
  --auth-password "PASSWORD"
```

---

## 9. Configure SMTP Relay (Optional)

For improved email deliverability, configure an SMTP relay service:

### Option A: Via Admin Panel

1. Navigate to **Settings > Email > SMTP Relay**
2. Click **Add Relay**
3. Choose provider (Mailgun, Postmark, or custom SMTP)
4. Fill in credentials
5. Click **Test Connection**
6. Set as default relay

### Option B: Direct Stalwart Configuration

Edit the Stalwart ConfigMap to add relay settings:

```bash
kubectl -n platform-system edit configmap stalwart-config
```

Add to `config.toml`:

```toml
[remote."relay"]
address = "smtp.mailgun.org"
port = 587
protocol = "tls"

[remote."relay".auth]
username = "postmaster@mg.your-domain.com"
secret = "${SMTP_RELAY_PASSWORD}"

[queue.outbound]
next-hop = ["relay"]
```

Apply the change:

```bash
kubectl -n platform-system rollout restart statefulset/stalwart-mail
```

---

## 10. Post-Deployment Checklist

### Security

- [ ] Admin user password changed from default
- [ ] All secrets stored via Sealed Secrets (no plaintext in manifests)
- [ ] HTTPS enforced on all ingress routes (TLS certificates issued)
- [ ] NetworkPolicies applied (`k8s/base/network-policies.yaml`)
- [ ] RBAC roles configured (`k8s/base/rbac.yaml`)
- [ ] WAF (ModSecurity) enabled on NGINX Ingress
- [ ] SSH root login disabled on VPS (key-only access)
- [ ] Firewall rules configured (only ports 80, 443, 2222, 25, 465, 587, 993 open)

### Monitoring

- [ ] Prometheus scraping all platform pods
- [ ] Alertmanager configured with notification channels (Slack/email)
- [ ] Loki collecting container logs
- [ ] Grafana dashboards imported (optional -- access via port-forward)

### Backups

- [ ] Backup configuration created in admin panel
- [ ] MariaDB automated backups running (daily)
- [ ] Mail data backup scheduled
- [ ] Offsite backup target tested (Hetzner StorageBox via Restic)
- [ ] Backup restore tested at least once

### DNS & Email

- [ ] All platform DNS records resolving correctly
- [ ] TLS certificates issued and auto-renewing
- [ ] SPF, DKIM, and DMARC records configured for email domains
- [ ] Email delivery tested (send and receive)
- [ ] SMTP relay configured (if using external relay)

### Application

- [ ] Admin panel accessible and functional
- [ ] Client panel accessible and functional
- [ ] API responding to health checks
- [ ] SFTP gateway accessible on port 2222
- [ ] Webmail accessible
- [ ] First test client created successfully
- [ ] First test domain added and verified

### Operational

- [ ] Runbook shared with all team members
- [ ] On-call rotation established
- [ ] Incident response plan reviewed (see `INCIDENT_RESPONSE_RUNBOOK.md`)
- [ ] VPS snapshot taken (post-deployment baseline)
- [ ] Smoke test passes: `./scripts/smoke-test.sh`

---

## Troubleshooting

### Common Issues

**Pods stuck in Pending:**
```bash
kubectl -n platform describe pod <pod-name>
# Check for resource constraints or PVC binding issues
kubectl get pv,pvc -A
```

**TLS certificate not issuing:**
```bash
kubectl -n platform describe certificate <cert-name>
kubectl -n cert-manager logs -l app.kubernetes.io/name=cert-manager
# Ensure DNS records are correct and HTTP-01 challenge can reach port 80
```

**Database connection refused:**
```bash
kubectl -n platform exec deployment/platform-api -- nc -zv mariadb.platform.svc.cluster.local 3306
# Check MariaDB pod status
kubectl -n platform get pods -l app=mariadb
kubectl -n platform logs statefulset/mariadb
```

**Email not sending/receiving:**
```bash
# Check Stalwart logs
kubectl -n platform-system logs statefulset/stalwart-mail
# Verify ports are open
kubectl -n platform-system get svc stalwart-mail
# Test SMTP connectivity
kubectl -n platform-system exec -it statefulset/stalwart-mail -- nc -zv localhost 25
```

**SFTP connection refused:**
```bash
kubectl -n platform-system get svc sftp-gateway
kubectl -n platform-system logs deployment/sftp-gateway
# Test from local machine
sftp -P 2222 user@<VPS_IP>
```

### Getting Help

- Check existing docs in `docs/` directory
- Review incident response procedures in `INCIDENT_RESPONSE_RUNBOOK.md`
- Check k3s logs: `journalctl -u k3s -f`
- Check node resources: `kubectl top nodes && kubectl top pods -A`
