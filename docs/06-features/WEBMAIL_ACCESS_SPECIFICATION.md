# Webmail Access Specification

## Overview

The platform provides secure, user-isolated webmail access via **Roundcube**, with **one branded webmail domain per customer domain**. Each email user has their own login and can only access their own email account. Automatic SSL certificate provisioning and theme/language customization complete the solution.

**Key Design:**
- ✅ Automatic webmail domain generation (`webmail.domain1.com`, `webmail.domain2.com`, etc.)
- ✅ One webmail domain per customer domain (branded, isolated)
- ✅ Single shared Roundcube instance (all customers via smart routing)
- ✅ Email account isolation (users log into only their own account)
- ✅ OIDC + app password authentication options
- ✅ Theme & language customization per user
- ✅ Automatic SSL certificates (Let's Encrypt via cert-manager)
- ✅ Admin controls (enable/disable per customer, view usage statistics)
- ✅ Plan-based webmail availability

---

## Architecture

### Single Roundcube Instance with Multi-Domain Routing

All customer webmail domains route to **one shared Roundcube pod** in the `mail` namespace:

```
Customer A (3 domains)          Customer B (2 domains)
├─ webmail.domain-a1.com        ├─ webmail.domain-b1.com
├─ webmail.domain-a2.com        └─ webmail.domain-b2.com
└─ webmail.domain-a3.com

                    ↓ (all route to same Service)
                    
            Roundcube Service (mail namespace)
                        ↓
            Roundcube Pod (single instance)
                    ↓
        Dovecot IMAP Backend (mail.mail.svc.cluster.local:993)
```

### Why Single Instance?

| Benefit | Why |
|---------|-----|
| **Cost** | One pod + database instead of N pods (huge savings) |
| **Simplicity** | Single configuration, easier to maintain |
| **Resource efficiency** | ~300-500m CPU, 256-512 MB RAM serves all customers |
| **Scalability** | Can handle 1000+ concurrent users |
| **Multi-tenancy** | Roundcube domain-agnostic; can serve multiple domains simultaneously |

### How Multi-Domain Routing Works

1. **Kubernetes Ingress rules (one per webmail domain):**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webmail-domain-a1
  namespace: mail
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - webmail.domain-a1.com
    secretName: webmail-domain-a1-tls  # Cert-manager auto-provisioned
  rules:
  - host: webmail.domain-a1.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: roundcube
            port:
              number: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webmail-domain-a2
  namespace: mail
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - webmail.domain-a2.com
    secretName: webmail-domain-a2-tls
  rules:
  - host: webmail.domain-a2.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: roundcube
            port:
              number: 80
```

2. **Roundcube configuration (domain-agnostic):**

Roundcube doesn't need per-domain configuration. The login page simply accepts any email address (regardless of domain). When a user logs in:

```
User enters: john@domain-a1.com
Password: (app password or OIDC token)

↓

Roundcube forwards auth request to Dovecot
Dovecot validates john@domain-a1.com against IMAP backend
↓ (if valid)
User logged in; Roundcube loads contacts, settings, etc.
```

**No special Roundcube config needed per domain** — authentication is domain-agnostic.

---

## Webmail Domain Auto-Generation

### Naming Convention

```
webmail.{customer_domain}
```

**Examples:**
- Customer with domain `example.com` → webmail domain is `webmail.example.com`
- Customer with domain `acme.co.uk` → webmail domain is `webmail.acme.co.uk`
- Customer with domain `mystore.shop` → webmail domain is `webmail.mystore.shop`

### Automatic Generation Workflow

**When customer creates a new domain:**

1. Admin/API creates domain (e.g., `example.com`) via `/api/v1/customers/{id}/domains`

2. Management API automatically:
   - [ ] Generates webmail domain name: `webmail.example.com`
   - [ ] Creates `cert-manager` Certificate resource (auto-provisions Let's Encrypt TLS)
   - [ ] Creates Kubernetes Ingress routing to Roundcube Service
   - [ ] Stores in database: `domains.webmail_domain = 'webmail.example.com'`
   - [ ] Sets `domains.webmail_enabled = true` (by default, unless plan disallows)

3. **Within ~30 seconds:**
   - Cert-manager provisions SSL certificate
   - Ingress becomes active
   - Users can access `https://webmail.example.com`

### Database Schema

**Table: `domain_webmail_config`**

```sql
CREATE TABLE domain_webmail_config (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  domain_id BIGINT NOT NULL,                -- FK: domains.id
  customer_id BIGINT NOT NULL,              -- FK: customers.id
  
  -- Webmail settings
  webmail_enabled BOOLEAN DEFAULT TRUE,     -- Can admin disable webmail for this domain?
  webmail_domain VARCHAR(255) NOT NULL,     -- e.g., "webmail.example.com"
  
  -- SSL certificate (cert-manager)
  cert_manager_secret_name VARCHAR(255),    -- K8s Secret with TLS cert+key
  certificate_issued_at TIMESTAMP,
  certificate_expires_at TIMESTAMP,
  certificate_status ENUM('pending', 'valid', 'expired', 'error') DEFAULT 'pending',
  
  -- Ingress
  k8s_ingress_name VARCHAR(255),            -- Name of Kubernetes Ingress resource
  k8s_ingress_uid VARCHAR(36),              -- UID from k8s API
  ingress_status ENUM('creating', 'active', 'deleting') DEFAULT 'creating',
  
  -- Customization
  user_theme VARCHAR(50) DEFAULT 'default', -- Default theme for users (overridable)
  user_language VARCHAR(10) DEFAULT 'en',   -- Default language (overridable)
  
  -- Usage tracking
  last_login TIMESTAMP NULL,
  unique_users_last_7d INT DEFAULT 0,       -- For admin dashboard
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_domain_id (domain_id),
  INDEX idx_customer_id (customer_id),
  INDEX idx_webmail_domain (webmail_domain),
  UNIQUE KEY uk_domain_webmail (domain_id),
  UNIQUE KEY uk_webmail_domain (webmail_domain)
);
```

---

## Authentication & Login

### Login Page

Users navigate to `https://webmail.domain.com` and see:

```
╔════════════════════════════════════╗
║                                    ║
║      Roundcube Webmail             ║
║      domain.com                    ║
║                                    ║
║  Email Address:  [________@domain] ║
║  Password:       [_______________] ║
║                                    ║
║  [ Remember me ]                   ║
║  [ Login with Google ]  (if OIDC)  ║
║  [ Login with Apple  ]  (if OIDC)  ║
║                                    ║
║  [  Sign In  ]                     ║
║                                    ║
║  Forgot password? Reset via admin  ║
║                                    ║
╚════════════════════════════════════╝
```

### Authentication Methods

#### Method 1: Application Password (Default)

```
User enters:
- Email: john@domain.com
- Password: xK9m2pL7vQ4nM8bR9sF2... (app password)

↓

Roundcube connects to Dovecot IMAP (dovecot.mail.svc.cluster.local:993)
Dovecot checks `email_app_passwords` table
If valid: User logged in
```

#### Method 2: OIDC Login (Optional, Per-Customer)

If customer enables OIDC (Google/Apple):

```
User clicks: [ Login with Google ]

↓

Redirects to Dex OIDC provider
User authenticates with Google
Dex returns: id_token with email claim

↓

Roundcube validates token against Dex
Extracts email: john@domain.com
Creates session (user doesn't enter password)
```

**Configuration per customer:**

| Setting | Value | Description |
|---------|-------|-------------|
| `email_oidc_enabled` | true/false | Enable OIDC login buttons? |
| `email_oidc_providers` | ['google', 'apple'] | Which providers to show |
| `email_oidc_domain_restriction` | 'domain.com' (optional) | Only allow OIDC users from this domain? |

### User Isolation (Critical Security)

**Roundcube must enforce:** User can only access their own email account.

This is enforced at **Dovecot IMAP level**, not Roundcube:

```
User logs in as: john@domain.com
Dovecot IMAP validates credentials
Dovecot allows: john@domain.com to access only the "john" mailbox

If user tries to access someone else's mailbox:
→ Dovecot denies (IMAP protocol prevents it)
→ Roundcube shows "permission denied"

User CANNOT access: 
- jane@domain.com mailbox (different user)
- anyone@different-domain.com (different domain)
```

**How Dovecot enforces this:**

```
IMAP LOGIN john@domain.com {password}

↓ Dovecot queries:
SELECT * FROM email_app_passwords 
WHERE email_address = 'john@domain.com' 
AND password_hash = bcrypt(provided_password)

If found:
→ Grant IMAP access to: user=john mailbox
→ Prevent access to any other mailbox

If not found:
→ IMAP LOGIN failed
```

---

## User Settings & Customization

### User-Configurable Settings

Each user can customize (per browser session):

| Setting | Options | Stored Where |
|---------|---------|--------------|
| **Language** | en, es, fr, de, it, pt, pl, ru, zh, ja, etc. | Roundcube DB (user preferences) |
| **Theme** | default, classic, larry, monochrome, etc. | Roundcube DB (user preferences) |
| **Time zone** | UTC, US/Eastern, Europe/London, etc. | Roundcube DB |
| **Date format** | MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD | Roundcube DB |
| **Editor mode** | HTML, Plain text | Roundcube DB |
| **Rows per page** | 10, 20, 50, 100 | Roundcube DB |
| **Display mode** | Wide, compact | Roundcube DB |

### Admin-Set Defaults

Admin can set default theme/language for a domain:

```sql
-- In domain_webmail_config table
user_theme = 'larry'         -- All new users see this theme
user_language = 'es'         -- All new users see this language
```

When user first logs in to that domain:
- Roundcube loads defaults (theme='larry', language='es')
- User can immediately override in preferences
- Settings persist in Roundcube database

### What Customers CANNOT Customize

❌ Branding/logo (platform-managed)
❌ Mail server settings (IMAP/SMTP hosts)
❌ Plugins (platform-managed)
❌ Features (all available features enabled by default)

---

## Customer Panel Features

### Email & Webmail Section

**Location:** Client Panel > Email > Webmail Access

#### Webmail Domains List

For customer with 3 domains:

```
💌 Webmail Access

Your customer has 3 email domains. Each domain has a branded webmail portal:

Domain                    Webmail URL                    Status      Action
────────────────────────────────────────────────────────────────────────
example.com               https://webmail.example.com    🟢 Active   Open
shop.example.com          https://webmail.shop.example   🟢 Active   Open
support.example.com       https://webmail.support        🟢 Active   Open

[+ Add Email Domain]
```

#### Webmail Login Links

Quick links to open webmail in new tab:

```
🔐 Quick Access to Your Webmail

[Open example.com Webmail]  [Open shop.example.com Webmail]  [Open support.example.com Webmail]
```

#### Email Account Management

List all email accounts for this domain:

```
example.com Email Accounts

Account Name          Full Email              Password          Last Login   Actions
──────────────────────────────────────────────────────────────────────────────
john                  john@example.com        [******* Rotate]  5 min ago    Delete
jane                  jane@example.com        [******* Rotate]  2h ago       Delete
admin                 admin@example.com       [******* Rotate]  1h ago       Delete
sales                 sales@example.com       [******* Rotate]  1d ago       Delete

[+ Create New Email Account]
```

#### Email Account Details

Click on "john" to see details:

```
Email Account: john@example.com

Access Methods:
├─ Webmail: https://webmail.example.com
│  └─ Login as: john@example.com
│  └─ Password: (app password or OIDC)
│
├─ IMAP/SMTP (Desktop/Mobile):
│  └─ Server: mail.platform.com
│  └─ IMAP port: 993 (TLS)
│  └─ SMTP port: 587 (STARTTLS)
│  └─ Username: john@example.com
│  └─ Password: (app password)
│
└─ OIDC Login:
   └─ Method: Google (if enabled)
   └─ Click "Login with Google" on webmail

App Passwords:
├─ iPhone Mail: [******* ] Last used 10 min ago
├─ Thunderbird:  [******* ] Last used 2h ago
└─ [+ Create New App Password]

Account Settings:
├─ Last login: 5 minutes ago
├─ Last password change: 2 months ago
├─ Storage used: 245 MB (of 2 GB quota)
├─ Forwarding: Disabled
└─ [Configure Additional Features]
```

#### Webmail Preferences

Link to webmail preferences page:

```
⚙️ Webmail Settings

[Manage Theme & Language Preferences]

Opens Roundcube at: https://webmail.example.com/?_task=settings

Within Roundcube, user can configure:
├─ Theme (default, classic, larry, monochrome)
├─ Language (50+ languages)
├─ Timezone
├─ Date/time format
├─ Editor mode (HTML vs plain text)
└─ Display preferences (rows per page, etc.)
```

---

## Admin Panel Features

### EC.2 Roundcube Webmail Configuration

**Location:** Admin Panel > Email > Webmail

#### Webmail Dashboard

```
📧 Roundcube Webmail Status

Overall Status: 🟢 Healthy
├─ Roundcube Pod: Running (1 pod, 1/1 ready)
├─ Database: Connected (roundcube DB)
├─ Webmail Domains: 127 (all active)
├─ Active Users: 34 (in last 5 minutes)
├─ Active Sessions: 89
└─ Avg Response Time: 245ms

Roundcube Version: 1.6.1
Last Updated: 2026-02-15
Plugins Enabled: 5 (standard set)
```

#### Webmail Domain Management

View/manage all webmail domains:

**Table: All Webmail Domains**

| Domain | Webmail URL | Certificate | Status | Users (7d) | Action |
|--------|------------|-------------|--------|-----------|--------|
| example.com | webmail.example.com | ✅ Valid (expires 2026-04-01) | 🟢 Active | 12 | Edit |
| acme.co.uk | webmail.acme.co.uk | ✅ Valid (expires 2026-05-15) | 🟢 Active | 34 | Edit |
| shop.co | webmail.shop.co | ⚠️ Expires in 14d | 🟢 Active | 5 | Edit |
| startup.io | webmail.startup.io | 🔄 Pending (cert-manager) | 🟡 Pending | 0 | Edit |
| failed.com | webmail.failed.com | ❌ Certificate error | 🔴 Down | 0 | Edit |

**Actions:**
- **Edit:** Open domain settings
- **View logs:** See access logs (Loki)
- **View users:** Active logins for this domain
- **Rotate certificate:** Force renewal
- **Disable webmail:** Customers can't access
- **Delete:** Remove webmail (if domain deleted)

#### Per-Domain Settings

Click "Edit" on a domain:

```
Edit Webmail Domain: example.com

Basic Info:
├─ Domain: example.com
├─ Webmail URL: webmail.example.com (read-only)
├─ Status: Active (🟢)
├─ Enabled for customers: Yes [✓] / No [ ]
└─ Date created: 2026-01-15

SSL Certificate:
├─ Provider: Let's Encrypt (via cert-manager)
├─ Status: Valid ✅
├─ Issued: 2025-11-01
├─ Expires: 2026-04-01 (in 89 days)
├─ Auto-renewal: Enabled
└─ [View Certificate Details] [Force Renewal]

User Defaults:
├─ Default Theme: [default ▼]
├─ Default Language: [en ▼]
└─ Allow OIDC login: Yes [✓] / No [ ]

Roundcube Configuration:
├─ Plugins enabled: [View list]
├─ Features enabled: [View list]
├─ Max attachment size: 25 MB
├─ Session timeout: 30 minutes
└─ [View Advanced Settings]

Access Stats (Last 7 days):
├─ Unique users: 12
├─ Total logins: 145
├─ Active sessions now: 3
├─ Avg session duration: 23 minutes
└─ [View detailed logs]

Actions:
[ Save Changes ] [ Disable Webmail ] [ View Logs ] [ Delete ]
```

#### Customer Webmail Toggle

Quick enable/disable webmail for a customer:

**Locate customer:**

```
Search: example.com
Results: 1 customer found

Customer: Example Corp
├─ Plan: Business
├─ Status: Active
├─ Domains: 3
├─ Email Accounts: 12
├─ Webmail Enabled: Yes [✓]
└─ [Disable Webmail for This Customer]
```

When disabled:

```
All webmail domains for this customer return:

╔════════════════════════════════╗
║  403 Forbidden                 ║
║                                ║
║  Webmail access is currently   ║
║  disabled for your account.    ║
║                                ║
║  Contact support for details.  ║
╚════════════════════════════════╝

(Admin can re-enable anytime)
```

#### Roundcube Configuration Management

Configure Roundcube defaults and features:

```
⚙️ Roundcube Global Settings

Roundcube Version: 1.6.1
Last Updated: 2026-02-15 (by admin)

Default User Settings:
├─ Default Language: en
├─ Default Theme: default
├─ Default Timezone: UTC
├─ Default Editor Mode: HTML
└─ Session Timeout: 30 minutes

Enabled Plugins:
├─ ✅ managesieve (sieve mail rules)
├─ ✅ password (change app password)
├─ ✅ identity_select (multiple identities)
├─ ✅ zipdownload (download messages as zip)
├─ ✅ archive (archive messages)

Disabled Plugins (not recommended to enable):
├─ calendar (requires CalDAV backend)
├─ carddav (requires CardDAV backend)
└─ enigma (PGP encryption - advanced)

Features:
├─ ✅ Contacts list
├─ ✅ Address book
├─ ✅ Message search
├─ ✅ IMAP flags
├─ ✅ Trash folder
├─ ✅ Spam reporting
├─ ✅ HTML email editing
└─ ✅ Attachment uploads

Resource Limits:
├─ Max attachment size: 25 MB
├─ Max message size (IMAP): 50 MB
├─ Max mailbox size: Unlimited (per quota)
├─ Max email addresses stored: 10,000 per user
└─ Max contact entries: 5,000 per user

Logging & Monitoring:
├─ Log level: INFO
├─ Logs sent to: Loki (mail.loki:3100)
├─ Metrics sent to: Prometheus
├─ Email template directory: [View]
└─ [View Recent Logs]

Actions:
[ Save Changes ] [ Reload Configuration ] [ Restart Roundcube Pod ]
```

#### Webmail Usage Statistics

Admin dashboard showing Roundcube usage:

```
📊 Webmail Usage Analytics

Last 7 Days:
├─ Total unique users: 487
├─ Total login events: 3,245
├─ Avg logins per user: 6.7
├─ Peak concurrent users: 45 (Tuesday 14:30)
├─ Avg session duration: 18 minutes
└─ Unique domains used: 127

By Plan:
├─ Starter: 45 active users (18%)
├─ Business: 289 active users (59%)
├─ Premium: 153 active users (31%)

Top Domains (by logins):
├─ webmail.example.com: 245 logins (8%)
├─ webmail.acme.co.uk: 187 logins (6%)
├─ webmail.shop.io: 156 logins (5%)
├─ ... (others)

Issues (Last 7 Days):
├─ Failed logins: 34 (0.1% of total)
├─ Expired sessions: 12
├─ Browser errors: 5
├─ IMAP connection timeouts: 2

[View Detailed Report] [Export CSV] [View Charts]
```

#### Webmail Sessions & Active Users

View currently logged-in users:

```
🟢 Active Webmail Sessions (Real-Time)

Total Active: 34 users, 45 sessions
Avg Response Time: 245ms

User                    Domain                Last Activity   Session Age  Action
────────────────────────────────────────────────────────────────────────────
john@example.com        webmail.example.com   10 seconds ago  23 minutes   Kick
jane@acme.co.uk         webmail.acme.co.uk    2 minutes ago   45 minutes   Kick
admin@shop.io           webmail.shop.io       Just now        5 minutes    Kick
support@startup.io      webmail.startup.io    5 minutes ago   1h 22m       Kick
...

Filter by: Domain, Customer, Time logged in

[Refresh] [Kick All Sessions] [Export List]
```

**"Kick" button:** Invalidates session; user redirected to login page on next page load

---

## API Endpoints

### Customer-Facing Endpoints

#### GET `/api/v1/customers/{customer_id}/webmail-domains`

List all webmail domains for a customer.

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/webmail-domains" \
  -H "Authorization: Bearer {token}"
```

**Response:**

```json
{
  "data": [
    {
      "id": "webmail_abc123",
      "domain_id": "domain_001",
      "domain_name": "example.com",
      "webmail_domain": "webmail.example.com",
      "webmail_url": "https://webmail.example.com",
      "webmail_enabled": true,
      "certificate_status": "valid",
      "certificate_expires_at": "2026-04-01T00:00:00Z",
      "user_theme": "default",
      "user_language": "en",
      "unique_users_last_7d": 12,
      "last_login": "2026-03-01T14:32:00Z",
      "created_at": "2026-01-15T10:30:00Z"
    }
  ]
}
```

#### GET `/api/v1/customers/{customer_id}/webmail-domains/{domain_id}`

Get details of one webmail domain.

**Response:** Same as above (single object)

#### GET `/api/v1/customers/{customer_id}/email-accounts`

List all email accounts for a customer.

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/email-accounts" \
  -H "Authorization: Bearer {token}"
```

**Response:**

```json
{
  "data": [
    {
      "id": "email_001",
      "customer_id": 123,
      "domain_id": "domain_001",
      "email_address": "john@example.com",
      "full_name": "John Doe",
      "storage_used_mb": 245,
      "storage_quota_mb": 2048,
      "last_login": "2026-03-01T14:32:00Z",
      "last_login_method": "webmail",
      "webmail_url": "https://webmail.example.com",
      "status": "active",
      "created_at": "2026-01-15T10:30:00Z"
    }
  ]
}
```

#### POST `/api/v1/customers/{customer_id}/email-accounts`

Create a new email account.

**Request:**

```json
{
  "domain_id": "domain_001",
  "email_local_part": "john",
  "full_name": "John Doe",
  "storage_quota_mb": 2048
}
```

**Response:** `201 Created` + account object

#### PATCH `/api/v1/customers/{customer_id}/email-accounts/{account_id}`

Update email account details.

**Request:**

```json
{
  "full_name": "John Doe",
  "storage_quota_mb": 5120,
  "forwarding_enabled": true,
  "forwarding_addresses": ["backup@other-domain.com"]
}
```

#### DELETE `/api/v1/customers/{customer_id}/email-accounts/{account_id}`

Delete email account (and all data).

---

### Admin-Facing Endpoints

#### GET `/api/v1/admin/webmail-domains`

List all webmail domains (all customers).

**Query Parameters:**
- `customer_id` (optional) — Filter by customer
- `status` (optional) — Filter by certificate status (valid, expired, error, pending)
- `limit` (optional) — Items per page

**Response:** Same structure as customer endpoint, but includes `customer_id`

#### GET `/api/v1/admin/webmail-domains/{domain_id}`

Get details including certificate, usage stats, active sessions.

#### PATCH `/api/v1/admin/webmail-domains/{domain_id}`

Update webmail domain settings.

**Request:**

```json
{
  "webmail_enabled": false,
  "user_theme": "larry",
  "user_language": "es"
}
```

#### POST `/api/v1/admin/webmail-domains/{domain_id}/disable`

Disable webmail for a domain (users see 403).

#### POST `/api/v1/admin/webmail-domains/{domain_id}/enable`

Re-enable webmail for a domain.

#### GET `/api/v1/admin/webmail/sessions`

List active webmail sessions (real-time).

**Query Parameters:**
- `domain_id` (optional)
- `customer_id` (optional)

**Response:**

```json
{
  "data": [
    {
      "session_id": "sess_abc123",
      "email_address": "john@example.com",
      "domain": "webmail.example.com",
      "logged_in_at": "2026-03-01T14:10:00Z",
      "last_activity": "2026-03-01T14:32:00Z",
      "user_agent": "Mozilla/5.0..."
    }
  ]
}
```

#### POST `/api/v1/admin/webmail/sessions/{session_id}/kick`

Invalidate a session (user kicked out on next page load).

#### POST `/api/v1/admin/webmail/sessions/kick-all`

Invalidate all sessions (emergency brake).

**Request:**

```json
{
  "customer_id": 123,
  "reason": "Account compromised; forcing password reset"
}
```

#### GET `/api/v1/admin/webmail/usage-stats`

Get usage statistics for webmail.

**Query Parameters:**
- `days` (optional, default 7) — Last N days
- `customer_id` (optional) — Filter by customer

**Response:**

```json
{
  "data": {
    "total_unique_users": 487,
    "total_login_events": 3245,
    "avg_logins_per_user": 6.7,
    "peak_concurrent_users": 45,
    "avg_session_duration_minutes": 18,
    "unique_domains": 127,
    "by_plan": {
      "starter": 45,
      "business": 289,
      "premium": 153
    },
    "failed_logins": 34,
    "expired_sessions": 12
  }
}
```

---

## Database Schema

### Main Table: `domain_webmail_config`

(See Architecture section for full schema)

### Supporting Tables

#### `webmail_sessions` (Roundcube sessions)

```sql
CREATE TABLE webmail_sessions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  email_address VARCHAR(255) NOT NULL,
  webmail_domain VARCHAR(255) NOT NULL,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  
  logged_in_at TIMESTAMP,
  last_activity TIMESTAMP,
  expires_at TIMESTAMP,
  
  ip_address VARCHAR(45),
  user_agent TEXT,
  
  INDEX idx_email_address (email_address),
  INDEX idx_webmail_domain (webmail_domain),
  INDEX idx_expires_at (expires_at)
);
```

#### `webmail_usage_daily` (For reporting)

```sql
CREATE TABLE webmail_usage_daily (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  date_utc DATE NOT NULL,
  webmail_domain VARCHAR(255),
  
  unique_users INT,
  total_logins INT,
  failed_logins INT,
  avg_session_duration_seconds INT,
  peak_concurrent_users INT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE KEY uk_date_domain (date_utc, webmail_domain)
);
```

---

## SSL Certificate Management

### Automatic Certificate Provisioning

When a new domain is created:

1. **API creates Certificate resource:**

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webmail-example-com
  namespace: mail
spec:
  secretName: webmail-example-com-tls
  commonName: webmail.example.com
  dnsNames:
  - webmail.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

2. **cert-manager automation:**
   - Validates domain ownership via ACME DNS challenge
   - Provisions certificate from Let's Encrypt
   - Stores in Kubernetes Secret: `webmail-example-com-tls`
   - Auto-renews 30 days before expiration

3. **Ingress references certificate:**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webmail-example-com
spec:
  tls:
  - hosts:
    - webmail.example.com
    secretName: webmail-example-com-tls  # ← From cert-manager
```

### Certificate Status Monitoring

**Admin can view:**
- ✅ Valid (expires in X days)
- ⚠️ Expiring soon (< 30 days)
- ❌ Expired
- 🔄 Pending (cert-manager working)
- 🔴 Error (ACME failed)

**Alerts:**
- Admin notified 30 days before expiration
- Auto-renewal scheduled 30 days before expiration
- If renewal fails: Critical alert to admin

### Manual Certificate Rotation

Admin can manually trigger renewal:

```bash
# Via API
POST /api/v1/admin/webmail-domains/{domain_id}/rotate-certificate

# Via kubectl (for emergency)
kubectl delete certificate webmail-example-com -n mail
# cert-manager recreates it immediately
```

---

## Plan-Based Features

| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| **Webmail enabled** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Custom webmail domain** | ❌ No (platform default only) | ✅ Yes (one per domain) | ✅ Yes (unlimited) |
| **Email accounts** | 1 | 5 | Unlimited |
| **Storage per account** | 512 MB | 2 GB | 5 GB |
| **OIDC login** | ❌ No | ✅ Yes (optional) | ✅ Yes (enabled by default) |
| **App passwords** | 1 | 5 | Unlimited |
| **Roundcube plugins** | Standard set | Standard set | Standard set (configurable) |
| **Webmail customization** | Theme/language only | Theme/language only | Theme/language only |

---

## Security Considerations

### Email Account Isolation

✅ **User can only access their own account**
- Enforced at Dovecot IMAP level
- Roundcube cannot override IMAP permissions
- Each login creates isolated IMAP session

### SSL/TLS Transport

✅ **All webmail traffic encrypted:**
- HTTPS only (TLS 1.2+)
- Let's Encrypt certificates (trusted CAs)
- HSTS headers enabled (prevent downgrade attacks)

### Session Security

✅ **Roundcube session hardening:**
- Session timeout: 30 minutes of inactivity
- Secure cookies (HttpOnly, Secure flags set)
- Session validation: IP address + User-Agent matching
- CSRF tokens on all forms

### Password Security

✅ **App passwords (not user passwords):**
- High-entropy (32-char random, base62)
- Bcrypt hashing at rest
- Can be revoked instantly
- Full audit trail of creation/rotation/deletion

### OIDC Login Security

✅ **Token validation:**
- Validate token signature against Dex public key
- Verify token expiration (short-lived: 1 hour)
- Validate email claim
- Store minimal claims (email only)

---

## Troubleshooting Guide

### Certificate Issues

**Problem:** "SSL certificate error" or "Not trusted"

**Solution:**
1. Check certificate status: `GET /api/v1/admin/webmail-domains/{id}`
2. If `status='error'`: cert-manager failed to provision
3. Check cert-manager logs: `kubectl logs -n cert-manager -l app=cert-manager`
4. Common cause: DNS not pointing to platform yet
5. Manual fix: `kubectl describe certificate webmail-{domain}-tls -n mail`

### Login Issues

**Problem:** User cannot log in (403 Forbidden)

**Solution:**
1. Check if webmail disabled for customer: `webmail_enabled = false`
2. Check if email account exists: `GET /api/v1/customers/{id}/email-accounts`
3. Check if password correct (reset via admin if needed)
4. Check Roundcube logs: `kubectl logs -l app=roundcube -n mail`

### Performance Issues

**Problem:** Webmail slow (>5s response time)

**Solution:**
1. Check Roundcube pod resources: `kubectl describe pod -l app=roundcube -n mail`
2. Check IMAP backend latency: `kubectl logs -l app=dovecot -n mail | grep latency`
3. Check database: Is Roundcube database slow?
4. Consider: Horizontal pod autoscaling if many concurrent users

### Session Expiration

**Problem:** User logged out unexpectedly

**Solution:**
1. Default timeout: 30 minutes of inactivity
2. User can extend by clicking anywhere
3. If forcibly logged out: Admin may have kicked session
4. Check admin logs: `GET /api/v1/admin/webmail/sessions`

---

## Implementation Checklist

- [ ] **Database Setup**
  - [ ] Create `domain_webmail_config` table
  - [ ] Create `webmail_sessions` table
  - [ ] Create `webmail_usage_daily` table
  - [ ] Add indexes and foreign keys

- [ ] **Kubernetes/Cert-Manager**
  - [ ] Configure cert-manager ClusterIssuer for Let's Encrypt
  - [ ] Test certificate provisioning (manual Certificate)
  - [ ] Set up automatic renewal
  - [ ] Configure ACME DNS challenges

- [ ] **Roundcube Configuration**
  - [ ] Deploy Roundcube pod (single instance)
  - [ ] Configure Roundcube `config.inc.php`:
    - IMAP backend (Dovecot)
    - SMTP backend (Postfix)
    - Session DB
    - Plugins (managesieve, password, identity_select, zipdownload, archive)
  - [ ] Set up OIDC integration (optional)
  - [ ] Disable customer branding customization

- [ ] **Ingress & Networking**
  - [ ] Create Ingress controller for webmail
  - [ ] Test routing to Roundcube Service
  - [ ] Verify certificate integration
  - [ ] Test from multiple domains simultaneously

- [ ] **Management API Integration**
  - [ ] Add webmail domain auto-generation logic to domain creation endpoint
  - [ ] Add 8 customer-facing API endpoints
  - [ ] Add 6 admin-facing API endpoints
  - [ ] Test plan-based feature restrictions

- [ ] **Customer Panel**
  - [ ] Webmail domains list view
  - [ ] Quick links to open webmail
  - [ ] Email account management
  - [ ] App password management
  - [ ] Webmail preferences link

- [ ] **Admin Panel**
  - [ ] Webmail dashboard
  - [ ] Webmail domain management table
  - [ ] Per-domain settings editor
  - [ ] Enable/disable toggle per customer
  - [ ] Usage statistics dashboard
  - [ ] Active sessions viewer
  - [ ] Kick session button

- [ ] **Monitoring & Alerts**
  - [ ] Certificate expiration alerts (30d, 7d, 1d before expiry)
  - [ ] Roundcube health checks (pod up, IMAP connectivity)
  - [ ] Usage metrics (Prometheus)
  - [ ] Session timeout metrics
  - [ ] OIDC authentication metrics

- [ ] **Testing**
  - [ ] Unit tests (domain generation logic, plan restrictions)
  - [ ] Integration tests (domain creation → ingress → cert-manager → webmail)
  - [ ] Security tests (user isolation, session validation, CSRF protection)
  - [ ] Load tests (1000+ concurrent webmail users)
  - [ ] Certificate renewal tests
  - [ ] OIDC login tests (Google, Apple)

- [ ] **Documentation**
  - [ ] Customer guide: How to access webmail, reset password, configure email client
  - [ ] Admin guide: Webmail management, troubleshooting, certificate renewal
  - [ ] API reference: All webmail endpoints
  - [ ] Roundcube configuration documentation

---

## Admin Email Access & Staff Role Management

### Overview

Admins and staff members can temporarily log into customer email accounts from the control panel for support, troubleshooting, or verification purposes. Access is controlled by **customizable staff roles** with fine-grained permissions (read-only vs full access), **customer/region-based access restrictions**, and **configurable action approval requirements**. All access is **fully logged with detailed audit trail** including IP address, browser, and every action taken.

**Key Design:**
- ✅ Fully customizable staff roles (not preset hierarchies)
- ✅ Coarse permission control (read-only vs full access per role)
- ✅ Customer access by tag/group (e.g., 'Enterprise', 'SMB', regions)
- ✅ Configurable action approval (some actions require supervisor sign-off)
- ✅ 24/7 access (no time-based restrictions)
- ✅ Detailed audit logging (every action tracked)
- ✅ Role management UI (admin can create/edit/delete roles)

**Key Design:**
- ✅ Role-based access control (support staff read-only, senior admins full access)
- ✅ Direct auto-login from admin panel (one-click access)
- ✅ Separate isolated session (marked as admin access, not customer)
- ✅ Detailed audit logging (every action tracked)
- ✅ No customer notification (silent access for support)
- ✅ Time-limited sessions (30-60 min timeout)
- ✅ Session encryption and secure token handling

---

## Staff Role Management System

### Overview

Instead of fixed admin roles, the platform supports **fully customizable staff roles** where admins define:
- **Permission level** (read-only vs full access)
- **Customer scope** (which customer groups/regions can access)
- **Action approval** (which actions require supervisor approval)
- **Staff members** assigned to each role

### Staff Role Hierarchy Examples

The system does NOT enforce a hierarchy - these are just examples:

**Small Team Setup:**
```
Support Team (3 people)
├─ Role: Support Staff
│  ├─ Permission: read-only
│  ├─ Customers: All (tag: "support-accessible")
│  ├─ Approval: delete emails requires supervisor
│  └─ Members: Alice, Bob, Carol
│
└─ Role: Team Lead
   ├─ Permission: full
   ├─ Customers: All
   ├─ Approval: None required
   └─ Members: Dave (Team Lead)
```

**Enterprise Setup (Multi-Region):**
```
Support Roles (Multi-Region)
├─ Role: US Support Tier 1
│  ├─ Permission: read-only
│  ├─ Customers: Region = "US" AND (tag = "support" OR tag = "enterprise")
│  ├─ Approval: delete, send require supervisor
│  └─ Members: 12 people
│
├─ Role: US Support Tier 2
│  ├─ Permission: full
│  ├─ Customers: Region = "US"
│  ├─ Approval: delete requires supervisor
│  └─ Members: 4 people
│
├─ Role: EU Support Tier 1
│  ├─ Permission: read-only
│  ├─ Customers: Region = "EU" AND (tag = "support" OR tag = "enterprise")
│  ├─ Approval: delete, send require supervisor
│  └─ Members: 10 people
│
└─ Role: Billing Support
   ├─ Permission: read-only
   ├─ Customers: All (tag: "has-billing-issues")
   ├─ Approval: Cannot send or delete
   └─ Members: 3 people
```

**Specialist Setup:**
```
Support Roles (By Customer Type)
├─ Role: Enterprise Customer Success
│  ├─ Permission: full
│  ├─ Customers: tag = "enterprise"
│  ├─ Approval: send emails to customers must be pre-approved
│  └─ Members: 8 people
│
├─ Role: SMB Support
│  ├─ Permission: read-only
│  ├─ Customers: tag = "smb"
│  ├─ Approval: delete requires supervisor
│  └─ Members: 15 people
│
└─ Role: Premium Support (All Access)
   ├─ Permission: full
   ├─ Customers: All
   ├─ Approval: None required
   └─ Members: 2 people
```

---

### Staff Role Definition

#### Database: `staff_roles` Table

```sql
CREATE TABLE staff_roles (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- Role info
  role_name VARCHAR(255) NOT NULL,        -- e.g., "Support Staff", "Team Lead"
  description TEXT,                       -- e.g., "Tier 1 support for SMB customers"
  
  -- Permission level
  permission_level ENUM('read-only', 'full') NOT NULL,
  -- read-only: Can read emails, search, view contacts
  -- full: Can read, compose, send, delete, move, modify contacts
  
  -- Customer access scope
  customer_scope_type ENUM('all', 'tags', 'region', 'tags_and_region') NOT NULL,
  customer_scope_tags JSON,               -- e.g., ["support", "enterprise"]
  customer_scope_regions JSON,            -- e.g., ["US", "EU", "APAC"]
  
  -- Metadata
  created_by_admin_id BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  deleted_at TIMESTAMP NULL,              -- Soft delete
  
  INDEX idx_role_name (role_name),
  INDEX idx_is_active (is_active)
);
```

#### Database: `staff_role_actions` Table

Configurable permissions for sensitive actions per role.

```sql
CREATE TABLE staff_role_actions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  staff_role_id BIGINT NOT NULL,          -- FK: staff_roles.id
  
  -- Action configuration
  action_type ENUM(
    'email_read',
    'email_search',
    'email_compose',
    'email_send',
    'email_delete',
    'email_move',
    'attachment_view',
    'attachment_download',
    'contact_view',
    'contact_modify',
    'account_settings_view'
  ) NOT NULL,
  
  -- Permission for this action
  is_allowed BOOLEAN DEFAULT TRUE,        -- Can staff member perform this?
  requires_approval BOOLEAN DEFAULT FALSE, -- Does it need supervisor approval?
  approval_role_id BIGINT,                -- Which role can approve? (FK: staff_roles.id)
  
  INDEX idx_staff_role_id (staff_role_id),
  INDEX idx_action_type (action_type),
  UNIQUE KEY uk_role_action (staff_role_id, action_type)
);
```

#### Database: `staff_members` Table

Individual staff assignments and settings.

```sql
CREATE TABLE staff_members (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- Staff info
  user_id BIGINT NOT NULL,                -- FK: admin users/dex users
  user_email VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  
  -- Role assignment
  staff_role_id BIGINT NOT NULL,          -- FK: staff_roles.id
  
  -- Override customer scope (if different from role)
  customer_scope_override_type ENUM('inherit', 'all', 'tags', 'region', 'tags_and_region') DEFAULT 'inherit',
  customer_scope_override_tags JSON,      -- Overrides role if set
  customer_scope_override_regions JSON,   -- Overrides role if set
  
  -- Override action permissions (if different from role)
  action_overrides JSON,                  -- e.g., {"email_send": false, "email_delete_requires_approval": true}
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  last_login TIMESTAMP,
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_user_id (user_id),
  INDEX idx_staff_role_id (staff_role_id),
  INDEX idx_is_active (is_active),
  UNIQUE KEY uk_user_id (user_id)
);
```

---

### Permission Matrix: Read-Only vs Full Access

#### Read-Only Permission

```
Staff member can:
├─ View emails
├─ Search emails
├─ Browse folders
├─ View contacts
├─ View account settings (read-only)
├─ Download attachments
└─ View email addresses, recipients, subjects

