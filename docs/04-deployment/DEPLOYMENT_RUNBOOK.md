# Deployment Runbook

**Status:** Phase 1
**Last Updated:** March 29, 2026
**Owner:** Platform Team

This document provides step-by-step instructions for first-time deployment of the K8s hosting platform on a Hetzner VPS running k3s.

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

```bash
# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && sudo mv kubectl /usr/local/bin/

# Install kustomize
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
sudo mv kustomize /usr/local/bin/

# Install kubeseal (Sealed Secrets CLI)
KUBESEAL_VERSION=0.27.0
curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
tar -xvzf kubeseal-*.tar.gz kubeseal && sudo mv kubeseal /usr/local/bin/

# Install Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

---

## 2. Bootstrap k3s Cluster

SSH into the Hetzner VPS and run the bootstrap script:

```bash
ssh root@<VPS_IP>

# Clone the platform repository
git clone https://github.com/your-org/k8s-hosting-platform.git
cd k8s-hosting-platform

# Run bootstrap (installs k3s without default flannel, uses Calico CNI)
./scripts/bootstrap.sh
```

If the bootstrap script is not yet available, install k3s manually:

```bash
# Install k3s without default CNI (we use Calico)
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
  --disable=traefik \
  --flannel-backend=none \
  --disable-network-policy \
  --write-kubeconfig-mode=644 \
  --tls-san=<VPS_IP> \
  --tls-san=api.your-domain.com" sh -

# Verify k3s is running
systemctl status k3s
kubectl get nodes
```

Copy the kubeconfig to your local machine:

```bash
# On the VPS
cat /etc/rancher/k3s/k3s.yaml

# On your local machine, save the output and update the server address
mkdir -p ~/.kube
# Paste kubeconfig and replace 127.0.0.1 with <VPS_IP> or NetBird mesh IP
```

---

## 3. Install Platform Dependencies

### 3.1 Calico CNI

```bash
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/calico.yaml

# Wait for Calico pods
kubectl -n kube-system wait --for=condition=ready pod -l k8s-app=calico-node --timeout=120s
```

### 3.2 NGINX Ingress Controller

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.kind=DaemonSet \
  --set controller.hostPort.enabled=true \
  --set controller.service.type=ClusterIP \
  --set controller.config.enable-modsecurity=true \
  --set controller.config.enable-owasp-modsecurity-crs=true

# Verify
kubectl -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=120s
```

### 3.3 cert-manager

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true

# Wait for cert-manager
kubectl -n cert-manager wait --for=condition=ready pod -l app.kubernetes.io/instance=cert-manager --timeout=120s

# Create Let's Encrypt ClusterIssuer
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@your-domain.com
    privateKeySecretRef:
      name: letsencrypt-production-key
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

### 3.4 Sealed Secrets

```bash
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system

# Verify
kubectl -n kube-system wait --for=condition=ready pod -l app.kubernetes.io/name=sealed-secrets --timeout=60s
```

### 3.5 Create Platform Namespace

```bash
kubectl apply -f k8s/base/namespaces.yaml
```

---

## 4. Configure DNS

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

## 5. Deploy Platform Services

### 5.1 Create Secrets

Create database credentials and other secrets using Sealed Secrets:

```bash
# Create the platform-db-credentials secret
kubectl create secret generic platform-db-credentials \
  --namespace platform \
  --from-literal=database-url="mysql://platform:PASSWORD@mariadb.platform.svc.cluster.local:3306/platform" \
  --from-literal=db-host="mariadb.platform.svc.cluster.local" \
  --from-literal=db-user="platform" \
  --from-literal=db-password="PASSWORD" \
  --dry-run=client -o yaml | kubeseal --format yaml > k8s/overlays/staging/sealed-db-credentials.yaml

kubectl apply -f k8s/overlays/staging/sealed-db-credentials.yaml
```

### 5.2 Deploy with Kustomize

```bash
# Deploy staging overlay (includes all base manifests + staging patches)
kubectl apply -k k8s/overlays/staging/

# Watch rollout
kubectl -n platform rollout status deployment/platform-api --timeout=120s
kubectl -n platform rollout status deployment/admin-panel --timeout=120s
kubectl -n platform rollout status deployment/client-panel --timeout=120s
```

### 5.3 Run Database Migrations

```bash
# Port-forward to the API pod and run migrations
kubectl -n platform exec deployment/platform-api -- npm run db:migrate

# Verify migration status
kubectl -n platform exec deployment/platform-api -- npm run db:migrate -- --status
```

---

## 6. Verify Deployment

### 6.1 Run Smoke Tests

```bash
./scripts/smoke-test.sh
```

The smoke test script validates:
- API health endpoint responds with 200
- Admin panel is accessible
- Client panel is accessible
- Database connectivity
- Redis connectivity

### 6.2 Manual Verification

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

## 7. Create First Admin User

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

## 8. Configure OIDC (Optional)

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

## 9. Deploy Email Stack (Stalwart + Roundcube)

### 9.1 Deploy Stalwart Mail Server

```bash
# Apply the Stalwart StatefulSet, Service, and ConfigMap
kubectl apply -f k8s/base/stalwart-deployment.yaml

# Wait for Stalwart to be ready
kubectl -n platform-system wait --for=condition=ready pod -l app=stalwart-mail --timeout=180s

# Verify mail ports are accessible
kubectl -n platform-system get svc stalwart-mail
```

### 9.2 Configure DNS for Email

Add the following DNS records for each email domain:

```
MX    example.com           -> mail.your-domain.com (priority 10)
TXT   example.com           -> "v=spf1 mx a:mail.your-domain.com ~all"
TXT   default._domainkey    -> (DKIM public key from admin panel)
TXT   _dmarc.example.com   -> "v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain.com"
```

### 9.3 Deploy Roundcube Webmail

```bash
# Apply the Roundcube Deployment, Service, and Ingress
kubectl apply -f k8s/base/roundcube-deployment.yaml

# Wait for Roundcube to be ready
kubectl -n platform-system wait --for=condition=ready pod -l app=roundcube --timeout=120s

# Verify webmail is accessible
curl -s -o /dev/null -w "%{http_code}" https://webmail.your-domain.com/
```

### 9.4 Test Email Flow

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

## 10. Configure SMTP Relay (Optional)

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

## 11. Post-Deployment Checklist

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
