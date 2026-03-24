# File Transfer: FTP/FTPS/SSH/SFTP Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, platform architects, support team

---

## Overview

This document specifies the **file transfer** feature, enabling customers to upload, download, and manage website files via industry-standard protocols: FTP, FTPS, and SSH/SFTP. The implementation prioritizes security (encryption, isolation, audit logging) while maintaining simplicity and compatibility with all major FTP/SFTP clients.

### Key Features

- **Multiple Protocols** — FTP (optional, for legacy clients), FTPS (TLS-encrypted), and SSH/SFTP (most secure)
- **Per-Customer Users** — Create multiple FTP/SSH users per customer with individual passwords and permissions
- **Path Isolation** — Each user restricted to customer's document root (`/home/customer/public_html/`)
- **Quota Management** — Per-user upload/download bandwidth limits, storage quota enforcement
- **Chroot Jail** — Impossible for users to escape their assigned directory
- **Audit Logging** — All file operations logged (upload, download, delete, rename) with user, IP, timestamp
- **Works Everywhere** — Shared pods (Starter) and dedicated pods (Business/Premium)
- **Web UI** — Optional file browser for non-technical customers (upload, download, delete, rename)
- **Automatic Backups** — File change tracking for restore functionality
- **API-Driven** — Full REST API for customer and admin management

### Use Cases

| Use Case | Example |
|----------|---------|
| **Web development** | Developer uploads code via SFTP during CI/CD or manual deployment |
| **Website maintenance** | Content manager downloads files, edits locally, uploads back |
| **Backup & restore** | Customer downloads complete website backup via SFTP |
| **File synchronization** | rsync or manual scripts sync files between systems |
| **Legacy support** | Older clients using FTP-only tools (FTP + FTPS available) |
| **Admin bulk operations** | Support staff downloads logs, config files for troubleshooting |
| **Third-party integrations** | External tools upload files (e.g., form submissions, backup scripts) |

### Security Model

- **Encryption enforced** — FTP disabled by default; FTPS + SSH/SFTP only
- **Per-customer isolation** — Users cannot access other customers' files
- **Chroot jail** — Users cannot escape their document root via `../` or symlinks
- **IP-based rate limiting** — Prevent brute force and DOS attacks
- **Audit trail** — Every file operation logged for compliance (GDPR, HIPAA, SOX)
- **Password strength** — System-generated or customer-created with complexity requirements
- **Credential rotation** — Customers can reset/regenerate credentials anytime
- **Admin oversight** — Admins can view, rotate, or disable credentials

---

## Architecture Overview

### High-Level Design

```
┌──────────────────────────────────────────────────────────────────┐
│ Customer's FTP/SFTP Client (Filezilla, Cyberduck, rsync, etc)   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Username: customer-dev                                           │
│ Password: ••••••••••                                             │
│ Host: sftp.platform.com (or ftp.platform.com)                   │
│ Port: 22 (SFTP) or 21 (FTP) or 990 (FTPS)                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Load Balancer (per-region)                                       │
├──────────────────────────────────────────────────────────────────┤
│ Port 22 (SFTP) → SFTP Pods                                       │
│ Port 21 (FTP) → FTP Pods (if enabled)                            │
│ Port 990 (FTPS) → FTP Pods (TLS)                                 │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ SFTP Pod (OpenSSH) - 2-4 replicas per region                     │
├──────────────────────────────────────────────────────────────────┤
│ Username/password auth ← Validates against FTP User DB           │
│ User isolation ← Chroot to /home/customer/public_html/           │
│ File operations ← Logged to audit log                            │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ FTP Pod (vsftpd) - 2-4 replicas per region (optional)           │
├──────────────────────────────────────────────────────────────────┤
│ Username/password auth ← Validates against FTP User DB           │
│ User isolation ← Chroot to /home/customer/public_html/           │
│ File operations ← Logged to audit log                            │
│ TLS enforcement ← FTPS (explicit or implicit)                    │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Shared Storage (NFS / Longhorn)                                  │
├──────────────────────────────────────────────────────────────────┤
│ /storage/customers/                                              │
│ ├─ acme/                                                         │
│ │  └─ public_html/                                               │
│ │     ├─ index.html                                              │
│ │     ├─ css/                                                    │
│ │     └─ js/                                                     │
│ └─ another-co/                                                   │
│    └─ public_html/                                               │
│       ├─ index.php                                               │
│       └─ uploads/                                                │
│                                                                  │
│ Management:                                                      │
│ - Storage quota enforcement per customer                         │
│ - File change tracking (for backups/restores)                    │
│ - Bandwidth throttling per user                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Database                                                         │
├──────────────────────────────────────────────────────────────────┤
│ - ftp_users (username, password_hash, customer_id, etc.)        │
│ - ftp_file_audit_log (user, file, operation, timestamp, etc.)   │
│ - ftp_bandwidth_quota (user, monthly_download_mb, etc.)         │
│ - ftp_session_log (login, logout, IP, duration, etc.)           │
└──────────────────────────────────────────────────────────────────┘
```

### Protocol Selection Guide

| Protocol | Security | Legacy Support | Recommendation | Use When |
|----------|----------|----------------|---|---|
| **FTP** | ❌ None (plaintext) | ✅ Yes | ❌ Do not use | Legacy clients only; disabled by default |
| **FTPS** | ✅ TLS (data + control) | ✅ Yes | ✅ Good | Clients supporting TLS (most tools) |
| **SSH/SFTP** | ✅ SSH encryption | ⚠️ Older clients | ✅ Best | Modern clients, developers, production |

**Recommendation:** Enable SSH/SFTP + FTPS by default. Offer FTP only if explicitly requested by customer (and document the security risk).

> **Note:** FTP (plaintext) is not offered. Only SFTP and FTPS are supported.

