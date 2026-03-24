# Web Server & PHP Version Switching Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, platform architects, support team

---

## Overview

This specification defines how clients can **seamlessly switch between different web servers (Apache ↔ NGINX) and PHP versions (8.3 ↔ 8.4)** without downtime, while maintaining application compatibility and handling configuration differences transparently.

### Key Features

- **Zero-downtime switching** — Pod replacement via ingress routing
- **Pre-flight compatibility checks** — Detect incompatible configurations before switching
- **Automatic configuration migration** — Convert Apache configs to NGINX where possible
- **PHP version flexibility** — Change PHP versions independently of web server
- **Rollback capability** — Automatic rollback on health check failure
- **Plan-aware limitations** — Starter clients limited to Apache; Business/Premium can switch freely
- **Full audit trail** — Track all switches with reasons and outcomes

### Use Cases

| Scenario | Example |
|----------|---------|
| **Performance tuning** | Switch from Apache to NGINX for higher concurrency |
| **PHP version upgrade** | Upgrade from PHP 8.3 → 8.4 to get new features |
| **Compatibility fix** | Downgrade PHP if application has compatibility issues |
| **Cost optimization** | Switch to NGINX (lower memory usage) to reduce resource allocation |
| **Debugging** | Test application on different stack before upgrading |
| **Migration preparation** | Test on Business plan stack before upgrading plan |

---

## Compatibility Matrix

### Web Server & PHP Version Combinations

**Available Catalog Images:**

| Catalog ID | Web Server | PHP Version | Status | Notes |
|------------|-----------|------------|--------|-------|
| `apache-php84` | Apache 2.4 | 8.4 | ✅ Active | Shared pod (Starter), Dedicated (Business/Premium) |
| `apache-php83` | Apache 2.4 | 8.3 | ✅ Active | Shared pod (Starter), Dedicated (Business/Premium) |
| `apache-php82` | Apache 2.4 | 8.2 | ⚠️ Deprecated | Still supported, migration recommended |
| `nginx-php84` | NGINX 1.25+ | 8.4 | ✅ Active | Dedicated pods only (Business/Premium) |
| `nginx-php83` | NGINX 1.25+ | 8.3 | ✅ Active | Dedicated pods only (Business/Premium) |
| `wordpress-php84` | Apache 2.4 | 8.4 + WP optimized | ✅ Active | Shared/Dedicated, WordPress-specific |
| `wordpress-php83` | Apache 2.4 | 8.3 + WP optimized | ✅ Active | Shared/Dedicated, WordPress-specific |

### Switching Matrix (Allowed Combinations)

| Current → Target | Starter | Business | Premium | Notes |
|------------------|---------|----------|---------|-------|
| `apache-php83` → `apache-php84` | ✅ Yes | ✅ Yes | ✅ Yes | Same web server, PHP upgrade |
| `apache-php84` → `apache-php83` | ✅ Yes | ✅ Yes | ✅ Yes | PHP downgrade (rare) |
| `apache-php83` → `nginx-php83` | ❌ No | ✅ Yes | ✅ Yes | Web server change, plan restricted |
| `nginx-php83` → `nginx-php84` | N/A | ✅ Yes | ✅ Yes | PHP upgrade, same web server |
| `nginx-php83` → `apache-php83` | N/A | ✅ Yes | ✅ Yes | Web server change (downgrade) |
| `apache-php84` → `wordpress-php84` | ✅ Yes | ✅ Yes | ✅ Yes | Convert to WordPress-optimized |
| `wordpress-php84` → `apache-php84` | ✅ Yes | ✅ Yes | ✅ Yes | Remove WordPress optimization |

**Key Restrictions:**
- **Starter clients (shared pods):** Apache only, can switch PHP versions
- **Business/Premium (dedicated pods):** Full flexibility, can switch web servers and PHP versions
- **All plans:** Can switch to/from WordPress-optimized versions if on same web server

---

## Configuration Migration Strategy

### Apache → NGINX Migration

**Challenge:** Apache uses `.htaccess` files and `mod_rewrite` directives; NGINX uses `location` blocks and `rewrite` directives.

**Solution:** Two-stage process with compatibility checking.

#### Stage 1: Pre-Flight Compatibility Check

Before switching, scan client's `.htaccess` files for:

```
Check for: Apache-specific directives

✅ COMPATIBLE:
  - RewriteRule, RewriteCond
  - SetEnvIf, Header
  - Order, Allow, Deny
  - BasicAuth (auth_basic in NGINX)
  - Redirect, RedirectMatch

⚠️ REQUIRES REVIEW:
  - FilesMatch (requires NGINX location ~ block)
  - SetHandler (requires NGINX config)
  - Custom mod_* modules

❌ INCOMPATIBLE:
  - mod_ssl directives (handled by NGINX natively)
  - mod_expires (use NGINX add_header instead)
  - Custom proprietary Apache modules
```

