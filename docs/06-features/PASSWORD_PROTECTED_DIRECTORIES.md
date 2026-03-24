# Password-Protected Directories Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, platform architects, support team

---

## Overview

This document specifies the **password-protected directories** feature, allowing customers to restrict access to specific directories or paths on their websites using HTTP Basic Authentication (username/password).

### Key Features

- **Simple HTTP Basic Auth** — Standard web server authentication via Authorization header
- **Path-based Protection** — Protect specific directories (e.g., `/admin/`, `/private/`, `/assets/staging/`)
- **Multiple Users** — Create multiple username/password combinations per protected directory
- **Admin & Client Management** — Both admin panel and client self-service
- **Works Everywhere** — Shared pods, dedicated pods, all PHP versions
- **Standard Tools** — Uses industry-standard `.htpasswd` format (bcrypt hashing)
- **API-Driven** — Full REST API for automation

### Use Cases

| Use Case | Example |
|----------|---------|
| **Admin portal** | Restrict `/admin/` to team members only |
| **Staging environment** | Protect `/staging/` or `/preview/` URLs |
| **Internal tools** | `/reports/`, `/analytics/`, `/dashboard/` |
| **Download areas** | Restrict `/downloads/private/` to registered users |
| **Development branches** | `/dev/`, `/beta/`, `/test/` |
| **Contractors/temporary access** | `/work/`, `/temp/uploads/` with time-limited users |

### Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│ Client Browser                                                 │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  GET /admin/index.php                                          │
│  → No Authorization header                                     │
│  → 401 Unauthorized                                            │
│  → Browser shows login dialog                                  │
│                                                                │
│  GET /admin/index.php                                          │
│  Authorization: Basic base64(user:pass)                        │
│  → NGINX checks against .htpasswd                              │
│  → Valid → 200 OK (content served)                             │
│  → Invalid → 401 Unauthorized (try again)                      │
└────────────────────────────────────────────────────────────────┘
         ↓                            ↓
┌────────────────────────────────────────────────────────────────┐
│ NGINX (Shared/Dedicated Pod)                                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  location ~ ^/admin/ {                                         │
│    auth_basic "Restricted Area";                               │
│    auth_basic_user_file /var/www/acme/.htpasswd;             │
│    try_files $uri $uri/ /index.php?$query_string;            │
│  }                                                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────────────────────────┐
│ Storage (.htpasswd file)                                       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  /var/www/acme/.htpasswd:                                     │
│  admin:$2y$10$abcd1234...                                     │
│  contractor:$2y$10$efgh5678...                                │
│  temp_user:$2y$10$ijkl9012...                                 │
│                                                                │
│  /var/www/acme/.htpasswd-staging:                             │
│  john:$2y$10$mnop3456...                                      │
│  jane:$2y$10$qrst7890...                                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Protected Directory

A directory path that requires HTTP Basic Authentication to access. Multiple directories can have different user lists.

```
Example protected directories:
/admin/              → Uses .htpasswd
/admin/reports/      → Same auth as /admin/ (inherited)
/staging/            → Uses .htpasswd-staging (separate users)
/downloads/private/  → Uses .htpasswd-downloads
```

### User Account (Protected Directory)

A username/password pair that grants access to one or more protected directories.

```
Example users:
- admin:password123          (access to /admin/)
- contractor:temppass456    (access to /admin/, expires 2026-04-01)
- staging_viewer:view789    (access to /staging/ only)
```

### .htpasswd File

Standard Apache/NGINX format file storing hashed credentials:
```
username:$2y$10$hash_of_password
contractor:$2y$10$abcdefghijklmnopqrst
temp_user:$2y$10$uvwxyzabcdefghijklmn
```

**Format:**
- `$2y$10$...` — bcrypt hash (cost 10)
- One user per line
- Generated by `htpasswd` or `openssl passwd` utilities

### Realm (Authentication Realm)

The human-readable name shown in browser login dialog:
```
Browser dialog:
┌─────────────────────────────┐
│ Authentication Required      │
│ Restricted Area             │ ← This is the "realm"
│                             │
│ Username: [________]        │
│ Password: [________]        │
│                             │
│ [Cancel]  [OK]              │
└─────────────────────────────┘
```

---

## Configuration Architecture

### Shared Pod Implementation

**NGINX Configuration (per customer, per protected directory):**

