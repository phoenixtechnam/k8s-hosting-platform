# Security & Access Control Architecture

## Overview

The platform implements a defense-in-depth security architecture covering authentication, authorization, secrets management, network security, and container security.

> **Note (ADR-022):** The OIDC provider (Dex or compatible) and VPN mesh (NetBird) are **external services** — the platform consumes their endpoints but does not deploy or manage them. See the infrastructure project for deployment details. Both services are configurable in the admin panel.

## Authentication — OpenID Connect (OIDC)

Client and admin authentication for the management panel and related services uses **OpenID Connect** with support for Google and Apple accounts.

| Component | Decision |
| --- | --- |
| **OIDC Provider** | **External** — connect to Dex or any compatible OIDC provider (configured in admin panel) |
| Supported providers | Google, Apple (via OIDC) |
| Local accounts | Optional fallback — email/password managed by the external OIDC provider |
| Admin authentication | OIDC with admin role claim |
| Client authentication | OIDC with client role claim, scoped to their namespace |
| Session management | JWT tokens with short expiry + refresh tokens |
| MFA | Delegated to OIDC provider (Google/Apple handle MFA) |

### OIDC Flow

1. Client visits management panel
2. Redirected to OIDC provider (Google/Apple sign-in)
3. On success, JWT issued with claims: `role`, `client_id`, `namespace`
4. Management API validates JWT on every request
5. API enforces namespace-scoped access based on claims

### JWT Token Validation Requirements

Every API request must include a valid JWT in the `Authorization: Bearer <token>` header. The Management API validates tokens as follows:

**Required Validations (all must pass):**

| Check | Requirement | Failure Response |
| --- | --- | --- |
| **Signature** | RS256 algorithm, verified against OIDC provider JWKS endpoint | `401 Unauthorized` |
| **Issuer (`iss`)** | Must match configured OIDC issuer URL (e.g., `https://dex.example.com`) | `401 Unauthorized` |
| **Audience (`aud`)** | Must match `management-api` (configurable) | `401 Unauthorized` |
| **Expiration (`exp`)** | Token must not be expired. Clock skew tolerance: 30 seconds | `401 Unauthorized` |
| **Not Before (`nbf`)** | Token must be active (if present) | `401 Unauthorized` |
| **Required Claims** | `sub` (subject), `role`, `exp`, `iat` must be present | `401 Unauthorized` |
| **Role Claim** | `role` must be one of: `admin`, `billing`, `support`, `read-only`, `client_admin`, `client_user` | `403 Forbidden` |

**JWKS Configuration:**
- JWKS endpoint: `{oidc_issuer_url}/.well-known/openid-configuration` → `jwks_uri`
- JWKS cache TTL: 1 hour (refresh on signature verification failure)
- JWKS refresh on unknown `kid` (key ID) in token header
- Minimum key size: RSA 2048-bit

**Token Lifecycle:**
- Access token lifetime: 1 hour (configurable via OIDC provider)
- Refresh token lifetime: 7 days (configurable via OIDC provider)
- Refresh endpoint: `POST /api/v1/auth/refresh` (exchanges refresh token for new access token)
- Token revocation: **Server-side token denylist** backed by Redis (see below)

**Token Denylist (Required for Phase 1):**

The platform maintains a Redis-backed token denylist that is checked on **every API request**. This is independent of the OIDC provider's revocation capabilities.

- **Storage:** Redis SET `token:denylist:{jti}` with TTL matching the token's remaining lifetime
- **Check:** Middleware extracts `jti` (JWT ID) claim from validated token and checks Redis before proceeding
- **Revocation triggers:**
  - Admin suspends or deactivates a client account → all active tokens for that client added to denylist
  - Admin or client changes their password → existing tokens revoked
  - Staff member is terminated → their tokens added to denylist
  - Client requests "logout all sessions" → all their tokens revoked
- **Refresh endpoint:** `POST /api/v1/auth/refresh` checks denylist before issuing new tokens
- **Performance:** Redis SET lookup is O(1), <1ms overhead per request
- **Cleanup:** TTL-based automatic expiry — no manual cleanup needed

