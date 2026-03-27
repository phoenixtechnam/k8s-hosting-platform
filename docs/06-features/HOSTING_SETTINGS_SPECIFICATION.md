# Customer Hosting Settings Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, platform architects, support team

---

## Overview

This document specifies the **Hosting Settings** feature, enabling customers to configure domain behavior, redirection rules, external forwarding, and webroot paths without requiring manual interventions or hosting changes.

### Key Features

- **REDIRECT_TO_WWW** — Redirect non-www ↔ www (www.example.com or example.com)
- **REDIRECT_TO_HTTPS** — Force HTTPS for all traffic (HTTP → HTTPS 301)
- **FORWARD_TO_EXTERNAL** — Forward domain to external URL (e.g., forward to Shopify/WordPress.com)
- **DISABLE_WEB_HOSTING** — Disable without deleting files (temporary maintenance/suspension)
- **EDIT_WEBROOT_PATH** — Change document root (serve from subdirectory like `/public/` or `/httpdocs/`)
- **Per-Domain Configuration** — Each domain can have different settings
- **Subdomain Support** — Configure subdomains independently
- **Instant Application** — Changes take effect immediately (or within 10 seconds)
- **Audit Logging** — All configuration changes logged with user/timestamp
- **Admin Oversight** — Admins can view/modify customer settings
- **Conflict Prevention** — Detect conflicting rules (e.g., WWW redirect + external forward)
- **Rollback Support** — Quickly revert to previous configuration

### Use Cases

| Use Case | Example |
|----------|---------|
| **WWW normalization** | Redirect example.com → www.example.com (or vice versa) |
| **HTTPS enforcement** | Force all traffic to HTTPS for security |
| **Domain parking** | Forward unused domain to another site |
| **External forwarding** | Forward to Shopify, WordPress.com, or other services |
| **Subdomain routing** | blog.example.com serves from `/blog/` directory |
| **Temporary migration** | Forward old domain to new domain during migration |
| **Maintenance mode** | Disable hosting temporarily; restore files when ready |
| **Multi-site setup** | Different subdomains serve different webroots |
| **Domain testing** | Test config before pointing DNS |

---

## Architecture Overview

### High-Level Design

```
┌──────────────────────────────────────────────────────────────────┐
│ Customer Accesses Domain                                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ HTTP Request: GET http://example.com/                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Load Balancer / NGINX Ingress                                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ 1. Load domain configuration from database/cache:                │
│    ├─ redirect_to_www: true                                      │
│    ├─ redirect_to_https: true                                    │
│    ├─ forward_to_external: null                                  │
│    ├─ web_hosting_enabled: true                                  │
│    └─ webroot_path: /public/                                     │
│                                                                  │
│ 2. Apply rules in order:                                         │
│    ├─ Check if DISABLE_WEB_HOSTING: YES? → 503 Service Unavail. │
│    ├─ Check if FORWARD_TO_EXTERNAL: YES? → 301 to external URL  │
│    ├─ Check if REDIRECT_TO_HTTPS: YES? → 301 http → https       │
│    ├─ Check if REDIRECT_TO_WWW: YES?                             │
│    │  example.com → www.example.com (301)                        │
│    │  www.example.com → OK                                       │
│    └─ PASS: All checks passed                                    │
│                                                                  │
│ 3. Route to appropriate pod:                                     │
│    └─ Dedicated pod (all plans): /storage/customers/{id}/         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Backend Server (Apache/NGINX)                                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Document root: /var/www/html/ + webroot_path                    │
│ Example: /var/www/html/public/                                   │
│                                                                  │
│ Serve: /public/index.html (from webroot)                        │
│ Return: 200 OK + HTML content                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Configuration Modes

| Mode | State | Behavior | Use Case |
|------|-------|----------|----------|
| **ACTIVE** | Normal | Serve from webroot; apply redirects | Production hosting |
| **REDIRECT_TO_WWW** | Modifier | Redirect non-www → www | Domain normalization |
| **REDIRECT_TO_HTTPS** | Modifier | Enforce HTTPS | Security requirement |
| **FORWARD_TO_EXTERNAL** | Alternative | 301 redirect to external URL | Domain forwarding |
| **DISABLED** | Suspended | Return 503; files preserved | Temporary suspension |

**Rule Priority:**
```
IF DISABLED_WEB_HOSTING:
  RETURN 503 Service Unavailable
ELSE IF FORWARD_TO_EXTERNAL:
  RETURN 301 Redirect to external_url
ELSE IF REDIRECT_TO_HTTPS:
  RETURN 301 http → https
ELSE IF REDIRECT_TO_WWW:
  CHECK: www vs non-www
  RETURN 301 if needed
ELSE:
  SERVE from webroot