---

## Infrastructure Components

### 1. SSH/SFTP Server (OpenSSH)

**Container Image:** `openssh-server:latest-alpine` or distroless variant

**Deployment:**
- 2-4 replicas per region
- StatefulSet (for session persistence across restarts)
- Port 22/TCP (NodePort or hostPort on worker nodes)
- Shared volume: `/storage/customers/` (read-write)

> **Security requirement:** SFTP pods MUST mount per-customer subpaths (`subPath: customers/{id}`) rather than the entire `/storage/customers/` tree. This ensures that even if the OpenSSH chroot is bypassed, the pod only has filesystem access to the authenticated customer's data. See SECURITY_ARCHITECTURE.md.

**Key Configuration:**
```bash
# /etc/ssh/sshd_config (Kubernetes ConfigMap)

# User isolation (chroot jail)
Match User *
  ChrootDirectory /home/%u
  AllowTcpForwarding no
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  X11Forwarding no
  PermitTTY no
  ForceCommand /bin/false  # Prevent shell access (SFTP only)

# Authentication
PasswordAuthentication yes
PubkeyAuthentication no  # (optional: support SSH keys in future)
PermitRootLogin no
PermitEmptyPasswords no

# Security hardening
ClientAliveInterval 300  # Timeout after 5 min inactivity
ClientAliveCountMax 2
MaxAuthTries 3
MaxSessions 10

# Logging
SyslogFacility AUTH
LogLevel VERBOSE
```

**PAM Configuration (for SFTP user auth):**
```bash
# /etc/pam.d/sshd

# Validate username/password against ftp_users table via MariaDB plugin
auth required pam_mysql.so user=ftp_user password=ftp_pass host=mysql.database.svc.cluster.local database=platform
account required pam_mysql.so user=ftp_user password=ftp_pass host=mysql.database.svc.cluster.local database=platform
```

### 2. FTP/FTPS Server (vsftpd)

**Container Image:** `vsftpd:latest-alpine`

**Deployment:**
- 2-4 replicas per region
- StatefulSet
- Port 21/TCP + Port 990/TCP (TLS) (NodePort or hostPort on worker nodes)
- Shared volume: `/storage/customers/` (read-write)

**Key Configuration:**
```bash
# /etc/vsftpd.conf (Kubernetes ConfigMap)

# SSL/TLS (FTPS)
ssl_enable=YES
force_local_data_ssl=YES  # Enforce TLS on data connection
force_local_logins_ssl=YES  # Enforce TLS on control connection
ssl_ciphers=HIGH
ssl_tlsv1=NO
ssl_tlsv1_1=NO
ssl_tlsv1_2=YES

# SSL certificates (mounted from Kubernetes Secret)
rsa_cert_file=/etc/vsftpd/certs/server.crt
rsa_private_key_file=/etc/vsftpd/certs/server.key

# User isolation (chroot jail)
chroot_local_user=YES
chroot_list_enable=YES
chroot_list_file=/etc/vsftpd/chroot_list
# (chroot_list is empty; all users jailed)

# Authentication
local_enable=YES
pam_service_name=vsftpd
# Validate against ftp_users table via PAM/MariaDB

# File/directory permissions
local_umask=0022
file_open_mode=0644
dirlist_enable=YES
download_enable=YES
dirlist_enable=YES
write_enable=YES
mkd_write_enable=YES
rmd_write_enable=YES
chmod_enable=YES

# Logging
xferlog_enable=YES
xferlog_file=/var/log/vsftpd.log
xferlog_std_format=NO
log_ftp_protocol=YES  # Log all commands and responses

# Security
anonymous_enable=NO
local_enable=YES
ascii_upload_enable=YES
ascii_download_enable=YES
ftpd_banner="Welcome to Platform FTP Server"
max_per_ip=10  # Max connections per IP
max_clients=100
idle_session_timeout=300
data_connection_timeout=120
connect_timeout_sec=60

# Bandwidth throttling (optional, can be enforced at pod level)
anon_max_rate=0  # No anonymous
local_max_rate=10485760  # 10 MB/s per user (configurable)
```

### 3. Database Tables

#### `ftp_users` — FTP/SFTP user credentials
```sql
CREATE TABLE ftp_users (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  -- Hash format: bcrypt ($2y$10$...) for compatibility
  
  description VARCHAR(255),
  -- e.g., "Production", "Staging Dev", "Client Access"
  
  enabled BOOLEAN DEFAULT TRUE,
  -- Can be disabled without deletion for audit purposes
  
  root_path VARCHAR(512) NOT NULL DEFAULT '/storage/customers/{customer_id}/public_html/',
  -- Chroot jail directory for this user
  
  allow_read BOOLEAN DEFAULT TRUE,
  allow_write BOOLEAN DEFAULT TRUE,
  allow_delete BOOLEAN DEFAULT TRUE,
  allow_rename BOOLEAN DEFAULT TRUE,
  allow_mkdir BOOLEAN DEFAULT FALSE,
  -- Per-user permissions (future: fine-grained ACLs)
  
  max_upload_monthly_mb BIGINT DEFAULT NULL,
  -- NULL = unlimited; 0 = disabled
  max_download_monthly_mb BIGINT DEFAULT NULL,
  
  ip_whitelist TEXT,
  -- CSV list or NULL (no restrictions). Format: "192.168.1.0/24,10.0.0.5"
  
  session_timeout_minutes INT DEFAULT 30,
  max_concurrent_sessions INT DEFAULT 5,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id BIGINT UNSIGNED,
  -- NULL if auto-generated; user ID if admin-created
  
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT UNSIGNED,
  
  last_login_at TIMESTAMP NULL,
  
  expires_at TIMESTAMP NULL,
  -- NULL = never expires; future: support temporary/contractor accounts
  
  password_rotated_at TIMESTAMP NULL,
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  UNIQUE KEY unique_username_per_customer (customer_id, username),
  KEY idx_customer_enabled (customer_id, enabled),
  KEY idx_expires (expires_at)
);
```