Staff member CANNOT:
├─ Compose emails
├─ Send emails
├─ Delete emails
├─ Move emails
├─ Modify contacts
├─ Change account settings
└─ Modify any customer data
```

#### Full Access Permission

```
Staff member can:
├─ View emails
├─ Search emails
├─ Compose emails
├─ Send emails (if not approval-required)
├─ Delete emails (if not approval-required)
├─ Move/organize emails
├─ Modify contacts
├─ View attachments
├─ Download attachments
└─ View account settings

Configurable actions (per role):
├─ email_send: Allowed? Requires approval?
├─ email_delete: Allowed? Requires approval?
└─ contact_modify: Allowed? Requires approval?
```

---

### Customer Access Restrictions

Staff can only access email accounts for customers matching their scope:

#### By Customer Tag

```
Support Staff role has:
  customer_scope_tags = ["support", "enterprise"]

Staff member can access email for:
├─ Example Corp (tag: "enterprise") ✅
├─ Acme Inc (tag: "support") ✅
├─ TechStart (tag: "premium") ❌ (no access)
└─ SmallBiz (no tags) ❌ (no access)
```

#### By Customer Region

```
US Support Tier 1 role has:
  customer_scope_regions = ["US"]

Staff member can access email for:
├─ US-based Example Corp ✅
├─ US-based Acme Inc ✅
└─ UK-based TechStart ❌ (different region)
```

#### By Tags AND Region Combined

```
Enterprise EU Support role has:
  customer_scope_type = "tags_and_region"
  customer_scope_tags = ["enterprise"]
  customer_scope_regions = ["EU"]