**Output:** Compatibility report with:
- Lines that require manual migration
- Warnings for directives requiring configuration change
- Automated conversion suggestions

#### Stage 2: Automatic Configuration Migration

Platform automatically generates NGINX config:

```
Apache .htaccess:
─────────────────
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^(.*)$ index.php?url=$1 [QSA,L]

SetEnvIf User-Agent "bot" no_log
CustomLog logs/access.log combined env=!no_log

Header set Cache-Control "max-age=3600"


NGINX Generated Config:
──────────────────────
server {
  listen 80;
  server_name example.com www.example.com;
  
  # Generated: RewriteRule ^(.*)$ index.php?url=$1
  location / {
    try_files $uri $uri/ /index.php?url=$1;
  }
  
  # Generated: Header set Cache-Control
  location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
    add_header Cache-Control "max-age=3600";
    expires 1h;
  }
  
  # Generated: CustomLog with env
  access_log /var/log/nginx/access.log combined;
}
```

#### Stage 3: Client Review & Approval

**Before switching:**
1. Generate NGINX config automatically
2. Show client side-by-side comparison (Apache vs NGINX)
3. Highlight incompatibilities (color-coded)
4. Require explicit approval or manual fixes
5. Optionally allow admin to force-migrate with warnings

**Diagram:**

```
┌─────────────────────────────────────────────────────┐
│ Switch to NGINX?                                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Current: apache-php84                              │
│ Target: nginx-php84                                │
│                                                     │
│ ⚠️ 3 issues found in .htaccess:                    │
│                                                     │
│ [!] Line 5: SetHandler php-handler                 │
│     Status: Incompatible                           │
│     Fix: Remove (NGINX uses location ~ \.php$)   │
│                                                     │
│ [!] Line 12: Custom Rewrite Rule                   │
│     Status: Requires review                        │
│     Suggestion: Add to NGINX location block       │
│                                                     │
│ [!] Line 18: mod_expires headers                   │
│     Status: Compatible (auto-converted)           │
│     NGINX: expires 1h;                             │
│                                                     │
│ ✅ Generated NGINX config is ready for review      │
│ ✅ All other files are compatible                  │
│                                                     │
│ Preview NGINX Config | View .htaccess | Help      │
│ [Approve & Switch] [Make Changes] [Cancel]        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### NGINX → Apache Migration

**Reverse process:** Extract NGINX `location` blocks and convert to `.htaccess` equivalent.

```
NGINX location block:
────────────────────
location ~ ^/admin/ {
  auth_basic "Admin Panel";
  auth_basic_user_file /var/www/.htpasswd-admin;
}

location ~* \.(jpg|png|css|js)$ {
  expires 30d;
  add_header Cache-Control "public, immutable";
}


Apache .htaccess Generated:
──────────────────────────
<Directory "/var/www/admin">
  AuthType Basic
  AuthName "Admin Panel"
  AuthUserFile /var/www/.htpasswd-admin
  Require valid-user
</Directory>

<FilesMatch "\.(jpg|png|css|js)$">
  Header set Cache-Control "public, immutable"
  ExpiresActive On
  ExpiresDefault "access plus 30 days"
</FilesMatch>
```

### PHP Version Switching (Same Web Server)

**No configuration migration needed** — only the runtime changes.

```
Apache PHP 8.3 → Apache PHP 8.4:
─────────────────────────────────
✅ .htaccess files remain unchanged
✅ NGINX config remains unchanged
✅ Database connections unchanged
⚠️ May require code updates if using removed functions
✅ Extensions (mysqli, gd, curl, etc.) available in both versions
✅ Fallback: Can downgrade back to 8.3 if issues found
```

**Pre-flight check for PHP version switch:**
- Scan codebase for removed/deprecated functions
- Check php.ini overrides for compatibility
- Verify required extensions are available in target version
- Run application health checks on both versions

---

## Pre-Flight Compatibility Check System

### Architecture

```
┌────────────────────────────────────────────────────────┐
│ Client initiates web server/PHP version switch         │
├────────────────────────────────────────────────────────┤
│                                                        │
│  1. Retrieve client configuration                     │
│     - Current catalog_image                           │
│     - .htaccess files                                 │
│     - php.ini overrides                               │
│     - Custom extensions                               │
│     - Application framework (detected)                │
│                                                        │
│  2. Run compatibility checks (in parallel)            │
│     ├─ Apache directives compatibility                │
│     ├─ PHP version compatibility                      │
│     ├─ Extension availability                         │
│     ├─ Framework version match                        │
│     └─ Performance prediction                         │
│                                                        │
│  3. Generate conversion artifacts                     │
│     ├─ NGINX config from .htaccess                    │
│     ├─ .htaccess from NGINX config                    │
│     ├─ php.ini adjustments for target version        │
│     └─ Migration guide for incompatibilities         │
│                                                        │
│  4. Present findings to user/admin                    │
│     ├─ Compatibility score (0-100%)                   │
│     ├─ Issues (grouped: critical, warning, info)     │
│     ├─ Suggested fixes                                │
│     └─ Confidence level for auto-migration            │
│                                                        │
│  5. User approval (if >= 90% compatible)              │
│     └─ Proceed to switching process                   │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### Compatibility Report Format