#### `ftp_file_audit_log` — File operation audit trail
```sql
CREATE TABLE ftp_file_audit_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  ftp_user_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  
  operation ENUM('UPLOAD', 'DOWNLOAD', 'DELETE', 'RENAME', 'MKDIR', 'CHMOD', 'CONNECT', 'DISCONNECT', 'FAILED_AUTH') NOT NULL,
  
  file_path VARCHAR(1024) NOT NULL,
  -- Relative to customer's root: "css/style.css", "uploads/image.jpg"
  
  file_size_bytes BIGINT UNSIGNED,
  -- Size at time of operation; NULL for non-file operations
  
  source_ip VARCHAR(45) NOT NULL,
  -- IPv4 or IPv6
  
  protocol ENUM('FTP', 'FTPS', 'SFTP') NOT NULL,
  
  status ENUM('SUCCESS', 'FAILED', 'DENIED') NOT NULL,
  error_message VARCHAR(512),
  
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (ftp_user_id) REFERENCES ftp_users(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  
  KEY idx_customer_timestamp (customer_id, timestamp),
  KEY idx_ftp_user_timestamp (ftp_user_id, timestamp),
  KEY idx_operation_timestamp (operation, timestamp),
  KEY idx_file_path (file_path(255))
);
```

#### `ftp_bandwidth_quota_usage` — Monthly bandwidth tracking
```sql
CREATE TABLE ftp_bandwidth_quota_usage (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  ftp_user_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  
  year_month DATE NOT NULL,  -- First day of month (2026-03-01)
  
  upload_bytes BIGINT UNSIGNED DEFAULT 0,
  download_bytes BIGINT UNSIGNED DEFAULT 0,
  
  last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (ftp_user_id) REFERENCES ftp_users(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  
  UNIQUE KEY unique_user_month (ftp_user_id, year_month),
  KEY idx_customer_month (customer_id, year_month)
);
```

#### `ftp_session_log` — Login/logout tracking
```sql
CREATE TABLE ftp_session_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  ftp_user_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  
  session_id VARCHAR(128) UNIQUE,
  -- Generated for tracking across login → operations → logout
  
  login_ip VARCHAR(45) NOT NULL,
  login_at TIMESTAMP NOT NULL,
  
  logout_at TIMESTAMP NULL,
  logout_reason ENUM('NORMAL', 'TIMEOUT', 'ADMIN_DISCONNECT', 'ERROR') DEFAULT NULL,
  
  operations_count INT DEFAULT 0,
  bytes_uploaded BIGINT UNSIGNED DEFAULT 0,
  bytes_downloaded BIGINT UNSIGNED DEFAULT 0,
  
  FOREIGN KEY (ftp_user_id) REFERENCES ftp_users(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  
  KEY idx_customer_dates (customer_id, login_at, logout_at),
  KEY idx_ftp_user_dates (ftp_user_id, login_at)
);
```

#### `ftp_event_log` — Real-time operation logging (for streaming)
```sql
CREATE TABLE ftp_event_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  session_id VARCHAR(128) NOT NULL,
  ftp_user_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  
  event_type ENUM('LOGIN', 'FILE_OPERATION', 'QUOTA_WARNING', 'LOGOUT') NOT NULL,
  event_data JSON,  -- Event-specific details
  
  timestamp TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),  -- Microsecond precision
  
  FOREIGN KEY (ftp_user_id) REFERENCES ftp_users(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  
  KEY idx_session (session_id),
  KEY idx_timestamp (timestamp)
);
```

---

## API Endpoints

### Customer Endpoints

#### 1. List FTP Users (GET)
```
GET /api/v1/customers/{customer_id}/ftp/users
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | int | Results per page (default: 50, max: 100) |
| `offset` | int | Pagination offset (default: 0) |
| `sort` | string | `created_at`, `username`, `last_login_at` (default: `created_at`) |
| `order` | string | `asc`, `desc` (default: `asc`) |

**Response (200 OK):**
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

#### 2. Create FTP User (POST)
```
POST /api/v1/customers/{customer_id}/ftp/users
```

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
  "session_timeout_minutes": 30,
  "max_concurrent_sessions": 3,
  "auto_generate_password": true
}
```

**Response (201 Created):**
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
    // ⚠️ Password only returned on creation; customer must save it
  }
}
```

#### 3. Get FTP User Details (GET)
```
GET /api/v1/customers/{customer_id}/ftp/users/{user_id}
```

**Response (200 OK):**
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
      "ftps_port": 990,
      "root_path": "/storage/customers/1/public_html/"
    }
  }
}
```

#### 4. Update FTP User (PATCH)
```
PATCH /api/v1/customers/{customer_id}/ftp/users/{user_id}
```

**Request Body (all optional):**
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

**Response (200 OK):** Updated user object

#### 5. Rotate FTP User Password (POST)
```
POST /api/v1/customers/{customer_id}/ftp/users/{user_id}/rotate-password
```

**Request Body (optional):**
```json
{
  "new_password": "newpass123",  // Optional; auto-generate if omitted
  "notify_user": true  // Send email with new credentials
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": 4,
    "username": "dev-staging",
    "new_password": "X7kM9pL2qR4sTv6wY8zAb",
    "password_rotated_at": "2026-03-01T12:30:00Z",
    "message": "Password rotated successfully. Please save the new password."
  }
}
```

