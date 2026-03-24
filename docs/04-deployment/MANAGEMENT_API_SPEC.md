# Management API Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, API consumers, DevOps engineers

---

## Overview

The Management API is the core RESTful interface for **admin-only** operations:
- Client/tenant lifecycle management (CRUD) — Create/read/update/delete customers
- Subscription management — Track and update subscription expiry dates, sync with external billing
- Domain provisioning and management — Add/remove customer domains
- Database provisioning and credential management — Create and manage customer databases
- Backup/restore operations — Automated backup management and point-in-time recovery
- Resource monitoring and reporting — Monitor customer resource usage

**Tech Stack:**
- Framework: Node.js (Fastify). See ADR-011.
- Port: `3000` (internal) / `8080` (external via NGINX)
- Authentication: OIDC (Dex) + Bearer tokens
- Response Format: JSON
- Versioning: `/api/v1/`

**Path Convention:** All client-scoped endpoints use `/api/v1/clients/{id}/` where `{id}` is the client identifier.

---

## Authentication & Authorization

### Token Requirements
All requests must include:
```
Authorization: Bearer <JWT_TOKEN>
```

**Token Claims:**
- `sub` — User ID (from Dex)
- `role` — One of: `admin`, `billing`, `support`, `read-only`
- `exp` — Expiration timestamp
- `iat` — Issued at timestamp

**Token Lifetime:** 1 hour (refresh token: 7 days)

### RBAC Matrix

| Endpoint | GET | POST | PATCH | DELETE | Roles |
|----------|-----|------|-------|--------|-------|
| `/clients` | ✅ | ✅ | ✅ | ✅ | admin |
| `/clients/{id}/subscription` | ✅ | - | ✅ | - | admin |
| `/clients/{id}/domains` | ✅ | ✅ | ✅ | ✅ | admin, support |
| `/clients/{id}/databases` | ✅ | ✅ | ✅ | ✅ | admin, support |
| `/clients/{id}/cron-jobs` | ✅ | ✅ | ✅ | ✅ | admin, support |
| `/clients/{id}/backups` | ✅ | ✅ | - | ✅ | admin, support |
| `/clients/{id}/metrics` | ✅ | - | - | - | admin, read-only |
| `/admin/cron-jobs` | ✅ | - | - | - | admin |
| `/admin/status` | ✅ | - | - | - | admin |

---

## Core Data Models

### Client Object

```json
{
  "id": "client_001",
  "name": "Acme Corp",
  "plan": "business",
  "email": "admin@acme.com",
  "status": "active",
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2025-02-20T14:22:00Z",
  "subscription": {
    "plan": "business",
    "expiry_date": "2026-02-20",
    "external_billing_id": "sub_12345xyz",
    "status": "active",
    "notes": "Renewed annually"
  },
  "quota": {
    "domains": 25,
    "databases": 5,
    "storage_gb": 100,
    "monthly_bandwidth_gb": 500
  },
  "usage": {
    "domains": 6,
    "databases": 2,
    "storage_gb": 34.2,
    "monthly_bandwidth_gb": 120
  }
}
```

### Domain Object

```json
{
  "id": "domain_042",
  "client_id": "client_001",
  "name": "www.acme.com",
  "tld": "com",
  "registrar": "namecheap",
  "status": "active",
  "ssl_status": "valid",
  "ssl_expiry": "2026-03-15",
  "created_at": "2024-06-10T09:00:00Z",
  "dns_mode": "primary",
  "dns": {
    "mode": "primary",
    "provider": "powerdns",
    "zone_id": "acme-com",
    "nameservers": ["ns1.k8s.local", "ns2.k8s.local", "ns3.k8s.local"],
    "records": {
      "A": ["192.0.2.15"],
      "AAAA": ["2001:db8::1"],
      "MX": ["mail.acme.com"],
      "TXT": ["v=spf1 include:acme.com ~all"]
    }
  }
}
```

**DNS Modes Explained:**

| Mode | Description | Use Case |
|------|-------------|----------|
| **`primary`** | Platform runs as authoritative nameserver; customer delegates domain to `ns1.k8s.local` | Customers who want platform to manage DNS completely |
| **`cname`** | Customer points CNAME to platform; no DNS zone management | Customers who manage DNS themselves (GoDaddy, Route53, Cloudflare) |
| **`secondary`** | Platform runs as secondary nameserver; customer's primary DNS is authoritative | Customers who want backup DNS without giving up DNS control |

**Example Domain Objects by Mode:**

*Primary Mode (Full Delegation):*
```json
{
  "dns_mode": "primary",
  "dns": {
    "mode": "primary",
    "provider": "powerdns",
    "zone_id": "acme-com",
    "nameservers": ["ns1.k8s.local", "ns2.k8s.local", "ns3.k8s.local"],
    "status": "delegated",
    "records": { "A": [...], "AAAA": [...], ... }
  }
}
```

*CNAME Mode (No Zone Management):*
```json
{
  "dns_mode": "cname",
  "dns": {
    "mode": "cname",
    "cname_target": "hosting.platform.com",
    "status": "cname_configured",
    "records": null
  }
}
```

*Secondary Mode (Backup DNS):*
```json
{
  "dns_mode": "secondary",
  "dns": {
    "mode": "secondary",
    "provider": "powerdns",
    "zone_id": "acme-com",
    "primary_nameserver": "ns.godaddy.com",
    "platform_nameserver": "ns1.k8s.local",
    "status": "secondary_active",
    "axfr_status": "synced",
    "last_axfr": "2025-03-01T14:32:00Z"
  }
}
```

### Database Object

```json
{
  "id": "db_128",
  "client_id": "client_001",
  "type": "mysql",
  "version": "8.0",
  "engine": "percona",
  "name": "acme_prod",
  "size_gb": 12.4,
  "replicas": 0,
  "created_at": "2024-09-20T14:30:00Z",
  "status": "healthy",
  "credentials": {
    "username": "acme_user",
    "host": "mysql-primary.k8s.local",
    "port": 3306
  }
}
```

---

## API Endpoints

### 1. Client Management

#### GET `/api/v1/clients`
List all clients (paginated).