```

---

## Database Schema

### 1. `domain_hosting_config` — Per-domain hosting configuration

```sql
CREATE TABLE domain_hosting_config (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT UNSIGNED NOT NULL UNIQUE,
  
  -- Basic hosting status
  web_hosting_enabled BOOLEAN DEFAULT TRUE,
  -- FALSE: Disable hosting; return 503 Service Unavailable
  -- TRUE: Enable hosting; serve files normally
  
  -- Webroot configuration
  webroot_path VARCHAR(512) DEFAULT 'public_html/',
  -- Path relative to domain directory
  -- Examples: 'public_html/', 'public/', 'httpdocs/', 'public_html/blog/'
  -- Absolute path: /storage/customers/{customer_id}/domains/{domain}/{webroot_path}
  -- See ADR-016 for canonical file path layout
  
  -- WWW redirection
  redirect_to_www ENUM('NONE', 'ADD_WWW', 'REMOVE_WWW') DEFAULT 'NONE',
  -- NONE: No WWW redirection
  -- ADD_WWW: example.com → www.example.com (301)
  -- REMOVE_WWW: www.example.com → example.com (301)
  
  -- HTTPS enforcement
  redirect_to_https BOOLEAN DEFAULT FALSE,
  -- FALSE: Allow both HTTP and HTTPS
  -- TRUE: Redirect HTTP → HTTPS (301)
  
  https_redirect_code INT DEFAULT 301,
  -- 301: Permanent redirect
  -- 302: Temporary redirect
  -- 307: Temporary (preserve method)
  -- 308: Permanent (preserve method)
  
  -- External forwarding
  forward_to_external VARCHAR(2048),
  -- NULL: No forwarding
  -- URL: Forward to this URL (301 redirect)
  -- Examples: "https://shop.myshop.com", "https://mysite.wordpress.com"
  
  forward_external_code INT DEFAULT 301,
  -- Redirect status code for external forward
  
  forward_external_preserve_path BOOLEAN DEFAULT FALSE,
  -- TRUE: Forward /page/path → external_url/page/path
  -- FALSE: Forward all requests to external_url root
  
  forward_external_preserve_query BOOLEAN DEFAULT TRUE,
  -- TRUE: Forward /page?param=value → external?param=value
  -- FALSE: Strip query string
  
  -- Validation
  is_valid BOOLEAN DEFAULT TRUE,
  validation_error VARCHAR(512),
  -- Stores error message if config is invalid
  -- E.g., "Conflicting settings: forward_to_external + redirect_to_https"
  
  -- Domain label (informational only — no behavioral difference)
  config_label ENUM('PRODUCTION', 'STAGING', 'DEVELOPMENT') DEFAULT 'PRODUCTION',
  -- Informational tag displayed in client panel next to domain name
  -- Does NOT change hosting behavior — all domains are served identically
  -- Customers use this to visually distinguish dev/staging/production domains
  -- See ADR-016: promotion between environments is manual (FileBrowser copy or Git merge)
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id BIGINT UNSIGNED,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT UNSIGNED,
  
  -- Cache busting
  config_version INT DEFAULT 1,
  -- Increment on each change to invalidate caches
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_domain (domain_id),
  KEY idx_valid (is_valid),
  KEY idx_enabled (web_hosting_enabled)
);
```

### 2. `domain_config_audit_log` — Configuration change history

```sql
CREATE TABLE domain_config_audit_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT UNSIGNED NOT NULL,
  
  action ENUM('CONFIG_UPDATED', 'WWW_REDIRECT_CHANGED', 'HTTPS_REDIRECT_CHANGED', 
              'EXTERNAL_FORWARD_SET', 'EXTERNAL_FORWARD_REMOVED', 'WEBROOT_CHANGED',
              'WEB_HOSTING_DISABLED', 'WEB_HOSTING_ENABLED') NOT NULL,
  
  -- Change details
  old_value VARCHAR(1024),
  new_value VARCHAR(1024),
  
  field_name VARCHAR(100),
  -- E.g., "redirect_to_www", "webroot_path", "web_hosting_enabled"
  
  reason VARCHAR(512),
  -- Why the change was made
  
  -- Metadata
  changed_by_user_id BIGINT UNSIGNED,
  changed_by_user_type ENUM('CUSTOMER', 'ADMIN') DEFAULT 'CUSTOMER',
  changed_by_ip VARCHAR(45),
  
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_domain_timestamp (domain_id, timestamp),
  KEY idx_action (action),
  KEY idx_timestamp (timestamp)
);
```

### 3. `webroot_validation_log` — Track webroot path changes and errors

```sql
CREATE TABLE webroot_validation_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT UNSIGNED NOT NULL,
  
  requested_path VARCHAR(512),
  -- Path customer requested
  
  validation_status ENUM('SUCCESS', 'ERROR_NOT_FOUND', 'ERROR_PERMISSION', 
                         'ERROR_SYMLINK_ESCAPE', 'ERROR_SIZE_EXCEEDED') NOT NULL,
  
  resolved_path VARCHAR(1024),
  -- Absolute path after validation
  
  error_message VARCHAR(512),
  -- Detailed error message
  
  directory_exists BOOLEAN,
  directory_readable BOOLEAN,
  directory_size_bytes BIGINT UNSIGNED,
  file_count INT,
  
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  
  KEY idx_domain_status (domain_id, validation_status),
  KEY idx_timestamp (timestamp)
);
```

### 4. `domain_redirect_stats` — Track redirect performance

```sql
CREATE TABLE domain_redirect_stats (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT UNSIGNED NOT NULL,
  
  redirect_type ENUM('WWW', 'HTTPS', 'EXTERNAL') NOT NULL,
  
  -- Statistics
  requests_count INT DEFAULT 0,
  -- Number of requests that hit this redirect
  
  redirect_duration_ms DECIMAL(5,2),
  -- Average redirect processing time
  
  status_code INT DEFAULT 0,
  -- HTTP status code used (301, 302, etc.)
  
  date_hour TIMESTAMP,
  -- Hourly bucket for time-series data
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  
  UNIQUE KEY unique_stat (domain_id, redirect_type, date_hour),
  KEY idx_domain (domain_id)
);
```

---

## API Endpoints

### Customer Endpoints

#### 1. Get Hosting Configuration (GET)
```
GET /api/v1/customers/{customer_id}/domains/{domain_id}/hosting-config
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "domain_id": 456,
    "domain_name": "example.com",
    "web_hosting_enabled": true,
    "webroot_path": "/",
    "redirect_to_www": "ADD_WWW",
    "redirect_to_https": true,
    "forward_to_external": null,
    "config_mode": "PRODUCTION",
    "is_valid": true,
    "updated_at": "2026-02-28T10:00:00Z",
    "current_status": {
      "hosting": "active",
      "https": "enforced",
      "www": "redirect to www",
      "forwarding": "none"
    }
  }
}
```

#### 2. Update Hosting Configuration (PATCH)
```
PATCH /api/v1/customers/{customer_id}/domains/{domain_id}/hosting-config
```

**Request Body:**
```json
{
  "web_hosting_enabled": true,
  "webroot_path": "/public/",
  "redirect_to_www": "ADD_WWW",
  "redirect_to_https": true,
  "forward_to_external": null,
  "reason": "Deploying new version with /public/ webroot"
}
```

**Response (200 OK):** Updated configuration object

**Status Codes:** 200, 400 (invalid config), 401, 403, 404, 409 (conflict)

#### 3. Disable Web Hosting (POST)
```
POST /api/v1/customers/{customer_id}/domains/{domain_id}/disable-hosting
```

**Request Body:**
```json
{
  "reason": "Temporary maintenance",
  "message_to_visitors": "Currently under maintenance. Back soon!",
  "expected_duration_hours": 2
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "domain_id": 456,
    "web_hosting_enabled": false,
    "status_code": 503,
    "message": "Website hosting disabled for example.com",
    "files_preserved": true,
    "disabled_at": "2026-03-01T12:00:00Z"
  }
}
```

#### 4. Enable Web Hosting (POST)
```
POST /api/v1/customers/{customer_id}/domains/{domain_id}/enable-hosting
```

**Request Body:**
```json
{
  "reason": "Maintenance completed"
}
```

**Response (200 OK):** Updated configuration object

#### 5. Set WWW Redirection (PATCH)
```
PATCH /api/v1/customers/{customer_id}/domains/{domain_id}/redirect-www
```

**Request Body:**
```json
{
  "redirect_type": "ADD_WWW",  // or "REMOVE_WWW" or "NONE"
  "reason": "Domain normalization"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "redirect_to_www": "ADD_WWW",
    "message": "WWW redirect configured. Non-www requests will redirect to www.example.com",
    "preview": "example.com → www.example.com (301 Permanent)"
  }
}
```

#### 6. Set HTTPS Redirection (PATCH)
```
PATCH /api/v1/customers/{customer_id}/domains/{domain_id}/redirect-https
```

**Request Body:**
```json
{
  "enabled": true,
  "redirect_code": 301,  // 301 (permanent), 302 (temporary), 307 (preserve), 308 (preserve)
  "reason": "Security requirement"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "redirect_to_https": true,
    "redirect_code": 301,
    "message": "HTTPS redirect enabled",
    "preview": "http://example.com → https://example.com (301 Permanent)"
  }
}
```

#### 7. Set External Forward (PATCH)
```
PATCH /api/v1/customers/{customer_id}/domains/{domain_id}/forward-external
```

**Request Body:**
```json
{
  "forward_url": "https://shop.myshop.com",
  "redirect_code": 301,
  "preserve_path": false,
  "preserve_query": true,
  "reason": "Domain forwarded to Shopify store"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "forward_to_external": "https://shop.myshop.com",
    "preserve_path": false,
    "preserve_query": true,
    "message": "External forward configured",
    "preview": "example.com/* → https://shop.myshop.com (301 Permanent)"
  }
}
```

#### 8. Remove External Forward (DELETE)
```
DELETE /api/v1/customers/{customer_id}/domains/{domain_id}/forward-external
```

**Request Body:**
```json
{
  "reason": "Domain moved back in-house"
}
```

**Response (204 No Content)** or (200 OK) with confirmation

#### 9. Set Webroot Path (PATCH)
```
PATCH /api/v1/customers/{customer_id}/domains/{domain_id}/webroot
```

**Request Body:**
```json
{
  "webroot_path": "/public/",
  "validate_before_apply": true,  // Test path before applying
  "reason": "Updated application structure"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "webroot_path": "/public/",
    "absolute_path": "/storage/customers/123/public/",
    "directory_exists": true,
    "file_count": 1523,
    "directory_size_mb": 256,
    "message": "Webroot path updated to /public/",
    "changes_effective_at": "2026-03-01T12:00:10Z"
  }
}
```

**Status Codes:** 200, 400 (path not found), 401, 403, 404

#### 10. Validate Webroot Path (POST)
```
POST /api/v1/customers/{customer_id}/domains/{domain_id}/validate-webroot
```

**Request Body:**
```json
{
  "webroot_path": "/public/"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "path": "/public/",
    "valid": true,
    "absolute_path": "/storage/customers/123/public/",
    "directory_exists": true,
    "directory_readable": true,
    "directory_size_mb": 256,
    "file_count": 1523,
    "subdirectories": ["assets", "uploads", "config"],
    "index_files": ["index.html", "index.php"],
    "warnings": []
  }
}
```

**Error Response (400):**
```json
{
  "status": "error",
  "data": {
    "path": "/invalid/",
    "valid": false,
    "error": "Directory not found",
    "suggestions": [
      "/",
      "/public/",
      "/httpdocs/",
      "/html/"
    ]
  }
}
```

#### 11. Get Configuration History (GET)
```
GET /api/v1/customers/{customer_id}/domains/{domain_id}/hosting-config/history
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | int | Results per page (default: 50) |
| `offset` | int | Pagination offset |
| `action` | enum | Filter by action type |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1001,
      "action": "WEBROOT_CHANGED",
      "field_name": "webroot_path",
      "old_value": "/",
      "new_value": "/public/",
      "reason": "Updated application structure",
      "timestamp": "2026-02-28T14:30:00Z",
      "changed_by": "customer@example.com"
    },
    {
      "id": 1000,
      "action": "HTTPS_REDIRECT_CHANGED",
      "field_name": "redirect_to_https",
      "old_value": "false",
      "new_value": "true",
      "reason": "Security requirement",
      "timestamp": "2026-02-20T10:00:00Z",
      "changed_by": "customer@example.com"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 2
  }
}
```

#### 12. Get Redirect Statistics (GET)
```
GET /api/v1/customers/{customer_id}/domains/{domain_id}/redirect-stats
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `redirect_type` | enum | Filter: `WWW`, `HTTPS`, `EXTERNAL`, `ALL` |
| `days` | int | Last N days (default: 7) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "domain_id": 456,
    "statistics": [
      {
        "redirect_type": "HTTPS",
        "requests_count": 450,
        "percentage": 15.2,
        "avg_duration_ms": 0.5,
        "status_code": 301
      },
      {
        "redirect_type": "WWW",
        "requests_count": 120,
        "percentage": 4.1,
        "avg_duration_ms": 0.3,
        "status_code": 301
      },
      {
        "redirect_type": "EXTERNAL",
        "requests_count": 0,
        "percentage": 0,
        "status_code": null
      }
    ],
    "total_requests": 3000,
    "period": "Last 7 days"
  }
}
```

---

### Admin Endpoints

#### 1. List All Domain Configs (Admin) (GET)
```
GET /api/v1/admin/domains/hosting-config
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `customer_id` | int | Filter by customer |
| `web_hosting_enabled` | bool | Filter: enabled or disabled |
| `is_valid` | bool | Filter: valid or invalid configs |