#### 6. Delete FTP User (DELETE)
```
DELETE /api/v1/customers/{customer_id}/ftp/users/{user_id}
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `force_delete` | bool | Delete immediately (audit log preserved); default: false |
| `soft_delete` | bool | Disable user (can be re-enabled); default: true |

**Response (204 No Content):** Empty response, or (200 OK):
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

#### 7. Get FTP User Audit Log (GET)
```
GET /api/v1/customers/{customer_id}/ftp/users/{user_id}/audit-log
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `operation` | enum | Filter: `UPLOAD`, `DOWNLOAD`, `DELETE`, `RENAME`, `CONNECT`, `DISCONNECT` |
| `start_date` | string | ISO 8601 date; default: 30 days ago |
| `end_date` | string | ISO 8601 date; default: now |
| `limit` | int | Results per page (default: 100) |
| `offset` | int | Pagination offset |

**Response (200 OK):**
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
    },
    {
      "id": 1023,
      "operation": "CONNECT",
      "file_path": null,
      "source_ip": "203.0.113.45",
      "protocol": "SFTP",
      "status": "SUCCESS",
      "timestamp": "2026-02-28T14:25:00Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 245
  }
}
```

#### 8. Get Bandwidth Usage (GET)
```
GET /api/v1/customers/{customer_id}/ftp/users/{user_id}/bandwidth
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `year_month` | string | YYYY-MM format (default: current month) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "year_month": "2026-03",
    "upload_bytes": 52428800,  // 50 MB
    "download_bytes": 104857600,  // 100 MB
    "upload_mb": 50,
    "download_mb": 100,
    "max_upload_monthly_mb": 500,
    "max_download_monthly_mb": 2000,
    "upload_percentage": 10,
    "download_percentage": 5,
    "quota_warning": false,
    "days_remaining_in_month": 29
  }
}
```

#### 9. Get FTP Connection Info (GET)
```
GET /api/v1/customers/{customer_id}/ftp/connection-info
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "sftp": {
      "enabled": true,
      "host": "sftp.platform.com",
      "port": 22,
      "protocol": "SSH/SFTP",
      "cipher_suite": "Modern (TLS 1.3)",
      "instructions": "Use any SFTP client (Filezilla, Cyberduck, rsync, etc.)"
    },
    "ftps": {
      "enabled": true,
      "host": "ftp.platform.com",
      "port": 990,
      "protocol": "FTPS (Explicit TLS)",
      "cipher_suite": "Strong (TLS 1.2+)",
      "instructions": "Use any FTP client with FTPS/TLS support. NOT legacy FTP."
    },
    "ftp_legacy": {
      "enabled": false,
      "host": "ftp.platform.com",
      "port": 21,
      "protocol": "FTP (Plaintext - NOT SECURE)",
      "instructions": "⚠️ Not recommended. Only enable if absolutely necessary for legacy clients."
    },
    "recommended": "SFTP on sftp.platform.com:22"
  }
}
```

#### 10. Enable/Disable FTP Protocols (PATCH)
```
PATCH /api/v1/customers/{customer_id}/ftp/settings
```

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

**Response (200 OK):** Updated settings object

---

### Admin Endpoints

#### 1. List All FTP Users (Admin) (GET)
```
GET /api/v1/admin/ftp/users
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `customer_id` | int | Filter by customer |
| `enabled` | bool | Filter by enabled status |
| `status` | enum | `ACTIVE`, `DISABLED`, `EXPIRED` |
| `limit` | int | Results per page |

**Response (200 OK):** Paginated list of all FTP users across all customers

#### 2. Disable/Enable FTP User (Admin) (PATCH)
```
PATCH /api/v1/admin/ftp/users/{user_id}/enable
```

**Request Body:**
```json
{
  "enabled": false,
  "reason": "Account abuse detected"
}
```

**Response (200 OK):** Updated user object

#### 3. Force Password Reset (Admin) (POST)
```
POST /api/v1/admin/ftp/users/{user_id}/force-password-reset
```

**Request Body:**
```json
{
  "temporary_password": "TempPass123",
  "force_change_on_next_login": true,
  "notify_customer": true
}
```

**Response (200 OK):** Confirmation with password details

#### 4. View Customer's FTP Audit (Admin) (GET)
```
GET /api/v1/admin/ftp/customers/{customer_id}/audit-log
```

**Query Parameters:** Same as customer endpoint (operation, date range, etc.)

**Response (200 OK):** Audit log with user information

#### 5. Bulk Disable FTP Users (Admin) (POST)
```
POST /api/v1/admin/ftp/users/bulk-action
```

**Request Body:**
```json
{
  "user_ids": [1, 2, 3],
  "action": "disable",
  "reason": "Compliance audit",
  "notify_customers": true
}
```

**Response (200 OK):** List of affected users and status

---

## Web UI (Client Panel)

### 1. FTP/SFTP Users Management Page

**Location:** `Control Panel → File Transfer → Users`

**Components:**

**Users Table:**
```
┌──────────────────────────────────────────────────────────────┐
│ FTP/SFTP Users                                               │
├──────────────────────────────────────────────────────────────┤
│                                     [+ Create User]           │
├─────────────────────┬────────┬──────────────┬───────────────┤
│ Username            │ Status │ Last Login   │ Actions       │
├─────────────────────┼────────┼──────────────┼───────────────┤
│ dev-user            │ Active │ Today 2:30pm │ [Edit] [...] │
│ staging-deploy      │ Active │ 3 days ago   │ [Edit] [...]  │
│ backup-script       │ Expired│ 30 days ago  │ [Edit] [...]  │
└─────────────────────┴────────┴──────────────┴───────────────┘
```