Staff member can access email for:
├─ Enterprise Corp (tag: "enterprise", region: "EU") ✅
└─ Enterprise Corp (tag: "enterprise", region: "US") ❌ (wrong region)
```

#### Per-Staff Overrides

Individual staff can have custom restrictions:

```
Alice is assigned to: "Support Staff" role
  Role scope: tags = ["support", "enterprise"]

But admin overrides for Alice:
  customer_scope_override_tags = ["support"]  # Can only access "support" tagged customers

Alice can access:
├─ Example Corp (tag: "support") ✅
└─ Enterprise Inc (tag: "enterprise") ❌ (Alice's override excludes this)
```

---

### Action Approval Requirements

Admin can configure which actions require supervisor approval:

#### Example Role: "Support Staff"

```json
{
  "role_name": "Support Staff",
  "permission_level": "full",
  "actions": {
    "email_read": {
      "is_allowed": true,
      "requires_approval": false
    },
    "email_compose": {
      "is_allowed": true,
      "requires_approval": false
    },
    "email_send": {
      "is_allowed": true,
      "requires_approval": true,  // ← Requires approval!
      "approval_role_id": 2        // Only "Team Lead" role can approve
    },
    "email_delete": {
      "is_allowed": true,
      "requires_approval": true,  // ← Requires approval!
      "approval_role_id": 2
    },
    "contact_modify": {
      "is_allowed": false,         // Not allowed at all
      "requires_approval": false
    }
  }
}
```

#### Approval Workflow

When Support Staff tries to send email:

```
Support Staff clicks: [Send]

↓

API checks action permissions:
├─ email_send.is_allowed = true ✅
├─ email_send.requires_approval = true ✅
└─ Needs: Team Lead approval

↓

System redirects to approval dialog:
┌─────────────────────────────────────────────────┐
│ Pending Approval                                 │
│                                                 │
│ This action requires supervisor approval.       │
│                                                 │
│ Action: Send email to boss@company.com          │
│ Subject: RE: Project Update                     │
│                                                 │
│ [Email preview shown]                           │
│                                                 │
│ Status: Pending approval from Team Lead         │
│ [View approval status] [Cancel]                 │
└─────────────────────────────────────────────────┘

↓

Team Lead receives notification:
"Support Staff Alice requested approval to send email 
in john@example.com at 14:32 UTC"

↓

Team Lead reviews + approves:

POST /api/v1/admin/staff/approval/{request_id}/approve

↓

Email sent + action logged:
├─ Requestor: Alice (Support Staff)
├─ Approver: Dave (Team Lead)
├─ Action: email_send
├─ Timestamp: 14:35 UTC
└─ Status: approved
```

---

### Database: `staff_action_approvals` Table

Track approval requests and decisions.

```sql
CREATE TABLE staff_action_approvals (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- Request details
  staff_member_id BIGINT NOT NULL,        -- FK: staff_members.id
  admin_email_session_id BIGINT,          -- FK: admin_email_access_sessions.id
  
  -- Action being approved
  action_type VARCHAR(50) NOT NULL,       -- "email_send", "email_delete", etc.
  action_details JSON,                    -- e.g., {"to": "boss@...", "subject": "..."}
  
  -- Approval status
  status ENUM('pending', 'approved', 'rejected', 'expired') DEFAULT 'pending',
  requested_at TIMESTAMP NOT NULL,
  
  -- Approver info
  approver_role_id BIGINT,                -- FK: staff_roles.id (which role can approve?)
  approved_by_admin_id BIGINT,            -- FK: admin (who approved?)
  approved_at TIMESTAMP NULL,
  approval_reason TEXT,                   -- Why approved/rejected?
  
  -- Timeout
  expires_at TIMESTAMP,                   -- Request expires if not approved within time
  
  INDEX idx_staff_member_id (staff_member_id),
  INDEX idx_status (status),
  INDEX idx_requested_at (requested_at)
);
```

---

### Admin Panel: Staff Role Management

#### Staff Roles Dashboard

**Location:** Admin Panel > Staff & Roles > Staff Roles

```
📋 Staff Roles Management

[+ Create New Role]

Active Roles:
┌───────────────────────────────────────────────────────────────┐
│ Role Name                  Permission  Customers    Members    │
├───────────────────────────────────────────────────────────────┤
│ Support Staff              read-only   support, ent  12 people │ [Edit] [Delete]
│ Team Lead                  full        all           1 person  │ [Edit] [Delete]
│ US Support Tier 1          read-only   US region     8 people  │ [Edit] [Delete]
│ US Support Tier 2          full        US region     4 people  │ [Edit] [Delete]
│ EU Support Tier 1          read-only   EU region     10 people │ [Edit] [Delete]
│ Billing Support            read-only   billing tag   3 people  │ [Edit] [Delete]
└───────────────────────────────────────────────────────────────┘

Inactive Roles (Archived):
├─ Legacy Support Role (archived 2025-12-15)
└─ Temporary Contractor Role (archived 2025-11-01)
```

#### Create/Edit Role Dialog

```
Create New Staff Role

Role Name: [Support Staff       ]
Description: [Tier 1 support for SMB customers]

Permission Level:
◉ Read-Only (can view, search emails only)
○ Full Access (can read, send, delete emails)

Customer Access:
Select which customers this role can access:

◉ All Customers
○ Specific Tags:
   [✓] support   [✓] enterprise   [ ] premium   [ ] billing
   [+ Add Tag]

○ By Region:
   [✓] US   [✓] EU   [ ] APAC   [ ] Other
   [+ Add Region]

○ Tags AND Region:
   [✓] support, enterprise
   [✓] US, EU regions

Action Permissions:
┌──────────────────────────────────────────────────────┐
│ Action                Required Approval?             │
├──────────────────────────────────────────────────────┤
│ Email: Read           [ ] No approval needed         │
│ Email: Compose        [ ] No approval needed         │
│ Email: Send           [✓] Requires approval from:    │
│                           [Team Lead ▼]              │
│ Email: Delete         [✓] Requires approval from:    │
│                           [Team Lead ▼]              │
│ Attachment: Download  [ ] No approval needed         │
│ Contact: Modify       [✓] Requires approval from:    │
│                           [Senior ▼]                 │
└──────────────────────────────────────────────────────┘

[ Cancel ] [ Save Role ]
```

#### Staff Members Assignment

**Location:** Admin Panel > Staff & Roles > Staff Members

```
👥 Staff Members

[+ Add Staff Member]

Active Staff:
┌─────────────────────────────────────────────────────────┐
│ Name           Email                Role              │
├─────────────────────────────────────────────────────────┤
│ Alice Smith    alice@company.com    Support Staff     │ [Edit] [Revoke]
│ Bob Johnson    bob@company.com      Support Staff     │ [Edit] [Revoke]
│ Carol Davis    carol@company.com    Support Staff     │ [Edit] [Revoke]
│ Dave Miller    dave@company.com     Team Lead         │ [Edit] [Revoke]
│ Eve Wilson     eve@company.com      US Support T2     │ [Edit] [Revoke]
│ Frank Brown    frank@company.com    EU Support T1     │ [Edit] [Revoke]
└─────────────────────────────────────────────────────────┘
```

#### Edit Staff Member

```
Edit Staff Member: Alice Smith

Basic Info:
├─ Name: Alice Smith
├─ Email: alice@company.com
└─ User ID: 789

Role Assignment:
├─ Current Role: Support Staff
│  └─ [Change Role ▼]
│
├─ Permission: read-only
├─ Can Access Customers: support, enterprise tags

Custom Overrides (optional):
──────────────────────────────────────

[ ] Override customer scope for Alice:
    Choose which customers Alice can access:
    
    ◉ Inherit from role (support, enterprise tags)
    ○ Custom - limit to: [     ] [+]
       • support tag only
    
[ ] Override action permissions for Alice:
    
    Current: email_send (requires Team Lead approval)
    
    ☑ email_send
    ○ No approval      ◉ Requires Team Lead approval   ○ Not allowed
    
    ☑ email_delete
    ◉ No approval      ○ Requires Team Lead approval   ○ Not allowed
    
    ☑ contact_modify
    ○ No approval      ◉ Requires Team Lead approval   ○ Not allowed

Status:
├─ Active: [✓] Yes / [ ] No
├─ Last Login: 2026-03-01 14:32 UTC
└─ Sessions: 3 active

[ Cancel ] [ Save ]
```

---

### Staff Access Workflow

#### Step 1: Staff Initiates Access

```
Support Staff (Alice) opens Customer Details page
Sees: john@example.com email account

Checks:
├─ Alice's role: Support Staff
├─ Permission: read-only
├─ Customers: support, enterprise tags
├─ Customer John: enterprise tag ✅ (allowed)

Click: [Access Email as Staff]
```

#### Step 2: Generate Token & Log In

```
API validates:
├─ Alice in Support Staff role? ✅
├─ Support Staff can access Enterprise customers? ✅
├─ John's customer = enterprise tag? ✅
└─ Permission: read-only ✅

↓

Token generated:
├─ expires_at: 60 min from now
├─ permission_level: read-only
├─ staff_member_id: Alice's ID
├─ ip_address: Alice's IP
└─ user_agent: Alice's browser

↓

Alice redirected to webmail with token
```

#### Step 3: Webmail Session Marked as Staff Access

```
╔═══════════════════════════════════════════════════════╗
║  🔒 STAFF ACCESS SESSION                              ║
║                                                       ║
║  Accessing: john@example.com                          ║
║  Staff: Alice Smith (Support Staff)                   ║
║  Permission: Read-Only                                ║
║  Session expires: 15:32 UTC (expires in 58 min)       ║
║                                                       ║
║  ⚠️ You have LIMITED access to this email             ║
║     You can view & search, but cannot send/delete     ║
║                                                       ║
║  [View Your Staff Log] [End Session]                  ║
╚═══════════════════════════════════════════════════════╝
```

#### Step 4: Action Taken (with Approval Check)

**Example 1: Alice tries to delete email (approval required)**

```
Alice clicks [Delete Email]

↓

API checks:
├─ Alice's role: Support Staff ✅
├─ email_delete.is_allowed: true ✅
├─ email_delete.requires_approval: true ✅
└─ approval_role_id: Team Lead

↓

Dialog shown:
┌──────────────────────────────────────────────────────┐
│ Approval Required                                    │
│                                                      │
│ Action: Delete email from John Doe                   │
│ Subject: "RE: Project Status"                        │
│ Reason (optional): [_________ old message ____]     │
│                                                      │
│ This action requires Team Lead approval.             │
│                                                      │
│ [ Cancel ]  [ Request Approval ]                     │
└──────────────────────────────────────────────────────┘

↓

Approval request created (pending)
Team Lead notified
Alice shown: "Approval pending - Dave Miller will review"
```

**Example 2: Alice tries to send email (approval not required in this role)**

```
Alice clicks [Send Email]

↓

API checks:
├─ Alice's role: Support Staff ✅
├─ email_send.is_allowed: true ✅
├─ email_send.requires_approval: false ✅
└─ Send allowed!

↓

Email sent immediately (no approval needed)
Action logged: email_send by Alice
```

---

### API Endpoints: Staff Role Management

#### Create Staff Role

**POST `/api/v1/admin/staff/roles`**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/staff/roles" \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "role_name": "Support Staff",
    "description": "Tier 1 support for SMB customers",
    "permission_level": "read-only",
    "customer_scope_type": "tags",
    "customer_scope_tags": ["support", "enterprise"],
    "actions": {
      "email_read": {"is_allowed": true, "requires_approval": false},
      "email_compose": {"is_allowed": false, "requires_approval": false},
      "email_send": {"is_allowed": false, "requires_approval": false},
      "email_delete": {"is_allowed": true, "requires_approval": true, "approval_role_id": 2}
    }
  }'
```

**Response (201 Created):**

```json
{
  "data": {
    "role_id": "sr_123",
    "role_name": "Support Staff",
    "permission_level": "read-only",
    "customer_scope_type": "tags",
    "customer_scope_tags": ["support", "enterprise"],
    "member_count": 0,
    "created_at": "2026-03-01T10:30:00Z"
  }
}
```

---

#### Get Staff Role Permissions

**GET `/api/v1/admin/staff/roles/{role_id}`**

```json
{
  "data": {
    "role_id": "sr_123",
    "role_name": "Support Staff",
    "description": "Tier 1 support",
    "permission_level": "read-only",
    "customer_scope": {
      "type": "tags",
      "tags": ["support", "enterprise"],
      "regions": null
    },
    "actions": {
      "email_read": {
        "is_allowed": true,
        "requires_approval": false
      },
      "email_send": {
        "is_allowed": true,
        "requires_approval": true,
        "approval_role_id": 2,
        "approval_role_name": "Team Lead"
      },
      "email_delete": {
        "is_allowed": true,
        "requires_approval": true,
        "approval_role_id": 2,
        "approval_role_name": "Team Lead"
      }
    },
    "members": 12,
    "created_at": "2026-03-01T10:30:00Z"
  }
}
```

---

#### Assign Staff Member to Role

**POST `/api/v1/admin/staff/members`**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/staff/members" \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 456,
    "user_email": "alice@company.com",
    "full_name": "Alice Smith",
    "staff_role_id": "sr_123",
    "customer_scope_override": null
  }'