```nginx
# Customer: acme, Protected directory: /admin/
location ~ ^/admin/ {
  auth_basic "Restricted Area: Admin";
  auth_basic_user_file /var/www/acme/.htpasswd-admin;
  
  # Continue normal PHP processing
  try_files $uri $uri/ /index.php?$query_string;
  
  # Pass to FPM with auth info
  location ~ \.php$ {
    fastcgi_pass unix:/var/run/php-fpm-acme.sock;
    include fastcgi.conf;
    
    # Optional: Pass authenticated user to PHP
    fastcgi_param REMOTE_USER $remote_user;
    fastcgi_param AUTH_USER $remote_user;
  }
}
```

**Multiple Protected Directories (Same Customer):**

```nginx
# Customer: acme.com
# Protected dirs: /admin/, /staging/, /downloads/private/

location ~ ^/admin/ {
  auth_basic "Admin Panel";
  auth_basic_user_file /var/www/acme/.htpasswd-admin;
  try_files $uri $uri/ /index.php?$query_string;
}

location ~ ^/staging/ {
  auth_basic "Staging Environment";
  auth_basic_user_file /var/www/acme/.htpasswd-staging;
  try_files $uri $uri/ /index.php?$query_string;
}

location ~ ^/downloads/private/ {
  auth_basic "Private Downloads";
  auth_basic_user_file /var/www/acme/.htpasswd-downloads;
  try_files $uri $uri/ /index.php?$query_string;
}
```

### Dedicated Pod Implementation

For dedicated pods, same approach applies, but NGINX config is customer-specific (not shared).

**NGINX ConfigMap (per customer pod):**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config-customer-001
  namespace: client-customer-001
data:
  nginx.conf: |
    upstream php_backend {
      server unix:/run/php-fpm.sock;
    }
    
    server {
      listen 80;
      server_name example.com;
      
      root /var/www/html;
      
      # Protected directory: /admin/
      location ~ ^/admin/ {
        auth_basic "Admin Area";
        auth_basic_user_file /var/www/html/.htpasswd-admin;
        try_files $uri $uri/ /index.php?$query_string;
        
        location ~ \.php$ {
          fastcgi_pass php_backend;
          include fastcgi.conf;
          fastcgi_param REMOTE_USER $remote_user;
        }
      }
      
      # Unprotected paths
      location ~ \.php$ {
        fastcgi_pass php_backend;
        include fastcgi.conf;
      }
    }
```

---

## Storage & Security

### File Locations

**Shared Pods:**
```
/var/www/{customer_id}/.htpasswd-{dirname}
/var/www/acme/.htpasswd-admin        (1.2 KB)
/var/www/acme/.htpasswd-staging      (1.1 KB)
/var/www/acme/.htpasswd-downloads    (1.3 KB)
```

**Dedicated Pods:**
```
/var/www/html/.htpasswd-{dirname}
/var/www/html/.htpasswd-admin
/var/www/html/.htpasswd-staging
```

### File Permissions

```bash
# .htpasswd files must be readable by NGINX/PHP process
# But NOT world-readable (contains password hashes)

chown www-data:www-data /var/www/acme/.htpasswd-admin
chmod 640 /var/www/acme/.htpasswd-admin

# NOT accessible via HTTP
# NGINX blocks via location rule
location ~ ^\.htpasswd {
  deny all;
}
```

### Password Hashing

**Algorithm:** bcrypt with cost factor 10

```bash
# Generate hash (example)
$ openssl passwd -apr1 "mypassword"
$apr1$r31.....$HqJZimcKQFAMYayBlzkrk/

# Or use htpasswd utility
$ htpasswd -c /var/www/acme/.htpasswd-admin admin
New password: ••••••••
Re-type password: ••••••••
Adding password for user admin

# Or use bcrypt (recommended)
$ htpasswd -b -B /var/www/acme/.htpasswd-admin admin mypassword
Adding password for user admin
```

**Platform Implementation (Node.js example):**

```javascript
// In password protection service
const bcrypt = require('bcrypt');

