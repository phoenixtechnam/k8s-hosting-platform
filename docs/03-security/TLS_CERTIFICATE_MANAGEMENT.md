# TLS Certificate Management

**Version:** 1.0  
**Last Updated:** 2026-03-07  
**Status:** Design / Pre-Implementation  
**Audience:** Platform Admins, DevOps Engineers

---

## Overview

All TLS certificates are managed via **cert-manager** with **Let's Encrypt** as the primary CA and **ZeroSSL** as fallback. The certificate strategy differs by domain DNS mode:

| DNS Mode | Challenge | Certificate Type | Covers |
|----------|-----------|-----------------|--------|
| **Primary** (platform authoritative) | DNS-01 via PowerDNS webhook | **Wildcard** `*.domain.com` + apex `domain.com` | All current and future subdomains |
| **CNAME** (customer DNS, CNAME to ingress) | HTTP-01 via NGINX ingress | **Single-domain** per hostname | Only the specific hostname requested |
| **Secondary** (platform secondary NS) | DNS-01 via PowerDNS webhook | **Wildcard** `*.domain.com` + apex `domain.com` | All current and future subdomains |

**Why wildcard for authoritative domains:** A wildcard certificate covers all subdomains without requiring a new certificate issuance for each one. This means adding `dev.customer.com` or `api.customer.com` requires no certificate action — the existing wildcard already covers them. DNS-01 is the only challenge type Let's Encrypt accepts for wildcard issuance, and is only possible when the platform controls the DNS zone.

**Why single-domain for CNAME domains:** The platform cannot complete a DNS-01 challenge for a zone it does not control. HTTP-01 is used instead, which issues a certificate for the specific hostname only.

---

## cert-manager ClusterIssuers

Three ClusterIssuers are maintained:

| Name | Purpose | Solver |
|------|---------|--------|
| `letsencrypt-wildcard` | Wildcard certs for authoritative domains | DNS-01 only (PowerDNS webhook) |
| `letsencrypt-prod` | Single-domain certs for CNAME/non-authoritative domains | HTTP-01 (NGINX) + DNS-01 fallback |
| `zerossl-prod` | Fallback CA if Let's Encrypt is unavailable | HTTP-01 only |

### letsencrypt-wildcard ClusterIssuer

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-wildcard
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@platform.com
    privateKeySecretRef:
      name: letsencrypt-wildcard-key
    solvers:
    - dns01:
        webhook:
          groupName: acme.platform.com
          solverName: powerdns
          config:
            apiUrl: http://ns1.platform.com:8081
            apiKeySecretRef:
              name: powerdns-api-key
              key: api-key
```

### letsencrypt-prod ClusterIssuer (unchanged — http01 + dns01)

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@platform.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - http01:
        ingress:
          class: nginx
    - dns01:
        webhook:
          groupName: acme.platform.com
          solverName: powerdns
          config:
            apiUrl: http://ns1.platform.com:8081
            apiKeySecretRef:
              name: powerdns-api-key
              key: api-key
```

---

## Certificate Selection Logic

The Management API applies this decision tree when provisioning or updating a domain's certificate:

```
Is the domain in Primary or Secondary DNS mode?
├── YES → Request wildcard cert via letsencrypt-wildcard (DNS-01)
│         Certificate covers: *.domain.com + domain.com
│         Secret name: {client-id}-{domain-slug}-wildcard-tls
│
└── NO (CNAME mode) → Request single-domain cert via letsencrypt-prod (HTTP-01)
                      Certificate covers: the specific hostname only
                      Secret name: {client-id}-{hostname-slug}-tls
```

### Subdomain Certificate Assignment

When a subdomain is added to a domain that already has a wildcard certificate, the subdomain **inherits the parent wildcard** by default. The customer can override this in the Client Panel.

| Subdomain scenario | Default | Customer can change to |
|-------------------|---------|----------------------|
| `dev.example.com` on authoritative `example.com` (has wildcard) | Use parent wildcard | Request own cert (DNS-01 wildcard or single-domain) |
| `app.example.com` (CNAME to ingress, non-authoritative) | Own single-domain cert (HTTP-01) | Not applicable — no wildcard available |
| `shop.example.com` on authoritative `example.com` — customer wants EV cert | Use parent wildcard | Install custom cert (CSR workflow) |