```

---

#### Override Staff Member Permissions

**PATCH `/api/v1/admin/staff/members/{staff_id}/override`**

```bash
curl -X PATCH "https://api.platform.example.com/v1/admin/staff/members/789/override" \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_scope_override": {
      "type": "tags",
      "tags": ["support"]  # Alice can only access "support" tagged customers
    },
    "action_overrides": {
      "email_delete": {
        "requires_approval": true,
        "approval_role_id": "sr_456"  # Different approver than role default
      }
    }
  }'
```

---

#### Request Action Approval

**POST `/api/v1/admin/staff/approval-requests`**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/staff/approval-requests" \
  -H "Authorization: Bearer {staff-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "staff_member_id": 789,
    "session_id": "sess_abc123",
    "action_type": "email_delete",
    "action_details": {
      "email_id": "msg_xyz",
      "folder": "INBOX",
      "subject": "RE: Old Message"
    },
    "reason": "Cleaning up old emails"
  }'
```

**Response (201 Created):**

```json
{
  "data": {
    "request_id": "apr_req_123",
    "staff_member": "Alice Smith",
    "action": "email_delete",
    "status": "pending",
    "requested_at": "2026-03-01T14:32:00Z",
    "approval_role": "Team Lead",
    "expires_at": "2026-03-01T16:32:00Z",
    "message": "Approval request sent to Team Leads"
  }
}
```