async function createProtectedDirectory(customerId, dirName, users) {
  const htpasswdContent = await Promise.all(
    users.map(async (user) => {
      const hash = await bcrypt.hash(user.password, 10);
      return `${user.username}:${hash}`;
    })
  ).then(lines => lines.join('\n'));
  
  // Write to .htpasswd file
  await fs.writeFile(
    `/var/www/${customerId}/.htpasswd-${dirName}`,
    htpasswdContent,
    { mode: 0o640 }
  );
  
  // Update NGINX config
  await updateNginxConfig(customerId, dirName);
  
  // Reload NGINX
  await reloadNginx();
}
```

---

## Database Schema

### Protected Directories Table

```sql
CREATE TABLE protected_directories (
  id VARCHAR(36) PRIMARY KEY,
  client_id VARCHAR(36) NOT NULL,
  domain_id VARCHAR(36) NOT NULL,
  path VARCHAR(255) NOT NULL,           -- /admin/, /staging/, etc.
  realm VARCHAR(100) NOT NULL,          -- "Admin Panel", "Staging", etc.
  htpasswd_filename VARCHAR(100) NOT NULL, -- .htpasswd-admin, .htpasswd-staging
  status ENUM('active', 'disabled', 'deleted') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  UNIQUE KEY unique_path (client_id, domain_id, path)
);
```

### Protected Directory Users Table

```sql
CREATE TABLE protected_directory_users (
  id VARCHAR(36) PRIMARY KEY,
  protected_dir_id VARCHAR(36) NOT NULL,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,  -- bcrypt hash
  description VARCHAR(255),              -- "Admin account", "Contractor access", etc.
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP NULL,             -- Optional: auto-disable on date
  last_used TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (protected_dir_id) REFERENCES protected_directories(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user (protected_dir_id, username)
);
```

### Audit Log

```sql
CREATE TABLE protected_directory_audit (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  protected_dir_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36),                   -- NULL if client action
  action VARCHAR(50),                    -- 'user_created', 'user_deleted', 'dir_created', 'dir_disabled', 'password_changed'
  details JSON,                          -- {"username": "admin", "reason": "..."}
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (protected_dir_id) REFERENCES protected_directories(id) ON DELETE CASCADE,
  INDEX idx_created_at (created_at),
  INDEX idx_protected_dir_id (protected_dir_id)
);
```

---

## Management API Specification

### Endpoints

#### 1. Create Protected Directory

**POST** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories`

**Description:** Create a new password-protected directory

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
    "client_id": "client_001",
    "domain_id": "domain_042",
    "path": "/admin/",
    "realm": "Admin Panel",
    "status": "active",
    "users_count": 0,
    "htpasswd_filename": ".htpasswd-admin",
    "created_at": "2025-03-01T10:00:00Z"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 409 (path already protected)

**Side Effects:**
- Creates empty `.htpasswd-{dirname}` file
- Updates NGINX config with `location ~ ^{path}` block
- Reloads NGINX
- Logs to audit trail

---

#### 2. List Protected Directories

**GET** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories`

**Query Parameters:**
- `status` (optional) — `active`, `disabled`, `deleted`

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
    },
    {
      "id": "protdir_002",
      "path": "/staging/",
      "realm": "Staging Environment",
      "status": "active",
      "users_count": 2,
      "created_at": "2025-03-01T11:30:00Z"
    }
  ],
  "pagination": { ... }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### 3. Get Protected Directory Details

**GET** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}`

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
      },
      {
        "id": "user_002",
        "username": "contractor",
        "description": "External contractor",
        "is_active": true,
        "expires_at": "2026-04-01T00:00:00Z",
        "created_at": "2025-02-01T10:00:00Z",
        "last_used": null
      }
    ]
  }
}
```

**Status Codes:** 200, 401, 403, 404

---

#### 4. Update Protected Directory

**PATCH** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}`

**Request Body:**
```json
{
  "realm": "Admin Portal (Updated)",
  "status": "disabled"
}
```

**Allowed Updates:**
- `realm` — Change display name
- `status` — `active` → `disabled` → `deleted` (one-way)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "protdir_001",
    "path": "/admin/",
    "realm": "Admin Portal (Updated)",
    "status": "disabled",
    "users_count": 3
  }
}
```

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects (if status changed to disabled):**
- Removes auth_basic block from NGINX config for this path
- Reloads NGINX
- Users can still access directory (no auth required)
- Logs to audit trail

---

#### 5. Delete Protected Directory

**DELETE** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}`

**Query Parameters:**
- `force` (optional, default: false) — Force delete even if active