### Wildcard Fallback on Loss of DNS Control

If a domain is switched from Primary/Secondary to CNAME mode (losing DNS-01 capability), the platform:

1. Detects the DNS mode change.
2. Identifies all subdomains that were relying on the wildcard.
3. Automatically requests individual HTTP-01 single-domain certificates for each affected subdomain.
4. Updates all Ingress TLS references to point at the new individual secrets.
5. Marks the old wildcard certificate as superseded (cert-manager stops renewing it).
6. Notifies the admin and customer via the notification system.

Fallback certificates are requested immediately on mode change. Until they are issued (typically < 2 minutes), the existing wildcard remains in use — there is no TLS gap.

---

## Certificate Resources (Kubernetes)

### Wildcard Certificate (authoritative domain)

Created per-customer-domain at provisioning time by the Management API:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {client-id}-{domain-slug}-wildcard
  namespace: client-{client-id}
spec:
  secretName: {client-id}-{domain-slug}-wildcard-tls
  duration: 2160h        # 90 days
  renewBefore: 720h      # Renew 30 days before expiry
  commonName: "*.{domain}"
  dnsNames:
  - "*.{domain}"
  - "{domain}"           # Apex — wildcard does not cover the apex itself
  issuerRef:
    name: letsencrypt-wildcard
    kind: ClusterIssuer
```

### Single-Domain Certificate (CNAME/non-authoritative)

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {client-id}-{hostname-slug}
  namespace: client-{client-id}
spec:
  secretName: {client-id}-{hostname-slug}-tls
  duration: 2160h
  renewBefore: 720h
  dnsNames:
  - "{hostname}"
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

### Ingress TLS Reference

For a domain using a wildcard, all subdomains reference the same secret:

```yaml
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - "example.com"
    - "*.example.com"
    secretName: client-acme-example-com-wildcard-tls
  rules:
  - host: example.com
    ...
  - host: dev.example.com     # Covered by wildcard — no separate cert needed
    ...
  - host: api.example.com     # Covered by wildcard — no separate cert needed
    ...
```

For a subdomain with its own certificate:

```yaml
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - "shop.example.com"
    secretName: client-acme-shop-example-com-tls   # Own cert for this subdomain
  rules:
  - host: shop.example.com
    ...
```

---

## Custom Certificates (CSR Workflow)

Customers who need certificates from a commercial CA (DigiCert, Sectigo, etc.) or want an EV/OV certificate can use the platform CSR workflow. The platform holds the private key; the customer supplies only the signed certificate.

### Workflow

```
1. Customer: Client Panel → Domains → {domain} → SSL → "Request Custom Certificate"
   └── Selects: key type (RSA 2048 / RSA 4096 / ECDSA P-256), SANs to include

2. Platform: Generates RSA/ECDSA keypair + CSR
   └── Private key stored as Sealed Secret in client namespace
   └── CSR displayed in panel + available for download as .csr file

3. Customer: Takes CSR to their chosen CA
   └── Submits CSR, completes CA validation (DV/OV/EV per CA requirements)
   └── Downloads signed certificate chain (.crt / .pem)

4. Customer: Client Panel → Domains → {domain} → SSL → "Install Certificate"
   └── Pastes or uploads: certificate + intermediate chain (or full chain bundle)
   └── Platform validates: certificate matches the stored private key, not expired

5. Platform: Stores cert + chain as a Kubernetes TLS Secret in client namespace
   └── cert-manager annotation set to unmanaged (platform will NOT auto-renew this cert)
   └── Ingress updated to reference the new secret
   └── Expiry date stored in database for monitoring and renewal reminder alerts

6. Renewal: Customer is responsible for renewal (cert-manager does not manage custom certs)
   └── Platform sends reminder alerts at 30 days and 7 days before expiry
   └── Customer repeats from step 3 (platform re-uses same keypair, or customer can regenerate)
```

### CSR Generation (platform-side)

```bash
# ECDSA P-256 keypair (recommended — smaller, faster, equally secure to RSA 3072)
openssl ecparam -genkey -name prime256v1 -noout -out private.key

