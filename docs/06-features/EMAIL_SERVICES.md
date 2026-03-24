# Email & Webmail Services

> **Related email documentation:**
> - [EMAIL_ENHANCEMENTS_SPECIFICATION.md](EMAIL_ENHANCEMENTS_SPECIFICATION.md) — DKIM, autodiscover, SRV records, sendmail
> - [EMAIL_SENDING_LIMITS_AND_MONITORING.md](EMAIL_SENDING_LIMITS_AND_MONITORING.md) — Rate limiting, delivery monitoring
> - [EMAIL_DELIVERABILITY.md](EMAIL_DELIVERABILITY.md) — IP pools, PTR, warm-up, reputation
> - [WEBMAIL_ACCESS_SPECIFICATION.md](WEBMAIL_ACCESS_SPECIFICATION.md) — Roundcube multi-domain access
> - [MAILBOX_IMPORT_EXPORT_SPECIFICATION.md](MAILBOX_IMPORT_EXPORT_SPECIFICATION.md) — Mailbox migration

## Overview

The platform provides a complete self-hosted email solution with Docker-Mailserver for SMTP/IMAP, Roundcube for webmail, and modern authentication via OIDC and application passwords.

## Email Stack Components

| Component | Technology | Namespace |
| --- | --- | --- |
| **MTA (outbound/inbound)** | **Docker-Mailserver** (Postfix) | `mail` |
| **IMAP server** | **Docker-Mailserver** (Dovecot) | `mail` |
| **Webmail** | **Roundcube** (shared instance) | `mail` |
| **App Password Service** | Custom microservice | `mail` |
| **Spam filtering** | **Docker-Mailserver** (Rspamd) | `mail` |
| **DKIM/SPF/DMARC** | **Docker-Mailserver** (OpenDKIM) | `mail` |
| **Intrusion Detection** | Docker-Mailserver built-in fail2ban | `mail` |
| **External SMTP option** | **SendGrid/Mailgun/AWS SES integration** (hybrid model available) | N/A |

## Roundcube Webmail

### Deployment

Roundcube runs as a **single shared instance** in the `mail` namespace, serving all clients efficiently.

| Parameter | Value |
| --- | --- |
| Deployment model | Single pod in `mail` namespace (shared by all clients) |
| Base image | `roundcube/roundcubemail:latest-apache` (Alpine-based) |
| Resource allocation | 200m-500m CPU, 256Mi-512Mi RAM |
| Database | Shared MariaDB or PostgreSQL (single `roundcube` database for sessions, contacts, identities) |
| IMAP backend | `dovecot.mail.svc.cluster.local:993` (TLS) |
| SMTP backend | `postfix.mail.svc.cluster.local:587` (STARTTLS) |
| Session storage | Database-backed (survives pod restarts) |
| Plugins | managesieve, password (app passwords), identity_select, archive, zipdownload |

### Client-Level Webmail Domains

Roundcube is reachable via both a **platform-level default domain** and **per-client custom domains**, allowing clients to offer branded webmail access to their users.

| Access Method | Domain Example | How It Works |
| --- | --- | --- |
| **Platform default** | `webmail.platform.com` | Single Ingress rule; all clients can log in here with their email credentials |
| **Client custom domain** | `webmail.client-a.com`, `mail.client-b.org` | Per-client Ingress rule pointing to the same Roundcube Service |

**How it works:**
- All webmail domains (platform default + all client custom domains) route to the same Roundcube Service in the `mail` namespace
- Roundcube itself is domain-agnostic — it authenticates users by email address against Dovecot regardless of which domain they accessed it from
- When a client is deleted or their `webmail_domain` is removed, the Management API deletes the corresponding Ingress and Certificate resources

## Email Authentication

### OIDC Login for Webmail

Clients who configure OIDC (Google or Apple) can log into Roundcube without entering a password.

**Configuration per client:**

| Parameter | Description |
| --- | --- |
| `email_oidc_enabled` | Whether OIDC login is available for this client's email accounts |
| `email_oidc_providers` | Which providers are enabled: `google`, `apple`, or both |
| `email_oidc_domain_restriction` | Optional: restrict OIDC login to users whose OIDC email matches the client's domain(s) |

**Note:** OIDC is optional per client. Clients who don't configure OIDC still have full access via application passwords.