```json
{
  "source_image": "apache-php83",
  "target_image": "nginx-php84",
  "compatibility_score": 87,
  "estimated_success": "HIGH",
  "checksum": "sha256:abc123...",
  "checks": {
    "apache_directives": {
      "status": "REQUIRES_REVIEW",
      "issues_count": 3,
      "issues": [
        {
          "severity": "CRITICAL",
          "line": 5,
          "directive": "SetHandler php-handler",
          "file": ".htaccess",
          "message": "Apache SetHandler not supported in NGINX",
          "fix": "Remove (NGINX uses fastcgi_pass in location block)",
          "auto_fix": false
        },
        {
          "severity": "WARNING",
          "line": 12,
          "directive": "mod_expires",
          "file": ".htaccess",
          "message": "mod_expires can be auto-converted to NGINX expires directive",
          "fix": "expires 30d;",
          "auto_fix": true
        }
      ]
    },
    "php_compatibility": {
      "status": "COMPATIBLE",
      "source_version": "8.3",
      "target_version": "8.4",
      "removed_functions": [],
      "deprecated_functions": [
        {
          "name": "get_magic_quotes_gpc",
          "line": 142,
          "file": "config.php",
          "action": "REMOVE (already removed in 8.4)"
        }
      ]
    },
    "extensions": {
      "status": "COMPATIBLE",
      "required": ["mysqli", "gd", "curl", "json"],
      "available_in_target": ["mysqli", "gd", "curl", "json"],
      "missing": []
    },
    "framework_detection": {
      "detected": "WordPress 6.4.2",
      "compatible_with_target": true,
      "notes": "WordPress 6.4+ requires PHP 7.2+, target is 8.4 ✓"
    },
    "performance_estimate": {
      "web_server_change": "apache → nginx",
      "estimated_improvement": "+40% throughput (NGINX handles concurrency better)",
      "estimated_memory_reduction": "-25% (NGINX uses less RAM)"
    }
  },
  "recommendations": [
    "Fix 1 critical issue before switching (SetHandler directive)",
    "Review 1 deprecated function (get_magic_quotes_gpc)",
    "After switching, run production tests for 24 hours before full rollout"
  ],
  "generated_config": {
    "nginx_conf": "... (generated NGINX config) ...",
    "htaccess_equivalent": "... (for reference) ..."
  }
}
```

---

## Zero-Downtime Switching Process

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ INGRESS (Service entry point, routes traffic to active pod) │
├─────────────────────────────────────────────────────────────┤
│  Domain: example.com                                         │
│  Routes to: active-pod (selects based on label)             │
└─────────────────────────────────────────────────────────────┘
         ↓
    ┌────────────────────────────────────────┐
    │  OLD POD (apache-php83)                 │
    │  Handling all traffic                   │
    │  ✅ Healthy                             │
    │  ✅ Receiving requests                  │
    └────────────────────────────────────────┘
         ↓
    Switching initiated by admin
         ↓
    Step 1: Create NEW POD (nginx-php84)
    ┌────────────────────────────────────────┐
    │  NEW POD (nginx-php84)                  │
    │  Status: Starting                       │
    │  Mounting: Same PersistentVolume        │
    │  Same files as old pod                  │
    └────────────────────────────────────────┘
         ↓
    Step 2: Wait for readiness probe
    ┌────────────────────────────────────────┐
    │  NEW POD (nginx-php84)                  │
    │  Status: Initializing                   │
    │  Readiness: /healthz endpoint check     │
    │  Max wait: 2 minutes                    │
    └────────────────────────────────────────┘
         ↓
    Step 3: Healthz check passes
    ┌────────────────────────────────────────┐
    │  NEW POD (nginx-php84)                  │
    │  Status: Ready                          │
    │  Readiness: PASS                        │
    │  Ready to serve traffic                 │
    └────────────────────────────────────────┘
         ↓
    Step 4: Switch ingress routing
    ┌─────────────────────────────────────────────────────────┐
    │ INGRESS updates selector:                               │
    │  OLD: pod-label=apache-php83-xyz                        │
    │  NEW: pod-label=nginx-php84-xyz                         │
    │  Result: New requests → NEW POD                         │
    └─────────────────────────────────────────────────────────┘
         ↓
    Step 5: Drain old pod (graceful shutdown)
    ┌────────────────────────────────────────┐
    │  OLD POD (apache-php83)                 │
    │  Status: Terminating                    │
    │  Draining: Active requests complete     │
    │  Timeout: 30 seconds                    │
    │  Then: Force kill                       │
    └────────────────────────────────────────┘
         ↓
    Step 6: Cleanup
    ┌────────────────────────────────────────┐
    │  OLD POD deleted                        │
    │  NEW POD label: pod-label=nginx-php84   │
    │  All traffic: NEW POD ✅                │
    └────────────────────────────────────────┘