```typescript
// Middleware pseudocode
const checkTokenDenylist = async (req, res, next) => {
  const jti = req.jwt.jti;
  const isDenied = await redis.exists(`token:denylist:${jti}`);
  if (isDenied) {
    throw new UnauthorizedError('Token has been revoked');
  }
  next();
};
```

**Implementation Notes:**
- Use `jose` or `jsonwebtoken` npm package with explicit algorithm whitelist (`RS256` only -- never `HS256` or `none`)
- Never decode tokens without signature verification
- Log all authentication failures to audit trail (see EVENT_LOGGING_STRATEGY.md)
- Rate limit failed authentication attempts: 10 per minute per IP (see API rate limiting)
- All tokens MUST include a `jti` claim (request this from the OIDC provider configuration)

## Intrusion Detection — fail2ban

fail2ban operates at **multiple layers** to protect both the platform and client sites.

| Layer | Implementation |
| --- | --- |
| **Ingress (HTTP)** | fail2ban DaemonSet reading ingress controller access logs; bans IPs with repeated 401/403/brute-force patterns |
| **SFTP** | fail2ban monitoring SFTP gateway auth logs; bans after N failed login attempts |
| **SSH (node-level)** | Host-level fail2ban on each K8s node (not containerized) |
| **Mail** | fail2ban integrated in Docker-Mailserver (built-in support) |
| **Management Panel** | Rate limiting at OIDC proxy + fail2ban on auth failure logs |

### Ban Management

| Configuration | Value |
| --- | --- |
| **Ban storage** | Centralized ban list in shared Redis (`f2b:banned:{ip}`) to propagate bans across all nodes/pods |
| **Ban duration** | Progressive: 10min → 1hr → 24hr → permanent (configurable) |
| **Whitelist** | Admin IPs and monitoring probes excluded |

## Web Application Firewall (WAF) — Optional

An optional WAF layer at the ingress controller to protect client sites from common web attacks.

| Decision | Value |
| --- | --- |
| **WAF engine** | **ModSecurity** (with NGINX Ingress) |
| Rule set | OWASP Core Rule Set (CRS) v4 |
| Mode | Detection-only initially; switch to blocking after tuning |
| Per-client toggle | Clients can enable/disable WAF via management panel |
| Custom rules | Admin-defined global rules + per-client overrides |
| Logging | WAF events logged to Loki, visible in Grafana |

## Kubernetes RBAC & Access Management

| Area | Approach |
| --- | --- |
| Cluster admin | Limited to ops team — OIDC-authenticated kubectl via NetBird mesh |
| Client access | No direct K8s access — all via management panel |
| Service accounts | Per-service, least privilege, per namespace |
| Admin kubectl access | OIDC-authenticated via kube-apiserver OIDC config, accessible only via external NetBird WireGuard mesh (port 6443 not public). See ADR-013, ADR-022. |

## Secrets Management

| Decision | Value |
| --- | --- |
| **Secrets backend** | **Sealed Secrets** (GitOps-friendly, simple) |
| DB credentials | Auto-generated per client, stored in namespace Secret, rotated via Management API |
| SFTP credentials | Auto-generated, stored in namespace Secret |
| TLS certificates | Managed by cert-manager (not stored manually) |
| OIDC client secrets | Stored in Sealed Secret |
| Rotation policy | DB passwords: 90 days; SFTP: on request; API keys: 30 days |
| Injection method | Environment variables + volume mounts (no sidecars initially) |

## Network Security

- [ ] **Default-deny NetworkPolicy** in every client namespace
- [ ] **Ingress controller** is the **only** external HTTP entry point to client pods
- [ ] **Cross-namespace client traffic blocked** — client-a cannot reach client-b
- [ ] **Client pods → shared services** allowed (specific ports only) via explicit NetworkPolicy rules
- [ ] **Platform services access client namespaces** via explicit NetworkPolicy rules
- [ ] **TLS termination** at ingress controller (HTTPS everywhere)
- [ ] **mTLS between platform services** — Deferred to Phase 2 (start with NetworkPolicy, upgrade if service mesh needed)
- [ ] **Egress controls** — client pods restricted to DNS + shared services by default; internet access opt-in per client
- [ ] **DDoS mitigation** — rate limiting at ingress + optional upstream protection (Cloudflare proxy)