# RSA 4096 keypair (for CAs that require RSA)
openssl genrsa -out private.key 4096

# Generate CSR
openssl req -new -key private.key \
  -subj "/CN={domain}/O={customer-name}/C=ZA" \
  -addext "subjectAltName=DNS:{domain},DNS:www.{domain}" \
  -out certificate.csr
```

### cert-manager Integration for Custom Certs

Custom certificates are stored as standard Kubernetes TLS Secrets but are flagged as externally managed:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {client-id}-{domain-slug}-custom-tls
  namespace: client-{client-id}
  labels:
    platform.io/cert-type: "custom"
    platform.io/cert-managed-by: "customer"
  annotations:
    cert-manager.io/certificate-name: ""   # Deliberately empty — cert-manager ignores this secret
    platform.io/cert-expiry: "2027-03-07"  # Stored for monitoring alerts
    platform.io/cert-san: "example.com,www.example.com"
type: kubernetes.io/tls
data:
  tls.crt: <base64 certificate + chain>
  tls.key: <base64 private key>
```

The Ingress for that domain references this secret exactly as it would a cert-manager-managed secret — no Ingress change is required when switching between managed and custom certs.

---

## Certificate Visibility

### Admin Panel — Certificate Information

**Admin Panel → Clients → {client} → Domains → {domain} → SSL**

| Field | Value |
|-------|-------|
| Certificate type | `Wildcard (Let's Encrypt)` / `Single-domain (Let's Encrypt)` / `Custom (external CA)` |
| Common Name | `*.example.com` |
| SANs | `*.example.com`, `example.com` |
| Issuer | `Let's Encrypt Authority X3` / CA name |
| Valid from | `2026-03-07` |
| Valid until | `2026-06-05` |
| Days remaining | `90` (colour-coded: green >30, amber 8–30, red ≤7) |
| Auto-renewal | `Enabled` / `Disabled (custom cert)` |
| ACME challenge | `DNS-01` / `HTTP-01` / `n/a (custom)` |
| Cert secret | `client-acme-example-com-wildcard-tls` (Kubernetes secret name) |
| Last renewed | `2026-03-07 02:14:33 UTC` |
| Subdomains using this cert | `dev.example.com`, `api.example.com` (list of subdomains sharing wildcard) |

**Admin Panel → Certificates (global list)**

Filterable table of all certificates across all clients:

| Column | Notes |
|--------|-------|
| Domain | Clickable — goes to domain detail |
| Client | Clickable — goes to client detail |
| Type | Wildcard / Single-domain / Custom |
| Expiry | Date + days remaining |
| Status | Valid / Expiring soon / Expired / Renewal pending / Error |
| Auto-renew | Yes / No |
| Actions | Force renew, View details, Revoke |

**Actions available to admin:**
- **Force renew** — triggers immediate cert-manager renewal regardless of expiry window
- **Revoke** — revokes the cert with Let's Encrypt and issues a new one
- **View raw cert** — displays certificate PEM + full chain in a modal
- **Download cert** — downloads `.pem` bundle (cert + chain + private key); download is logged in the audit trail with a `private_key_downloaded` flag on the certificate record
- **Switch cert type** — convert between wildcard and single-domain (triggers re-issuance)

### Client Panel — Certificate Information

**Client Panel → Domains → {domain} → SSL Certificate**

| Field | Visible to customer |
|-------|-------------------|
| Certificate type | Yes (`Wildcard` / `Single-domain` / `Custom`) |
| Valid until | Yes (date + days remaining, colour-coded) |
| Covered hostnames | Yes (list of SANs) |
| Auto-renewal status | Yes (`Automatic` / `Manual renewal required`) |
| Renewal history | Last 5 renewals (date, success/failure) |
| Subdomains using this cert | Yes — shows which subdomains share the wildcard |

**Actions available to customer:**
- **Request custom certificate** — initiates CSR workflow (generates keypair + CSR)
- **Install certificate** — paste/upload signed cert after getting it from CA (CSR workflow step 4)
- **Download CSR** — re-download the pending CSR if not yet submitted to CA
- **Manage API tokens** — create and revoke scoped `cert:read` tokens for automated certificate download (see Certificate Download section below)
- **Switch subdomain cert** — per-subdomain toggle: "Use parent wildcard" / "Use own certificate"
- **Regenerate keypair** — generates new keypair + new CSR (invalidates any pending CSR)