**Response:**
```json
{
  "success": true,
  "message": "Protected directory deleted"
}
```

**Status Codes:** 200, 401, 403, 404

**Side Effects:**
- Removes auth_basic block from NGINX config
- Deletes .htpasswd file
- Reloads NGINX
- Logs to audit trail

---

### User Management Endpoints

#### 6. Create User

**POST** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users`

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
- `username` — Required, 3-50 chars, alphanumeric + underscore/dash only
- `password` — Required, 8-128 chars (no validation rules enforced server-side; client responsible)
- `description` — Optional, 0-255 chars
- `expires_at` — Optional, ISO 8601 datetime (future date)

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

**Status Codes:** 201, 400, 401, 403, 409 (username exists)

**Side Effects:**
- Generates bcrypt hash of password
- Appends line to .htpasswd file
- Reloads NGINX (via graceful reload)
- Logs to audit trail (password hash NOT logged)
- Clears user agent browser cache (no control, user must clear)

---

#### 7. List Users (Protected Directory)

**GET** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users`

**Query Parameters:**
- `include_expired` (default: false) — Include expired users
- `sort` (default: created_at) — Sort by: `username`, `created_at`, `expires_at`, `last_used`

**Response:**
```json
{
  "success": true,
  "data": [
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
```

**Status Codes:** 200, 401, 403, 404

---

#### 8. Change Password