**Response (200 OK):** List of all domain configurations

#### 2. Get Domain Config (Admin) (GET)
```
GET /api/v1/admin/domains/{domain_id}/hosting-config
```

**Response (200 OK):** Full domain configuration with all details

#### 3. Update Domain Config (Admin) (PATCH)
```
PATCH /api/v1/admin/domains/{domain_id}/hosting-config
```

**Request Body:** Same as customer endpoint, with admin-only fields:
```json
{
  "web_hosting_enabled": false,
  "reason": "Account suspended for non-payment",
  "admin_notes": "Suspension notice sent to customer"
}
```

**Response (200 OK):** Updated configuration

#### 4. Validate All Webroots (Admin) (POST)
```
POST /api/v1/admin/domains/validate-all-webroots
```

**Request Body:**
```json
{
  "customer_id": 123,  // Optional: validate only this customer's domains
  "fix_errors": false  // Optional: auto-fix broken webroots to /
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "total_domains": 42,
    "valid_configs": 40,
    "invalid_configs": 2,
    "issues": [
      {
        "domain_id": 456,
        "domain_name": "broken.example.com",
        "issue": "Webroot path /nonexistent/ does not exist",
        "suggestion": "Change to / or /public/",
        "fixed": false
      }
    ]
  }
}
```