```

### Detailed Process Flow

**Timing:** Total switching time: 1-3 minutes (no downtime if health checks pass)

```
T+0s:   Admin clicks "Switch to NGINX"
T+5s:   Pre-flight checks passed, switching initiated
        NEW pod created: nginx-php84-abc123

T+15s:  NEW pod container started
        OLD pod still receiving 100% traffic

T+25s:  NEW pod readiness checks passing
        /healthz returns 200 OK
        Database connections verified

T+30s:  INGRESS routing updated
        NEW traffic → NEW pod
        OLD traffic → OLD pod (existing connections)

T+35s:  OLD pod receives SIGTERM
        Active connections drain
        New requests rejected (go to NEW pod)

T+65s:  Timeout reached, OLD pod killed

T+70s:  Cleanup complete
        ✅ All traffic on NEW pod
        ✅ No downtime (only milliseconds of re-routing)
```

### Automatic Rollback on Failure

**Triggers for rollback:**

1. **Readiness check fails** (>2 minutes without passing)
   - Action: Delete new pod, continue with old pod
   - Notification: "Switching failed — health checks did not pass"

2. **New pod crashes after ingress switch**
   - Action: Revert ingress routing to old pod
   - Notification: "New pod crashed, reverted to previous version"

3. **High error rate detected** (>5% errors for 1 minute)
   - Action: Revert ingress routing
   - Notification: "Error rate spike detected, reverted to previous version"

4. **Timeout exceeded** (>5 minutes total)
   - Action: Rollback to old pod
   - Notification: "Switching timeout, reverted to previous version"

---

## Management API Specification

### Endpoints

#### 1. Get Available Options

**GET** `/api/v1/clients/{id}/catalog`

**Description:** Get available catalog images for this client (filtered by plan).

**Query Parameters:**
- `include_current` (default: true) — Include current image in list
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
        "status": "active",
        "description": "Latest PHP 8.4 with Apache"
      },
      {
        "id": "nginx-php84",
        "web_server": "NGINX 1.25",
        "php_version": "8.4",
        "status": "active",
        "description": "High-performance NGINX with PHP 8.4"
      },
      {
        "id": "nginx-php83",
        "web_server": "NGINX 1.25",
        "php_version": "8.3",
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

#### 2. Pre-Flight Compatibility Check

**POST** `/api/v1/clients/{id}/catalog/{image_id}/compatibility-check`

**Description:** Run pre-flight checks before switching. Returns compatibility score and issues.

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
    "checksum": "sha256:abc123...",
    "issues": [
      {
        "severity": "CRITICAL",
        "category": "apache_directive",
        "line": 5,
        "file": ".htaccess",
        "directive": "SetHandler",
        "message": "Not supported in NGINX",
        "suggestion": "Remove or convert to location block"
      },
      {
        "severity": "WARNING",
        "category": "php_deprecated_function",
        "file": "config.php",
        "line": 142,
        "function": "get_magic_quotes_gpc()",
        "message": "Removed in PHP 8.4",
        "suggestion": "Remove function call"
      }
    ],
    "recommendations": [
      "Fix 1 critical issue before switching",
      "Review 1 deprecated function",
      "Run tests after switching"
    ],
    "generated_config": {
      "nginx_conf": "... (NGINX config preview) ...",
      "htaccess": "... (.htaccess for reference) ..."
    }
  }
}
```

**Status Codes:** 200, 400, 401, 403, 404

---

#### 3. Initiate Switch

**PATCH** `/api/v1/clients/{id}/catalog_image`

**Description:** Switch to a new catalog image. Requires approval if compatibility issues exist.

**Request Body:**

```json
{
  "target_image": "nginx-php84",
  "force": false,
  "backup_before_switch": true,
  "auto_rollback_on_failure": true,
  "reason": "Performance optimization",
  "notification_webhook": "https://example.com/webhooks/switch-status"
}
```