## Admin Access Transport — External NetBird WireGuard Mesh

All admin access to cluster infrastructure is routed through an **external NetBird WireGuard mesh VPN** (see ADR-013). The platform assumes the mesh is already running and all nodes are joined. Management ports are not exposed to the public internet. NetBird connection details are configurable in the admin panel.

| Component | Public Internet | NetBird Mesh Only |
| --- | --- | --- |
| **HTTP/HTTPS (80/443)** | Yes (customer traffic via NGINX Ingress) | — |
| **SMTP/IMAP (25/587/993)** | Yes (customer email) | — |
| **SFTP (2222)** | Yes (customer file transfer) | — |
| **SSH (22)** | **No** — closed on public firewall | Yes (admin only) |
| **Kubernetes API (6443)** | **No** — closed on public firewall | Yes (admin kubectl) |
| **etcd (2379/2380)** | **No** | Yes (cluster internal + admin) |
| **Backup SSHFS** | **No** — backup server not publicly accessible | Yes (SSHFS mount over mesh tunnel) |
| **DNS (53 TCP+UDP)** | Yes (public — serves customer domain queries) | — |
| **PowerDNS API (8081)** | **No** — closed on public firewall | Yes (Management API creates zones via mesh) |

### Security Model

The platform requires that the NetBird WireGuard mesh provides:
- P2P encrypted tunnels between all cluster nodes and admin workstations
- Signal and TURN/Relay redundancy for connection establishment
- OIDC-based authentication for admin users (via the external OIDC provider)
- Pre-authenticated setup keys for break-glass scenarios

> See the infrastructure project for NetBird deployment topology, redundancy model, and failure scenarios.

### OIDC Integration

NetBird authenticates admin users via the external OIDC provider:

```
Admin opens NetBird client
    → NetBird redirects to OIDC provider login
    → Admin authenticates via Google/Apple
    → OIDC provider issues token to NetBird
    → NetBird grants mesh access based on group policy
    → WireGuard tunnel established
```

**Fallback:** Pre-authenticated setup keys (static tokens) stored in Sealed Secret + offline backup. These bypass OIDC for break-glass scenarios.

### Firewall Rules (Per Node)

```bash
# Public interface — only customer-facing ports
iptables -A INPUT -p tcp --dport 80 -j ACCEPT     # HTTP
iptables -A INPUT -p tcp --dport 443 -j ACCEPT    # HTTPS
iptables -A INPUT -p tcp --dport 25 -j ACCEPT     # SMTP
iptables -A INPUT -p tcp --dport 587 -j ACCEPT    # SMTP submission
iptables -A INPUT -p tcp --dport 993 -j ACCEPT    # IMAPS
iptables -A INPUT -p tcp --dport 2222 -j ACCEPT   # SFTP (customer)
iptables -A INPUT -p udp --dport 51820 -j ACCEPT  # WireGuard (NetBird)

# Management ports — only via WireGuard interface (wt0)
iptables -A INPUT -i wt0 -p tcp --dport 22 -j ACCEPT    # SSH via mesh
iptables -A INPUT -i wt0 -p tcp --dport 6443 -j ACCEPT  # K8s API via mesh

# Drop all other SSH/K8s API from public
iptables -A INPUT -p tcp --dport 22 -j DROP
iptables -A INPUT -p tcp --dport 6443 -j DROP
```

## Container Security

- [ ] **Admin-managed catalog images only** — no client-supplied images
- [ ] **Trivy scanning** on every build before publishing to catalog
- [ ] **Alpine-based images** for all catalog containers and platform services
- [ ] **Kubernetes Pod Security Standards** set to `restricted` for platform, `baseline` for client workloads
- [ ] **No privileged containers** — all pods run as non-root where possible
- [ ] **Read-only root filesystem** for platform services; client pods get writable PV mount only
- [ ] **Basic Pod Security Standards only (MVP)** — Falco evaluation in Phase 2
- [ ] **Image pull policy: `Always`** for platform; `IfNotPresent` for catalog images (pinned by digest)
- [ ] **No `exec` into client pods via kubectl** — disabled for non-admin RBAC roles

## Security Event Logging