**User Details Panel (Expanded):**
```
┌──────────────────────────────────────────────────────────────┐
│ dev-user (Edit Mode)                                  [Close] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Description: Production CI/CD                               │
│ Last Login: 2026-02-28 14:25 (203.0.113.45)               │
│ Status: ✓ Enabled                                           │
│                                                              │
│ Permissions:                                                │
│ ☑ Read files      ☑ Write files   ☐ Delete files          │
│ ☐ Rename files    ☐ Create folders                         │
│                                                              │
│ Usage Limits:                                               │
│ Upload: [1000] MB/month      Download: [5000] MB/month     │
│                                                              │
│ Advanced Settings:                                          │
│ Session timeout: [30] minutes                               │
│ Max concurrent sessions: [5]                                │
│ IP whitelist: [203.0.113.0/24]                             │
│ Expires: [2026-06-01]  or [Never]                          │
│                                                              │
│ [Save Changes] [Reset Password] [Rotate Password] [Delete] │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Create User Modal:**
```
┌──────────────────────────────────────────────────────────────┐
│ Create FTP/SFTP User                                  [Close] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Username: [dev-new-user________________]                     │
│ Description: [___________________________]                   │
│                                                              │
│ Password Options:                                           │
│ ◉ Auto-generate strong password                             │
│ ○ Use custom password: [______________]                     │
│                                                              │
│ Permissions (defaults):                                     │
│ ☑ Read files      ☑ Write files   ☐ Delete files          │
│                                                              │
│ Usage Limits:                                               │
│ Upload: [Unlimited] or [500] MB/month                       │
│ Download: [Unlimited] or [2000] MB/month                    │
│                                                              │
│ [Create User] [Cancel]                                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2. FTP/SFTP Connection Info Page

**Location:** `Control Panel → File Transfer → Connection Info`

```
┌──────────────────────────────────────────────────────────────┐
│ Connection Information                                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ 🔒 SSH/SFTP (Recommended)                                   │
│    Host: sftp.platform.com                                  │
│    Port: 22                                                 │
│    Instructions: [View Guide] [Copy to Clipboard]          │
│                                                              │
│ 🔒 FTPS (TLS-Encrypted FTP)                                │
│    Host: ftp.platform.com                                   │
│    Port: 990                                                │
│    Instructions: [View Guide] [Copy to Clipboard]          │
│                                                              │
│ ⚠️ FTP Legacy (NOT SECURE)                                 │
│    Status: Disabled                                         │
│    [Enable if Necessary] (⚠️ Warning message shown)         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Guide Pop-up:**
```
┌──────────────────────────────────────────────────────────────┐
│ How to Connect with Filezilla                        [Close] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ 1. Download Filezilla from filezilla-project.org            │
│                                                              │
│ 2. Open Site Manager and create a new site:                │
│    Protocol: SFTP                                           │
│    Host: sftp.platform.com                                  │
│    Port: 22                                                 │
│    Username: dev-user                                       │
│    Password: (from credentials)                             │
│    Encryption: Require explicit FTP over TLS/SSL            │
│                                                              │
│ 3. Click "Connect"                                          │
│                                                              │
│ [Alternative Guides: Cyberduck, rsync, WinSCP, Putty]      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3. File Browser (Optional Web UI)

**Location:** `Control Panel → File Transfer → Browser` (optional)

```
┌────────────────────────────────────────────────────────────────┐
│ File Browser                  [Upload] [New Folder] [Refresh]  │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│ Breadcrumb: public_html / css /                               │
│                                                                │
│ ┌─────────────────────────────────────────────────────────┐  │
│ │ Name                 Size        Modified        Actions │  │
│ ├─────────────────────────────────────────────────────────┤  │
│ │ style.css            2.1 KB      2 hrs ago    [↓] [...]  │  │
│ │ main.css             1.8 KB      1 day ago    [↓] [...]  │  │
│ │ responsive.css       3.2 KB      1 week ago   [↓] [...]  │  │
│ │                                                           │  │
│ │ Quota: 50 MB / 1000 MB (5%) Used    [Details]          │  │
│ └─────────────────────────────────────────────────────────┘  │
│                                                                │
│ [Download Selected] [Delete Selected] [Rename]                │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**File Context Menu:**
```
├─ Download
├─ View
├─ Rename: [new_name.css__________]
├─ Delete
├─ Properties
│  ├─ Size: 2.1 KB
│  ├─ Modified: 2026-02-28 14:25
│  ├─ Permissions: rw-r--r--
│  └─ [Edit Permissions]
```

### 4. Usage & Audit Log Page

**Location:** `Control Panel → File Transfer → Usage & Activity`

**Bandwidth Usage Chart:**
```
┌──────────────────────────────────────────────────────────────┐
│ Bandwidth Usage (March 2026)                                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Upload:   [||||        ] 50 MB / 500 MB (10%)              │
│ Download: [||||||      ] 100 MB / 2000 MB (5%)             │
│                                                              │
│ Per-User Breakdown:                                         │
│ ├─ dev-user: 25 MB up / 60 MB down                         │
│ ├─ staging-deploy: 20 MB up / 40 MB down                   │
│ └─ backup-script: 5 MB up / 0 MB down                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Audit Log Table:**
```
┌──────────────────────────────────────────────────────────────┐
│ Activity Log                                [Filter] [Export] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Filters: [User ▼] [Operation ▼] [Date ▼] [Status ▼]      │
│                                                              │
│ User            Operation    File             Time          │
│ ─────────────────────────────────────────────────────────── │
│ dev-user        UPLOAD       style.css        Today 2:30pm │
│ dev-user        CONNECT      (no file)        Today 2:25pm │
│ staging-deploy  DOWNLOAD     index.php        3 days ago   │
│ backup-script   DELETE       old_backup.zip   1 week ago   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Security Considerations

### 1. User Isolation

**Problem:** User X should not access User Y's files or other customers' files.

**Solution:**
- **Chroot Jail** — Each FTP/SFTP user chrooted to `/home/customer/public_html/`
- **OS-level enforcement** — Cannot escape via `../` or symlinks
- **SELinux/AppArmor** (optional) — Additional MAC layer in pod container
- **Database validation** — Management API validates user → customer mapping before granting access

**Test:**
```bash
# User dev-user attempts to access parent directory:
cd ..
# Result: Permission Denied (chroot prevents escape)