**Parameters:**
- `target_image` — Catalog image ID
- `force` (default: false) — Skip compatibility checks, force switch (admin only)
- `backup_before_switch` (default: true) — Create backup before switching
- `auto_rollback_on_failure` (default: true) — Automatically rollback if health checks fail
- `reason` (optional) — Reason for switch (logged in audit trail)
- `notification_webhook` (optional) — Webhook URL for progress updates

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
    },
    "status_url": "/api/v1/clients/{id}/catalog_image/sw_abc123xyz",
    "cancel_url": "/api/v1/clients/{id}/catalog_image/sw_abc123xyz/cancel"
  }
}
```

**Status Codes:** 202, 400, 401, 403, 409 (already switching), 422 (compatibility issues)

**Side Effects:**
- Backup created (if enabled)
- New pod image pulled from registry
- New pod created and started
- Health checks initiated
- Ingress updated (when ready)
- Old pod drained and terminated
- Audit log entry created
- Webhook notifications sent

---

#### 4. Get Switch Status

**GET** `/api/v1/clients/{id}/catalog_image/{switch_id}`

**Description:** Poll for switch progress.

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
        "duration_seconds": 5,
        "timestamp": "2025-03-01T10:00:05Z"
      },
      {
        "step": 2,
        "name": "Backup creation",
        "status": "completed",
        "duration_seconds": 12,
        "timestamp": "2025-03-01T10:00:17Z"
      },
      {
        "step": 3,
        "name": "New pod startup",
        "status": "in_progress",
        "duration_seconds": 15,
        "timestamp": "2025-03-01T10:00:32Z",
        "details": {
          "pod_name": "client-001-nginx-abc123",
          "container_ready": false,
          "readiness_probe_passes": 2,
          "readiness_probe_failures": 0
        }
      }
    ],
    "estimated_completion": "2025-03-01T10:03:00Z"
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### 5. Cancel Switch (In-Progress)

**POST** `/api/v1/clients/{id}/catalog_image/{switch_id}/cancel`

**Description:** Cancel an in-progress switch. Only possible before ingress update.

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

#### 6. Rollback to Previous Image

**POST** `/api/v1/clients/{id}/catalog_image/rollback`

**Description:** Rollback to the previous catalog image (if switch failed or user wants to revert).

**Request Body:**

```json
{
  "reason": "Application compatibility issues detected"
}
```

**Response:**

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

#### 7. Get Switch History

**GET** `/api/v1/clients/{id}/catalog_image/history`

**Description:** View all switches with timeline and outcomes.

**Query Parameters:**
- `limit` (default: 50)
- `offset` (default: 0)
- `status` (optional) — `completed`, `failed`, `cancelled`, `rolling_back`

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
      "initiated_by": "admin_user@platform.local",
      "reason": "Performance optimization",
      "created_at": "2025-02-28T14:30:00Z",
      "completed_at": "2025-02-28T14:33:15Z",
      "duration_seconds": 195,
      "backup_id": "backup_xyz",
      "health_check_result": "PASS",
      "performance_impact": {
        "throughput_improvement": "+42%",
        "memory_reduction": "-28%"
      }
    }
  ],
  "pagination": { ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

## Client Panel Features

### New Section: Web Server & PHP Version

**Location:** Dashboard → Sites & Hosting → Web Server & PHP Version

#### Features

| Feature | Description |
|---------|-------------|
| **Current configuration** | Display current image (web server, PHP version, status) |
| **Available options** | List of images client can switch to (filtered by plan) |
| **Switch button** | Initiate switch dialog |
| **Compatibility check** | Auto-run pre-flight checks, show issues |
| **Configuration preview** | Show generated NGINX/Apache config |
| **Progress indicator** | Real-time progress during switch (auto-refresh) |
| **Switch history** | Timeline of all switches with details |
| **Rollback button** | Revert to previous version if needed |
| **Performance metrics** | Show improvement/impact of switch |
| **Estimated downtime** | Show expected switching time |
| **Approval dialog** | Confirm switch (with warnings if issues exist) |

#### UI Mockup

```
┌─────────────────────────────────────────────────────┐
│ Web Server & PHP Version                            │
├─────────────────────────────────────────────────────┤
│                                                     │
│ CURRENT CONFIGURATION                              │
│ ┌─────────────────────────────────────────────┐   │
│ │ Apache 2.4 with PHP 8.3                     │   │
│ │ Catalog ID: apache-php83                    │   │
│ │ Status: ✅ Active                           │   │
│ │ Running since: Feb 15, 2025 (14 days)      │   │
│ └─────────────────────────────────────────────┘   │
│                                                     │
│ AVAILABLE OPTIONS                                   │
│                                                     │
│ ┌─ PHP Version Changes ──────────────────────┐    │
│ │                                            │    │
│ │ [✓] Apache 2.4 + PHP 8.3 (current)        │    │
│ │ [ ] Apache 2.4 + PHP 8.4                  │    │
│ │     └─ Newer version, better performance │    │
│ │        Performance: +5% faster            │    │
│ │        [Switch] [Compatibility Report]    │    │
│ │                                            │    │
│ └────────────────────────────────────────────┘    │
│                                                     │
│ ┌─ Web Server Changes ──────────────────────┐    │
│ │                                            │    │
│ │ [ ] NGINX 1.25 + PHP 8.3                  │    │
│ │     └─ Higher concurrency, less memory   │    │
│ │        Performance: +40% concurrency      │    │
│ │        Memory: -25% usage                 │    │
│ │        Compatibility: 87/100              │    │
│ │        [Switch] [Compatibility Report]    │    │
│ │                                            │    │
│ │ [ ] NGINX 1.25 + PHP 8.4                  │    │
│ │     └─ Latest version, best performance  │    │
│ │        Performance: +50% concurrent       │    │
│ │        Memory: -25% usage                 │    │
│ │        Compatibility: 87/100              │    │
│ │        [Switch] [Compatibility Report]    │    │
│ │                                            │    │
│ └────────────────────────────────────────────┘    │
│                                                     │
│ ⓘ Tip: Business plan allows web server changes.   │
│        Starter plan supports Apache PHP versions  │
│        only. Upgrade plan to use NGINX.          │
│                                                     │
│ ─────────────────────────────────────────────────  │
│ RECENT SWITCHES                                    │
│ ─────────────────────────────────────────────────  │
│                                                     │
│ Feb 15, 2025 ✅ COMPLETED                         │
│ Switched from PHP 8.2 → PHP 8.3                   │
│ Duration: 2 minutes  | No downtime                │
│ [View Details] [Rollback]                         │
│                                                     │
│ Jan 01, 2025 ✅ COMPLETED                         │
│ Switched from Apache PHP 8.1 → Apache PHP 8.2    │
│ Duration: 90 seconds | No downtime                │
│ [View Details]                                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