| Event Type | Logged To | Retention |
| --- | --- | --- |
| **Authentication attempts** | Audit log + Loki | 1 year |
| **Authorization failures** | Audit log + Loki | 1 year |
| **fail2ban bans** | Loki (via DaemonSet logs) | 90 days |
| **WAF blocks** | Loki (via ModSecurity logs) | 30 days |
| **API calls** (audit trail) | Audit log database | 1 year |
| **Secrets access** (if readable) | Kubernetes audit log | 1 year |
| **Certificate changes** | Audit log | 1 year |

## TLS & Certificate Management

| Component | Implementation |
| --- | --- |
| **Certificate provisioning** | cert-manager + Let's Encrypt (automatic) |
| **Certificate renewal** | Automatic 30 days before expiry |
| **Self-signed fallback** | Dev/test environments only |
| **TLS version** | TLS 1.2+ (configured in NGINX Ingress Controller) |
| **Cipher suites** | Strong ciphers only (no weak/deprecated algorithms) |
| **HSTS** | Enabled globally (preload list registration optional) |

## API Security

| Measure | Implementation |
| --- | --- |
| **Rate limiting** | Per-IP, per-user, per-endpoint (configurable) |
| **Request signing** | Optional for critical operations (admin API) |
| **API versioning** | v1, v2, etc. — old versions phased out gradually |
| **Input validation** | All user inputs sanitized (no code injection, XSS, etc.) |
| **CORS** | Restricted to known origins; wildcard origins blocked |
| **API keys** | Scoped API keys for service-to-service auth (if needed) |

## Data Protection

| Layer | Strategy |
| --- | --- |
| **Encryption at rest** | Block storage encrypted via Longhorn; database encryption optional |
| **Encryption in transit** | TLS everywhere (ingress, inter-pod, database connections) |
| **Backup encryption** | AES-256 encrypted before storage on offsite server |
| **Secrets encryption** | Via Sealed Secrets (encryption key stored separately) |
| **Database passwords** | Hashed with bcrypt/argon2; plaintext only at creation/reset |

## Compliance Considerations

| Requirement | Applies? | Notes |
| --- | --- | --- |
| **GDPR** | Likely | If hosting EU client data — data residency, right to deletion |
| **PCI-DSS** | **Not required (MVP)** | Defer until/if clients process payments |
| **SOC 2** | **Not required (MVP)** | Defer until/if enterprise clients require it |
| **HIPAA** | Unlikely | Unless hosting healthcare clients |

### GDPR Compliance (If Applicable)

- **Data residency:** All client data stored in single country/region (configurable)
- **Right to deletion:** Ability to permanently delete all client data from cluster and backups
- **Data portability:** Ability to export customer data in machine-readable format
- **Privacy policy:** Published and customer consent obtained
- **Data processing agreement (DPA):** Available for regulated clients

## Break-Glass Emergency Access

**Purpose:** Provide out-of-band access to the platform when the primary authentication system (external OIDC provider) is unavailable.

**When to use:** Only during P1 incidents where the OIDC provider is unreachable and platform management is required. All break-glass access is fully audited.

### Procedure

**Level 1: Direct kubectl via NetBird Mesh (Primary)**

Operators SSH to control plane nodes via the **external NetBird WireGuard mesh** (SSH is not exposed on public internet — see ADR-013):

```bash
# SSH to control plane via NetBird WireGuard mesh
# NetBird tunnel persists even if OIDC provider is down
# Use pre-authenticated setup key if NetBird OIDC session expired
ssh admin@<cp-node-netbird-ip>

# k3s stores kubeconfig locally
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Verify access
kubectl get nodes
kubectl get pods -A
```

This bypasses the OIDC provider entirely as k3s kubeconfig uses certificate-based authentication. NetBird WireGuard tunnels persist without the management server — already-established P2P connections survive total NetBird infrastructure outage.

**If NetBird tunnel is also down:** Use a pre-authenticated NetBird setup key (stored offline alongside the break-glass password) to re-establish the mesh connection. As a last resort, temporarily open SSH (port 22) on the node's public firewall via the hosting provider's console, SSH in, then close the port immediately after recovery.

**Level 2: Emergency Admin Account**

A static user is pre-configured in the external OIDC provider for break-glass access (e.g., a Dex static password entry). The OIDC provider manages this account — see the infrastructure project for configuration details.