**POST** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users/{user_id}/change-password`

**Request Body:**
```json
{
  "new_password": "NewSecurePassword456!"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

**Status Codes:** 200, 400, 401, 403, 404

**Side Effects:**
- Regenerates bcrypt hash
- Updates .htpasswd file
- Reloads NGINX
- Logs to audit trail
- Sessions using old password remain valid until timeout/logout

---

#### 9. Disable User

**POST** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users/{user_id}/disable`

**Response:**
```json
{
  "success": true,
  "message": "User disabled"
}
```

**Status Codes:** 200, 401, 403, 404

**Side Effects:**
- Sets `is_active = false`
- Removes user line from .htpasswd file
- Reloads NGINX
- Active sessions are immediately invalidated
- Logs to audit trail

---

#### 10. Delete User

**DELETE** `/api/v1/clients/{id}/domains/{domain_id}/protected-directories/{dir_id}/users/{user_id}`

**Response:**
```json
{
  "success": true,
  "message": "User deleted"
}
```

**Status Codes:** 200, 401, 403, 404

**Side Effects:**
- Removes user from database
- Removes line from .htpasswd file
- Reloads NGINX
- Logs to audit trail

---

## Client Panel Features

### Protected Directories Section

New section in Client Panel: **Sites & Hosting → Protected Directories**

#### Features List

| Feature | Description |
|---------|-------------|
| **Directory list** | All protected directories with path, realm, user count, status |
| **Create protected directory** | Input path, realm; auto-validates |
| **Edit realm** | Change display name |
| **Disable/Enable** | Toggle protection on/off (without deleting) |
| **Delete** | Remove protection entirely |
| **View users** | List users with username, expires_at, last_used, actions |
| **Create user** | Form: username, password, description, expires_at |
| **Change password** | Click user → change password (requires re-entry) |
| **Disable user** | Temporarily revoke access |
| **Delete user** | Permanently remove |
| **Copy credentials** | Copy username:password for backup/sharing |
| **Generate random password** | Auto-generate strong password |
| **User expiration** | Set expiry date; auto-disables expired users |
| **Last used tracking** | Shows when user last accessed protected dir |
| **Activity log** | View recent access logs (if enabled) |

#### UI Mockup

```
┌─────────────────────────────────────────────────────┐
│ Protected Directories                               │
├─────────────────────────────────────────────────────┤
│                                                     │
│ [+ New Protected Directory]  [? Help]               │
│                                                     │
│ /admin/           "Admin Panel"          3 users    │
│ Status: Active    Created: Feb 15, 2025            │
│ [Manage] [Edit Realm] [Disable] [Delete]           │
│                                                     │
│ /staging/         "Staging Environment"  2 users   │
│ Status: Disabled  Created: Jan 20, 2025            │
│ [Manage] [Edit Realm] [Enable] [Delete]            │
│                                                     │
│ /downloads/       "Private Downloads"    1 user    │
│ Status: Active    Created: Mar 01, 2025            │
│ [Manage] [Edit Realm] [Disable] [Delete]           │
│                                                     │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Manage Protected Directory: /admin/                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Realm: Admin Panel                                  │
│ Status: Active | [Disable] [Delete]                │
│                                                     │
│ Users (3):                                          │
│                                                     │
│ admin              [Change PW] [Disable] [Delete]  │
│ Active, Created Feb 15, Last used Mar 01 14:32     │
│                                                     │
│ contractor         [Change PW] [Disable] [Delete]  │
│ Active, Expires Apr 01, Last used never            │
│                                                     │
│ temp_dev           [Change PW] [Disable] [Delete]  │
│ EXPIRED, Created Feb 01, Expires Mar 01            │
│                                                     │
│ [+ Add New User]                                   │
│                                                     │
│ ┌──────────────────────────────────────────────┐  │
│ │ New User                                     │  │
│ │                                              │  │
│ │ Username: [___________________]              │  │
│ │                                              │  │
│ │ Password: [___________________] [Generate]  │  │
│ │                                              │  │
│ │ Description: [___________________]           │  │
│ │ (optional, e.g., "John Doe - contractor")   │  │
│ │                                              │  │
│ │ Expires: [YYYY-MM-DD] or [Never]            │  │
│ │                                              │  │
│ │ [Create User] [Cancel]                       │  │
│ │                                              │  │
│ │ After creation, you'll see:                 │  │
│ │ "✅ User created. Share these credentials:" │  │
│ │ Username: contractor_new                     │  │
│ │ Password: [hidden, click to reveal]          │  │
│ │ [Copy] [Done]                                │  │
│ │                                              │  │
│ └──────────────────────────────────────────────┘  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Admin Panel Features

### Protected Directories Management

**New Section:** **Cluster → Clients → {client} → Domains → {domain} → Protected Directories**

#### Features

| Feature | Description |
|---------|-------------|
| **Client-level override** | Force-enable/disable feature per client |
| **Bulk operations** | Disable all protected dirs for client; delete all |
| **Usage statistics** | Total protected dirs, total users, active users |
| **Access logs** | View HTTP 401/authentication attempts per dir |
| **User audit trail** | Full history of user changes (admin + client) |
| **Performance impact** | Show if auth_basic is slowing requests |
| **NGINX config review** | View generated NGINX config for verification |
| **Force reload** | Manually reload NGINX if needed |
| **Issue resolution** | Troubleshoot auth_basic problems |

---

## Implementation Details

### NGINX Reload Strategy

**Problem:** Reloading NGINX terminates active connections.

**Solution:** Use graceful reload with active request draining.

```bash
# Test config before reload
nginx -t

# Graceful reload (waits for active requests)
systemctl reload nginx

# Or with signal
kill -HUP $(cat /var/run/nginx.pid)

# Verify (check PID changed)
ps aux | grep nginx
```

**Wait time:** 30 seconds maximum, then force-kill old process.

### .htpasswd File Generation

**Platform-side (Node.js/Python):**

```javascript
const bcrypt = require('bcrypt');
const fs = require('fs').promises;

async function generateHtpasswd(users) {
  const lines = await Promise.all(
    users
      .filter(u => u.is_active && (!u.expires_at || new Date(u.expires_at) > new Date()))
      .map(async (u) => {
        // Use bcrypt hash (format: $2y$10$...)
        const hash = await bcrypt.hash(u.password, 10);
        return `${u.username}:${hash}`;
      })
  );
  
  return lines.join('\n') + '\n';
}

async function updateHtpasswdFile(filePath, users) {
  const content = await generateHtpasswd(users);
  await fs.writeFile(filePath, content, { mode: 0o640 });
}
```

### Expiration Handling

**Automatic Expiration Job:**

```bash
# CronJob: Every hour
0 * * * * /usr/local/bin/expire-protected-dir-users.sh

# Script logic:
# 1. Query all protected_directory_users where expires_at < NOW and is_active = true
# 2. Set is_active = false
# 3. Regenerate .htpasswd files for affected directories
# 4. Reload NGINX
# 5. Log to audit trail
```

### Browser Caching

**Issue:** Browser caches credentials after first login. User disabled but browser still sends credentials.

**Solution:** 
- HTTP headers prevent intermediate proxy caching
- Browser cache cleared by user (Ctrl+Shift+Del)
- Sessions don't persist across browser restart
- Can't force client-side cache clear from server

**Mitigation:**
```nginx
location ~ ^/admin/ {
  auth_basic "Admin Panel";
  auth_basic_user_file ...;
  
  # Prevent proxy caching
  proxy_no_cache $cookie_nocache $arg_nocache;
  add_header Cache-Control "private, no-cache, no-store, must-revalidate";
  add_header Pragma "no-cache";
  add_header Expires "0";
}
```

### Regex Path Matching

**Exact match:**
```nginx
location = /admin/config.php {
  auth_basic "...";
  ...
}
```

**Prefix match (recommended):**
```nginx
location ~ ^/admin/ {
  auth_basic "...";
  ...
}
```

**Regex (advanced):**
```nginx
location ~ ^/(admin|private|staging)/ {
  auth_basic "...";
  ...
}
```

---

## Limitations & Edge Cases

### Limitation 1: API Access

**Problem:** REST APIs and webhooks can't use HTTP Basic Auth easily.

**Workaround:**
```php
// In protected /api/ directory, check for API token override
if ($_SERVER['HTTP_X_API_TOKEN'] === $valid_token) {
  // Skip HTTP Basic Auth requirement
} else {
  // Require HTTP Basic Auth
  if (!isset($_SERVER['PHP_AUTH_USER'])) {
    // Trigger auth_basic challenge
  }
}
```

**Better Solution:** Don't protect `/api/` — use separate API keys.

### Limitation 2: Subdomains

**Problem:** Protected dirs only work on origin domain, not subdomains (due to host-based routing).

```
www.acme.com/admin/ → Protected ✅
api.acme.com/admin/ → Not protected ❌ (different ingress rule)
```

**Solution:** Use dedicated CNAME for API with separate ingress.

### Limitation 3: Static Files

**Problem:** Protecting `/images/` or `/assets/` protects all static files (slower).

**Solution:** Use separate directory for public assets:
```nginx
location ~ ^/public/ {
  # No auth
}

location ~ ^/private-assets/ {
  auth_basic "...";
}
```

### Limitation 4: POST Requests

**Problem:** Form submissions are protected, but CSRF tokens might be cached.

**Solution:** POST requests are re-authenticated (each request), so no issue.

### Limitation 5: WebSocket/Server-Sent Events

**Problem:** HTTP Basic Auth only sent on initial handshake, not on upgrades.

**Solution:** Don't protect WebSocket endpoints; use app-level auth instead.

```nginx
location ~ ^/api/socket/ {
  # Don't protect — use app-level token auth
  auth_basic off;
}
```

---

## Testing Strategy

### Unit Tests

```javascript
// Test bcrypt hash generation
test('generateHtpasswd creates valid bcrypt hashes', async () => {
  const users = [
    { username: 'admin', password: 'pass123', is_active: true }
  ];
  const content = await generateHtpasswd(users);
  expect(content).toMatch(/^admin:\$2y\$10\$/);
});

// Test expiration filtering
test('expired users are excluded from htpasswd', async () => {
  const users = [
    { username: 'active', password: 'p1', is_active: true, expires_at: null },
    { username: 'expired', password: 'p2', is_active: true, expires_at: '2020-01-01' }
  ];
  const content = await generateHtpasswd(users);
  expect(content).toContain('active:');
  expect(content).not.toContain('expired:');
});
```

### Integration Tests

```bash
# 1. Create protected directory
curl -X POST /api/v1/clients/client_001/domains/domain_042/protected-directories \
  -d '{"path": "/admin/", "realm": "Admin"}'

# 2. Verify NGINX config updated
grep -q "location ~ ^/admin/" /etc/nginx/sites-enabled/acme.com.conf

# 3. Create user
curl -X POST .../protected-directories/protdir_001/users \
  -d '{"username": "admin", "password": "pass123"}'

# 4. Test unauthenticated access → 401
curl http://acme.com/admin/ -i
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Basic realm="Admin"

# 5. Test authenticated access → 200
curl -u admin:pass123 http://acme.com/admin/index.php -i
# HTTP/1.1 200 OK

# 6. Test wrong password → 401
curl -u admin:wrongpass http://acme.com/admin/index.php -i
# HTTP/1.1 401 Unauthorized

# 7. Disable user
curl -X POST .../users/user_001/disable

# 8. Test disabled user → 401
curl -u admin:pass123 http://acme.com/admin/index.php -i
# HTTP/1.1 401 Unauthorized
```

### Load Testing

```bash
# Test with many users in .htpasswd
users_count=1000

# Create 1000 users
for i in {1..1000}; do
  curl -X POST /api/v1/.../users \
    -d "{\"username\": \"user_$i\", \"password\": \"pass_$i\"}"
done

# Benchmark authentication
ab -n 10000 -c 100 -A user_500:pass_500 http://acme.com/admin/

# Expected: auth_basic with 1000 users should be < 5ms latency
```

---

## Monitoring & Alerts

### Metrics to Track

```
# Prometheus metrics
protected_directories_count{client_id, status}       # Total count
protected_directory_users_count{protected_dir_id}   # Users per dir
protected_directory_auth_failures_total             # Failed login attempts
protected_directory_auth_latency_ms                 # Auth check latency
protected_directory_htpasswd_size_bytes             # .htpasswd file size
protected_directory_user_expiring_soon              # Users expiring < 7 days
```

### Alerts

| Alert | Trigger | Action |
|-------|---------|--------|
| **Auth failure rate high** | >100 failures/min for single dir | Potential brute-force attack; enable fail2ban rule |
| **Htpasswd file missing** | Cannot find .htpasswd file | Emergency: Restore from backup, notify admin |
| **NGINX reload failed** | Graceful reload exits with error | Rollback to previous config, investigate |
| **Auth latency spike** | >10ms for auth check (normally <1ms) | Investigate NGINX load, .htpasswd file size |
| **User expiration upcoming** | User expires in <7 days | Notify client to extend expiry |

---

## Implementation Checklist

### Backend (Week 1-2)

- [ ] Database schema (protected_directories, users, audit tables)
- [ ] API endpoints (create, list, update, delete protected dirs)
- [ ] User management endpoints (create, change password, disable, delete)
- [ ] .htpasswd file generation (bcrypt hashing)
- [ ] NGINX config generation and reload
- [ ] Expiration job (CronJob)
- [ ] Audit logging
- [ ] Error handling and validation

### Integration (Week 2)

- [ ] Shared pod NGINX config template update
- [ ] Dedicated pod ConfigMap generation
- [ ] Integration with existing domain lifecycle
- [ ] Delete cascade (when domain/client deleted)

### Frontend (Week 2-3)

- [ ] Client panel UI (list, create, manage protected dirs)
- [ ] User management UI (add, change password, disable, delete)
- [ ] Password reveal/hide toggle
- [ ] Generate random password button
- [ ] Copy to clipboard for credentials
- [ ] Expiration date picker
- [ ] Activity/audit log view
- [ ] Confirmation dialogs for destructive actions

### Admin Panel (Week 3)

- [ ] View all protected directories per client
- [ ] Bulk operations (disable all, delete all)
- [ ] Access logs / authentication failures
- [ ] User audit trail
- [ ] NGINX config review
- [ ] Manual reload trigger
- [ ] Feature toggle per client

### Testing (Week 3-4)

- [ ] Unit tests (hash generation, expiration, etc.)
- [ ] Integration tests (auth flows, NGINX reload)
- [ ] Load tests (many users, many directories)
- [ ] Security tests (brute force, timing attacks)
- [ ] Browser compatibility tests
- [ ] Upgrade path (no data loss)

### Documentation (Week 4)

- [ ] Customer-facing help article
- [ ] Admin guide
- [ ] Troubleshooting guide
- [ ] API documentation

---

## Related Documents

- [`../01-core/SHARED_POD_IMPLEMENTATION.md`](../01-core/SHARED_POD_IMPLEMENTATION.md) — NGINX configuration and templates
- [`../04-deployment/MANAGEMENT_API_SPEC.md`](../04-deployment/MANAGEMENT_API_SPEC.md) — API endpoint specifications
- [`./CLIENT_PANEL_FEATURES.md`](./CLIENT_PANEL_FEATURES.md) — Client panel features and UI
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Admin panel features

---

**Status:** Ready for implementation  
**Estimated Development Time:** 3-4 weeks (backend, frontend, testing)  
**Priority:** HIGH — Commonly requested feature, enables many use cases  
**Complexity:** Medium — Involves NGINX config, file I/O, expiration scheduling