#### Switch Dialog

```
┌───────────────────────────────────────────────────┐
│ Switch to NGINX 1.25 + PHP 8.4?                  │
├───────────────────────────────────────────────────┤
│                                                   │
│ BEFORE YOU SWITCH                                 │
│                                                   │
│ ⚠️ Compatibility Check Results:                  │
│    Compatibility Score: 87/100 (HIGH)            │
│    Issues Found: 1 critical, 1 warning           │
│                                                   │
│ CRITICAL ISSUE:                                   │
│ ┌─────────────────────────────────────────────┐ │
│ │ SetHandler php-handler in .htaccess        │ │
│ │ This directive is not supported in NGINX.  │ │
│ │                                             │ │
│ │ Suggested fix:                              │ │
│ │ Remove this line from .htaccess            │ │
│ │ (NGINX uses location blocks instead)       │ │
│ │                                             │ │
│ │ [Fix in File Manager] [Show in Text]       │ │
│ └─────────────────────────────────────────────┘ │
│                                                   │
│ WARNING:                                          │
│ Deprecated function: get_magic_quotes_gpc()     │
│ in config.php:142 — removed in PHP 8.4          │
│ [View in Code]                                   │
│                                                   │
│ ESTIMATED IMPACT:                                │
│ ✅ Downtime: ~1 minute (automatic fallback)     │
│ ✅ Performance: +40% concurrent requests        │
│ ✅ Memory: -25% usage (NGINX more efficient)   │
│ ✅ Files: No changes (same PersistentVolume)   │
│                                                   │
│ PROCESS:                                          │
│ 1. Create backup (5 min)                        │
│ 2. Start new pod (10 sec)                       │
│ 3. Health checks (20 sec)                       │
│ 4. Switch traffic (1 sec)                       │
│ 5. Shutdown old pod (30 sec)                    │
│ ─────────────────────────────────────────────   │
│ Total: ~2 minutes, automatic rollback on failure│
│                                                   │
│ APPROVAL:                                         │
│ ☑ I understand the changes and risks            │
│ ☑ My team has tested with PHP 8.4              │
│ ☑ I approve the switch (no automatic rollback) │
│                                                   │
│ [Approve & Switch]  [Review Config]  [Cancel]  │
│                                                   │
└───────────────────────────────────────────────────┘
```

#### In-Progress Switch

```
┌─────────────────────────────────────────────────┐
│ Switching to NGINX 1.25 + PHP 8.4...             │
├─────────────────────────────────────────────────┤
│                                                 │
│ Progress: 3 of 6 steps (50%)                    │
│ Estimated time remaining: 1 minute              │
│                                                 │
│ ▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 50%          │
│                                                 │
│ ✅ Step 1: Pre-flight checks              5s   │
│ ✅ Step 2: Backup creation               12s   │
│ ⏳ Step 3: New pod startup           (15s)    │
│           Container: 90% ready                 │
│           Readiness probes: 2/3 passing       │
│ ⏸ Step 4: Switch routing                      │
│ ⏸ Step 5: Shutdown old pod                   │
│ ⏸ Step 6: Cleanup                             │
│                                                 │
│ Live Log:                                       │
│ [14:02:15] Creating pod: client-001-nginx...  │
│ [14:02:18] Container started                  │
│ [14:02:22] Health check #1: PASS              │
│ [14:02:27] Health check #2: PASS              │
│ [14:02:32] Waiting for readiness probe...     │
│                                                 │
│ Your site continues serving on current stack.  │
│ After completion, you'll be on NGINX + PHP 8.4│
│                                                 │
│ [Cancel Switch]  [View Config]  [Help]        │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Admin Panel Features

### Additional Capabilities

| Feature | Description |
|---------|-------------|
| **Force switch** | Skip compatibility checks, force all clients to new version |
| **Bulk migrate** | Switch multiple clients at once to new catalog image |
| **View all switches** | Audit trail of all client switches (who, when, why) |
| **Rollback policy** | Set default rollback behavior per client |
| **Compatibility override** | Manually approve low-score switches (admin signature) |
| **Performance analytics** | Track throughput/memory improvements after switches |
| **Deprecation timeline** | Schedule automatic migrations for deprecated versions |
| **Test before deploy** | Run health checks on new pod before ingress switch |
| **Rollback history** | Track which switches had rollbacks and why |
| **Cost impact** | Show memory/CPU changes and billing impact |

---

## Limitations & Edge Cases

### Limitation 1: Starter Clients Cannot Use NGINX

**Problem:** Starter clients run in shared Apache+PHP pods, cannot switch to NGINX (requires dedicated pod).

**Workaround:**
```
If Starter client wants NGINX:
1. Upgrade to Business plan
   OR