**Query Parameters:**
- `limit` (default: 50, max: 500) — Results per page
- `offset` (default: 0) — Pagination offset
- `status` (optional) — Filter: `active`, `suspended`, `cancelled`
- `plan` (optional) — Filter: `starter`, `business`, `premium`
- `search` (optional) — Search by name/email

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "client_001", "name": "Acme Corp", ... },
    { "id": "client_002", "name": "Beta Inc", ... }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 2,
    "has_more": false
  }
}
```

**Status Codes:** 200, 401, 403

---

#### POST `/api/v1/clients`
Create a new client **(Admin only)**.

**Request Body:**
```json
{
  "name": "Acme Corp",
  "email": "admin@acme.com",
  "plan": "business",
  "subscription": {
    "expiry_date": "2026-03-01",
    "external_billing_id": "sub_stripe_12345",
    "notes": "Renewed annually via external billing"
  }
}
```

**Validation Rules:**
- `name` — Required, 3-100 chars, alphanumeric + spaces
- `email` — Required, valid RFC 5322 format, must be unique
- `plan` — Required, one of: `starter`, `business`, `premium`
- `subscription.expiry_date` — Required, ISO 8601 date (YYYY-MM-DD)
- `subscription.external_billing_id` — Required, ID from external billing platform
- `subscription.notes` — Optional, memo for admin reference

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "client_001",
    "name": "Acme Corp",
    "email": "admin@acme.com",
    "plan": "business",
    "status": "active",
    "subscription": {
      "plan": "business",
      "expiry_date": "2026-03-01",
      "external_billing_id": "sub_stripe_12345",
      "status": "active",
      "notes": "Renewed annually via external billing"
    },
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Error Responses:**
```json
{
  "success": false,
  "error": {
    "code": "DUPLICATE_EMAIL",
    "message": "Email already exists",
    "field": "email"
  }
}
```

**Possible Error Codes:**
- `VALIDATION_ERROR` (400) — Invalid input
- `DUPLICATE_EMAIL` (409) — Email already registered
- `PLAN_NOT_FOUND` (400) — Invalid plan specified
- `QUOTA_EXCEEDED` (429) — Admin quota exceeded
- `INTERNAL_ERROR` (500) — Server error

**Status Codes:** 201, 400, 409, 429, 500

**Side Effects:**
- Creates Kubernetes namespace: `client-{id}`
- Provisions shared pod if plan requires it
- Creates initial DNS zone
- Sends welcome email to client
- Logs event to audit trail

---

#### GET `/api/v1/clients/{id}`
Get a specific client.

**Response:**
```json
{
  "success": true,
  "data": { ... full Client object ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}`
Update client settings **(Admin only)**.

**Request Body (all optional):**
```json
{
  "name": "Acme Corporation",
  "status": "suspended",
  "subscription": {
    "expiry_date": "2027-03-01",
    "status": "active",
    "notes": "Renewed for additional year"
  }
}
```

**Allowed Updates:**
- `name` — Client display name
- `status` — `active`, `suspended`, `cancelled`
- `subscription.expiry_date` — Update subscription expiry (synced with external billing platform)
- `subscription.status` — `active`, `expired`, `suspended` (track subscription state)
- `subscription.notes` — Admin notes

**Immutable Fields:**
- `id`, `created_at`, `email`, `plan` (plan cannot be changed; requires new client)

**Response:**
```json
{
  "success": true,
  "data": { ... updated Client object ... }
}
```

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects on Suspension:**
- Disable all ingress/egress
- Stop all pods (retain data)
- Send notification to admin (NOT to customer directly)

**Side Effects on Subscription Expiry Update:**
- Update internal expiry date
- Recalculate subscription status (if expiry < today, mark as expired)
- Cancel scheduled expiry notification if renewed
- No automatic service changes (admin handles that via status field)

---

#### DELETE `/api/v1/clients/{id}`
Delete a client (hard delete).

**Query Parameters:**
- `force` (optional) — Force delete even if data exists

**Response:**
```json
{
  "success": true,
  "message": "Client deleted",
  "data": {
    "id": "client_001",
    "deleted_at": "2025-03-01T10:00:00Z"
  }
}
```

**Validation:**
- Client must have status `cancelled`
- No active deployments (unless `force=true`)
- All backups must be deleted first

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects:**
- Deletes Kubernetes namespace
- Deletes all client data (if force=true)
- Archives audit logs
- Sends final invoice

---

### 2. Subscription Management

#### GET `/api/v1/clients/{id}/subscription`
Get subscription details for a client.

**Response:**
```json
{
  "success": true,
  "data": {
    "plan": "business",
    "expiry_date": "2026-03-01",
    "external_billing_id": "sub_stripe_12345",
    "status": "active",
    "days_until_expiry": 365,
    "renewal_reminder_sent": false,
    "notes": "Renewed annually via external billing"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}/subscription`
Update subscription details **(Admin only)**.

**Request Body:**
```json
{
  "expiry_date": "2027-03-01",
  "status": "active",
  "external_billing_id": "sub_stripe_12345",
  "notes": "Renewed for additional year"
}
```

**Allowed Updates:**
- `expiry_date` — ISO 8601 date (YYYY-MM-DD), synced with external billing
- `status` — `active`, `expired`, `suspended`
- `external_billing_id` — External billing platform subscription ID
- `notes` — Admin-only notes about subscription

**Response:**
```json
{
  "success": true,
  "data": {
    "plan": "business",
    "expiry_date": "2027-03-01",
    "external_billing_id": "sub_stripe_12345",
    "status": "active",
    "days_until_expiry": 730,
    "renewal_reminder_sent": false,
    "notes": "Renewed for additional year"
  }
}
```

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects:**
- If `status` changed to `expired`: Triggers expiry notification to admin (if configured)
- If `expiry_date` updated: Recalculates `days_until_expiry`, resets `renewal_reminder_sent` flag
- No customer-facing changes (admin manages via client status field)

---

#### Plan Change Procedure (Upgrade/Downgrade)

The `plan` field on a client is **immutable** — it cannot be changed via PATCH. To change a customer's plan, the admin must:

1. **Create a new client** with the target plan (`POST /api/v1/clients/`)
2. **Migrate data** from the old client (domains, databases, files, email) using backup/restore
3. **Update external billing** to reflect the new plan
4. **Suspend** the old client (`PATCH /api/v1/clients/{old_id}` → `status: suspended`)
5. **Delete** the old client once migration is verified (`DELETE /api/v1/clients/{old_id}`)

> **Future improvement:** A dedicated `POST /api/v1/clients/{id}/plan-change` endpoint could automate this workflow, handling resource limit changes, pod migration (shared→dedicated or vice versa), and data transfer in a single operation. This is deferred to Phase 2.

**Downgrade considerations:**
- If the new plan has lower limits (storage, domains, databases), the admin must ensure the customer's current usage fits within the new plan's limits before migration
- Excess resources (e.g., domains over limit) must be removed before the new client is created
- The API should validate resource counts during client creation and reject if limits are exceeded

---

### 3. Domain Management

#### GET `/api/v1/clients/{id}/domains`
List domains for a client.

**Query Parameters:** Same as `/clients` (limit, offset, search)

**Response:**
```json
{
  "success": true,
  "data": [ { ... Domain objects ... } ],
  "pagination": { ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/domains`
Create a new domain for a client with configurable DNS mode.

**Request Body (Primary Mode - Full Delegation):**
```json
{
  "name": "www.acme.com",
  "dns_mode": "primary",
  "registrar": "namecheap"
}
```

**Request Body (CNAME Mode - Customer-Managed DNS):**
```json
{
  "name": "www.acme.com",
  "dns_mode": "cname"
}
```

**Request Body (Secondary Mode - Backup DNS):**
```json
{
  "name": "www.acme.com",
  "dns_mode": "secondary",
  "primary_nameserver": "ns.godaddy.com",
  "primary_ns_ip": "1.2.3.4"
}
```

**Validation:**
- `name` — Valid FQDN format (RFC 1035)
- `dns_mode` — Required, one of: `primary` | `cname` | `secondary`
- `primary_nameserver` — Required if `dns_mode == "secondary"` (FQDN of customer's primary NS)
- `primary_ns_ip` — Required if `dns_mode == "secondary"` (IP of customer's primary NS)
- `registrar` — Optional, one of: `namecheap`, `godaddy`, `cloudflare`, `manual`

**Response (201 Created) - Primary Mode:**
```json
{
  "success": true,
  "data": {
    "id": "domain_042",
    "name": "www.acme.com",
    "dns_mode": "primary",
    "status": "delegated",
    "dns": {
      "nameservers": ["ns1.k8s.local", "ns2.k8s.local", "ns3.k8s.local"],
      "action": "Update your domain registrar to use these nameservers"
    },
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Response (201 Created) - CNAME Mode:**
```json
{
  "success": true,
  "data": {
    "id": "domain_042",
    "name": "www.acme.com",
    "dns_mode": "cname",
    "status": "cname_pending",
    "dns": {
      "cname_target": "hosting.platform.com",
      "action": "Create CNAME record: www.acme.com → hosting.platform.com"
    },
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Response (201 Created) - Secondary Mode:**
```json
{
  "success": true,
  "data": {
    "id": "domain_042",
    "name": "www.acme.com",
    "dns_mode": "secondary",
    "status": "secondary_pending",
    "dns": {
      "platform_nameserver": "ns1.k8s.local",
      "primary_nameserver": "ns.godaddy.com",
      "action": "Add this nameserver as secondary: ns1.k8s.local (IP will be assigned)"
    },
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 409

**Side Effects (Conditional on dns_mode):**

*Primary Mode:*
- Creates PowerDNS zone (Primary)
- Generates SSL certificate (Let's Encrypt ACME DNS-01)
- Configures NGINX ingress rules
- Sends nameserver delegation instructions to admin
- Logs to audit trail

*CNAME Mode:*
- Skips PowerDNS zone creation
- Generates SSL certificate (Let's Encrypt HTTP-01, not DNS-01)
- Configures NGINX ingress rules (routes by Host header)
- Sends CNAME target instructions to admin
- Logs to audit trail

*Secondary Mode:*
- Creates PowerDNS zone (Secondary, not Primary)
- Configures zone as slave, accepts AXFR from primary NS
- Generates SSL certificate (Let's Encrypt HTTP-01)
- Configures NGINX ingress rules
- Sends secondary nameserver setup instructions to admin
- Initiates first AXFR from primary NS
- Logs to audit trail

---

#### PATCH `/api/v1/clients/{id}/domains/{domain_id}`
Update domain settings and DNS configuration.

**Request Body (optional — SSL/Routing):**
```json
{
  "ssl_auto_renew": true,
  "redirect_to": "https://example.com"
}
```

**Request Body (DNS Mode Change) — Admin Only:**
```json
{
  "dns_mode": "secondary",
  "primary_nameserver": "ns.godaddy.com",
  "primary_ns_ip": "1.2.3.4"
}
```

**Allowed Updates:**
- `ssl_auto_renew` — Enable/disable automatic SSL renewal (true/false)
- `redirect_to` — Permanent redirect target URL
- `dns_mode` — **Migration only** (primary → cname, primary → secondary, etc.)
- `primary_nameserver` — Update secondary NS primary authority (if dns_mode == secondary)
- `primary_ns_ip` — Update secondary NS primary authority IP (if dns_mode == secondary)

**DNS Mode Migration Rules:**
- Primary → CNAME: Allowed (removes zone delegation)
- Primary → Secondary: Allowed (converts zone to secondary)
- CNAME → Primary: ❌ Not allowed (customer must delete and recreate)
- CNAME → Secondary: Allowed (creates secondary zone)
- Secondary → Primary: Allowed (converts to primary)
- Secondary → CNAME: Allowed (removes zone)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "domain_042",
    "name": "www.acme.com",
    "dns_mode": "secondary",
    "status": "secondary_active",
    "dns": {
      "mode": "secondary",
      "primary_nameserver": "ns.godaddy.com",
      "platform_nameserver": "ns1.k8s.local",
      "axfr_status": "synced",
      "last_axfr": "2025-03-01T15:32:00Z"
    }
  }
}
```

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects (DNS Mode Change):**
- Old PowerDNS zone configuration removed (or converted)
- New PowerDNS zone configuration created
- SSL certificate regenerated if needed (DNS-01 → HTTP-01 or vice versa)
- Zone propagation status reset to pending
- Admin notified of migration
- Audit log created

---

#### DELETE `/api/v1/clients/{id}/domains/{domain_id}`
Delete a domain.

**Query Parameters:**
- `purge_dns` (optional) — Remove PowerDNS zone too

**Status Codes:** 200, 401, 403, 404

---

### 3a. Protected Directories (Password-Protected Paths)

#### POST `/api/v1/clients/{id}/domains/{domain_id}/protected-directories`
Create a new password-protected directory.

**Request Body:**
```json
{
  "path": "/admin/",
  "realm": "Admin Panel"
}
```

**Validation:**
- `path` — Required, starts with `/`, ends with `/`, valid path chars only
- `realm` — Required, 5-100 chars, human-readable name

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "protdir_001",
    "path": "/admin/",
    "realm": "Admin Panel",
    "status": "active",
    "users_count": 0,
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 409

**Side Effects:**
- Creates .htpasswd file
- Updates NGINX config with auth_basic block
- Reloads NGINX gracefully
- Logs to audit trail

---

#### GET `/api/v1/clients/{id}/domains/{domain_id}/protected-directories`
List all protected directories for a domain.

**Query Parameters:**
- `status` (optional) — Filter: `active`, `disabled`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "protdir_001",
      "path": "/admin/",
      "realm": "Admin Panel",
      "status": "active",
      "users_count": 3,
      "created_at": "2025-03-01T10:00:00Z"
    }
  ],
  "pagination": { ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}`
Get protected directory details including users.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "protdir_001",
    "path": "/admin/",
    "realm": "Admin Panel",
    "status": "active",
    "users": [
      {
        "id": "user_001",
        "username": "admin",
        "description": "System administrator",
        "is_active": true,
        "expires_at": null,
        "created_at": "2025-03-01T10:00:00Z",
        "last_used": "2025-03-01T14:32:00Z"
      }
    ]
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}`
Update protected directory settings.

**Request Body:**
```json
{
  "realm": "Admin Portal (Updated)",
  "status": "disabled"
}
```

**Allowed Updates:**
- `realm` — Change display name
- `status` — `active` or `disabled`

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects:**
- Updates NGINX config (removes auth_basic if disabled)
- Reloads NGINX
- Logs to audit trail

---

#### DELETE `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}`
Delete a protected directory.

**Query Parameters:**
- `force` (optional) — Force delete

**Status Codes:** 200, 401, 403, 404

**Side Effects:**
- Removes auth_basic block from NGINX config
- Deletes .htpasswd file
- Reloads NGINX
- Logs to audit trail

---

#### POST `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users`
Create a new user for protected directory.

**Request Body:**
```json
{
  "username": "contractor",
  "password": "SecurePassword123!",
  "description": "External contractor - project X",
  "expires_at": "2026-04-01T00:00:00Z"
}
```

**Validation:**
- `username` — Required, 3-50 chars, alphanumeric + underscore/dash
- `password` — Required, 8-128 chars
- `description` — Optional, 0-255 chars
- `expires_at` — Optional, ISO 8601 datetime

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "user_002",
    "username": "contractor",
    "description": "External contractor - project X",
    "is_active": true,
    "expires_at": "2026-04-01T00:00:00Z",
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 409

**Side Effects:**
- Generates bcrypt hash of password
- Appends to .htpasswd file
- Reloads NGINX
- Logs to audit trail

---

#### GET `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users`
List users for protected directory.

**Query Parameters:**
- `include_expired` (default: false) — Include expired users
- `sort` (default: created_at) — Sort by: `username`, `created_at`, `expires_at`, `last_used`

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users/{user_id}/change-password`
Change user password.

**Request Body:**
```json
{
  "new_password": "NewSecurePassword456!"
}
```

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects:**
- Regenerates bcrypt hash
- Updates .htpasswd file
- Reloads NGINX
- Logs to audit trail

---

#### POST `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users/{user_id}/disable`
Disable user access.

**Status Codes:** 200, 401, 403, 404

**Side Effects:**
- Sets is_active = false
- Removes from .htpasswd file
- Reloads NGINX
- Active sessions immediately invalidated

---

#### DELETE `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users/{user_id}`
Delete user.

**Status Codes:** 200, 401, 403, 404

**Side Effects:**
- Removes from database and .htpasswd file
- Reloads NGINX
- Logs to audit trail

---

### 3b. Hosting Settings (Domain Behavior Configuration)

> **Status:** Endpoints defined in `06-features/HOSTING_SETTINGS_SPECIFICATION.md`. Summary included here for completeness. Full request/response schemas are in the feature spec.

Manages per-domain hosting behavior: WWW/HTTPS redirects, external forwarding, webroot path, and enable/disable.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/clients/{id}/domains/{domain_id}/hosting-settings` | Get current hosting settings |
| `PATCH` | `/api/v1/clients/{id}/domains/{domain_id}/hosting-settings` | Update hosting settings (partial) |
| `POST` | `/api/v1/clients/{id}/domains/{domain_id}/hosting-settings/rollback` | Rollback to previous config |

**Configurable Settings:**
- `redirect_www` — `"to_www"`, `"to_non_www"`, or `"disabled"`
- `redirect_https` — `true` / `false`
- `forward_external` — External URL or `null`
- `webroot_path` — Document root (e.g., `/public/`, `/httpdocs/`)
- `hosting_enabled` — `true` / `false` (disable without deleting files)

See **HOSTING_SETTINGS_SPECIFICATION.md** for complete endpoint schemas, conflict detection rules, and subdomain support.

---

### 3c. Web Server & PHP Version Switching

#### GET `/api/v1/clients/{id}/catalog`
Get available catalog images for this client.

**Query Parameters:**
- `include_current` (default: true) — Include current image
- `show_deprecated` (default: false) — Show deprecated images

**Response:**
```json
{
  "success": true,
  "data": {
    "current_image": {
      "id": "apache-php83",
      "web_server": "Apache 2.4",
      "php_version": "8.3",
      "status": "active"
    },
    "available_images": [
      {
        "id": "apache-php84",
        "web_server": "Apache 2.4",
        "php_version": "8.4",
        "status": "active"
      },
      {
        "id": "nginx-php84",
        "web_server": "NGINX 1.25",
        "php_version": "8.4",
        "status": "active"
      }
    ],
    "plan_restrictions": {
      "web_server_change": "ALLOWED",
      "reason": "Business plan allows full flexibility"
    }
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/catalog/{image_id}/compatibility-check`
Run pre-flight compatibility checks before switching.

**Request Body:**
```json
{
  "target_image": "nginx-php84",
  "dry_run": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "source_image": "apache-php83",
    "target_image": "nginx-php84",
    "compatibility_score": 87,
    "estimated_success": "HIGH",
    "can_auto_migrate": true,
    "issues": [
      {
        "severity": "CRITICAL",
        "category": "apache_directive",
        "line": 5,
        "file": ".htaccess",
        "directive": "SetHandler",
        "message": "Not supported in NGINX",
        "suggestion": "Remove or convert to location block"
      }
    ],
    "recommendations": [
      "Fix 1 critical issue before switching"
    ]
  }
}
```

**Status Codes:** 200, 400, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}/catalog_image`
Switch to a new catalog image (web server / PHP version).

**Request Body:**
```json
{
  "target_image": "nginx-php84",
  "force": false,
  "backup_before_switch": true,
  "auto_rollback_on_failure": true,
  "reason": "Performance optimization"
}
```

**Parameters:**
- `target_image` — Catalog image ID (required)
- `force` (default: false) — Skip compatibility checks (admin only)
- `backup_before_switch` (default: true) — Create backup first
- `auto_rollback_on_failure` (default: true) — Auto-rollback on health check failure
- `reason` (optional) — Reason for switch (audit trail)

**Response (202 Accepted):**
```json
{
  "success": true,
  "data": {
    "switch_id": "sw_abc123xyz",
    "status": "in_progress",
    "source_image": "apache-php83",
    "target_image": "nginx-php84",
    "created_at": "2025-03-01T10:00:00Z",
    "estimated_completion": "2025-03-01T10:03:00Z",
    "progress": {
      "current_step": 1,
      "total_steps": 6,
      "step_name": "Running pre-flight checks"
    }
  }
}
```

**Status Codes:** 202, 400, 401, 403, 409 (already switching), 422 (compatibility issues)

**Side Effects:**
- Compatibility checks run automatically
- Backup created (if enabled)
- New pod created with target image
- Health checks initiated
- Ingress updated when ready
- Old pod gracefully shutdown
- Audit log entry created

---

#### GET `/api/v1/clients/{id}/catalog_image/{switch_id}`
Get status of an in-progress or completed switch.

**Response:**
```json
{
  "success": true,
  "data": {
    "switch_id": "sw_abc123xyz",
    "status": "in_progress",
    "source_image": "apache-php83",
    "target_image": "nginx-php84",
    "progress": {
      "current_step": 3,
      "total_steps": 6,
      "step_name": "Waiting for new pod to be ready",
      "percentage": 50
    },
    "timeline": [
      {
        "step": 1,
        "name": "Pre-flight checks",
        "status": "completed",
        "duration_seconds": 5
      },
      {
        "step": 2,
        "name": "Backup creation",
        "status": "completed",
        "duration_seconds": 12
      },
      {
        "step": 3,
        "name": "New pod startup",
        "status": "in_progress",
        "duration_seconds": 15
      }
    ],
    "estimated_completion": "2025-03-01T10:03:00Z"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/catalog_image/{switch_id}/cancel`
Cancel an in-progress switch.

**Response:**
```json
{
  "success": true,
  "message": "Switch cancelled. Old pod remains active.",
  "data": {
    "switch_id": "sw_abc123xyz",
    "status": "cancelled",
    "active_image": "apache-php83"
  }
}
```

**Status Codes:** 200, 400 (too late to cancel), 401, 403, 404

---

#### POST `/api/v1/clients/{id}/catalog_image/rollback`
Rollback to the previous catalog image.

**Request Body:**
```json
{
  "reason": "Application compatibility issues"
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "data": {
    "switch_id": "sw_rollback_xyz",
    "status": "in_progress",
    "previous_image": "apache-php83",
    "rolling_back_from": "nginx-php84"
  }
}
```

**Status Codes:** 202, 400 (no previous image), 401, 403, 404

---

#### GET `/api/v1/clients/{id}/catalog_image/history`
View switch history with timeline and outcomes.

**Query Parameters:**
- `limit` (default: 50)
- `offset` (default: 0)
- `status` (optional) — Filter: `completed`, `failed`, `cancelled`, `rolling_back`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "switch_id": "sw_abc123xyz",
      "source_image": "apache-php83",
      "target_image": "nginx-php84",
      "status": "completed",
      "initiated_by": "admin@platform.local",
      "reason": "Performance optimization",
      "created_at": "2025-02-28T14:30:00Z",
      "completed_at": "2025-02-28T14:33:15Z",
      "duration_seconds": 195,
      "health_check_result": "PASS"
    }
  ],
  "pagination": { ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

### 3d. Database Management

#### GET `/api/v1/clients/{id}/databases`
List databases for a client.

**Response:**
```json
{
  "success": true,
  "data": [ { ... Database objects ... } ],
  "pagination": { ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/databases`
Create a new database.

**Request Body:**
```json
{
  "type": "mysql",
  "version": "8.0",
  "name": "acme_prod",
  "size_gb": 10
}
```

**Validation:**
- `type` — `mysql` or `postgresql`
- `version` — Supported version for type
- `name` — 3-64 alphanumeric chars, no spaces
- `size_gb` — 1-500 (within quota)

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "db_128",
    "type": "mysql",
    "name": "acme_prod",
    "status": "provisioning",
    "credentials": {
      "username": "acme_prod_u",
      "password": "...",
      "host": "mysql-primary.k8s.local",
      "port": 3306
    },
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Error Codes:** `QUOTA_EXCEEDED`, `INVALID_SIZE`, `TYPE_NOT_SUPPORTED`

**Status Codes:** 201, 400, 401, 403, 429

**Side Effects:**
- Provisions database instance or shared slot
- Generates random password
- Configures backup scheduling
- Sends credentials to client via email
- Logs to audit trail

---

#### GET `/api/v1/clients/{id}/databases/{db_id}`
Get database details including credentials.

**Response:**
```json
{
  "success": true,
  "data": { ... Database object with current credentials ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}/databases/{db_id}/credentials`
Rotate database password.

**Request Body:**
```json
{
  "action": "rotate"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "db_128",
    "credentials": {
      "username": "acme_prod_u",
      "password": "...",
      "host": "mysql-primary.k8s.local"
    },
    "previous_password_valid_until": "2025-03-08T10:00:00Z"
  }
}
```

**Notes:** Old password remains valid for 7 days for graceful migration.

**Status Codes:** 200, 400, 401, 403, 404

---

#### DELETE `/api/v1/clients/{id}/databases/{db_id}`
Delete a database.

**Query Parameters:**
- `force` (optional) — Force delete even if data exists

**Status Codes:** 200, 400, 401, 403, 404

---

### 3e. Cron Jobs (Scheduled Tasks)

Manage customer cron jobs — recurring scheduled tasks executed on Kubernetes CronJob resources. See **CUSTOMER_CRON_JOBS.md** for detailed architecture, database schema, and implementation guide.

#### GET `/api/v1/clients/{id}/cron-jobs`

List all cron jobs for a customer.

**Query Parameters:**
- `enabled` (optional) — Filter: `true`, `false`
- `page` (optional, default: 1) — Pagination page
- `limit` (optional, default: 20, max: 100) — Items per page
- `sort` (optional, default: `-created_at`) — Sort field; prefix `-` for descending

**Response:**
```json
{
  "data": [
    {
      "id": "cron_abc123",
      "customer_id": 123,
      "name": "Daily backup",
      "description": "Backs up database to S3 every night at 2 AM",
      "schedule": "0 2 * * *",
      "timezone": "UTC",
      "script_path": "/cron/backup.php",
      "script_type": "php",
      "timeout_seconds": 600,
      "max_retries": 3,
      "enabled": true,
      "webhook_enabled": false,
      "next_run_at": "2026-03-02T02:00:00Z",
      "last_run_at": "2026-03-01T02:05:30Z",
      "last_status": "success",
      "last_exit_code": 0,
      "created_at": "2026-01-15T10:30:00Z",
      "updated_at": "2026-01-15T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/cron-jobs/{job_id}`

Get details of a specific cron job.

**Response:**
```json
{
  "data": {
    "id": "cron_abc123",
    "customer_id": 123,
    "name": "Daily backup",
    "schedule": "0 2 * * *",
    "timezone": "UTC",
    "script_path": "/cron/backup.php",
    "script_type": "php",
    "timeout_seconds": 600,
    "max_retries": 3,
    "enabled": true,
    "webhook_enabled": false,
    "webhook_url": null,
    "next_run_at": "2026-03-02T02:00:00Z",
    "last_run_at": "2026-03-01T02:05:30Z",
    "last_status": "success",
    "last_exit_code": 0,
    "plan_limit": {
      "max_jobs": 2,
      "current_count": 1,
      "can_create_more": true
    },
    "plan_capabilities": {
      "max_timeout": 300,
      "supports_webhooks": true,
      "max_retries": 3
    },
    "created_at": "2026-01-15T10:30:00Z",
    "updated_at": "2026-01-15T10:30:00Z"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/cron-jobs`

Create a new cron job for a customer.

**Request Body:**
```json
{
  "name": "Daily backup",
  "description": "Backs up database to S3 every night at 2 AM",
  "schedule": "0 2 * * *",
  "timezone": "America/New_York",
  "script_path": "/cron/backup.php",
  "script_type": "php",
  "timeout_seconds": 600,
  "max_retries": 3,
  "enabled": true,
  "webhook_enabled": false,
  "webhook_url": null,
  "webhook_secret": null
}
```

**Validation:**
- `name` — Required, 1-255 chars, unique per customer
- `schedule` — Required, valid crontab format (validated with crontab parser)
- `script_path` — Required if `script_type` != 'inline', 1-512 chars
- `inline_command` — Required if `script_type` = 'inline', 1-2000 chars
- `script_type` — One of: 'php', 'shell', 'python', 'node', 'inline'
- `timezone` — Valid IANA timezone (e.g., "UTC", "America/New_York")
- `timeout_seconds` — 60-1800 (1-30 min, limited by plan)
- `max_retries` — 0-5
- `webhook_url` — Optional, must be valid HTTPS URL if provided
- **Plan check:** Customer must have available job slots (based on plan)

**Response:**
```json
{
  "data": {
    "id": "cron_abc123",
    "customer_id": 123,
    "name": "Daily backup",
    "schedule": "0 2 * * *",
    "timezone": "UTC",
    "script_path": "/cron/backup.php",
    "script_type": "php",
    "timeout_seconds": 600,
    "max_retries": 3,
    "enabled": true,
    "webhook_enabled": false,
    "next_run_at": "2026-03-02T02:00:00Z",
    "last_run_at": null,
    "last_status": "pending",
    "created_at": "2026-03-01T10:30:00Z",
    "updated_at": "2026-03-01T10:30:00Z"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}/cron-jobs/{job_id}`

Update a cron job configuration.

**Request Body (all fields optional):**
```json
{
  "name": "Daily backup (updated)",
  "description": "...",
  "schedule": "0 3 * * *",
  "timezone": "America/New_York",
  "timeout_seconds": 900,
  "max_retries": 5,
  "webhook_url": "https://example.com/webhooks/cron",
  "webhook_secret": "whsec_abc123xyz"
}
```

**Note:** Cannot change `script_path` or `script_type` via update; delete and recreate to change script.

**Response:** Same as GET detail

**Status Codes:** 200, 400, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/cron-jobs/{job_id}/enable`
#### POST `/api/v1/clients/{id}/cron-jobs/{job_id}/disable`

Enable or disable a cron job without deleting it.

**Response:**
```json
{
  "data": {
    "id": "cron_abc123",
    "enabled": true,
    "updated_at": "2026-03-01T11:20:00Z"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### DELETE `/api/v1/clients/{id}/cron-jobs/{job_id}`

Permanently delete a cron job (soft delete; data retained 30 days).

**Status Codes:** 204, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/cron-jobs/{job_id}/runs`

Retrieve execution history for a cron job.

**Query Parameters:**
- `status` (optional) — Filter: 'pending', 'running', 'success', 'failed', 'timeout'
- `page` (optional, default: 1) — Pagination page
- `limit` (optional, default: 20, max: 100) — Items per page
- `days` (optional, default: 30) — Show last N days of history

**Response:**
```json
{
  "data": [
    {
      "id": "run_xyz789",
      "cron_job_id": "cron_abc123",
      "started_at": "2026-03-01T02:00:05Z",
      "completed_at": "2026-03-01T02:05:30Z",
      "duration_seconds": 325,
      "exit_code": 0,
      "status": "success",
      "error_message": null,
      "stdout": "Backup started...\nConnected to S3...\nUpload complete.",
      "stderr": null,
      "output_size_bytes": 450,
      "webhook_sent": false,
      "webhook_response_code": null,
      "created_at": "2026-03-01T02:00:05Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 30,
    "pages": 2
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/cron-jobs/{job_id}/last-run`

Quick endpoint to get only the most recent execution (for monitoring/dashboards).

**Response:**
```json
{
  "data": {
    "id": "run_xyz789",
    "cron_job_id": "cron_abc123",
    "started_at": "2026-03-01T02:00:05Z",
    "completed_at": "2026-03-01T02:05:30Z",
    "duration_seconds": 325,
    "exit_code": 0,
    "status": "success",
    "error_message": null,
    "stdout": "Backup started...\nConnected to S3...\nUpload complete.",
    "stderr": null,
    "webhook_sent": false
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/cron-jobs/{job_id}/trigger`

Immediately execute a cron job, regardless of schedule (manual trigger).

**Response (202 Accepted):**
```json
{
  "data": {
    "id": "run_xyz789",
    "cron_job_id": "cron_abc123",
    "status": "pending",
    "started_at": "2026-03-01T12:30:00Z",
    "message": "Job triggered manually; execution in progress"
  }
}
```

**Status Codes:** 202, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/cron-jobs/validate-schedule`

Validate a crontab schedule string without creating a job.

**Request Body:**
```json
{
  "schedule": "0 2 * * *",
  "timezone": "America/New_York"
}
```

**Response (valid):**
```json
{
  "valid": true,
  "description": "At 02:00 every day",
  "next_runs": [
    "2026-03-02T02:00:00-05:00",
    "2026-03-03T02:00:00-05:00",
    "2026-03-04T02:00:00-05:00"
  ]
}
```

**Response (invalid):**
```json
{
  "valid": false,
  "error": "Invalid schedule: field 'day of month' value 32 is out of range (1-31)"
}
```

**Status Codes:** 200, 400, 401, 403

---

#### GET `/api/v1/admin/cron-jobs` (admin-only)

View all cron jobs across all customers.

**Query Parameters:**
- `customer_id` (optional) — Filter by customer
- `status` (optional) — Filter by status
- `enabled` (optional) — Filter by enabled/disabled
- `limit` (optional) — Items per page

**Response:** List of cron jobs with `customer_id` field for each

**Status Codes:** 200, 401, 403

---

#### POST `/api/v1/admin/cron-jobs/{job_id}/force-run` (admin-only)

Immediately execute any customer's cron job (admin debugging).

**Response:** Same as manual trigger (202 Accepted)

**Status Codes:** 202, 401, 403, 404

---

#### POST `/api/v1/admin/cron-jobs/disable-all` (admin-only)

Disable all cron jobs for a customer.

**Request Body:**
```json
{
  "customer_id": 123,
  "reason": "Scheduled maintenance window"
}
```

**Response:**
```json
{
  "data": {
    "customer_id": 123,
    "disabled_count": 5,
    "message": "All cron jobs disabled"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

### 3f. File Transfer (FTP/FTPS/SFTP)

Manage customer FTP/SFTP users for file access and transfers. See **FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md** for detailed architecture, database schema, security model, and implementation guide.

#### GET `/api/v1/clients/{id}/ftp/users`

List all FTP/SFTP users for a customer.

**Query Parameters:**
- `enabled` (optional) — Filter: `true`, `false`
- `sort` (optional, default: `created_at`) — Sort field: `created_at`, `username`, `last_login_at`
- `order` (optional, default: `asc`) — Sort order: `asc`, `desc`
- `limit` (optional, default: 50, max: 100) — Items per page
- `offset` (optional, default: 0) — Pagination offset

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1,
      "username": "dev-user",
      "description": "Production CI/CD",
      "enabled": true,
      "created_at": "2026-02-15T10:30:00Z",
      "last_login_at": "2026-02-28T14:25:00Z",
      "allow_read": true,
      "allow_write": true,
      "allow_delete": false,
      "allow_rename": false,
      "allow_mkdir": false,
      "max_upload_monthly_mb": 1000,
      "max_download_monthly_mb": 5000,
      "expires_at": null,
      "protocols": ["SFTP", "FTPS"]
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 3
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/ftp/users`

Create a new FTP/SFTP user for a customer.

**Request Body:**
```json
{
  "username": "dev-staging",
  "description": "Staging environment deployment",
  "allow_read": true,
  "allow_write": true,
  "allow_delete": false,
  "allow_rename": false,
  "allow_mkdir": false,
  "max_upload_monthly_mb": 500,
  "max_download_monthly_mb": 2000,
  "expires_at": "2026-06-01T00:00:00Z",
  "ip_whitelist": "203.0.113.0/24,198.51.100.42",
  "auto_generate_password": true
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 4,
    "username": "dev-staging",
    "description": "Staging environment deployment",
    "enabled": true,
    "created_at": "2026-03-01T12:00:00Z",
    "allow_read": true,
    "allow_write": true,
    "allow_delete": false,
    "allow_rename": false,
    "allow_mkdir": false,
    "max_upload_monthly_mb": 500,
    "max_download_monthly_mb": 2000,
    "expires_at": "2026-06-01T00:00:00Z",
    "protocols": ["SFTP", "FTPS"],
    "temporary_password": "X7kM9pL2qR4sTv6wY8zAb"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 409 (username exists)

---

#### GET `/api/v1/clients/{id}/ftp/users/{user_id}`

Get details of a specific FTP/SFTP user.

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 4,
    "username": "dev-staging",
    "description": "Staging environment deployment",
    "enabled": true,
    "created_at": "2026-02-20T08:00:00Z",
    "last_login_at": "2026-02-28T16:45:00Z",
    "allow_read": true,
    "allow_write": true,
    "allow_delete": false,
    "allow_rename": false,
    "allow_mkdir": false,
    "max_upload_monthly_mb": 500,
    "max_download_monthly_mb": 2000,
    "expires_at": "2026-06-01T00:00:00Z",
    "ip_whitelist": "203.0.113.0/24,198.51.100.42",
    "session_timeout_minutes": 30,
    "max_concurrent_sessions": 3,
    "protocols": ["SFTP", "FTPS"],
    "password_rotated_at": "2026-02-20T08:00:00Z",
    "connection_info": {
      "sftp_host": "sftp.platform.com",
      "sftp_port": 22,
      "ftps_host": "ftp.platform.com",
      "ftps_port": 990
    }
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}/ftp/users/{user_id}`

Update an FTP/SFTP user.

**Request Body:** (all optional)
```json
{
  "description": "Updated description",
  "allow_read": true,
  "allow_write": true,
  "allow_delete": true,
  "allow_mkdir": true,
  "max_upload_monthly_mb": 2000,
  "expires_at": "2026-12-31T00:00:00Z",
  "ip_whitelist": null,
  "max_concurrent_sessions": 5
}
```

**Response:** Updated user object (same as GET endpoint)

**Status Codes:** 200, 400, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/ftp/users/{user_id}/rotate-password`

Rotate (change) the password for an FTP/SFTP user.

**Request Body (optional):**
```json
{
  "new_password": "newpass123",
  "notify_user": true
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 4,
    "username": "dev-staging",
    "new_password": "X7kM9pL2qR4sTv6wY8zAb",
    "password_rotated_at": "2026-03-01T12:30:00Z",
    "message": "Password rotated successfully"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### DELETE `/api/v1/clients/{id}/ftp/users/{user_id}`

Delete an FTP/SFTP user.

**Query Parameters:**
- `soft_delete` (optional, default: true) — Disable instead of delete (preserves audit log)
- `force_delete` (optional, default: false) — Permanently delete

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 4,
    "username": "dev-staging",
    "status": "deleted",
    "deleted_at": "2026-03-01T13:00:00Z"
  }
}
```

**Status Codes:** 204, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/ftp/users/{user_id}/audit-log`

View audit log for a specific FTP/SFTP user's file operations.

**Query Parameters:**
- `operation` (optional) — Filter: `UPLOAD`, `DOWNLOAD`, `DELETE`, `RENAME`, `MKDIR`, `CONNECT`, `DISCONNECT`
- `start_date` (optional) — ISO 8601 date (default: 30 days ago)
- `end_date` (optional) — ISO 8601 date (default: now)
- `limit` (optional, default: 100, max: 1000) — Items per page
- `offset` (optional, default: 0) — Pagination offset

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1024,
      "operation": "UPLOAD",
      "file_path": "css/style.css",
      "file_size_bytes": 2048,
      "source_ip": "203.0.113.45",
      "protocol": "SFTP",
      "status": "SUCCESS",
      "timestamp": "2026-02-28T14:25:30Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 245
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/ftp/users/{user_id}/bandwidth`

Get monthly bandwidth usage for an FTP/SFTP user.

**Query Parameters:**
- `year_month` (optional) — YYYY-MM format (default: current month)

**Response:**
```json
{
  "status": "success",
  "data": {
    "year_month": "2026-03",
    "upload_bytes": 52428800,
    "download_bytes": 104857600,
    "upload_mb": 50,
    "download_mb": 100,
    "max_upload_monthly_mb": 500,
    "max_download_monthly_mb": 2000,
    "upload_percentage": 10,
    "download_percentage": 5,
    "quota_warning": false
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/ftp/connection-info`

Get FTP/FTPS/SFTP connection information and recommended protocols.

**Response:**
```json
{
  "status": "success",
  "data": {
    "sftp": {
      "enabled": true,
      "host": "sftp.platform.com",
      "port": 22,
      "protocol": "SSH/SFTP",
      "cipher_suite": "Modern (TLS 1.3)"
    },
    "ftps": {
      "enabled": true,
      "host": "ftp.platform.com",
      "port": 990,
      "protocol": "FTPS (Explicit TLS)",
      "cipher_suite": "Strong (TLS 1.2+)"
    },
    "ftp_legacy": {
      "enabled": false,
      "host": "ftp.platform.com",
      "port": 21,
      "protocol": "FTP (Plaintext)"
    },
    "recommended": "SFTP on sftp.platform.com:22"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### PATCH `/api/v1/clients/{id}/ftp/settings`

Configure FTP/FTPS/SFTP protocols for customer.

**Request Body:**
```json
{
  "enable_sftp": true,
  "enable_ftps": true,
  "enable_ftp_legacy": false,
  "sftp_hostname": "sftp.platform.com",
  "ftps_hostname": "ftp.platform.com"
}
```

**Response:** Updated settings object

**Status Codes:** 200, 400, 401, 403

---

### 3g. Mailbox Import/Export (IMAP Migration)

Manage customer mailbox imports and exports via IMAP protocol. Supports migration from legacy platforms, email consolidation, and scheduled backups. See **MAILBOX_IMPORT_EXPORT_SPECIFICATION.md** for detailed architecture, deduplication strategy, credential management, and implementation guide.

#### POST `/api/v1/clients/{id}/email/import-jobs`

Create a new import job to import emails from external IMAP server.

**Request Body:**
```json
{
  "workflow_type": "CREATE_NEW_ACCOUNT",
  "new_email_address": "newemail@customer.com",
  
  "external_imap_host": "imap.gmail.com",
  "external_imap_port": 993,
  "external_imap_username": "oldaccount@gmail.com",
  "external_imap_password": "app_password_or_oauth_token",
  "external_imap_auth_type": "PASSWORD",
  
  "folder_mapping": {
    "Inbox": "Inbox",
    "[Gmail]/All Mail": "Archive"
  },
  
  "exclude_folders": ["[Gmail]/Spam", "[Gmail]/Trash"],
  "preserve_flags": true,
  "preserve_timestamps": true,
  "skip_duplicates": true,
  "schedule_type": "ONE_TIME"
}
```

**Response (201 Created):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "customer_id": 123,
    "new_email_address": "newemail@customer.com",
    "workflow_type": "CREATE_NEW_ACCOUNT",
    "status": "VALIDATING",
    "progress_percent": 0,
    "created_at": "2026-03-01T12:00:00Z"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 409

---

#### GET `/api/v1/clients/{id}/email/import-jobs`

List all import jobs for a customer.

**Query Parameters:**
- `status` (optional) — Filter: `CREATED`, `VALIDATING`, `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `FAILED`, `CANCELLED`
- `limit` (optional, default: 50, max: 100)
- `offset` (optional, default: 0)

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "job_id": "import_job_12345",
      "job_type": "IMPORT",
      "email_account_id": 456,
      "new_email_address": "newemail@customer.com",
      "status": "IN_PROGRESS",
      "progress_percent": 45,
      "total_emails": 5000,
      "transferred_emails": 2250,
      "skipped_emails": 50,
      "failed_emails": 0,
      "created_at": "2026-03-01T12:00:00Z",
      "estimated_completion_at": "2026-03-01T14:30:00Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 3
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/email/import-jobs/{job_id}`

Get details of a specific import job.

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "status": "IN_PROGRESS",
    "progress_percent": 45,
    "total_emails": 5000,
    "transferred_emails": 2250,
    "current_folder": "Inbox",
    "last_processed_uid": 3500,
    "preserve_flags": true,
    "preserve_timestamps": true,
    "folder_mapping": {
      "Inbox": "Inbox",
      "[Gmail]/All Mail": "Archive"
    }
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/email/import-jobs/{job_id}/pause`

Pause an in-progress import job. Can be resumed later from the same position.

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "status": "PAUSED",
    "paused_at": "2026-03-01T13:55:00Z",
    "last_processed_uid": 2250,
    "message": "Job paused. You can resume it later from the same position."
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/email/import-jobs/{job_id}/resume`

Resume a paused import job from the last position.

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "status": "RESUMING",
    "resumed_at": "2026-03-01T14:00:00Z",
    "message": "Job resumed. Continuing from position 2250 in Inbox."
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/email/import-jobs/{job_id}/cancel`

Cancel an import job.

**Query Parameters:**
- `cleanup_imported` (optional, default: false) — Delete imported emails if cancelling

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "status": "CANCELLED",
    "cancelled_at": "2026-03-01T14:05:00Z",
    "transferred_emails": 2250,
    "message": "Job cancelled. 2,250 emails were transferred."
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/email/import-jobs/{job_id}/audit-log`

View audit log for an import job.

**Query Parameters:**
- `event_type` (optional) — Filter by event type
- `limit` (optional, default: 100, max: 1000)
- `offset` (optional, default: 0)

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "event_id": 1001,
      "event_type": "JOB_STARTED",
      "event_data": {"folders_found": 8, "total_emails": 5000},
      "timestamp": "2026-03-01T12:05:00Z"
    },
    {
      "event_id": 1002,
      "event_type": "PROGRESS_UPDATE",
      "event_data": {"folder": "Inbox", "emails_transferred": 1000},
      "timestamp": "2026-03-01T12:20:00Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 150
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/email/test-imap-connection`

Test connection to external IMAP server before creating import job.

**Request Body:**
```json
{
  "external_imap_host": "imap.gmail.com",
  "external_imap_port": 993,
  "external_imap_username": "user@gmail.com",
  "external_imap_password": "app_password",
  "external_imap_auth_type": "PASSWORD"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "connected": true,
    "folders_found": 8,
    "total_emails": 5000,
    "folders": [
      {
        "name": "Inbox",
        "messages": 500,
        "unseen": 25,
        "selectable": true
      },
      {
        "name": "[Gmail]/All Mail",
        "messages": 5000,
        "selectable": true
      }
    ],
    "message": "Successfully connected and listed folders."
  }
}
```

**Status Codes:** 200, 400, 401, 403

---

#### POST `/api/v1/clients/{id}/email/export-jobs`

Create a new export job to export emails to external IMAP server.

**Request Body:**
```json
{
  "email_account_id": 456,
  
  "external_imap_host": "imap.backupservice.com",
  "external_imap_port": 993,
  "external_imap_username": "backup@backupservice.com",
  "external_imap_password": "backup_password",
  "external_imap_auth_type": "PASSWORD",
  
  "folder_mapping": {
    "Inbox": "Inbox",
    "Archive": "[Backup]/Archive"
  },
  
  "exclude_folders": ["Spam", "Trash"],
  "preserve_flags": true,
  "preserve_timestamps": true,
  "skip_duplicates": true,
  
  "schedule_type": "DAILY",
  "schedule_time": "02:00:00"
}
```

**Response (201 Created):** Similar to import job response

**Status Codes:** 201, 400, 401, 403, 409

---

#### GET `/api/v1/clients/{id}/email/export-jobs`

List all export jobs for a customer.

**Query Parameters:** Same as import jobs

**Response (200 OK):** Similar to import jobs list

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/clients/{id}/email/export-jobs/{job_id}`

Get details of a specific export job.

**Response (200 OK):** Similar to import job detail response

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/email/export-jobs/{job_id}/pause`

Pause an in-progress export job.

**Response (200 OK):** Similar to import job pause response

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/email/export-jobs/{job_id}/resume`

Resume a paused export job.

**Response (200 OK):** Similar to import job resume response

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/email/export-jobs/{job_id}/cancel`

Cancel an export job.

**Response (200 OK):** Similar to import job cancel response

**Status Codes:** 200, 401, 403, 404

---

### 4. Backup & Restore

#### GET `/api/v1/clients/{id}/backups`
List backups for a client.

**Query Parameters:**
- `type` (optional) — Filter: `application`, `database`, `full`
- `status` (optional) — Filter: `completed`, `failed`, `in_progress`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "backup_001",
      "type": "full",
      "created_at": "2025-02-28T23:00:00Z",
      "size_gb": 45.2,
      "status": "completed",
      "retention_until": "2025-05-30T23:00:00Z",
      "checksum": "sha256:abc123..."
    }
  ],
  "pagination": { ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### POST `/api/v1/clients/{id}/backups`
Trigger a manual backup.

**Request Body:**
```json
{
  "type": "full",
  "retention_days": 30
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "data": {
    "id": "backup_001",
    "status": "in_progress",
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Status Codes:** 202, 400, 401, 403

---

#### POST `/api/v1/clients/{id}/backups/{backup_id}/restore`
Restore from a backup.

**Request Body:**
```json
{
  "mode": "full",
  "target_date": "2025-02-28T23:00:00Z"
}
```

**Validation:**
- `mode` — `full` (all) or `selective` (specific items)
- `target_date` — Must be within backup retention

**Response (202 Accepted):**
```json
{
  "success": true,
  "data": {
    "restore_id": "restore_042",
    "status": "in_progress",
    "estimated_completion": "2025-03-01T10:30:00Z"
  }
}
```

**Status Codes:** 202, 400, 401, 403

**Critical Safety Checks:**
1. Verify checksum before restore
2. Create snapshot of current data before overwriting
3. If restore fails, rollback to snapshot
4. Send confirmation notification to client

---

### 5. Monitoring & Status

#### GET `/api/v1/clients/{id}/metrics`
Get resource usage metrics for a client.

**Query Parameters:**
- `period` (optional) — `hour`, `day`, `month` (default: `day`)
- `metric` (optional) — Specific metric name

**Response:**
```json
{
  "success": true,
  "data": {
    "cpu_percent": 34.5,
    "memory_mb": 512,
    "storage_gb": 34.2,
    "bandwidth_gb": 12.4,
    "requests_per_second": 45,
    "error_rate": 0.2,
    "uptime_percent": 99.98,
    "timestamp": "2025-03-01T10:00:00Z"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### GET `/api/v1/admin/status`
Get cluster health status (admin only).

**Response:**
```json
{
  "success": true,
  "data": {
    "cluster_status": "healthy",
    "nodes": 3,
    "pods_running": 145,
    "pods_failing": 2,
    "etcd_status": "healthy",
    "ingress_status": "healthy",
    "storage_status": "healthy",
    "database_status": "healthy",
    "last_backup": "2025-03-01T02:00:00Z",
    "backup_status": "completed"
  }
}
```

**Status Codes:** 200, 401, 403

---

## Error Handling

### Standard Error Response Format

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": {
      "field": "email",
      "reason": "Email already exists"
    },
    "trace_id": "abc-123-def-456"
  }
}
```

### Common HTTP Status Codes

| Code | Meaning | Example |
|------|---------|---------|
| 200 | Success | GET client details |
| 201 | Created | POST new client |
| 202 | Accepted (async) | POST restore job |
| 400 | Bad request | Invalid parameters |
| 401 | Unauthorized | Missing token |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not found | Client doesn't exist |
| 409 | Conflict | Duplicate email |
| 429 | Too many requests | Rate limited |
| 500 | Server error | Internal error |

### Error Codes Reference

| Code | HTTP | Cause | Retry? |
|------|------|-------|--------|
| `VALIDATION_ERROR` | 400 | Invalid input | No |
| `DUPLICATE_EMAIL` | 409 | Email exists | No |
| `QUOTA_EXCEEDED` | 429 | Over limit | No |
| `NOT_FOUND` | 404 | Resource missing | No |
| `UNAUTHORIZED` | 401 | Bad token | No |
| `FORBIDDEN` | 403 | No permission | No |
| `RATE_LIMITED` | 429 | Too many requests | Yes (retry later) |
| `INTERNAL_ERROR` | 500 | Server issue | Yes (retry later) |
| `SERVICE_UNAVAILABLE` | 503 | Maintenance | Yes (retry later) |

---

## Rate Limiting

### Rules
All requests require authentication (admin token). Rate limits:
- **Standard admin:** 100 requests/min per user
- **Service accounts:** 1000 requests/min (management API, automation)
- **Burst:** 200 requests/min for 1 minute

**Response Headers:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1625097600
```

**When Exceeded:**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Retry after 60 seconds."
  }
}
```

---

## Audit Logging

Every API call is logged with:
- Timestamp (ISO 8601)
- User ID (from token)
- HTTP method + endpoint
- Request parameters (excluding passwords)
- Response status code
- Response time (ms)
- IP address
- User agent

**Logs stored in:** Loki (via Fluent Bit)  
**Retention:** 1 year for admin actions, 90 days for read-only actions

---

## Implementation Notes

### Security
- All endpoints require OIDC token (except `/health`)
- HTTPS only (TLS 1.2+)
- Passwords never logged or cached
- Secrets stored in Kubernetes Sealed Secrets
- All responses gzipped

### CORS Configuration
- **Frontend Origin:** https://panel.platform.com (admin & client panels via path-based routing)
- **IP-Based Access:** https://{cluster-ip} (for direct IP access to admin panel)
- **Allowed Methods:** GET, POST, PATCH, DELETE, PUT
- **Allowed Headers:** Content-Type, Authorization, X-Panel-Role, X-Idempotency-Key
- **Credentials:** true (include cookies/auth headers)

**Example Implementation (Fastify — see ADR-011):**
```javascript
import { fastifyCors } from '@fastify/cors';

fastify.register(fastifyCors, {
  origin: [
    'https://panel.platform.com',        // Domain-based
    'https://admin.platform.com',        // Optional: alternate domain
    'https://client.platform.com',       // Optional: alternate domain
    `https://${process.env.CLUSTER_IP}`, // IP-based (restrict to actual cluster IP)
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Panel-Role', 'X-Idempotency-Key'],
  maxAge: 86400, // 24 hours
});
// Security: Never use a wildcard IP regex — always restrict to the specific cluster IP.
```

**Frontend API URL Configuration:**
- Development: `http://localhost:5000` (localhost API)
- Production: `https://api.platform.com` (absolute URL works for both domain and IP access)
- The frontend (React SPA) will make requests to `${API_URL}/api/v1/admin/*` and `${API_URL}/api/v1/client/*`

See **FRONTEND_DEPLOYMENT_ARCHITECTURE.md** for complete frontend/API integration details.

### Rate Limiting

API rate limiting protects against abuse and ensures fair usage. Implemented via `@fastify/rate-limit` backed by Redis.

| Scope | Limit | Window | Applies To |
|-------|-------|--------|------------|
| **Global (per IP)** | 100 requests | 1 minute | All endpoints |
| **Authentication** | 10 requests | 1 minute | `/auth/*`, failed login attempts |
| **Write operations** | 30 requests | 1 minute | POST, PATCH, DELETE |
| **Backup/restore** | 5 requests | 10 minutes | `/api/v1/clients/{id}/backups/*` |

**Response headers:**
- `X-RateLimit-Limit` — Maximum requests in window
- `X-RateLimit-Remaining` — Remaining requests
- `X-RateLimit-Reset` — Unix timestamp when window resets

**Rate limit exceeded response (429):**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Retry after 42 seconds.",
    "retry_after": 42
  }
}
```

**Implementation:**
```javascript
import rateLimit from '@fastify/rate-limit';

fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  redis: redisClient,  // Shared across API replicas
  keyGenerator: (request) => request.ip,
});
```

### Performance
- Cache GET responses for 5 minutes (except metrics)
- Index database queries on `client_id`, `created_at`
- Pagination required for list endpoints
- Async operations (backups, restores) return 202 status

### Idempotency
- POST operations with `idempotency_key` header (optional)
- Prevents duplicate charges on network retries

### Versioning
- Current version: `v1`
- URL scheme: `/api/v1/`
- Backward compatible changes: new fields, new endpoints
- Breaking changes: major version bump (e.g., `/api/v2/`)

---

## Example Workflows

### Create a Client with Domain (Admin Workflow)

```bash
# 1. Create client with subscription
# Admin creates new customer in external billing platform first,
# gets subscription ID, then provisions here
POST /api/v1/clients
{
  "name": "Acme Corp",
  "email": "admin@acme.com",
  "plan": "business",
  "subscription": {
    "expiry_date": "2026-03-01",
    "external_billing_id": "sub_stripe_12345",
    "notes": "New customer, 1-year annual plan"
  }
}
# Response: id=client_001

# 2. Check subscription status
GET /api/v1/clients/client_001/subscription
# Response: expiry_date=2026-03-01, status=active, days_until_expiry=365

# 3. Create domain
POST /api/v1/clients/client_001/domains
{ "name": "www.acme.com", "registrar": "namecheap", "registrar_api_key": "..." }
# Response: id=domain_042, status=pending_dns

# 4. Admin guides customer to update registrar nameservers to:
#    ns1.k8s.local, ns2.k8s.local

# 5. Verify domain is live
GET /api/v1/clients/client_001/domains/domain_042
# Response: status=active (once DNS propagates, ~5-30 minutes)
```

### Admin Workflow: Renew Customer Subscription

```bash
# External billing platform notifies platform of renewal
# Admin updates subscription in platform API

# 1. Check current subscription
GET /api/v1/clients/client_001/subscription
# Response: expiry_date=2025-03-01, days_until_expiry=10

# 2. Customer renews via external billing (e.g., Stripe)
# External platform sends webhook with new sub ID

# 3. Admin updates subscription in platform
PATCH /api/v1/clients/client_001/subscription
{
  "expiry_date": "2027-03-01",
  "external_billing_id": "sub_stripe_renewal_67890",
  "status": "active",
  "notes": "Renewed for 2 additional years"
}
# Response: expiry_date=2027-03-01, days_until_expiry=730

# 4. Automatic notifications sent to admin if subscription expires
# (see SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md)
```

---

## Related Documents

- [`FRONTEND_DEPLOYMENT_ARCHITECTURE.md`](./FRONTEND_DEPLOYMENT_ARCHITECTURE.md) — Frontend deployment, path-based routing, IP access, CORS setup
- [`FRONTEND_INGRESS_CONFIGURATIONS.md`](./FRONTEND_INGRESS_CONFIGURATIONS.md) — Kubernetes Ingress configs for frontend + API integration
- [`./DEPLOYMENT_PROCESS.md`](./DEPLOYMENT_PROCESS.md) — Client onboarding workflow that uses this API
- [`../02-operations/CLIENT_PANEL_FEATURES.md`](../02-operations/CLIENT_PANEL_FEATURES.md) — Frontend endpoints powered by this API
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Admin dashboard using this API
- [`../03-security/SECURITY_ARCHITECTURE.md`](../03-security/SECURITY_ARCHITECTURE.md) — Token validation, OIDC integration
- [`../02-operations/BACKUP_STRATEGY.md`](../02-operations/BACKUP_STRATEGY.md) — Backup endpoints implementation

---

## Implementation Checklist

- [ ] Set up Fastify app with middleware (logging, auth, error handling) — see ADR-011
- [ ] Implement database models (Knex/Prisma migrations)
- [ ] Create route handlers for all endpoints
- [ ] Add input validation (joi/zod schemas)
- [ ] Implement OIDC token verification (Dex integration)
- [ ] Add audit logging to every endpoint
- [ ] Implement rate limiting (redis-based)
- [ ] Add error handling middleware
- [ ] Create OpenAPI/Swagger documentation
- [ ] Add integration tests (Jest/Mocha)
- [ ] Set up CI/CD pipeline (GitHub Actions)
- [ ] Load test (artillery/k6)
- [ ] Security audit (OWASP top 10 checklist)

---

**Status:** Ready for implementation  
**Estimated Development Time:** 4-6 weeks (with testing)  
**Next Phase:** Implement Client Onboarding workflow using these endpoints