---

#### List Pending Approvals

**GET `/api/v1/admin/staff/approval-requests?status=pending`**

```json
{
  "data": [
    {
      "request_id": "apr_req_123",
      "staff_name": "Alice Smith",
      "action_type": "email_delete",
      "customer": "Example Corp",
      "email_account": "john@example.com",
      "requested_at": "2026-03-01T14:32:00Z",
      "expires_at": "2026-03-01T16:32:00Z",
      "reason": "Cleaning up old emails",
      "action": "[Approve] [Reject]"
    }
  ]
}
```

---

#### Approve Action Request

**POST `/api/v1/admin/staff/approval-requests/{request_id}/approve`**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/staff/approval-requests/apr_req_123/approve" \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "approval_reason": "Approved - looks like legitimate cleanup"
  }'
```

**Response (200 OK):**

```json
{
  "data": {
    "request_id": "apr_req_123",
    "status": "approved",
    "approved_by": "Dave Miller (Team Lead)",
    "approved_at": "2026-03-01T14:35:00Z",
    "message": "Approval recorded. Staff member Alice may now proceed."
  }
}
```

---

### Audit Logging for Staff Access

#### Enhanced `admin_email_access_audit_log`

Staff access is logged the same as admin access, but includes additional context:

```sql
INSERT INTO admin_email_access_audit_log (
  session_id,
  admin_id,           -- Actually staff_member_id for staff sessions
  admin_role_type,    -- "staff" vs "admin"
  admin_staff_role,   -- "Support Staff", "Team Lead", etc.
  customer_id,
  email_account,
  action_type,
  action_details,
  ip_address,
  user_agent_hash,
  approval_request_id,  -- If action required approval
  approval_status,      -- pending/approved/rejected
  action_timestamp
) VALUES (
  'sess_abc123',
  456,                  -- Alice's user_id
  'staff',
  'Support Staff',
  123,
  'john@example.com',
  'email_delete',
  '{"email_id": "msg_xyz", "folder": "INBOX"}',
  '203.0.113.42',
  'sha256(...)',
  'apr_req_123',        -- Approval request ID
  'approved',           -- Approval was granted
  '2026-03-01T14:35:00Z'
);
```

---

### Implementation Checklist

- [ ] **Database**
  - [ ] Create `staff_roles` table
  - [ ] Create `staff_role_actions` table
  - [ ] Create `staff_members` table
  - [ ] Create `staff_action_approvals` table
  - [ ] Update `admin_email_access_audit_log` with role fields

- [ ] **Staff Role Management UI**
  - [ ] Staff Roles dashboard
  - [ ] Create/edit role dialog
  - [ ] Staff members list
  - [ ] Edit staff member (role assignment, overrides)
  - [ ] Pending approvals dashboard

- [ ] **API Endpoints**
  - [ ] Create staff role
  - [ ] Get staff role permissions
  - [ ] Update staff role
  - [ ] Delete staff role
  - [ ] Assign staff member
  - [ ] Override staff permissions
  - [ ] Request action approval
  - [ ] Approve/reject request
  - [ ] List pending approvals

- [ ] **Webmail Integration**
  - [ ] Validate staff token against role/customer scope
  - [ ] Enforce read-only mode
  - [ ] Check action permissions on each action
  - [ ] Intercept approval-required actions
  - [ ] Submit approval requests

- [ ] **Testing**
  - [ ] Role creation and validation
  - [ ] Customer scope filtering (tags, regions)
  - [ ] Permission enforcement (read-only vs full)
  - [ ] Action approval workflow
  - [ ] Override logic (staff overrides role)
  - [ ] Audit logging completeness

---

### Architecture

#### Admin Email Access Flow

```
Admin clicks: [Access Email] on customer john@example.com
         ↓