2. Use Apache but optimize PHP version
```

**Implementation:**
- Block NGINX options in client panel for Starter clients
- Show message: "Upgrade to Business plan to use NGINX"
- Allow one-click upgrade link

### Limitation 2: .htaccess Compatibility

**Problem:** Some Apache directives cannot be auto-converted to NGINX.

**Solution:**
- Pre-flight checks identify incompatibilities
- User must manually fix or choose NOT to switch
- Provide side-by-side editor for .htaccess ↔ NGINX config

### Limitation 3: Password-Protected Directories

**Problem:** Apache uses `.htpasswd` with `mod_auth`, NGINX uses `auth_basic` with same format.

**Solution:**
- ✅ Password-protected directories ARE compatible both ways
- No configuration migration needed for `.htpasswd` files
- Location blocks auto-converted to NGINX auth_basic

### Limitation 4: Custom Apache Modules

**Problem:** Custom `mod_*` modules (mod_geoip, mod_evasive, etc.) not available in NGINX.

**Solution:**
- Pre-flight checks detect custom modules
- Block switch or offer workarounds
- Suggest NGINX equivalents (e.g., GeoIP2 module, rate limiting)

### Limitation 5: Downtime During Peak Load

**Problem:** Health checks may fail under high load (false positive).

**Solution:**
- Configurable health check timeout (default: 2 minutes)
- Multiple retry attempts before rollback
- Scheduled switching during off-peak hours (optional)

### Limitation 6: Database Connection Pool Reset

**Problem:** Database connections don't automatically reset during pod switch.

**Solution:**
- Application uses connection pooling library (PDO, MySQLi)
- PHP-FPM graceful shutdown ensures connections drain
- New pod gets fresh connection pool

**Mitigation:**
- Document connection pooling best practices
- Recommend connection retry logic in applications

---

## Monitoring & Alerts

### Metrics

```
Prometheus metrics:

catalog_switch_initiated_total{image_pair}
catalog_switch_completed_total{image_pair, status}
catalog_switch_failed_total{image_pair, reason}
catalog_switch_duration_seconds{image_pair}
catalog_switch_rollback_total{image_pair}
pod_health_check_success_rate{image_id}
pod_readiness_duration_seconds{image_id}
```

### Alerts

| Alert | Trigger | Action |
|-------|---------|--------|
| **Switch failed** | Compatibility checks failed, admin notified | Provide guidance to fix issues |
| **Health check timeout** | New pod not ready in 2+ minutes | Auto-rollback, investigate logs |
| **High error rate post-switch** | >5% error rate for 1 minute | Auto-rollback, notify client |
| **Switch cancelled by user** | User clicked Cancel during progress | Stop current switch, revert to old pod |
| **Pod startup slowdown** | Pod startup > 30 seconds | Alert admin, may indicate resource issues |

---

## Testing Strategy

### Unit Tests

```javascript
// Test compatibility check logic
test('detects Apache SetHandler incompatibility', () => {
  const htaccess = "SetHandler php-handler";
  const result = checkCompatibility(htaccess, 'apache', 'nginx');
  expect(result.issues[0].severity).toBe('CRITICAL');
});

test('PHP 8.4 deprecated functions detected', () => {
  const code = 'get_magic_quotes_gpc()';
  const result = checkPHPCompatibility(code, '8.3', '8.4');
  expect(result.deprecated_functions).toContain('get_magic_quotes_gpc');
});
```

### Integration Tests

```bash
# 1. Create test client on Apache PHP 8.3
curl -X POST /api/v1/clients \
  -d '{"name": "test", "plan": "business", "catalog_image": "apache-php83"}'

# 2. Run compatibility check for NGINX
curl -X POST /api/v1/clients/test/catalog/nginx-php84/compatibility-check