---

## Web UI (Customer Panel)

### 1. Hosting Settings Dashboard

**Location:** `Control Panel → Domains → {domain} → Hosting Settings`

```
┌──────────────────────────────────────────────────────────────┐
│ Hosting Settings: example.com                          [Help] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Status: ✓ Active                                             │
│ Webroot: / (root directory)                                 │
│ HTTPS: ✓ Enforced                                            │
│ WWW: → redirect to www                                       │
│ Forwarding: None                                             │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ [Edit Hosting Settings] [View History] [Advanced]            │
│                                                              │
│ Quick Actions:                                              │
│ [Disable Temporarily] [Change Webroot] [Add Forward]        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2. Hosting Settings Editor

```
┌──────────────────────────────────────────────────────────────┐
│ Edit Hosting Settings: example.com                    [Close] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ ━━ WEB HOSTING STATUS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ ☑ Enable Web Hosting  [Temporarily Disable]                 │
│ (ℹ️ Disabling keeps all files; hosting returns 503)         │
│                                                              │
│ ━━ WEBROOT PATH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Document Root: [/_______________]  [Browse Directories]    │
│ (ℹ️ Path relative to your storage. Test before applying)    │
│                                                              │
│ Preview: /storage/customers/123/public/                     │
│ ✓ Directory exists | 1,523 files | 256 MB                  │
│ [Validate Path]                                             │
│                                                              │
│ ━━ DOMAIN REDIRECTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ WWW Redirect:                                               │
│ ◉ None (both example.com and www work)                     │
│ ○ Redirect to www (example.com → www.example.com)          │
│ ○ Redirect to non-www (www.example.com → example.com)      │
│                                                              │
│ ☑ Require HTTPS                                             │
│    Redirect Code: [301 - Permanent ▼]                       │
│    Preview: http://example.com → https://example.com       │
│                                                              │
│ ━━ EXTERNAL FORWARDING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ ☐ Forward to External Website                              │
│   Target URL: [________________________________]           │
│   (ℹ️ All requests forward to this URL)                     │
│                                                              │
│   Forward Options:                                          │
│   ☐ Preserve path (/page → external/page)                 │
│   ☑ Preserve query string (?param=value)                   │
│   Redirect Code: [301 - Permanent ▼]                       │
│                                                              │
│   Preview: example.com/* → target.com/* (301 Permanent)    │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Change Reason (for audit log):                             │
│ [Updated application structure; deployed new version_____]│
│                                                              │
│ [Save Settings] [Preview Changes] [Cancel]                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3. Disable Web Hosting Modal

```
┌──────────────────────────────────────────────────────────────┐
│ Temporarily Disable Web Hosting                       [Close] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ ⚠️ WARNING: This will make your website unavailable          │
│                                                              │
│ You can disable hosting temporarily without deleting any     │
│ files. Visitors will see a 503 Service Unavailable error.   │
│                                                              │
│ Reason for Disabling:                                       │
│ [Maintenance / Testing / Migration / Other]  [Other: ____]  │
│                                                              │
│ Expected Duration (optional):                               │
│ [2] hours                                                    │
│                                                              │
│ Custom Message to Visitors (optional):                      │
│ [Currently under maintenance. Back soon!________________]    │
│                                                              │
│ ✓ I understand that files will NOT be deleted                │
│ ✓ I understand that visitors will see 503 error            │
│                                                              │
│ [Disable Hosting] [Cancel]                                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4. Webroot Path Selector

```
┌──────────────────────────────────────────────────────────────┐
│ Change Webroot Path: example.com                      [Close] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Current Webroot: /                                           │
│                                                              │
│ Browse Directories:                                         │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ ► /                                                  │   │
│ │   ► assets/                                          │   │
│ │   ► config/                                          │   │
│ │   ► public/         ← Good choice for Laravel/Rails │   │
│ │     ► js/                                            │   │
│ │     ► css/                                           │   │
│ │   ► uploads/                                         │   │
│ │   ► vendor/                                          │   │
│ │   ► admin/          ← Not recommended (security)    │   │
│ │   ► httpdocs/       ← Available                      │   │
│ │   ► html/           ← Available                      │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                              │
│ OR Enter Path: [/public/_________________]                  │
│                                                              │
│ [Validate] → ✓ Valid (1,523 files, 256 MB)                │
│                                                              │
│ Recommended webroots (detected in your files):              │
│ • /public/ (Laravel detected: composer.json)               │
│ • /httpdocs/ (WordPress detected: wp-config.php)           │
│ • /html/ (Generic)                                         │
│                                                              │
│ [Apply Webroot] [Cancel]                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 5. Configuration History Page

```
┌──────────────────────────────────────────────────────────────┐
│ Hosting Configuration History: example.com             [↻]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Filters: [All Actions ▼] [Last 30 Days ▼]                 │
│                                                              │
│ ┌─────────────────────────────────────────────────────────┐│
│ │ Date       │ Action              │ Details              ││
│ ├─────────────────────────────────────────────────────────┤│
│ │ 2026-02-28 │ WEBROOT_CHANGED     │ / → /public/        ││
│ │ 14:30      │                     │ By: customer@ex.com ││
│ │            │                     │ Reason: Updated app ││
│ │            │                     │                     ││
│ │ 2026-02-20 │ HTTPS_REDIRECT...   │ false → true        ││
│ │ 10:00      │ CHANGED             │ By: customer@ex.com ││
│ │            │                     │ Reason: Security    ││
│ │            │                     │                     ││
│ │ 2026-02-01 │ WWW_REDIRECT...     │ NONE → ADD_WWW      ││
│ │ 08:30      │ CHANGED             │ By: admin@plat.com  ││
│ │            │                     │ Reason: Setup       ││
│ │            │                     │                     ││
│ └─────────────────────────────────────────────────────────┘│
│                                                              │
│ [Show More]                                                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. REDIRECT_TO_WWW Implementation

**NGINX Configuration:**
```nginx
# Example: redirect non-www to www
server {
  server_name example.com;
  listen 443 ssl http2;
  
  # Match domain config from cache/database
  set $redirect_to_www "ADD_WWW";  # From domain_hosting_config
  
  # Check if needs WWW redirect
  if ($redirect_to_www = "ADD_WWW") {
    if ($host != "www.example.com") {
      return 301 https://www.example.com$request_uri;
    }
  }
  
  # If matched, serve content
  location / {
    proxy_pass http://backend;
  }
}
```

**Decision Logic:**
```python
def apply_www_redirect(host, domain_config):
    if domain_config.redirect_to_www == "NONE":
        return None  # No redirect
    
    if domain_config.redirect_to_www == "ADD_WWW":
        if not host.startswith("www."):
            return 301, f"https://www.{host}/"
    
    elif domain_config.redirect_to_www == "REMOVE_WWW":
        if host.startswith("www."):
            clean_host = host[4:]  # Remove "www."
            return 301, f"https://{clean_host}/"
    
    return None
```

### 2. REDIRECT_TO_HTTPS Implementation

**NGINX Configuration:**
```nginx
server {
  server_name example.com www.example.com;
  listen 80;
  
  set $redirect_to_https "true";  # From domain_hosting_config
  set $https_redirect_code "301";  # Permanent or temporary
  
  if ($redirect_to_https = "true") {
    if ($scheme != "https") {
      return $https_redirect_code https://$host$request_uri;
    }
  }
  
  # Serve content on HTTPS
  location / {
    proxy_pass http://backend;
  }
}
```

### 3. FORWARD_TO_EXTERNAL Implementation

**NGINX Configuration:**
```nginx
server {
  server_name example.com www.example.com;
  
  set $forward_to_external "https://shop.myshop.com";
  set $forward_code "301";
  set $preserve_path "off";
  set $preserve_query "on";
  
  if ($forward_to_external != "") {
    # Build target URL
    if ($preserve_path = "off") {
      return $forward_code $forward_to_external;
    }
    
    if ($preserve_path = "on") {
      if ($preserve_query = "on") {
        return $forward_code "$forward_to_external$request_uri";
      }
      if ($preserve_query = "off") {
        return $forward_code "$forward_to_external$request_path";
      }
    }
  }
}
```

**Decision Logic:**
```python
def apply_external_forward(request_uri, domain_config):
    if not domain_config.forward_to_external:
        return None
    
    base_url = domain_config.forward_to_external
    
    if domain_config.forward_external_preserve_path:
        target = base_url + request_uri
    else:
        target = base_url
    
    if not domain_config.forward_external_preserve_query:
        # Strip query string
        target = target.split('?')[0]
    
    return domain_config.forward_external_code, target
```

### 4. DISABLE_WEB_HOSTING Implementation

**NGINX Configuration:**
```nginx
server {
  server_name example.com www.example.com;
  listen 443 ssl http2;
  
  set $web_hosting_enabled "true";  # From domain_hosting_config
  
  if ($web_hosting_enabled = "false") {
    return 503 "Service Unavailable";
  }
  
  location / {
    proxy_pass http://backend;
  }
}
```

**Response Body:**
```html
<!DOCTYPE html>
<html>
<head>
  <title>Service Unavailable</title>
</head>
<body>
  <h1>Service Unavailable</h1>
  <p>This website is temporarily unavailable.</p>
  <p>Please try again later.</p>
</body>
</html>
```

### 5. EDIT_WEBROOT_PATH Implementation

**Path Validation:**
```python
def validate_webroot_path(customer_id, requested_path):
    """
    Validate that webroot path is safe and exists.
    """
    # Get customer's storage root
    storage_root = f"/storage/customers/{customer_id}/"
    
    # Build absolute path
    absolute_path = os.path.normpath(
        os.path.join(storage_root, requested_path)
    )
    
    # Security: Prevent escaping storage root via symlinks
    real_path = os.path.realpath(absolute_path)
    if not real_path.startswith(os.path.realpath(storage_root)):
        raise ValueError("Path escapes storage root")
    
    # Check if directory exists
    if not os.path.isdir(absolute_path):
        raise ValueError("Directory does not exist")
    
    # Check if readable
    if not os.access(absolute_path, os.R_OK):
        raise ValueError("Directory not readable")
    
    return absolute_path
```

**NGINX Configuration:**
```nginx
server {
  server_name example.com;
  
  set $webroot_path "/public/";  # From domain_hosting_config
  set $customer_storage "/storage/customers/123/";
  
  root $customer_storage;
  
  location / {
    # Serve from webroot
    try_files $webroot_path$uri $webroot_path$uri/ @fallback;
  }
  
  location @fallback {
    # Not found
    return 404;
  }
}
```

---

## Security Considerations

### 1. Path Traversal Prevention

**Problem:** Customer attempts to set webroot to `/../../../etc/` or use symlinks to escape storage.

**Solutions:**
- **Normalize paths** — Use `os.path.normpath()` and `os.path.realpath()`
- **Whitelist validation** — Only allow alphanumeric, `-`, `_`, `/`
- **Symlink detection** — Prevent symlinks that escape storage root
- **Escape detection** — Block `../` patterns
- **Size limits** — Path max length 512 chars

**Implementation:**
```python
# Block dangerous patterns
FORBIDDEN_PATTERNS = [
  r'\.\.',  # Parent directory
  r'\.\./', # Escape attempt
  r'/\.\.',
  r'^/',    # Absolute path
  r'~',     # Home directory
  r'\0',    # Null byte
]

def sanitize_webroot_path(path):
    for pattern in FORBIDDEN_PATTERNS:
        if re.search(pattern, path):
            raise ValueError(f"Invalid path: contains '{pattern}'")
    
    # Must be relative and under customer's storage
    if len(path) > 512:
        raise ValueError("Path too long")
    
    return path
```

### 2. Redirect Loop Prevention

**Problem:** Customer configures conflicting redirects (e.g., both WWW and external forward).

**Solutions:**
- **Conflict detection** — Validate config before applying
- **Rule ordering** — Define clear priority
- **Warning to customer** — Warn if config might cause issues

**Validation:**
```python
def validate_hosting_config(config):
    errors = []
    
    # Cannot have both WWW redirect and external forward
    if config.redirect_to_www != "NONE" and config.forward_to_external:
        errors.append("Cannot redirect to WWW and external URL simultaneously")
    
    # Cannot disable hosting and redirect HTTPS
    if not config.web_hosting_enabled and config.redirect_to_https:
        errors.append("Cannot require HTTPS when hosting is disabled")
    
    # External forward must be valid URL
    if config.forward_to_external:
        try:
            urllib.parse.urlparse(config.forward_to_external)
        except:
            errors.append("Invalid external forward URL")
    
    if errors:
        raise ValueError("\n".join(errors))
```

### 3. Rate Limiting on Config Changes

**Problem:** Attacker rapidly toggles settings causing cache thrashing.

**Solutions:**
- **Rate limit** — Max 10 config changes per hour per domain
- **Cooldown** — 5-second delay between changes
- **Log all changes** — Audit trail with user/IP

### 4. Access Control

**Problem:** Admin or attacker disables customer's hosting.

**Solutions:**
- **Role-based access** — Only domain owner (customer) or admin can change
- **Approval workflow** (optional) — Require approval for critical changes
- **Audit logging** — All changes logged with user ID and IP
- **IP restrictions** (optional) — Restrict config changes to specific IPs

---

## Implementation Checklist

### Phase 1: Core Infrastructure (Weeks 1-2)

- [ ] Database schema creation
  - [ ] All 4 tables with indexes
  - [ ] Migration scripts

- [ ] NGINX configuration generation
  - [ ] Rule priority (disable → external → https → www → serve)
  - [ ] Config templating system
  - [ ] Cache invalidation on changes

- [ ] Configuration cache
  - [ ] Load configs into memory/Redis
  - [ ] Invalidate on update (increment version)
  - [ ] TTL: 5 minutes

### Phase 2: Core Functionality (Weeks 3-4)

- [ ] Webroot path validation
  - [ ] Security checks (symlink escape, etc.)
  - [ ] Directory existence checks
  - [ ] Readable permission checks

- [ ] Configuration conflict detection
  - [ ] Validate before saving
  - [ ] Show errors to user
  - [ ] Suggest fixes

- [ ] Redirect rule application
  - [ ] WWW redirect (ADD_WWW / REMOVE_WWW)
  - [ ] HTTPS redirect with status code selection
  - [ ] External forward with path/query preservation
  - [ ] Disable hosting (503 response)

- [ ] Audit logging
  - [ ] Log all changes to database
  - [ ] Capture user ID, IP, timestamp
  - [ ] Store old/new values

### Phase 3: API Endpoints (Weeks 5-6)

- [ ] Customer endpoints (12 total)
  - [ ] Get/update hosting config
  - [ ] Disable/enable hosting
  - [ ] Set WWW/HTTPS redirects
  - [ ] Set/remove external forward
  - [ ] Set webroot path
  - [ ] Validate webroot
  - [ ] View config history
  - [ ] View redirect statistics

- [ ] Admin endpoints (4 total)
  - [ ] List all configs
  - [ ] Get config
  - [ ] Update config
  - [ ] Validate all webroots

- [ ] Error handling
  - [ ] Invalid path
  - [ ] Conflicting config
  - [ ] Not found
  - [ ] Permission denied

### Phase 4: Web UI (Weeks 7-8)

- [ ] Dashboard
  - [ ] Status display
  - [ ] Quick actions
  - [ ] Current settings summary

- [ ] Settings editor
  - [ ] Hosting enable/disable toggle
  - [ ] Webroot path selector with directory browser
  - [ ] Redirect options (WWW, HTTPS)
  - [ ] External forward input
  - [ ] Change reason field
  - [ ] Validation feedback

- [ ] Additional UIs
  - [ ] Disable hosting modal
  - [ ] Webroot path selector dialog
  - [ ] Configuration history page
  - [ ] Redirect statistics page

### Phase 5: Testing & Documentation (Weeks 9-10)

- [ ] Integration tests
  - [ ] WWW redirect test (example.com → www)
  - [ ] HTTPS redirect test (http → https)
  - [ ] External forward test
  - [ ] Disable hosting test (503 response)
  - [ ] Webroot path test (serve from /public/)

- [ ] Security tests
  - [ ] Path traversal prevention
  - [ ] Symlink escape prevention
  - [ ] Redirect loop prevention
  - [ ] Access control

- [ ] Performance tests
  - [ ] Config cache invalidation (< 10 seconds)
  - [ ] Redirect latency (< 1ms)
  - [ ] Webroot path validation (< 100ms)

- [ ] Documentation
  - [ ] Customer guide (how to configure each setting)
  - [ ] API documentation
  - [ ] Troubleshooting guide

---

## Operational Considerations

### Caching & Invalidation

```python
# Invalidate on config change
def update_domain_config(domain_id, new_config):
    # Update database
    domain_hosting_config.save(new_config)
    
    # Increment version (triggers cache invalidation)
    new_config.config_version += 1
    
    # Invalidate cache
    redis.delete(f"domain_config:{domain_id}")
    
    # Invalidate NGINX config cache
    redis.delete(f"nginx_config:{domain_id}")
    
    # Signal NGINX reload (if needed)
    signal_nginx_reload(domain_id)
```

### Monitoring & Alerts

**Metrics:**
- Config changes per hour (spike detection)
- Redirect latency (p95, p99)
- Disabled domains count
- Failed webroot validations

**Alerts:**
- Multiple config changes (potential attack)
- Redirect loops detected
- Webroot validation failures

---

## Summary

The **Customer Hosting Settings** specification provides:

✅ **Multiple redirection modes** — WWW, HTTPS, external forwarding  
✅ **Flexible webroot paths** — Change where files are served from  
✅ **Temporary suspension** — Disable hosting without deleting files  
✅ **Instant application** — Changes effective in seconds  
✅ **Security-first design** — Path traversal prevention, symlink checks  
✅ **Audit logging** — All changes tracked by user/timestamp  
✅ **Conflict prevention** — Detect and prevent incompatible settings  
✅ **Admin oversight** — Full control over customer configurations  
✅ **Production-ready** — Database schema, API endpoints, implementation checklist

This feature is essential for allowing customers to configure their domains flexibly without requiring platform support interventions.