**Dovecot OIDC integration options:**

| Approach | Complexity | Recommendation |
| --- | --- | --- |
| **Dovecot OAuth2 passdb** | Medium | **Recommended** — Dovecot natively supports OAuth2 token validation via passdb lookup |
| **Master password delegation** | Low | Roundcube uses a Dovecot master password to authenticate on behalf of the OIDC-verified user |
| **Token-to-app-password swap** | Medium | OIDC flow generates a short-lived app password used for the session |

**Recommendation:** Use **Dovecot OAuth2 passdb** if the OIDC provider (Dex) can issue tokens Dovecot can validate. Fall back to **master password delegation** (simpler) where Roundcube authenticates to Dovecot using a master password after independently verifying the user's OIDC identity.

### Application Passwords

Application passwords are the primary credential for email access outside of OIDC. Used for:

- **IMAP/SMTP clients** (Thunderbird, Outlook, Apple Mail, mobile clients)
- **Webmail fallback** (manual login on the Roundcube login page)
- **Automated systems** (scripts that send email via SMTP)

**Key properties:**

| Property | Value |
| --- | --- |
| Format | High-entropy random string (e.g., 32-char base62: `xK9m2pL7...`) |
| Scope | One app password per email account per purpose (or multiple per account) |
| Storage | Hashed (bcrypt/argon2) in app password database; plaintext stored **only** in client namespace Secret and platform vault for admin access |
| Rotation | Client can regenerate via management panel; admin can rotate via admin panel |
| Revocation | Instant — delete the app password, Dovecot rejects it on next auth attempt |
| Multiple per account | Yes — client can create multiple app passwords (e.g., one for phone, one for desktop) with labels |
| Auto-generated | Yes — one default app password created per email account during provisioning |

### App Password Service

The App Password Service is a microservice (or module within the Management API) that manages the full lifecycle of email application passwords.

**API Endpoints:**

| Endpoint | Description |
| --- | --- |
| `POST /email/{account}/app-passwords` | Create a new app password for an email account |
| `GET /email/{account}/app-passwords` | List app passwords (labels + creation dates; plaintext only for admin role) |
| `DELETE /email/{account}/app-passwords/{id}` | Revoke a specific app password |
| `POST /email/{account}/app-passwords/{id}/rotate` | Regenerate a specific app password |
| `POST /email/{account}/app-passwords/rotate-all` | Rotate all app passwords for an account (admin only) |

**Storage & Validation:**

App passwords are validated by Dovecot's passdb. The App Password Service syncs password hashes to Dovecot's authentication backend:

| Dovecot passdb option | How it works |
| --- | --- |
| **SQL passdb** | **Recommended** — Dovecot queries the app password table directly (MariaDB/PG) for simplicity and performance |
| **Lua passdb** | Custom Lua script that calls the App Password Service API to validate |
| **passwd-file passdb** | App Password Service writes hashed passwords to a mounted file; Dovecot reads it |

### Admin Access to App Passwords

Admin users have **full read access** to all application passwords in plaintext. This is necessary for:

- Client support (helping clients configure their email clients)
- Account recovery (resending credentials to clients)
- Security auditing (reviewing which passwords exist and when they were last used)

**Admin capabilities:**

| Capability | Description |
| --- | --- |
| **View plaintext passwords** | Admin panel shows app passwords in cleartext (decrypted from vault) |
| **View usage metadata** | Last used timestamp, created by, label, active status |
| **Rotate for client** | Admin can regenerate any client's app password |
| **Revoke for client** | Admin can disable any app password immediately |
| **Bulk operations** | Rotate all passwords for a client; revoke all passwords for a client |
| **Audit log** | All admin actions on app passwords are logged |

**Security mitigations:**

| Concern | Mitigation |
| --- | --- |
| Plaintext at rest | Encrypted via Vault transit engine (or Sealed Secret); decrypted only on admin request |
| Access control | Only admin role can access plaintext; client role sees masked passwords |
| Audit trail | Every plaintext password view/retrieval is logged with admin identity and timestamp |
| Rotation after admin view | Optional policy: auto-rotate password N days after admin views it |
| Principle of least privilege | Consider: admin can view but not use passwords (no IMAP login as client) |

## Email Account Provisioning

### During Client Onboarding

When a new client is created with `max_email_accounts > 0`:

1. Management API creates email accounts as configured
2. One default app password is auto-generated per account
3. Credentials stored in client namespace Secret
4. Roundcube database initialized with empty sessions/contacts/identities
5. Webmail domain configured (platform default or custom)
6. OIDC providers configured if enabled

### Client Self-Service (via Management Panel)

Clients can manage their email accounts and app passwords through the control panel:

| Action | Description |
| --- | --- |
| **Create email account** | New mailbox (up to `max_email_accounts` limit) |
| **Delete email account** | Remove mailbox + all app passwords + data |
| **Create app password** | Generate new app password with label |
| **View app passwords** | See list with labels, creation date, last used (masked; reveal on click) |
| **Regenerate app password** | Replace existing app password (old one immediately revoked) |
| **Delete app password** | Revoke a specific app password |
| **Configure OIDC** | Enable/disable Google/Apple login for their email accounts |
| **Set webmail domain** | Configure `webmail.client.com` custom domain |
| **View IMAP/SMTP settings** | Display server addresses, ports, encryption settings |

## Resource & Cost Impact

| Aspect | Impact |
| --- | --- |
| Pods added | 1 Roundcube pod (shared by all clients) + 1 Docker-Mailserver pod + app password service |
| CPU | 200m-500m Roundcube + 500m-1000m mail server (lightweight) |
| Memory | 256Mi-512Mi Roundcube + 512Mi-1Gi mail server |
| Database | 1 small database on shared MariaDB/PG (sessions, contacts, identities, app passwords) |
| Storage | Minimal — no per-client PVs (all data in DB + Dovecot) |
| Ingress rules | 1 platform default + 1 per client with custom webmail domain |
| TLS certificates | 1 platform + 1 per client custom webmail domain |
| App Password Service | Minimal footprint — lightweight API, uses shared DB |

**Cost impact is negligible.** Email adds a single lightweight mail pod and webmail pod. The App Password Service can be a module within the Management API (zero additional pods) or a separate microservice (one small pod). All data lives in the existing shared database infrastructure.

## Email Security

| Concern | Implementation |
| --- | --- |
| No traditional passwords | Email accounts have no user-facing "mailbox password" — all access is via OIDC or app passwords |
| App password strength | System-generated only (32-char high-entropy); users cannot choose weak passwords |
| Brute force protection | fail2ban on Dovecot auth logs (Docker-Mailserver built-in) + rate limiting on Roundcube login |
| App password audit trail | All creation, rotation, revocation, and admin-view events logged |
| OIDC token validation | Short-lived tokens; validated against Dex on every Roundcube session |
| Transport encryption | IMAP: TLS/STARTTLS; SMTP: STARTTLS; Webmail: HTTPS (TLS at ingress) |
| At-rest encryption (passwords) | App password plaintext encrypted via Vault transit; hashes stored with argon2/bcrypt |
| Sending limits | Per-account hourly/daily sending limits enforced by Postfix + tracked by platform (see **EMAIL_SENDING_LIMITS_AND_MONITORING.md** for details) |

## Email Per-Plan Allowances

### Starter Plan
- `max_email_accounts`: 1 or 0 (no email)
- Webmail: Platform default domain only
- OIDC: Disabled
- App passwords: 1 per account

### Business Plan
- `max_email_accounts`: 5
- Webmail: Platform default + optional custom domain
- OIDC: Optional per client
- App passwords: Multiple per account

### Premium Plan
- `max_email_accounts`: Unlimited
- Webmail: Platform default + custom domain
- OIDC: Enabled by default
- App passwords: Unlimited per account

### Custom Plan
- Any combination of email features per agreement

## Related Documentation

- **HOSTING_PLANS.md**: Email feature availability per plan
- **WEBMAIL_ACCESS_SPECIFICATION.md**: Webmail domain setup, SSL certificates, multi-domain routing, authentication
- **EMAIL_SENDING_LIMITS_AND_MONITORING.md**: Rate limiting, quota enforcement, customer/admin monitoring dashboards
- **STORAGE_DATABASES.md**: Email data storage and backups
- **MONITORING_OBSERVABILITY.md**: Email queue and delivery monitoring (system-wide alerts)
- **SECURITY_ARCHITECTURE.md**: Email authentication and security
- **BACKUP_STRATEGY.md**: Email data backup procedures