**Customer cannot:**
- Revoke a certificate (admin-only)
- Disable auto-renewal for Let's Encrypt-managed certs (auto-renewal is always on for LE certs)

### Domain List — Certificate Status Column

Both Admin and Client Panel domain list views show a compact certificate status badge per domain:

| Badge | Meaning |
|-------|---------|
| `✓ Valid (87d)` | Certificate valid, days remaining shown |
| `⚠ Expiring (12d)` | Within 30-day renewal window — renewal may be in progress |
| `✗ Expired` | Certificate expired — immediate action required |
| `↻ Renewing` | cert-manager renewal in progress |
| `! Error` | Renewal failed — click for details |
| `Custom` | Custom certificate installed — manual renewal |

---

## Certificate Download

Certificate files (private key + certificate + full chain) are available exclusively via the API using a scoped token. There is no panel download button — the API-only approach avoids casual exposure of private key material through a browser and is better suited to the primary use case: automated pickup by external servers and deploy pipelines.

### Download via API

For CI/CD pipelines, deployment scripts, and external servers that need to fetch the current certificate automatically — particularly important since Let's Encrypt certificates renew every 90 days — customers can use a **scoped certificate download token**.

#### Token Management

Tokens are managed in **Client Panel → Domains → {domain} → SSL Certificate → API Access**.

| Field | Notes |
|-------|-------|
| Token name | Human-readable label (e.g. `"staging-server"`, `"deploy-pipeline"`) |
| Scope | `cert:read` — can only download certificate files for this domain; no other panel access |
| Domain binding | Token is bound to a single domain; cannot be used for any other domain |
| Expiry | Never / 30 days / 90 days / 1 year (customer choice) |
| Created | Timestamp |
| Last used | Timestamp (updated on each use) |
| Actions | Revoke |

A customer can create multiple tokens per domain (e.g. one per server). Tokens are shown once at creation and cannot be retrieved again — if lost, revoke and create a new one.

#### API Endpoint

```
GET /api/v1/certs/{domain}/download
Authorization: Bearer <cert-download-token>
```

Response: `application/x-pem-file` — PEM bundle containing the private key, certificate, and full chain.

**Example — curl:**

```bash
curl -H "Authorization: Bearer <token>" \
     https://api.platform.com/api/v1/certs/example.com/download \
     -o example.com-cert.pem
```

**Example — Nginx post-deploy hook:**

```bash
#!/bin/bash
# Fetch renewed cert after Let's Encrypt renewal (runs on external server)
curl -sf -H "Authorization: Bearer ${CERT_TOKEN}" \
     https://api.platform.com/api/v1/certs/example.com/download \
     -o /etc/nginx/certs/example.com.pem
nginx -s reload
```

**Example — GitHub Actions deploy step:**

```yaml
- name: Fetch certificate
  run: |
    curl -sf -H "Authorization: Bearer ${{ secrets.CERT_TOKEN }}" \
         https://api.platform.com/api/v1/certs/${{ vars.DOMAIN }}/download \
         -o cert.pem
```

#### Error responses

| HTTP status | Meaning |
|-------------|---------|
| `200 OK` | PEM bundle returned |
| `401 Unauthorized` | Token missing, invalid, or revoked |
| `403 Forbidden` | Token is valid but not scoped to this domain |
| `404 Not Found` | Domain not found or no active certificate |
| `410 Gone` | Token has expired |

#### Renewal behaviour

The download endpoint always returns the **currently active certificate**. When cert-manager renews the Let's Encrypt certificate (30 days before expiry), the Kubernetes Secret is updated automatically. The next call to the download endpoint returns the new certificate with no change required on the caller's side.

For external servers that need to pick up renewals automatically, the recommended pattern is a cron job or systemd timer that fetches the cert daily and reloads the web server only if the certificate has changed:

```bash
#!/bin/bash
# /etc/cron.daily/refresh-platform-cert
NEW=$(curl -sf -H "Authorization: Bearer ${CERT_TOKEN}" \
           https://api.platform.com/api/v1/certs/example.com/download)
CURRENT=$(cat /etc/nginx/certs/example.com.pem 2>/dev/null)

if [ "$NEW" != "$CURRENT" ]; then
  echo "$NEW" > /etc/nginx/certs/example.com.pem
  nginx -s reload
  echo "Certificate updated and nginx reloaded"
fi
```

### Database Schema (additions)

```sql
-- Scoped certificate download tokens
CREATE TABLE cert_download_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  token_hash    VARCHAR(255) NOT NULL UNIQUE,  -- bcrypt hash; plaintext shown once at creation
  expires_at    TIMESTAMPTZ,                   -- NULL = never expires
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log for every certificate download (API only)
CREATE TABLE cert_download_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  cert_id       UUID NOT NULL REFERENCES domain_certificates(id),
  client_id     UUID REFERENCES clients(id),
  admin_id      UUID REFERENCES admins(id),
  token_id      UUID NOT NULL REFERENCES cert_download_tokens(id),
  ip_address    INET,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Flag on domain_certificates to indicate private key has ever been downloaded
-- (already exists in domain_certificates — add column):
ALTER TABLE domain_certificates
  ADD COLUMN private_key_downloaded_at TIMESTAMPTZ,  -- NULL = never downloaded
  ADD COLUMN private_key_download_count INTEGER NOT NULL DEFAULT 0;
```

### Implementation Checklist

- [ ] Add `cert:read` scoped token generation to Client Panel SSL section
- [ ] Add token management UI: create, list (name + last used + expiry), revoke
- [ ] Implement `GET /api/v1/certs/{domain}/download` — authenticate via Bearer token, return PEM bundle
- [ ] Build PEM bundle assembler: read `tls.key` + `tls.crt` from Kubernetes Secret, concatenate in correct order
- [ ] Create `cert_download_tokens` table and `cert_download_log` table
- [ ] Add `private_key_downloaded_at` and `private_key_download_count` columns to `domain_certificates`
- [ ] Add download log view to Admin Panel → Certificates → {domain} → Download History

---

## Certificate Monitoring & Alerts

| Alert | Threshold | Recipient | Channel |
|-------|-----------|-----------|---------|
| `CertExpiryWarning` | < 30 days remaining | Admin + customer | Email + panel notification |
| `CertExpiryCritical` | < 7 days remaining | Admin | Email + SMS + panel |
| `CertRenewalFailed` | cert-manager reports renewal error | Admin | Email + SMS immediately |
| `CertExpired` | 0 days remaining | Admin + customer | Email + SMS immediately |
| `CustomCertExpiry30d` | Custom cert < 30 days | Customer | Email + panel notification |
| `CustomCertExpiry7d` | Custom cert < 7 days | Admin + customer | Email + SMS |

Custom certificate expiry alerts fire even when auto-renewal is disabled — the platform always monitors expiry regardless of cert type.

### Prometheus Rules

```yaml
groups:
- name: certificates
  rules:
  - alert: CertExpiryWarning
    expr: platform_cert_expiry_days < 30
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Certificate expiring in {{ $value }} days"
      description: "Domain {{ $labels.domain }} (client {{ $labels.client_id }})"

  - alert: CertExpiryCritical
    expr: platform_cert_expiry_days < 7
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "Certificate expiring in {{ $value }} days — URGENT"

  - alert: CertRenewalFailed
    expr: increase(platform_cert_renewal_failures_total[1h]) > 0
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "Certificate renewal failed for {{ $labels.domain }}"

  - alert: CustomCertExpiry
    expr: platform_custom_cert_expiry_days < 30
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Custom certificate for {{ $labels.domain }} expires in {{ $value }} days"
```

---

## Database Schema