API generates secure session token
         ↓
Backend creates admin_email_access record:
├─ admin_id, admin_name, admin_role
├─ customer_id, email_account
├─ access_type (read-only / full)
├─ session_token (expires in 60 min)
├─ created_at, ip_address
└─ logged: true
         ↓
Admin redirected to special URL:
  https://webmail.example.com/?admin_access={token}
         ↓
Webmail validates token:
├─ Token valid? (not expired, not used before)
├─ Admin role authorized? (support can read-only, senior can full)
└─ Allow access
         ↓
Roundcube logs in as: john@example.com
(But marked as: "accessed by admin Mary")
         ↓
All actions logged:
├─ Email read
├─ Folder browsed
├─ Search queries
├─ Message deleted
├─ Reply composed
└─ Every action with timestamp + IP
         ↓
Admin logs out (or 60-min timeout)
         ↓
Session audit logged:
├─ Total session duration
├─ All actions summary
├─ IP address, browser, user agent
└─ Stored in database permanently
```

#### Session Token Generation & Validation

**Token format (cryptographically secure):**

```
admin_email_access_token = {
  "admin_id": 456,
  "admin_role": "support",
  "customer_id": 123,
  "email_account": "john@example.com",
  "access_type": "read-only",
  "issued_at": 1709312400,
  "expires_at": 1709316000,  // +60 min
  "ip_address": "203.0.113.42",
  "user_agent": "Mozilla/5.0...",
  "nonce": "{random-256-bit-hex}"
}

Encrypted with: AES-256-GCM (using admin session key)
```

**Token lifetime:** 60 minutes from issuance
**Single-use:** Once redeemed, token is invalidated (cannot be reused)

---

### Database Schema

#### `admin_email_access_sessions` Table

```sql
CREATE TABLE admin_email_access_sessions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- Admin details
  admin_id BIGINT NOT NULL,              -- FK: admin users
  admin_name VARCHAR(255) NOT NULL,      -- Cached for audit trail
  admin_email VARCHAR(255) NOT NULL,     -- Admin's email address
  admin_role ENUM('support', 'senior', 'super') NOT NULL,
  
  -- Customer & email details
  customer_id BIGINT NOT NULL,           -- FK: customers.id
  customer_name VARCHAR(255) NOT NULL,   -- Cached
  email_account VARCHAR(255) NOT NULL,   -- e.g., "john@example.com"
  
  -- Access control
  access_type ENUM('read-only', 'full') NOT NULL,
  -- read-only: can read, search, but NOT compose/send/delete
  -- full: can do everything (read, compose, send, delete, move, etc.)
  
  -- Session details
  session_token_hash VARCHAR(255) UNIQUE, -- SHA-256 hash of token (for validation)
  session_token_expires_at TIMESTAMP,     -- When token expires (usually 60 min from creation)
  session_authenticated_at TIMESTAMP NULL,-- When admin actually used the token
  session_ended_at TIMESTAMP NULL,        -- When admin logged out or timed out
  session_duration_seconds INT,           -- (session_ended_at - session_authenticated_at)
  
  -- Network & security
  ip_address VARCHAR(45) NOT NULL,        -- IPv4 or IPv6 of admin
  user_agent TEXT,                        -- Browser/OS of admin
  user_agent_hash VARCHAR(255),           -- SHA-256 of user agent
  session_cookie_id VARCHAR(255),         -- Roundcube session ID (for tracking all actions)
  
  -- Status
  status ENUM('pending', 'active', 'ended', 'expired', 'revoked') DEFAULT 'pending',
  -- pending: token created, not yet used
  -- active: admin logged in, session active
  -- ended: admin logged out normally
  -- expired: token/session expired without use
  -- revoked: admin revoked the session early
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_admin_id (admin_id),
  INDEX idx_customer_id (customer_id),
  INDEX idx_email_account (email_account),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_session_token_expires_at (session_token_expires_at)
);
```

#### `admin_email_access_audit_log` Table

Detailed log of every action taken during admin session.

```sql
CREATE TABLE admin_email_access_audit_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  session_id BIGINT NOT NULL,            -- FK: admin_email_access_sessions.id
  admin_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  email_account VARCHAR(255) NOT NULL,
  
  -- Action details
  action_type ENUM(
    'login',              -- Admin logged in
    'logout',             -- Admin logged out
    'email_read',         -- Opened/read an email
    'email_search',       -- Performed search
    'folder_accessed',    -- Opened a folder
    'email_deleted',      -- Deleted an email
    'email_moved',        -- Moved email to folder
    'email_composed',     -- Started composing new email
    'email_sent',         -- Sent an email
    'email_forwarded',    -- Forwarded an email
    'attachment_opened',  -- Opened an attachment
    'attachment_downloaded', -- Downloaded an attachment
    'contact_viewed',     -- Viewed a contact
    'contact_added',      -- Added a new contact
    'settings_viewed',    -- Viewed account settings
    'error'               -- Error occurred
  ) NOT NULL,
  
  -- Action metadata
  action_details JSON,                   -- {
                                         --   "email_id": "...",
                                         --   "folder": "INBOX",
                                         --   "email_subject": "...",
                                         --   "email_from": "...",
                                         --   "recipient": "...",
                                         --   "error_message": "...",
                                         --   "query": "..."  // for search
                                         -- }
  
  -- Security context
  ip_address VARCHAR(45),
  user_agent_hash VARCHAR(255),
  
  -- Timestamp
  action_timestamp TIMESTAMP NOT NULL,
  
  INDEX idx_session_id (session_id),
  INDEX idx_admin_id (admin_id),
  INDEX idx_action_type (action_type),
  INDEX idx_action_timestamp (action_timestamp),
  INDEX idx_email_account (email_account)
);
```

#### `admin_email_access_summary` Table

Summary stats for each session (for quick reporting).

```sql
CREATE TABLE admin_email_access_summary (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  session_id BIGINT UNIQUE NOT NULL,    -- FK: admin_email_access_sessions.id
  
  -- Counts
  emails_read INT DEFAULT 0,
  emails_searched INT DEFAULT 0,
  emails_deleted INT DEFAULT 0,
  emails_composed INT DEFAULT 0,
  emails_sent INT DEFAULT 0,
  folders_accessed INT DEFAULT 0,
  attachments_accessed INT DEFAULT 0,
  
  -- Sensitive actions
  sensitive_actions_performed BOOLEAN DEFAULT FALSE,
  -- TRUE if: email deleted, email sent, or email composed
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_session_id (session_id)
);
```

---

### Role-Based Access Control

Access control is defined by **customizable staff roles** (not preset hierarchies). Each role can be configured with:

1. **Permission Level:** read-only or full access
2. **Customer Scope:** all customers, specific tags, specific regions, or combination
3. **Action Approvals:** which actions (send, delete, etc.) require supervisor approval
4. **Per-Staff Overrides:** individual staff can have different permissions than their role

**See "Staff Role Management System" section above for:**
- How to create and configure custom roles
- Customer access restriction (tags, regions, combinations)
- Action approval workflow (send/delete require approval)
- Staff member assignment and overrides
- Complete examples (small teams, enterprise multi-region, specialists)

---

### Admin Panel UI

#### Customer Details Page: Email Management

**New section: Email Account Access**

```
john@example.com Email Account
────────────────────────────────