# User dev-user attempts to access another customer:
ls /storage/customers/another-customer/
# Result: Permission Denied (mounted read-only for this user)
```

### 2. Encryption

**Problem:** Credentials and files transmitted in plaintext over network.

**Solutions:**
- **SSH/SFTP** (default) — All traffic encrypted with TLS 1.3 (modern ciphers)
- **FTPS** (TLS 1.2+) — Control + data channels encrypted
- **FTP legacy** — Disabled by default; document security risk if enabled
- **In-transit hashing** — MD5/SHA checksums transmitted (optional)
- **At-rest encryption** — Storage volume encrypted via Kubernetes/cloud provider

**Enforcement:**
```bash
# SSH/SFTP server rejects unencrypted connections:
# Client attempts plaintext FTP? → Connection refused on port 21

# FTPS enforces TLS:
# vsftpd config: force_local_data_ssl=YES, force_local_logins_ssl=YES
# Client attempts plaintext data connection? → SSL_REQUIRED error
```

### 3. Authentication

**Problem:** Weak passwords, credential stuffing attacks, brute force.

**Solutions:**
- **System-generated passwords** — 20+ character high-entropy (bcrypt hashed)
- **Rate limiting** — Max 3 failed auth attempts per user per minute
- **IP whitelisting** (optional) — Restrict login to specific IP ranges
- **Password rotation** — Customers can rotate anytime; admin can enforce policy
- **Expiring credentials** — Optional account expiration date
- **Session timeout** — Configurable inactivity timeout (default: 30 minutes)

**Implementation:**
```bash
# PAM/MariaDB validates credentials
# Dovecot/vsftpd queries ftp_users table
# Hash comparison: bcrypt($password) == stored_hash

# Failed login logged to audit_log
# Attempts tracked per user per IP
# After 3 failures → Account lock for 5 minutes
```

### 4. Audit Logging

**Problem:** No visibility into file operations; compliance requirements.

**Solution:** Comprehensive audit trail
- **Every operation logged** — UPLOAD, DOWNLOAD, DELETE, RENAME, MKDIR, CONNECT, DISCONNECT, FAILED_AUTH
- **Metadata captured** — User, file path, file size, source IP, protocol, timestamp, status
- **Immutable log** — Append-only; cannot be deleted or modified by users
- **Compliance retention** — 1-year retention by default (configurable)
- **Real-time streaming** — Events logged with microsecond precision
- **Admin & customer views** — Separated; customers see only their own logs

**Database:**
- `ftp_file_audit_log` — Detailed operation log
- `ftp_session_log` — Login/logout with duration and byte counts
- `ftp_bandwidth_quota_usage` — Monthly tracking
- `ftp_event_log` — Real-time streaming

**Compliance Use Cases:**
- **GDPR:** Customer requests "show me all files downloaded in 2025" → Query audit log
- **HIPAA:** "Verify no unauthorized downloads of patient data" → Review failed_auth attempts
- **SOX:** "Generate audit trail for period X to Y" → Export audit log with signature

### 5. Quota Enforcement

**Problem:** Users upload unlimited data, DoS storage infrastructure.

**Solutions:**
- **Storage quota** — Hard limit per customer (enforced at pod level)
- **Bandwidth quota** — Monthly upload/download limits per user
- **Quota warning** — Alert at 80% and 100%
- **Soft enforcement** — Warn user at 80% ("you are approaching limit")
- **Hard enforcement** — Reject uploads at 100% ("quota exceeded")
- **Per-protocol limits** — Optional: SFTP vs FTPS different limits

**Implementation:**
```sql
-- User bandwidth limits
max_upload_monthly_mb = 500;
max_download_monthly_mb = 2000;

-- Check before each operation:
SELECT upload_bytes FROM ftp_bandwidth_quota_usage 
WHERE ftp_user_id = {user_id} AND year_month = DATE_TRUNC('month', NOW());

IF (upload_bytes + file_size_bytes) > (max_upload_monthly_mb * 1024 * 1024)
  THEN reject_upload("Quota exceeded");
ENDIF;
```

### 6. DDoS & Rate Limiting

**Problem:** Attacker brute-forces credentials, floods with connections, exhausts bandwidth.

**Solutions:**
- **Connection limits** — Max 10 concurrent sessions per IP
- **Login rate limiting** — Max 3 failed auth attempts per user per minute
- **IP-based rate limiting** — Max 100 connections per IP per minute (global)
- **Bandwidth throttling** — 10 MB/s per user (configurable)
- **Timeout enforcement** — Disconnect idle sessions after 5 minutes
- **WAF/DDoS protection** — Cloud provider (Cloudflare, DDoS.com) mitigates large attacks

**Configuration:**
```bash
# vsftpd limits
max_per_ip=10
idle_session_timeout=300
data_connection_timeout=120
local_max_rate=10485760  # 10 MB/s