```sql
-- Per-domain certificate state (one row per active cert per domain)
CREATE TABLE domain_certificates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id       UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  cert_type       VARCHAR(20) NOT NULL CHECK (cert_type IN ('wildcard', 'single', 'custom')),
  managed_by      VARCHAR(20) NOT NULL CHECK (managed_by IN ('letsencrypt', 'zerossl', 'custom')),
  acme_challenge  VARCHAR(10) CHECK (acme_challenge IN ('dns01', 'http01', NULL)),
  common_name     VARCHAR(255) NOT NULL,          -- e.g. *.example.com
  sans            TEXT[] NOT NULL,                -- all SANs
  issuer          VARCHAR(255),                   -- CA name
  serial_number   VARCHAR(255),
  valid_from      TIMESTAMPTZ,
  valid_until     TIMESTAMPTZ NOT NULL,
  k8s_secret_name VARCHAR(255) NOT NULL,          -- Kubernetes secret holding the cert
  k8s_namespace   VARCHAR(255) NOT NULL,
  auto_renew      BOOLEAN NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  csr_pending     TEXT,                           -- PEM CSR if custom cert workflow in progress
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subdomain cert assignment (which cert a subdomain uses)
CREATE TABLE subdomain_cert_assignment (
  subdomain_id       UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  cert_id            UUID NOT NULL REFERENCES domain_certificates(id),
  assigned_by        VARCHAR(20) NOT NULL CHECK (assigned_by IN ('auto', 'customer', 'admin')),
  assigned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subdomain_id)
);

-- Certificate renewal history
CREATE TABLE cert_renewal_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_id     UUID NOT NULL REFERENCES domain_certificates(id) ON DELETE CASCADE,
  renewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success     BOOLEAN NOT NULL,
  error_msg   TEXT,
  renewed_by  VARCHAR(20) NOT NULL CHECK (renewed_by IN ('auto', 'admin', 'customer'))
);
```

---

## Implementation Checklist

### Phase 1 — Wildcard + DNS-01

- [ ] Deploy `cert-manager-webhook-pdns` in `cert-manager` namespace
- [ ] Create `letsencrypt-wildcard` ClusterIssuer with DNS-01 solver only
- [ ] Update Management API provisioning: create wildcard `Certificate` resource for Primary/Secondary domains, single-domain `Certificate` for CNAME domains
- [ ] Update Ingress template: wildcard TLS secret covers apex + `*.domain`; subdomains reference same secret
- [ ] Implement wildcard fallback on DNS mode change (detect → request individual certs → update Ingress)
- [ ] Store cert metadata in `domain_certificates` table
- [ ] Create `subdomain_cert_assignment` table and populate on provisioning

### Phase 2 — Custom Certificates (CSR workflow)

- [ ] Admin Panel: Certificate global list view with filters and bulk actions
- [ ] Admin Panel: Per-domain SSL detail panel (all fields listed above)
- [ ] Client Panel: Per-domain SSL section (all fields listed above)
- [ ] Client Panel: "Request custom certificate" — keypair generation + CSR display
- [ ] Client Panel: "Install certificate" — paste/upload signed cert, validate against stored key
- [ ] Client Panel: Per-subdomain cert toggle (use parent wildcard / use own cert)
- [ ] Store CSR and custom cert metadata in `domain_certificates` table
- [ ] Implement custom cert monitoring and renewal reminder alerts

### Phase 3 — Monitoring & Alerts

- [ ] Expose `platform_cert_expiry_days` and `platform_cert_renewal_failures_total` Prometheus metrics
- [ ] Deploy PrometheusRules for all alert thresholds defined above
- [ ] Connect custom cert expiry to notification system (email + panel notification)
- [ ] Add certificate status badge to domain list in both Admin and Client Panel

---

## Related Documentation

- **SECRETS_MANAGEMENT.md** — ClusterIssuer definitions and cert-manager secret naming
- **DNS_MODE_SELECTION.md** — DNS mode per domain and its impact on ACME challenge method
- **POWERDNS_INTEGRATION.md** — DNS-01 ACME challenge record management via PowerDNS API
- **ADMIN_PANEL_REQUIREMENTS.md** — Admin Panel SSL certificate management UI (section ND.2)
- **CLIENT_PANEL_FEATURES.md** — Client Panel SSL certificate UI
- **MONITORING_OBSERVABILITY.md** — Certificate expiry alerts
- **DEPLOYMENT_PROCESS.md** — Certificate provisioning during client onboarding