Account Details:
├─ Status: Active
├─ Created: 2026-01-15
├─ Storage: 245 MB / 2 GB
└─ Last login: 5 minutes ago

🔐 Admin Access to This Email Account:

Access Type: [Full Access ▼]  (dropdown: read-only / full)
Duration: [60 minutes]
Reason (optional): [Troubleshooting customer's bounced emails]

[  Access Email as Admin  ]  ← Main button

Recent Admin Access:
┌─────────────────────────────────────────────────────────────┐
│ Admin          Role    When           Duration  Actions      │
├─────────────────────────────────────────────────────────────┤
│ Mary Support   Support 1h ago         15 min    [View Log]   │
│ John Senior    Senior  Today 10:30 AM 45 min    [View Log]   │
│ Bob Support    Support 2 days ago     22 min    [View Log]   │
└─────────────────────────────────────────────────────────────┘

[View Full Access History] [Disable Admin Access (Advanced)]
```

#### Admin Dashboard: Email Access Monitoring

**New section: Admin Email Access Dashboard**

```
📧 Admin Email Access Overview

Today's Admin Access Sessions: 23
├─ Support staff: 18 (mostly read-only)
├─ Senior admins: 4 (full access)
└─ Super admins: 1

Sessions in Last 24h:
├─ Total: 67
├─ Average duration: 18 minutes
├─ Sensitive actions: 12 (emails sent, deleted, etc.)

Current Active Sessions: 3
┌─────────────────────────────────────────────────────────────────┐
│ Admin         Customer           Email Account    Role    Elapsed│
├─────────────────────────────────────────────────────────────────┤
│ Mary Support  Acme Corp          john@acme.com    Support  12 min│
│ John Senior   TechStart Inc      admin@tech.io    Senior   34 min│
│ Bob Support   SmallBiz LLC       jane@small.biz   Support   5 min│
└─────────────────────────────────────────────────────────────────┘

Actions: [View Session Details] [Revoke Session] [View Logs]

Most Accessed Customers (Last 7 days):
├─ Example Corp: 12 accesses (avg 20 min)
├─ Acme Inc: 8 accesses (avg 15 min)
└─ TechStart: 6 accesses (avg 25 min)

Sensitive Actions Performed:
├─ Emails sent by admins: 8
├─ Emails deleted by admins: 15
├─ Settings changed by admins: 2
└─ [View Details]
```

#### Session Details & Audit Trail

**Click [View Log] to see complete action log:**

```
Admin Email Access Session Details

┌──────────────────────────────────────────────────────────┐
│ Admin Email Access: john@example.com                     │
│ Session ID: sess_abc123                                  │
└──────────────────────────────────────────────────────────┘

Session Info:
├─ Admin: Mary Support (ID: 456, support staff)
├─ Customer: Example Corp (ID: 123)
├─ Email: john@example.com
├─ Access Type: Full Access
├─ Started: 2026-03-01 14:32:00 UTC
├─ Ended: 2026-03-01 14:47:30 UTC
├─ Duration: 15 minutes 30 seconds
├─ IP Address: 203.0.113.42
├─ Browser: Chrome 123.0 on macOS 14.3
├─ Status: Ended normally
└─ Reason for access: "Customer reported bounced emails"

Action Log (Detailed):
┌──────────────────────────────────────────────────────────┐
│ Time        Action               Details                  │
├──────────────────────────────────────────────────────────┤
│ 14:32:05    login                Admin Mary logged in     │
│ 14:32:15    folder_accessed      Opened INBOX (45 msgs)  │
│ 14:32:45    email_search         Searched: "bounce"      │
│ 14:32:55    email_read           Opened email from...    │
│             (ID: msg_123)        "Delivery Failed"       │
│ 14:33:20    email_read           Opened email from...    │
│             (ID: msg_124)        "Undeliverable"         │
│ 14:33:50    folder_accessed      Opened Trash folder     │
│ 14:34:15    email_search         Searched: "sender"      │
│ 14:35:00    email_moved          Moved msg_123 to...     │
│             → INBOX (from Spam)  Reason: "False positive" │
│ 14:35:30    contact_viewed       Viewed sender contact   │
│ 14:36:00    email_read           Opened original email   │
│ 14:47:20    logout               Admin Mary logged out    │
└──────────────────────────────────────────────────────────┘

Summary Statistics:
├─ Emails read: 5
├─ Emails moved: 1
├─ Searches performed: 2
├─ Folders accessed: 3
├─ Sensitive actions: 1 (email moved)
└─ Attachments downloaded: 0

Export Options:
[Export as PDF]  [Export as CSV]  [Copy Session Link]

[Back to Customer]  [Back to Dashboard]
```

---

### Webmail Session: Admin Indicator

When admin is logged in to customer email, Roundcube shows:

```
╔═══════════════════════════════════════════════════════════╗
║  🔒 ADMIN ACCESS SESSION                                  ║
║                                                           ║
║  You are accessing this email as an administrator.        ║
║  This session is logged and monitored.                    ║
║                                                           ║
║  Access by: Mary Support (support staff)                  ║
║  Session started: 14:32 UTC                               ║
║  Session expires: 15:32 UTC (expires in 27 min)           ║
║                                                           ║
║  [View Your Admin Logs] [End Session Early]               ║
╚═══════════════════════════════════════════════════════════╝

(This banner is always visible, cannot be dismissed)
```

**Read-only mode shows:**
```
⚠️ READ-ONLY ACCESS
You cannot compose, send, delete, or modify this email.
[Try to compose] → "Cannot compose in read-only mode"
```

---

### Generating & Using Access Tokens

#### Step 1: Admin Initiates Access (From Control Panel)

```bash
POST /api/v1/admin/email-access/generate-token

Request:
{
  "customer_id": 123,
  "email_account": "john@example.com",
  "access_type": "full",           // or "read-only"
  "duration_minutes": 60,
  "reason": "Troubleshooting bounced emails"
}

Response (201 Created):
{
  "session_id": "sess_abc123",
  "access_token": "{encrypted-token}",
  "webmail_url": "https://webmail.example.com/?admin_access={token}",
  "expires_at": "2026-03-01T15:32:00Z",
  "access_type": "full",
  "email_account": "john@example.com"
}
```

#### Step 2: Admin Clicks Link (From Control Panel UI)

```
Admin clicks: [Access Email as Admin]
↓
Opens new tab: https://webmail.example.com/?admin_access={token}
```

#### Step 3: Webmail Validates Token

```bash
GET https://webmail.example.com/?admin_access={token}

Roundcube validates:
1. Token hash matches database
2. Token not expired
3. Token not already redeemed
4. IP address matches (or within whitelist)
5. Admin role authorized for access_type

If all valid:
├─ Mark token as: redeemed
├─ Create Roundcube session
├─ Log: "Admin access session started"
└─ Redirect to INBOX

If invalid:
├─ Log: "Invalid admin access attempt"
└─ Show: "Access denied. Please try again."
```

#### Step 4: All Actions Logged

```
During session, every action triggers:

POST /api/v1/admin/email-access/{session_id}/log-action

{
  "action_type": "email_read",
  "action_details": {
    "email_id": "msg_abc123",
    "folder": "INBOX",
    "email_subject": "RE: Project Update",
    "email_from": "boss@company.com"
  },
  "ip_address": "203.0.113.42",
  "user_agent_hash": "sha256(...)",
  "timestamp": "2026-03-01T14:32:45Z"
}

↓

Database record created in:
admin_email_access_audit_log
```

#### Step 5: Session Ends

```
When admin logs out or 60-min timeout:

POST /api/v1/admin/email-access/{session_id}/end

Body:
{
  "ended_by": "admin_logout",  // or "timeout" or "revoked"
  "end_timestamp": "2026-03-01T14:47:30Z"
}

↓

Roundcube session destroyed
Database updated:
├─ session_duration_seconds = (15 * 60 + 30)
├─ status = "ended"
├─ session_ended_at = timestamp
└─ session_ended_by = "admin_logout"

Summary record created in:
admin_email_access_summary
```

---

### API Endpoints

#### Generate Access Token

**POST `/api/v1/admin/email-access/generate-token`**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/email-access/generate-token" \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 123,
    "email_account": "john@example.com",
    "access_type": "full",
    "duration_minutes": 60,
    "reason": "Troubleshooting bounced emails"
  }'
```

**Response (201 Created):**

```json
{
  "data": {
    "session_id": "sess_abc123",
    "access_token": "{encrypted-token}",
    "webmail_url": "https://webmail.example.com/?admin_access={token}",
    "expires_at": "2026-03-01T15:32:00Z",
    "access_type": "full",
    "email_account": "john@example.com",
    "admin_id": 456,
    "admin_name": "Mary Support",
    "admin_role": "support"
  }
}
```

---

#### Get Active Sessions (Admin Dashboard)

**GET `/api/v1/admin/email-access/sessions?status=active`**

```json
{
  "data": [
    {
      "session_id": "sess_abc123",
      "admin_id": 456,
      "admin_name": "Mary Support",
      "admin_role": "support",
      "customer_id": 123,
      "customer_name": "Example Corp",
      "email_account": "john@example.com",
      "access_type": "full",
      "ip_address": "203.0.113.42",
      "started_at": "2026-03-01T14:32:00Z",
      "expires_at": "2026-03-01T15:32:00Z",
      "status": "active",
      "duration_so_far_minutes": 12
    }
  ]
}
```

---

#### Get Session Audit Log

**GET `/api/v1/admin/email-access/sessions/{session_id}/log`**

```json
{
  "data": {
    "session_id": "sess_abc123",
    "admin_name": "Mary Support",
    "email_account": "john@example.com",
    "started_at": "2026-03-01T14:32:00Z",
    "ended_at": "2026-03-01T14:47:30Z",
    "duration_seconds": 930,
    "ip_address": "203.0.113.42",
    "user_agent": "Chrome 123.0 on macOS 14.3",
    "actions": [
      {
        "timestamp": "2026-03-01T14:32:05Z",
        "action_type": "login",
        "action_details": {}
      },
      {
        "timestamp": "2026-03-01T14:32:15Z",
        "action_type": "folder_accessed",
        "action_details": {"folder": "INBOX", "message_count": 45}
      },
      {
        "timestamp": "2026-03-01T14:32:45Z",
        "action_type": "email_search",
        "action_details": {"query": "bounce"}
      },
      {
        "timestamp": "2026-03-01T14:32:55Z",
        "action_type": "email_read",
        "action_details": {
          "email_id": "msg_123",
          "folder": "INBOX",
          "email_subject": "Delivery Failed",
          "email_from": "noreply@mailserver.com"
        }
      }
    ],
    "summary": {
      "emails_read": 5,
      "emails_moved": 1,
      "emails_deleted": 0,
      "emails_composed": 0,
      "emails_sent": 0,
      "folders_accessed": 3,
      "searches_performed": 2,
      "sensitive_actions": 1
    }
  }
}
```

---

#### Revoke Session Early

**POST `/api/v1/admin/email-access/sessions/{session_id}/revoke`**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/email-access/sessions/sess_abc123/revoke" \
  -H "Authorization: Bearer {admin-token}"
```

**Response (200 OK):**

```json
{
  "data": {
    "session_id": "sess_abc123",
    "status": "revoked",
    "revoked_at": "2026-03-01T14:35:00Z",
    "revoked_by_admin_id": 999,
    "message": "Session revoked by super admin"
  }
}
```

---

#### Get Email Access History for Customer

**GET `/api/v1/admin/customers/{customer_id}/email-access-history`**

```json
{
  "data": [
    {
      "session_id": "sess_abc123",
      "admin_name": "Mary Support",
      "email_account": "john@example.com",
      "accessed_at": "2026-03-01T14:32:00Z",
      "duration_minutes": 15,
      "access_type": "full",
      "actions_count": 12,
      "sensitive_actions": 1
    },
    {
      "session_id": "sess_def456",
      "admin_name": "John Senior",
      "email_account": "admin@example.com",
      "accessed_at": "2026-02-28T10:15:00Z",
      "duration_minutes": 45,
      "access_type": "full",
      "actions_count": 8,
      "sensitive_actions": 0
    }
  ]
}
```

---

### Security & Compliance

#### Password Protection

✅ **Admin cannot change customer password while in session**
- If password change attempted: Show message "Cannot change password in admin access mode"
- Only Super Admin with additional verification can reset password

#### Email Sending Safeguard

✅ **For full access, sending emails requires confirmation:**

```
Dialog when admin clicks "Send":

╔═══════════════════════════════════════════════════════╗
║  Send Email as john@example.com?                      ║
║                                                       ║
║  This email will be sent from the customer's account. ║
║  This action is logged and audited.                   ║
║                                                       ║
║  From: john@example.com                               ║
║  To: boss@company.com                                 ║
║  Subject: RE: Project Status                          ║
║                                                       ║
║  [  Cancel  ]  [  Send  ]                             ║
╚═══════════════════════════════════════════════════════╝
```

After sending:
```
✅ Email sent as john@example.com
⚠️ Action logged to admin audit trail
ℹ️ This message is marked with [Admin Sent] tag (visible to sender)
```

#### Email Deletion Safeguard

✅ **For full access, deleting emails requires confirmation:**

```
Dialog when admin tries to delete:

╔═══════════════════════════════════════════════════════╗
║  Permanently Delete This Email?                       ║
║                                                       ║
║  From: client@domain.com                              ║
║  Subject: Important Project Files                     ║
║                                                       ║
║  ⚠️ This action CANNOT be undone.                     ║
║  ⚠️ This action is logged and audited.                ║
║                                                       ║
║  [  Cancel  ]  [  Delete  ]                           ║
╚═══════════════════════════════════════════════════════╝
```

#### IP Address & Session Validation

✅ **Token tied to admin's IP address**
- Token only valid from IP where it was created
- If admin connects from different IP: Token rejected
- Prevents token theft/forwarding

✅ **User-Agent validation**
- Session bound to browser/OS at creation time
- If browser changes: Logged as warning (possible session hijacking)

#### Audit Trail Immutable

✅ **Audit logs cannot be deleted or modified**
- Stored in separate table with integrity checks
- Hashed IP address and User-Agent for privacy
- Separate permission to view admin access logs (super admin only)

---

### Compliance & Privacy

#### GDPR Compliance

✅ **Customer data protection:**
- Admin access logged with timestamp, IP, all actions
- Customers can request: "What did admins do with my data?"
- Audit trail provides full answer
- Data retention: 1 year (configurable)

#### SOX Compliance

✅ **Financial/audit email access:**
- Every email access logged
- Sensitive actions (send, delete) require confirmation
- Immutable audit trail for regulatory review

#### HIPAA Compliance

✅ **For healthcare customers:**
- Role-based access (different admins see different data)
- Full action logging for compliance
- Encryption of tokens and session data
- Audit trail for regulatory audits

---

### Monitoring & Alerts

#### Admin Access Dashboard Metrics

```
Prometheus metrics:

admin_email_access_total{admin_id="456", access_type="full"}
admin_email_access_duration_seconds{admin_id="456", quantile="0.95"}
admin_email_actions_total{admin_id="456", action_type="email_sent"}
admin_email_access_sensitive_actions_total{admin_id="456"}
admin_email_access_sessions_active
admin_email_access_most_accessed_customer
```

#### Alerts

```
🚨 Admin Email Access Anomalies:

1. Excessive access: Admin accessed >10 customers in 1 day
2. Long sessions: Admin session >120 minutes
3. Mass deletions: Admin deleted >50 emails in 1 session
4. Suspicious sending: Admin sent emails between 22:00-06:00 UTC
5. IP change: Admin accessed from unexpected geography
6. Failed authentications: >5 failed token validations
```

---

### Kubernetes Integration

#### Roundcube Configuration

```yaml
# In Roundcube config.inc.php:

// Admin masquerading
$config['admin_access_enabled'] = true;
$config['admin_access_log_actions'] = true;
$config['admin_access_require_confirmation_send'] = true;
$config['admin_access_require_confirmation_delete'] = true;
$config['admin_access_session_timeout'] = 3600; // 60 min

// Log all admin actions to API
$config['admin_access_api_endpoint'] = 'http://management-api:3000/admin/email-access/log-action';
$config['admin_access_api_token'] = env('ROUNDCUBE_ADMIN_API_TOKEN');
```

#### Sidecar for Action Logging

Optional: Add logging sidecar to Roundcube pod:

```yaml
containers:
- name: roundcube
  image: roundcube:latest

- name: action-logger
  image: custom-registry/roundcube-action-logger:latest
  # Tails Roundcube logs
  # Parses admin actions
  # POSTs to management API
  # Enriches with IP, User-Agent, etc.
```

---

### Implementation Checklist

- [ ] **Database**
  - [ ] Create `admin_email_access_sessions` table
  - [ ] Create `admin_email_access_audit_log` table
  - [ ] Create `admin_email_access_summary` table
  - [ ] Add indexes for performance
  - [ ] Set up log retention policy (1 year)

- [ ] **Token Generation & Validation**
  - [ ] Implement secure token generation (AES-256-GCM)
  - [ ] Add IP address validation
  - [ ] Add expiration check (60 min)
  - [ ] Add single-use validation
  - [ ] Add user-agent binding

- [ ] **Roundcube Integration**
  - [ ] Add admin access token validation endpoint
  - [ ] Create session initialization for admin access
  - [ ] Add UI banner ("Admin Access Session")
  - [ ] Implement read-only mode for support staff
  - [ ] Add confirmation dialogs (send, delete)
  - [ ] Action logging hooks (every action tracked)
  - [ ] Session expiration handling

- [ ] **Management API**
  - [ ] Add 5 new endpoints (generate token, get sessions, get logs, revoke, history)
  - [ ] Add role-based permission checks
  - [ ] Implement comprehensive error handling
  - [ ] Add rate limiting (prevent token spam)

- [ ] **Admin Panel UI**
  - [ ] Customer details: Email account access section
  - [ ] Admin dashboard: Email access monitoring
  - [ ] Session details: Audit log viewer
  - [ ] Active sessions: Revoke controls
  - [ ] Access history: Per-customer view

- [ ] **Audit Logging**
  - [ ] Log all admin access initiations
  - [ ] Log all actions during session
  - [ ] Log session end/timeout
  - [ ] Store IP address + User-Agent
  - [ ] Calculate sensitive action summary

- [ ] **Monitoring & Alerts**
  - [ ] Prometheus metrics (access count, duration, sensitive actions)
  - [ ] Alert rules (excessive access, suspicious patterns)
  - [ ] Grafana dashboard
  - [ ] Email alerts to admin on suspicious activity

- [ ] **Testing**
  - [ ] Unit tests (token generation, validation)
  - [ ] Integration tests (end-to-end email access)
  - [ ] Role-based access tests (support vs senior)
  - [ ] Security tests (token theft, IP spoofing, session hijacking)
  - [ ] Load tests (100+ concurrent admin sessions)
  - [ ] Audit log tests (verify all actions logged)

- [ ] **Documentation**
  - [ ] Admin guide: How to access customer email
  - [ ] Security guide: What's logged, how to review
  - [ ] Compliance guide: GDPR/HIPAA/SOX audit trail
  - [ ] API reference: All endpoints
  - [ ] Troubleshooting: Common issues

---

## Related Documentation

- **EMAIL_SERVICES.md**: Email authentication, app passwords, OIDC
- **EMAIL_SENDING_LIMITS_AND_MONITORING.md**: Email quota enforcement
- **SECURITY_ARCHITECTURE.md**: Role-based access control, compliance
- **ADMIN_PANEL_REQUIREMENTS.md**: Admin panel feature specifications
- **MONITORING_OBSERVABILITY.md**: Audit logging, alerting, compliance

- **EMAIL_SERVICES.md**: Email authentication, app passwords, OIDC, account provisioning
- **EMAIL_SENDING_LIMITS_AND_MONITORING.md**: Email quota enforcement, mailqueue monitoring
- **CLIENT_PANEL_FEATURES.md**: Email management features from customer perspective
- **ADMIN_PANEL_REQUIREMENTS.md**: Email & webmail admin controls
- **SECURITY_ARCHITECTURE.md**: Session security, HTTPS enforcement, CSRF protection
- **INFRASTRUCTURE_PLAN.md** Section 11: Email & Webmail architecture overview