# sshd limits
MaxAuthTries=3
ClientAliveInterval=300
MaxSessions=10
```

### 7. File Integrity

**Problem:** User deletes important file; need to recover.

**Solution:** Integration with backup/restore
- **File change tracking** — Audit log captures all modifications
- **Snapshots** — Daily/hourly snapshots retained per RESTORE_SPECIFICATION.md
- **Version history** — Customer can browse previous versions and restore
- **Immutable logs** — Deletion logged; cannot be hidden

**Workflow:**
```
1. User deletes "important.zip" via SFTP
2. Event logged: { operation: DELETE, file_path: "important.zip", timestamp: now }
3. Backup snapshot still contains "important.zip"
4. Customer navigates to Restore panel → File restore → "important.zip" → Restore
```

### 8. Admin Oversight

**Problem:** Need security and compliance controls on who can access what.

**Features:**
- **Disabled accounts** — Soft delete (audit log preserved)
- **Forced password reset** — Admin resets password; customer must change on next login
- **Disable protocols** — Admin can disable FTP/FTPS while allowing SFTP only
- **Activity monitoring** — Real-time dashboard of all file operations
- **Suspicious activity alerts** — Automated alerts for unusual patterns (bulk deletes, failed auths, etc.)

---

## Implementation Checklist

### Phase 1: Core Infrastructure (Weeks 1-2)

- [ ] Deploy SSH/SFTP server (OpenSSH)
  - [ ] Container image selection and hardening
  - [ ] StatefulSet configuration
  - [ ] Chroot jail setup per customer
  - [ ] PAM/MariaDB authentication integration
  - [ ] Test user isolation (cannot escape chroot)

- [ ] Deploy FTP/FTPS server (vsftpd)
  - [ ] Container image selection
  - [ ] StatefulSet configuration
  - [ ] TLS certificate generation and renewal
  - [ ] PAM/MariaDB authentication integration
  - [ ] Test FTPS data + control encryption

- [ ] Load balancer / ingress
  - [ ] Port 22/TCP for SFTP
  - [ ] Port 21/TCP for FTP (if enabled)
  - [ ] Port 990/TCP for FTPS
  - [ ] Session stickiness (optional; stateless is preferred)

- [ ] Database schema
  - [ ] Create all 5 tables (ftp_users, audit_log, bandwidth, session_log, event_log)
  - [ ] Create indexes and constraints
  - [ ] Write migration scripts

- [ ] Credential management
  - [ ] Password hashing (bcrypt)
  - [ ] Rotation mechanism
  - [ ] Vault integration (encrypt at-rest)

### Phase 2: API Endpoints (Weeks 3-4)

- [ ] Customer endpoints
  - [ ] List FTP users (GET)
  - [ ] Create FTP user (POST)
  - [ ] Get user details (GET)
  - [ ] Update user (PATCH)
  - [ ] Rotate password (POST)
  - [ ] Delete user (DELETE)
  - [ ] View audit log (GET)
  - [ ] View bandwidth usage (GET)
  - [ ] Get connection info (GET)
  - [ ] Enable/disable protocols (PATCH)

- [ ] Admin endpoints
  - [ ] List all FTP users (GET)
  - [ ] Disable/enable user (PATCH)
  - [ ] Force password reset (POST)
  - [ ] View customer audit log (GET)
  - [ ] Bulk actions (POST)

- [ ] Validation & error handling
  - [ ] Username uniqueness per customer
  - [ ] Password strength validation
  - [ ] IP whitelist format validation
  - [ ] Quota limit validation
  - [ ] Rate limit enforcement

- [ ] Unit tests
  - [ ] Each endpoint tested with valid/invalid inputs
  - [ ] Isolation tests (customer cannot access another's users)
  - [ ] Quota enforcement tests
  - [ ] Audit log verification tests

### Phase 3: Web UI (Weeks 5-6)

- [ ] Users management page
  - [ ] List users table
  - [ ] Create user modal
  - [ ] Edit user panel
  - [ ] Delete user confirmation
  - [ ] Password rotation dialog

- [ ] Connection info page
  - [ ] Display SFTP/FTPS/FTP details
  - [ ] Copy-to-clipboard buttons
  - [ ] Client setup guides (Filezilla, Cyberduck, rsync, etc.)

- [ ] File browser (optional)
  - [ ] Directory listing
  - [ ] Upload files
  - [ ] Download files
  - [ ] Delete files
  - [ ] Create folders
  - [ ] Rename files
  - [ ] Breadcrumb navigation

- [ ] Usage & audit log page
  - [ ] Bandwidth usage chart
  - [ ] Per-user breakdown
  - [ ] Audit log table with filters
  - [ ] Export audit log (CSV/JSON)

### Phase 4: Security & Hardening (Weeks 7-8)

- [ ] Encryption
  - [ ] SSH key generation and storage
  - [ ] TLS certificate provisioning (cert-manager)
  - [ ] Cipher suite hardening
  - [ ] Session key rotation

- [ ] Authentication & rate limiting
  - [ ] PAM integration tested
  - [ ] Failed login tracking
  - [ ] IP-based rate limiting
  - [ ] Connection limits enforcement

- [ ] Audit logging
  - [ ] All operations logged
  - [ ] Timestamps with microsecond precision
  - [ ] Immutable log enforcement
  - [ ] Retention policy enforced

- [ ] Quota enforcement
  - [ ] Storage quota enforced
  - [ ] Bandwidth quota tracked and enforced
  - [ ] Quota warnings sent

- [ ] Admin controls
  - [ ] Disable/enable users
  - [ ] Force password reset
  - [ ] Activity monitoring dashboard
  - [ ] Suspicious activity alerts

### Phase 5: Testing & Documentation (Weeks 9-10)

- [ ] Integration tests
  - [ ] SFTP client connect → upload → download → delete
  - [ ] FTPS client (explicit TLS) connect and operations
  - [ ] FTP legacy (if enabled) tested
  - [ ] Multiple users per customer isolation verified
  - [ ] Quota limits enforced

- [ ] Security tests
  - [ ] Chroot escape attempts blocked
  - [ ] Cross-customer access prevented
  - [ ] Encryption verified (no plaintext)
  - [ ] Audit log immutability verified
  - [ ] Rate limiting tested (brute force, DOS)

- [ ] Performance tests
  - [ ] 100 concurrent SFTP connections
  - [ ] Large file uploads (1 GB+)
  - [ ] Audit log query performance (years of data)

- [ ] Documentation
  - [ ] Runbook for ops team (deployment, troubleshooting, emergency procedures)
  - [ ] Customer guide (how to set up SFTP in Filezilla, rsync, etc.)
  - [ ] Admin guide (manage users, review audit logs, enforce policies)
  - [ ] API documentation (OpenAPI/Swagger)

- [ ] Deployment & cutover
  - [ ] Stage 1: Deploy SFTP only (no FTP)
  - [ ] Stage 2: Enable FTPS after validation
  - [ ] Stage 3: Optional FTP legacy (for customers who request)
  - [ ] Customer notification & guides

---

## Operational Considerations

### Deployment Topology

**Per Region:**
```yaml
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: sftp-server
  namespace: sftp