# 3. Initiate switch
curl -X PATCH /api/v1/clients/test/catalog_image \
  -d '{"target_image": "nginx-php84"}'

# 4. Poll status until complete
while [ $(curl .../status | jq .status) != "completed" ]; do sleep 1; done

# 5. Verify new pod is running
kubectl get pod -l app=client-test | grep nginx-php84

# 6. Test application on new pod
curl -H "Host: test.example.com" http://ingress.local/healthz
# Expected: 200 OK

# 7. Verify files are intact
curl -H "Host: test.example.com" http://ingress.local/index.php
# Expected: Same content as before
```

### Load Testing

```bash
# Before switch: baseline
ab -n 10000 -c 100 http://test.example.com/ > before.txt

# After switch: verify improvement
ab -n 10000 -c 100 http://test.example.com/ > after.txt

# Compare throughput, latency, error rate
```

### Failure Scenarios

```
Test 1: Health check failure
├─ Scenario: New pod /healthz returns 500
├─ Expected: Auto-rollback to old pod
└─ Result: ✅ All traffic back on old pod within 2 min

Test 2: Incompatible directive in .htaccess
├─ Scenario: SetHandler php-handler exists
├─ Expected: Compatibility check identifies critical issue
└─ Result: ✅ Switch blocked, user shown fix suggestion

Test 3: Pod startup timeout
├─ Scenario: New pod takes >2 minutes to start
├─ Expected: Timeout, rollback
└─ Result: ✅ Reverted to old pod, no downtime

Test 4: High error rate post-switch
├─ Scenario: New pod returns 50% error rate
├─ Expected: Detect, rollback
└─ Result: ✅ Auto-reverted after 1 minute spike
```

---

## Implementation Checklist

### Phase 1: Core Switching Logic (Week 1-2)

- [ ] Implement catalog image model with compatibility matrix
- [ ] Build pre-flight compatibility check system
  - [ ] Apache directive scanner
  - [ ] PHP version checker
  - [ ] Extension availability checker
- [ ] Create config migration engine
  - [ ] .htaccess → NGINX generator
  - [ ] NGINX → .htaccess generator
  - [ ] Config validation
- [ ] Implement pod replacement logic
  - [ ] New pod creation
  - [ ] Health check monitoring
  - [ ] Graceful shutdown of old pod
- [ ] Setup ingress routing logic
  - [ ] Pod selector update
  - [ ] Traffic draining
  - [ ] Rollback on failure

### Phase 2: API Endpoints (Week 2)

- [ ] GET /clients/{id}/catalog (available options)
- [ ] POST /clients/{id}/catalog/{image_id}/compatibility-check
- [ ] PATCH /clients/{id}/catalog_image (initiate switch)
- [ ] GET /clients/{id}/catalog_image/{switch_id} (status polling)
- [ ] POST .../cancel (cancel in-progress switch)
- [ ] POST .../rollback (rollback to previous)
- [ ] GET .../history (view switch history)

### Phase 3: Client Panel UI (Week 2-3)

- [ ] Display current web server/PHP version
- [ ] List available options (filtered by plan)
- [ ] Compatibility check before switch
- [ ] Switch dialog with warnings
- [ ] Progress indicator (live update)
- [ ] Switch history timeline
- [ ] Rollback button

### Phase 4: Admin Panel (Week 3)

- [ ] View all client switches
- [ ] Bulk migrate clients to new version
- [ ] Force switch (skip checks)
- [ ] Compatibility override
- [ ] Deprecation timeline scheduler
- [ ] Performance analytics dashboard

### Phase 5: Testing & Documentation (Week 3-4)

- [ ] Unit tests (compatibility detection, config migration)
- [ ] Integration tests (full switch flow)
- [ ] Load tests (before/after performance)
- [ ] Failure scenario tests
- [ ] Customer documentation
- [ ] Admin runbook

---

## Related Documents

- [`./WORKLOAD_DEPLOYMENT.md`](./WORKLOAD_DEPLOYMENT.md) — Catalog structure and images
- [`./HOSTING_PLANS.md`](./HOSTING_PLANS.md) — Plan restrictions and customization
- [`../04-deployment/MANAGEMENT_API_SPEC.md`](../04-deployment/MANAGEMENT_API_SPEC.md) — API specification
- [`../02-operations/CLIENT_PANEL_FEATURES.md`](../02-operations/CLIENT_PANEL_FEATURES.md) — Client panel
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Admin panel
- [`./SHARED_POD_IMPLEMENTATION.md`](./SHARED_POD_IMPLEMENTATION.md) — Shared pod architecture

---

**Status:** Ready for implementation  
**Estimated Development Time:** 3-4 weeks (backend, frontend, testing)  
**Priority:** HIGH — Critical for customer flexibility and support  
**Complexity:** High — Involves pod lifecycle, config migration, compatibility detection