- Password stored in sealed envelope (physical) and encrypted password manager
- Two-person rule: password is split between two operators (neither has the full password alone)
- Rotated quarterly during DR drills
- Usage triggers immediate P1 alert via Alertmanager

**Level 3: Sealed Secrets Key Recovery**

If the cluster is being rebuilt from scratch:

1. Retrieve Sealed Secrets backup from offline storage (GPG-encrypted)
2. Decrypt with GPG key held by authorized operators
3. Install into new cluster before deploying any SealedSecret resources

### Post Break-Glass Actions

After every break-glass access event:

1. **Immediately:** Document the incident (who, when, why, what actions taken)
2. **Within 24 hours:** Rotate the break-glass password
3. **Within 48 hours:** Conduct post-incident review
4. **If compromised:** Rotate all credentials accessed during the break-glass session

### Monitoring

- Alert: `BreakGlassAccessUsed` — fires on any login by `emergency-admin@k8s-platform.local-dev`
- Severity: Critical (always pages on-call, even outside business hours)
- Audit: All kubectl commands during break-glass sessions logged to immutable audit trail

## Security Incident Response

| Stage | Procedure |
| --- | --- |
| **Detection** | Alertmanager notifications for security events |
| **Investigation** | Access logs in Loki, metrics in Prometheus, audit trail in database |
| **Containment** | Disable compromised user/API key, isolate affected namespace |
| **Eradication** | Patch vulnerability, rotate credentials, update WAF rules |
| **Recovery** | Restore from backup if needed, validate integrity, resume operations |
| **Post-mortem** | Document incident, update procedures, notify affected clients |

## Security Update Process

| Component | Update Frequency | Process |
| --- | --- | --- |
| **Base images** | Monthly (Alpine updates) | Rebuild catalog images, test, publish, notify clients of upgrade availability |
| **Dependencies** | As needed (Dependabot) | Automated PRs, review, test, merge, release |
| **Kubernetes** | Quarterly (k3s releases) | Test in staging, plan maintenance window, upgrade cluster, validate |
| **Platform services** | As needed (internal) | Code review, CI tests, deploy to staging, deploy to production (blue-green) |

## Security Checklist for MVP

**To verify before launch:**

- [ ] All default passwords/secrets changed from example values
- [ ] TLS certificates for all ingress routes (not self-signed)
- [ ] Network policies deployed and tested in staging
- [ ] RBAC roles created and tested (admin vs client)
- [ ] Sealed Secrets encryption key backed up securely
- [ ] OIDC provider configured with appropriate scopes
- [ ] fail2ban rules tuned and tested
- [ ] Audit logging enabled for all APIs
- [ ] Database backups encrypted and tested for restoration
- [ ] Security contacts and incident response plan documented
- [ ] Vulnerability scanning enabled in CI pipeline
- [ ] Container images scanned with Trivy before publication
- [ ] WAF rules loaded and tested (detection mode initially)
- [ ] **NetBird mesh connectivity verified** — all nodes + admin workstations joined and reachable
- [ ] **SSH (22) and K8s API (6443) closed** on public firewall — only via NetBird mesh
- [ ] **NetBird OIDC integration** with external OIDC provider tested (login flow works)
- [ ] **NetBird setup keys** generated and stored offline (break-glass)
- [ ] **Backup server** reachable via NetBird mesh — rsync works over tunnel

## Related Documentation

- **INFRASTRUCTURE_SIZING.md**: Network configuration and isolation
- **STORAGE_DATABASES.md**: Database encryption and access controls
- **EMAIL_SERVICES.md**: Email authentication and app password security
- **MONITORING_OBSERVABILITY.md**: Security event monitoring and alerting
- **DEPLOYMENT_PROCESS.md**: Secure CI/CD pipeline and secrets management
- **ARCHITECTURE_DECISION_RECORDS.md**: ADR-013 (NetBird WireGuard Mesh for Admin Access), ADR-022 (External Services Separation)
- **INCIDENT_RESPONSE_RUNBOOK.md**: NetBird VPN failure runbook
- **SECRETS_MANAGEMENT.md**: NetBird credentials and setup key rotation