spec:
  serviceName: sftp-service
  replicas: 2  # Per region; scale to 4 for high availability
  selector:
    matchLabels:
      app: sftp-server
  template:
    metadata:
      labels:
        app: sftp-server
    spec:
      containers:
      - name: openssh
        image: openssh-server:latest-alpine
        ports:
        - containerPort: 22
          protocol: TCP
        env:
        - name: DATABASE_HOST
          value: mysql.database.svc.cluster.local
        - name: DATABASE_NAME
          value: platform
        volumeMounts:
        - name: storage
          mountPath: /storage/customers
        - name: ssh-config
          mountPath: /etc/ssh
        - name: ssh-keys
          mountPath: /etc/ssh/keys
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: storage
        nfs:
          server: nfs.storage.svc.cluster.local
          path: /customers
      - name: ssh-config
        configMap:
          name: sshd-config
      - name: ssh-keys
        secret:
          secretName: ssh-host-keys
  volumeClaimTemplates:
  - metadata:
      name: ssh-logs
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 10Gi
```

### Monitoring & Alerts

**Key Metrics:**
- Active SFTP/FTP connections per pod
- Failed login attempts per user/IP
- Quota usage per customer
- Bandwidth utilization
- Pod CPU/memory usage
- Audit log write latency

**Alerts:**
- Failed logins > 10 per user in 1 hour (credential stuffing attempt)
- Quota exceeded for user (notify customer)
- Pod restart (investigate errors)
- Audit log write latency > 1 second (DB issue)

### Backup & Recovery

**File Data Backup:**
- Handled by main backup system (snapshots, external storage)
- FTP/SFTP role: Enable fast restore via RESTORE_SPECIFICATION.md

**Credentials Backup:**
- Password hashes backed up to Vault
- Rotate hashes on schedule
- No plaintext passwords stored

**Audit Log Backup:**
- Export to immutable storage (S3 with object lock)
- Retention: 1 year minimum (per compliance)
- Searchable via Management API

---

## Compliance & Regulatory

### GDPR (Data Protection)

- **Data subject requests** — Customer can download all files via SFTP/web UI
- **Audit trail** — Every file operation logged with timestamp and user
- **Right to erasure** — Delete user account → files deleted (but audit log preserved)
- **Data breach notification** — Failed authentication attempts logged; admins alerted on suspicious activity

### HIPAA (Healthcare)

- **Encryption in transit** — SSH/SFTP enforced
- **Encryption at rest** — Storage encrypted via cloud provider
- **Access controls** — Chroot jail, IP whitelist, password rotation
- **Audit logging** — All operations logged; immutable and retained 6 years
- **Integrity checks** — File checksums tracked (optional)

### SOX (Financial)

- **Segregation of duties** — Different roles (customer, support, admin) with different permissions
- **Change tracking** — All file operations logged with user and timestamp
- **Audit trail** — Immutable log; cannot be modified or deleted by users
- **Access control** — Users cannot access beyond their chroot jail
- **Compliance report** — Audit log exportable for external auditors

---

## Future Enhancements

### Phase 2 (Post-MVP)

- **SSH key-based authentication** — Support public/private keys (in addition to passwords)
- **Two-factor authentication** — OTP (TOTP) or U2F for FTP/SFTP login
- **Fine-grained ACLs** — Per-user, per-directory permissions (read, write, delete, rename)
- **File versioning** — Web UI shows file history; restore previous versions
- **Bandwidth metering** — Real-time bandwidth meter showing current upload/download speed
- **WebDAV** — Alternative protocol for clients that prefer it
- **Resumable uploads** — Support for large file uploads with pause/resume
- **Compression** — Automatic compression of files over size threshold

### Phase 3 (Advanced)

- **Backup integration** — Auto-sync backups to external storage via SFTP
- **Sync workflows** — Scheduled sync between customer's local directory and platform
- **Collaboration** — Multi-user file locks, shared annotations
- **Zero-knowledge encryption** — Customer-side encryption (server cannot decrypt)
- **Ransomware detection** — Automated detection of unusual file activity patterns
- **Geographic failover** — SFTP traffic fails over to regional backup

---

## Summary

The **File Transfer: FTP/SFTP/SSH/SFTP specification** provides:

✅ **Security-first design** — SSH/SFTP default; encryption enforced; chroot isolation  
✅ **Audit compliance** — Immutable logging; retention policies; compliance-ready  
✅ **Easy customer access** — Multiple protocols; web UI optional; client guides  
✅ **Admin control** — User management, password rotation, activity monitoring, protocol enforcement  
✅ **Scalability** — Stateless pods; load balancer support; per-region deployment  
✅ **Production-ready** — Database schema, API endpoints, implementation checklist, security hardening

This feature is ready for implementation and can be integrated with existing platform infrastructure (storage, auth, backup/restore, monitoring).
