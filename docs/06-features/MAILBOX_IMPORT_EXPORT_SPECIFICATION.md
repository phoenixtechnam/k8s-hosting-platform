# Mailbox Import/Export via IMAP Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, platform architects, support team

---

## Overview

This document specifies the **mailbox import/export** feature, enabling customers to transfer email content to/from external IMAP servers. Supports migration from legacy hosting providers (Plesk, cPanel, etc.), email consolidation, backup to external services, and switching between providers.

### Key Features

- **Import from External IMAP** — Copy emails from Gmail, Outlook, previous hosting, or any IMAP server
- **Export to External IMAP** — Backup emails to external services (Backblaze, ProtonMail, personal servers, etc.)
- **Multiple Workflows** — Create new account, merge to existing, incremental sync, scheduled sync
- **Folder Mapping** — Smart mapping of source folders to destination (e.g., "Inbox" → "Inbox", "[Gmail]/All Mail" → "Archive")
- **Conflict Resolution** — Handle duplicates, folder name conflicts, timestamp mismatches
- **Progress Tracking** — Real-time job progress (% complete, emails transferred, remaining time)
- **Selective Sync** — Choose which folders to import/export (not everything)
- **Scheduled Sync** — One-time imports, recurring sync jobs, incremental updates
- **Deduplication** — Detect and skip duplicate emails (by Message-ID, content hash)
- **Resume Capability** — Pause and resume long-running jobs without losing progress
- **Audit Logging** — Track all imports/exports for compliance (GDPR, HIPAA, SOX)
- **Admin Oversight** — Admins can monitor, pause, resume, cancel jobs

### Use Cases

| Use Case | Example |
|----------|---------|
| **Migration from legacy hosting** | Move 10,000 emails from cPanel+Dovecot to this platform |
| **Email consolidation** | Merge multiple Gmail accounts into one account on platform |
| **Provider migration** | Switch from previous email hosting to this platform |
| **Backup to external service** | Auto-sync all emails to external backup service |
| **Personal archival** | Export all email to personal IMAP server for long-term storage |
| **Multi-account sync** | Keep work emails synced between platform and Outlook |
| **Disaster recovery** | Restore mailbox from external backup if main system fails |

### Security Model

- **Credential encryption** — External IMAP credentials encrypted at-rest (Vault transit)
- **Connection validation** — TLS/SSL enforcement, certificate pinning (optional)
- **Credential rotation** — Stored securely; deleted after job completes (unless recurring)
- **Audit trail** — All imports/exports logged with user, IP, timestamp
- **Rate limiting** — Prevent abuse (max 5 concurrent jobs per customer)
- **Folder filtering** — Customer can exclude sensitive folders (e.g., Spam, Trash)
- **Admin oversight** — Admins can disable/monitor imports/exports per customer

---

## Architecture Overview

### High-Level Design

```
┌──────────────────────────────────────────────────────────────────┐
│ Customer's Email Account (External IMAP Server)                  │
├──────────────────────────────────────────────────────────────────┤
│ Provider: Gmail, Outlook, Zoho, Previous Hosting, etc.           │
│                                                                  │
│ IMAP Folders:                                                    │
│ ├─ Inbox                                                         │
│ ├─ Sent Mail                                                     │
│ ├─ Drafts                                                        │
│ ├─ [Gmail]/All Mail                                              │
│ └─ Custom folders                                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↕ (IMAP Protocol: List folders, fetch emails, append)
          ↕ (TLS/SSL encryption, authentication via password/token)
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Import/Export Job Service (Kubernetes Pod)                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ - Connect to external IMAP server                                │
│ - List and filter folders                                        │
│ - Fetch emails in batches                                        │
│ - Detect duplicates (Message-ID, hash)                           │
│ - Validate email structure                                       │
│ - Track progress (offset, job state)                             │
│ - Log all operations (audit trail)                               │
│ - Handle retries and failures                                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Platform's Email Infrastructure (Dovecot + Postfix)              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Customer's Mailbox:                                              │
│ ├─ Inbox                                                         │
│ ├─ Sent Mail                                                     │
│ ├─ Archive                   (merged from external "All Mail")   │
│ ├─ Spam                                                          │
│ └─ Custom folders                                                │
│                                                                  │
│ Operations:                                                      │
│ - Append emails to mailbox                                       │
│ - Create folders as needed                                       │
│ - Preserve IMAP flags (Seen, Flagged, Deleted, etc.)            │
│ - Maintain timestamps                                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↕
┌──────────────────────────────────────────────────────────────────┐
│ Database (Job tracking, credentials, audit log)                  │
├──────────────────────────────────────────────────────────────────┤
│ - mailbox_import_export_jobs (job metadata, status, progress)    │
│ - mailbox_import_export_credentials (encrypted IMAP creds)       │
│ - mailbox_import_export_log (audit trail)                        │
│ - mailbox_dedup_cache (Message-ID, content hash for dedup)       │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Management API (REST endpoints)                                  │
├──────────────────────────────────────────────────────────────────┤
│ - POST /api/v1/customers/{id}/email/import-jobs (create)         │
│ - GET /api/v1/customers/{id}/email/import-jobs (list)            │
│ - GET /api/v1/customers/{id}/email/import-jobs/{job_id} (detail) │
│ - POST /api/v1/customers/{id}/email/import-jobs/{job_id}/pause   │
│ - POST /api/v1/customers/{id}/email/import-jobs/{job_id}/resume  │
│ - POST /api/v1/customers/{id}/email/import-jobs/{job_id}/cancel  │
│ - (Similar for export jobs)                                      │
└──────────────────────────────────────────────────────────────────┘
```

### Protocol & Standards

- **IMAP Protocol** — RFC 3501 (IMAP4rev1)
- **IMAP Extensions** — UIDPLUS (UID manipulation), MOVE (folder operations)
- **Authentication** — Plain password, OAuth2 tokens (Gmail, Outlook)
- **Encryption** — TLS 1.2+ (STARTTLS or implicit TLS on port 993)
- **Email Format** — RFC 5322 (email messages), RFC 2822 (MIME)
- **Deduplication** — Message-ID header, SHA256 content hash
- **Folder Mapping** — IMAP folder names standardized (INBOX vs Inbox)

### Job Execution Model

**Stateless Microservice:**
- Import/Export Worker pods (horizontally scalable)
- Long-running jobs with persistent state in database
- Periodic status updates (every 5-10 seconds)
- Can be paused/resumed without data loss
- Auto-retry on transient failures (3 retries max)

**Job States:**
```
CREATED
  ↓
VALIDATING (connecting to external server, listing folders)
  ↓
CONNECTING (establishing IMAP connection)
  ↓
IN_PROGRESS (fetching/transferring emails)
  ├─ Can pause → PAUSED
  │   ↓
  │ RESUMING (continue from last offset)
  │   ↓
  │ IN_PROGRESS
  │
  └─ Can cancel → CANCELLED
  ↓
COMPLETED (success) or FAILED (error)
```

---

## Infrastructure Components

### 1. IMAP Client Library

**Language/Library:** Go, Python, or Rust for performance
- **Python:** `imaplib` (stdlib) + `imapclient` (third-party)
- **Go:** `imap` (github.com/emersion/go-imap)
- **Rust:** `imap-proto` for protocol handling

**Key capabilities:**
- Connect to external IMAP servers
- List mailboxes (folders)
- Fetch emails with headers + body
- Handle IMAP flags (Seen, Flagged, Deleted, Draft, etc.)
- Append emails to destination mailbox
- Create folders on demand
- Handle UTF-7 IMAP folder names (Gmail's [Gmail]/All Mail)
- Detect and handle folder hierarchies

### 2. Deduplication Engine

**Strategy:** Multi-layer deduplication

```
Layer 1: Message-ID Header
  IF email.message_id in database:
    SKIP email (already imported)

Layer 2: Content Hash (SHA256)
  IF SHA256(email.headers + email.body) in database:
    SKIP email (duplicate by content, even without Message-ID)

Layer 3: Platform's Native Dedup
  Dovecot's LDA can use Content-ID for additional dedup
```

**Database:**
```sql
CREATE TABLE mailbox_dedup_cache (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  email_account_id BIGINT,
  message_id VARCHAR(255) UNIQUE,
  content_hash VARCHAR(64) UNIQUE,
  timestamp TIMESTAMP,
  FOREIGN KEY (email_account_id) REFERENCES email_accounts(id)
);
```

### 3. Job Worker Pool

**Kubernetes Deployment:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mailbox-import-export-worker
  namespace: mail
spec:
  replicas: 3  # Adjust based on load
  selector:
    matchLabels:
      app: mailbox-worker
  template:
    metadata:
      labels:
        app: mailbox-worker
    spec:
      containers:
      - name: worker
        image: mailbox-worker:latest-alpine
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: url
        - name: VAULT_ADDR
          value: http://vault.platform.svc.cluster.local:8200
        - name: MAX_CONCURRENT_JOBS
          value: "5"
        - name: BATCH_SIZE
          value: "100"  # Fetch 100 emails at a time
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: 500m
            memory: 1Gi
```

---

## Database Schema

### 1. `mailbox_import_export_jobs` — Job metadata

```sql
CREATE TABLE mailbox_import_export_jobs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  email_account_id BIGINT UNSIGNED NOT NULL,
  
  job_type ENUM('IMPORT', 'EXPORT') NOT NULL,
  
  -- Source (for imports) or destination (for exports)
  external_imap_host VARCHAR(255) NOT NULL,
  external_imap_port INT DEFAULT 993,
  external_imap_username VARCHAR(255) NOT NULL,
  -- password stored in mailbox_import_export_credentials table
  
  -- Workflow type
  workflow_type ENUM('CREATE_NEW_ACCOUNT', 'MERGE_TO_EXISTING', 'INCREMENTAL_SYNC', 'SCHEDULED_SYNC') NOT NULL,
  
  -- For CREATE_NEW_ACCOUNT: new email address
  new_email_address VARCHAR(255),
  
  -- Folder mapping (JSON)
  -- Example: {"Inbox": "Inbox", "[Gmail]/All Mail": "Archive", "Drafts": "Drafts"}
  folder_mapping JSON,
  
  -- Folder filtering
  include_folders TEXT,  -- CSV list or NULL (all folders)
  exclude_folders TEXT,  -- CSV list or NULL (e.g., "Spam,Trash,[Gmail]/Spam")
  
  -- Sync options
  sync_all BOOLEAN DEFAULT TRUE,  -- If false, only selected folders
  preserve_flags BOOLEAN DEFAULT TRUE,  -- Preserve Seen, Flagged, Deleted, etc.
  preserve_timestamps BOOLEAN DEFAULT TRUE,  -- Keep original email dates
  skip_duplicates BOOLEAN DEFAULT TRUE,  -- Enable deduplication
  
  -- Scheduling
  schedule_type ENUM('ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY') DEFAULT 'ONE_TIME',
  schedule_time TIME,  -- For daily/weekly/monthly
  schedule_day_of_week INT,  -- 0=Sun, 1=Mon, ..., 6=Sat (for WEEKLY)
  next_run_at TIMESTAMP NULL,  -- For scheduled jobs
  last_run_at TIMESTAMP NULL,
  
  -- Job progress
  status ENUM('CREATED', 'VALIDATING', 'CONNECTING', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED') DEFAULT 'CREATED',
  progress_percent INT DEFAULT 0,  -- 0-100%
  
  total_emails INT DEFAULT 0,  -- Total emails to transfer
  transferred_emails INT DEFAULT 0,  -- Emails transferred so far
  skipped_emails INT DEFAULT 0,  -- Duplicates/errors skipped
  failed_emails INT DEFAULT 0,  -- Emails that failed to transfer
  
  last_error_message VARCHAR(512),
  last_error_timestamp TIMESTAMP NULL,
  
  -- Resume capability
  last_processed_uid INT,  -- For resuming from last position
  last_processed_folder VARCHAR(255),
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id BIGINT UNSIGNED,
  started_at TIMESTAMP NULL,
  paused_at TIMESTAMP NULL,
  resumed_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  
  estimated_completion_at TIMESTAMP NULL,  -- Estimated time remaining
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (email_account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_customer_status (customer_id, status),
  KEY idx_account_status (email_account_id, status),
  KEY idx_next_run (next_run_at),
  KEY idx_created (created_at)
);
```

### 2. `mailbox_import_export_credentials` — Encrypted IMAP credentials

```sql
CREATE TABLE mailbox_import_export_credentials (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  job_id BIGINT UNSIGNED NOT NULL UNIQUE,
  
  -- Encrypted credentials (stored as base64)
  -- Format: AES-256-GCM encrypted JSON:
  -- {
  --   "host": "imap.gmail.com",
  --   "port": 993,
  --   "username": "user@example.com",
  --   "password": "password_or_oauth_token",
  --   "auth_type": "PASSWORD" or "OAUTH2"
  -- }
  encrypted_credentials TEXT NOT NULL,  -- Encrypted via Vault transit
  
  -- For tracking OAuth2 token refresh
  oauth2_provider VARCHAR(50),  -- "GMAIL", "OUTLOOK", etc.
  oauth2_refresh_token VARCHAR(512),  -- For token refresh (also encrypted)
  oauth2_token_expires_at TIMESTAMP NULL,
  
  -- Security
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TIMESTAMP NULL,
  access_count INT DEFAULT 0,
  
  -- Cleanup: auto-delete after job completes (unless recurring)
  auto_delete_after_completion BOOLEAN DEFAULT TRUE,
  
  FOREIGN KEY (job_id) REFERENCES mailbox_import_export_jobs(id) ON DELETE CASCADE,
  
  KEY idx_job (job_id),
  KEY idx_oauth_provider (oauth2_provider)
);
```

### 3. `mailbox_import_export_log` — Audit trail

```sql
CREATE TABLE mailbox_import_export_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  job_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  email_account_id BIGINT UNSIGNED NOT NULL,
  
  event_type ENUM('JOB_STARTED', 'JOB_PAUSED', 'JOB_RESUMED', 'JOB_COMPLETED', 'JOB_FAILED', 'JOB_CANCELLED', 
                   'FOLDER_SKIPPED', 'EMAIL_TRANSFERRED', 'EMAIL_SKIPPED_DUPLICATE', 'EMAIL_FAILED', 
                   'CONFLICT_RESOLVED', 'PROGRESS_UPDATE') NOT NULL,
  
  event_data JSON,  -- Event-specific details
  -- Examples:
  -- {"folder": "Inbox", "emails_transferred": 150, "progress_percent": 25}
  -- {"message_id": "xxx@example.com", "reason": "duplicate"}
  -- {"folder_source": "All Mail", "folder_dest": "Archive"}
  
  error_message VARCHAR(512),
  
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (job_id) REFERENCES mailbox_import_export_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (email_account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
  
  KEY idx_job_timestamp (job_id, timestamp),
  KEY idx_customer_timestamp (customer_id, timestamp),
  KEY idx_event_type (event_type)
);
```

### 4. `mailbox_dedup_cache` — Deduplication tracking

```sql
CREATE TABLE mailbox_dedup_cache (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  email_account_id BIGINT UNSIGNED NOT NULL,
  job_id BIGINT UNSIGNED,  -- NULL if added during normal operation
  
  -- Deduplication keys
  message_id VARCHAR(255),  -- RFC 5322 Message-ID header
  content_hash VARCHAR(64),  -- SHA256(headers + body)
  
  -- Metadata
  subject VARCHAR(255),  -- For debugging
  from_address VARCHAR(255),
  timestamp_sent TIMESTAMP,  -- Email's original date
  
  first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (email_account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES mailbox_import_export_jobs(id) ON DELETE SET NULL,
  
  UNIQUE KEY unique_dedup (email_account_id, message_id, content_hash),
  KEY idx_account_message_id (email_account_id, message_id),
  KEY idx_account_content_hash (email_account_id, content_hash),
  KEY idx_first_seen (first_seen_at)
);
```

---

## API Endpoints

### Customer Endpoints

#### 1. Create Import Job (POST)
```
POST /api/v1/customers/{customer_id}/email/import-jobs
```

**Request Body:**
```json
{
  "workflow_type": "CREATE_NEW_ACCOUNT",
  "new_email_address": "newemail@customer.com",
  
  "external_imap_host": "imap.gmail.com",
  "external_imap_port": 993,
  "external_imap_username": "oldaccount@gmail.com",
  "external_imap_password": "app_password_or_oauth_token",
  "external_imap_auth_type": "PASSWORD",  // or "OAUTH2"
  
  "folder_mapping": {
    "Inbox": "Inbox",
    "[Gmail]/All Mail": "Archive",
    "[Gmail]/Drafts": "Drafts",
    "[Gmail]/Sent Mail": "Sent Mail"
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
    "created_at": "2026-03-01T12:00:00Z",
    "estimated_completion_at": null,
    "message": "Job created. Validating external IMAP connection..."
  }
}
```

**Error Responses:**
- 400 — Invalid request (missing required fields, invalid email, etc.)
- 401 — Unauthorized
- 403 — Forbidden (customer quota exceeded, disabled by admin)
- 409 — Conflict (email already exists, folder mapping conflict, etc.)

#### 2. Create Export Job (POST)
```
POST /api/v1/customers/{customer_id}/email/export-jobs
```

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
    "Archive": "[Backup]/Archive",
    "Sent Mail": "[Backup]/Sent",
    "Drafts": "[Backup]/Drafts"
  },
  
  "exclude_folders": ["Spam", "Trash"],
  "preserve_flags": true,
  "preserve_timestamps": true,
  "skip_duplicates": true,
  
  "schedule_type": "DAILY",
  "schedule_time": "02:00:00"  // 2 AM UTC
}
```

**Response (201 Created):** Similar to import job

#### 3. List Import/Export Jobs (GET)
```
GET /api/v1/customers/{customer_id}/email/import-jobs
GET /api/v1/customers/{customer_id}/email/export-jobs
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter: `CREATED`, `VALIDATING`, `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `limit` | int | Results per page (default: 50, max: 100) |
| `offset` | int | Pagination offset |
| `sort` | string | Sort field: `created_at`, `status`, `progress_percent` |

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

#### 4. Get Job Details (GET)
```
GET /api/v1/customers/{customer_id}/email/import-jobs/{job_id}
GET /api/v1/customers/{customer_id}/email/export-jobs/{job_id}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "job_type": "IMPORT",
    "customer_id": 123,
    "email_account_id": 456,
    "new_email_address": "newemail@customer.com",
    "workflow_type": "CREATE_NEW_ACCOUNT",
    
    "external_imap_host": "imap.gmail.com",
    "external_imap_port": 993,
    "external_imap_username": "oldaccount@gmail.com",
    
    "status": "IN_PROGRESS",
    "progress_percent": 45,
    "total_emails": 5000,
    "transferred_emails": 2250,
    "skipped_emails": 50,
    "failed_emails": 0,
    
    "current_folder": "Inbox",
    "last_processed_uid": 3500,
    
    "preserve_flags": true,
    "preserve_timestamps": true,
    "skip_duplicates": true,
    
    "created_at": "2026-03-01T12:00:00Z",
    "started_at": "2026-03-01T12:05:00Z",
    "estimated_completion_at": "2026-03-01T14:30:00Z",
    
    "folder_mapping": {
      "Inbox": "Inbox",
      "[Gmail]/All Mail": "Archive"
    },
    
    "recent_events": [
      {
        "event_type": "PROGRESS_UPDATE",
        "event_data": {"folder": "Inbox", "emails_transferred": 2250, "progress_percent": 45},
        "timestamp": "2026-03-01T13:50:00Z"
      }
    ]
  }
}
```

#### 5. Pause Job (POST)
```
POST /api/v1/customers/{customer_id}/email/import-jobs/{job_id}/pause
POST /api/v1/customers/{customer_id}/email/export-jobs/{job_id}/pause
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "status": "PAUSED",
    "paused_at": "2026-03-01T13:55:00Z",
    "last_processed_uid": 2250,
    "last_processed_folder": "Inbox",
    "message": "Job paused. You can resume it later from the same position."
  }
}
```

#### 6. Resume Job (POST)
```
POST /api/v1/customers/{customer_id}/email/import-jobs/{job_id}/resume
POST /api/v1/customers/{customer_id}/email/export-jobs/{job_id}/resume
```

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

#### 7. Cancel Job (POST)
```
POST /api/v1/customers/{customer_id}/email/import-jobs/{job_id}/cancel
POST /api/v1/customers/{customer_id}/email/export-jobs/{job_id}/cancel
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `cleanup_imported` | bool | Delete imported emails if cancelling (default: false) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "job_id": "import_job_12345",
    "status": "CANCELLED",
    "cancelled_at": "2026-03-01T14:05:00Z",
    "transferred_emails": 2250,
    "message": "Job cancelled. 2,250 emails were transferred before cancellation."
  }
}
```

#### 8. Get Job Audit Log (GET)
```
GET /api/v1/customers/{customer_id}/email/import-jobs/{job_id}/audit-log
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `event_type` | enum | Filter by event type |
| `limit` | int | Results per page (default: 100) |
| `offset` | int | Pagination offset |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "event_id": 1001,
      "event_type": "JOB_STARTED",
      "event_data": {"folders_found": 8, "total_emails_found": 5000},
      "timestamp": "2026-03-01T12:05:00Z"
    },
    {
      "event_id": 1002,
      "event_type": "PROGRESS_UPDATE",
      "event_data": {"folder": "Inbox", "emails_transferred": 1000, "progress_percent": 20},
      "timestamp": "2026-03-01T12:20:00Z"
    },
    {
      "event_id": 1003,
      "event_type": "EMAIL_SKIPPED_DUPLICATE",
      "event_data": {"message_id": "123@example.com", "subject": "Meeting notes"},
      "timestamp": "2026-03-01T12:21:00Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 150
  }
}
```

#### 9. Test External IMAP Connection (POST)
```
POST /api/v1/customers/{customer_id}/email/test-imap-connection
```

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
        "unseen": 0,
        "selectable": true
      }
    ],
    "message": "Successfully connected and listed folders."
  }
}
```

**Error Response (400):**
```json
{
  "status": "error",
  "data": {
    "connected": false,
    "error": "AUTHENTICATION_FAILED",
    "message": "Invalid username or password for imap.gmail.com"
  }
}
```

---

### Admin Endpoints

#### 1. List All Import/Export Jobs (Admin) (GET)
```
GET /api/v1/admin/email/import-export-jobs
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `customer_id` | int | Filter by customer |
| `job_type` | enum | Filter: `IMPORT`, `EXPORT` |
| `status` | enum | Filter by status |

**Response:** List of all jobs across all customers

#### 2. Pause/Resume/Cancel Job (Admin) (POST)
```
POST /api/v1/admin/email/import-export-jobs/{job_id}/pause
POST /api/v1/admin/email/import-export-jobs/{job_id}/resume
POST /api/v1/admin/email/import-export-jobs/{job_id}/cancel
```

Same as customer endpoints, but admin can act on any job

#### 3. Disable Import/Export for Customer (Admin) (PATCH)
```
PATCH /api/v1/admin/customers/{customer_id}/email/import-export-settings
```

**Request Body:**
```json
{
  "imports_enabled": false,
  "exports_enabled": true,
  "max_concurrent_jobs": 3,
  "reason": "Security concern"
}
```

**Response:** Updated settings

---

## Web UI (Customer Panel)

### 1. Import/Export Dashboard

**Location:** `Control Panel → Email → Import & Export`

```
┌──────────────────────────────────────────────────────────────┐
│ Email Import & Export                                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ [+ Import from External IMAP] [+ Export to External IMAP]  │
│                                                              │
│ ━━━ ACTIVE JOBS (1) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ Import: newemail@customer.com from imap.gmail.com           │
│ Status: ◐ IN PROGRESS (45%)                                 │
│ Progress: [████████░░░░░░░░░░░░░░] 2,250 / 5,000 emails    │
│ Estimated: 1h 45m remaining                                 │
│ [Pause] [Cancel] [Details]                                  │
│                                                              │
│ ━━━ RECENT JOBS (3) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ ✓ Import (completed)    newemail@customer.com  5,000 emails│
│   Completed 2 days ago                                      │
│                                                              │
│ ✓ Export (completed)    backup@backup.com      3,200 emails│
│   Scheduled sync (daily at 2:00 AM)                         │
│                                                              │
│ ✗ Import (failed)       admin@oldprovider.com  2/500 emails│
│   Error: Connection timeout. [Retry] [Details]             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2. Create Import Job Modal

```
┌──────────────────────────────────────────────────────────────┐
│ Import Email from External IMAP Server                [Close]│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Step 1: Choose Workflow                                     │
│ ◉ Create new email account (recommended)                    │
│ ○ Merge to existing account                                 │
│ ○ One-time sync                                             │
│ ○ Scheduled sync (recurring)                                │
│                                                              │
│ New Email Address: [user@customer.com________]              │
│                                                              │
│ Step 2: External IMAP Server Details                        │
│ Host: [imap.gmail.com_____________]                         │
│ Port: [993]                                                 │
│ Username: [oldaccount@gmail.com________________]            │
│ Password: [••••••••••••••]                                   │
│ Auth Type: ◉ Password ○ OAuth2 (Google/Outlook)            │
│                                                              │
│ [Test Connection]  Result: ✓ Connected. 8 folders found.   │
│                                                              │
│ Step 3: Folder Mapping                                      │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ Source Folder      → Destination Folder    [Auto-Map] │  │
│ ├────────────────────────────────────────────────────────┤  │
│ │ Inbox              → Inbox                             │  │
│ │ [Gmail]/All Mail   → Archive                           │  │
│ │ [Gmail]/Drafts     → Drafts                            │  │
│ │ Sent Mail          → Sent Mail                         │  │
│ │ [Gmail]/Spam       → [skip]                            │  │
│ │ [Gmail]/Trash      → [skip]                            │  │
│ │ Custom folder 1    → → [select destination...]        │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                              │
│ Step 4: Options                                             │
│ ☑ Preserve email flags (Seen, Flagged, etc.)              │
│ ☑ Preserve original timestamps                             │
│ ☑ Skip duplicate emails                                    │
│                                                              │
│ Step 5: Schedule                                            │
│ ◉ One-time import (now)                                     │
│ ○ Daily sync at [02:00] AM                                 │
│ ○ Weekly sync on [Monday] at [02:00] AM                    │
│                                                              │
│ [Start Import] [Save as Draft] [Cancel]                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3. Job Progress & Details Page

```
┌──────────────────────────────────────────────────────────────┐
│ Import Job: newemail@customer.com                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Status: ◐ IN PROGRESS (45%)                                 │
│ Started: 2026-03-01 12:05 UTC                               │
│ Estimated Completion: 2026-03-01 14:30 UTC (1h 45m left)   │
│                                                              │
│ Progress: [████████░░░░░░░░░░░░░░]                          │
│                                                              │
│ Statistics:                                                 │
│ ├─ Total Emails: 5,000                                      │
│ ├─ Transferred: 2,250 (45%)                                 │
│ ├─ Skipped (duplicates): 50                                 │
│ ├─ Failed: 0                                                │
│ └─ Current Folder: Inbox (processing)                       │
│                                                              │
│ Actions:                                                    │
│ [Pause] [Cancel]                                            │
│                                                              │
│ Folder Progress:                                            │
│ ✓ Inbox                1,000 / 1,000 emails                │
│ ◐ Sent Mail             800 / 1,500 emails                 │
│ ○ Archive            0 / 2,000 emails (pending)             │
│ ○ Drafts             0 / 500 emails (pending)               │
│                                                              │
│ Recent Events:                                              │
│ 13:50:00 | PROGRESS_UPDATE | Inbox complete (1,000 emails) │
│ 13:35:00 | PROGRESS_UPDATE | Sent Mail 50% complete (800)  │
│ 13:20:00 | PROGRESS_UPDATE | Started Sent Mail             │
│ 13:05:00 | PROGRESS_UPDATE | Inbox 50% complete (500)      │
│ 12:05:00 | JOB_STARTED | Found 5,000 emails in 8 folders   │
│                                                              │
│ [Export Full Log] [Retry Failed] [View Settings]            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Security Considerations

### 1. Credential Management

**Problem:** Storing IMAP passwords/tokens for external servers.

**Solution:**
- **Vault Transit Encryption** — Encrypt credentials using Vault AES-256-GCM
- **Auto-deletion** — Delete credentials after job completes (unless recurring)
- **Limited access** — Only job workers can decrypt (not web API, not admins)
- **Rotation** — Re-enter credentials for recurring jobs monthly
- **OAuth2 support** — Use OAuth2 tokens for Gmail, Outlook (no passwords stored)

**Implementation:**
```python
# Encrypt credentials before storing
def encrypt_credentials(plain_text_creds):
    response = vault_client.secrets.transit.encrypt_data(
        path="transit/encrypt/mailbox-import-export",
        plaintext=base64.b64encode(json.dumps(plain_text_creds).encode())
    )
    return response['data']['ciphertext']

# Decrypt only in job worker
def decrypt_credentials(encrypted_creds):
    response = vault_client.secrets.transit.decrypt_data(
        path="transit/decrypt/mailbox-import-export",
        ciphertext=encrypted_creds
    )
    return json.loads(base64.b64decode(response['data']['plaintext']))
```

### 2. Connection Security

**Problem:** Connecting to untrusted IMAP servers could be exploited.

**Solutions:**
- **TLS 1.2+ enforcement** — Reject connections without TLS
- **Certificate validation** — Verify server certificate (no self-signed in production)
- **Timeout enforcement** — 30-second connection timeout
- **Rate limiting** — Max 5 concurrent jobs per customer
- **IP whitelisting** (optional) — Restrict to known external servers

**Configuration:**
```python
import ssl
import imaplib

# Enforce TLS 1.2+
context = ssl.create_default_context()
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.verify_mode = ssl.CERT_REQUIRED

# Connect with timeout
imap = imaplib.IMAP4_SSL(
    host=config['host'],
    port=config['port'],
    ssl_context=context,
    timeout=30
)
```

### 3. Data Isolation

**Problem:** Prevent users from accessing other customers' imports/exports.

**Solution:**
- **Database-level filtering** — Query only `(customer_id = current_customer)`
- **API validation** — Verify customer_id matches authenticated user's customer
- **Folder isolation** — Each mailbox isolated at Dovecot level

### 4. Audit Logging

**Problem:** No visibility into who imported/exported what.

**Solution:** Comprehensive audit trail
- **Job creation** — User, IP, timestamp
- **Progress updates** — Periodic snapshots of job state
- **Errors** — Detailed error messages and context
- **Completion** — Final statistics and confirmation
- **Immutable log** — Append-only; cannot be deleted by users

**Compliance Use Cases:**
- **GDPR:** "Show me all imports/exports for customer X in 2025"
- **HIPAA:** "Verify no HIPAA patient data was exported"
- **SOX:** "Audit trail for financial data exports"

### 5. Email Content Security

**Problem:** IMAP import/export transfers sensitive email content.

**Solutions:**
- **In-transit encryption** — TLS for all IMAP connections
- **At-rest encryption** — Platform storage encrypted by cloud provider
- **Deduplication safety** — Hash-based, not content extraction
- **No plaintext logging** — Email bodies never logged
- **Access control** — Only authenticated user can export their own emails

### 6. Quota & Rate Limiting

**Problem:** Prevent abuse (unlimited imports, DOS attacks).

**Solutions:**
- **Max concurrent jobs** — 5 per customer (configurable)
- **Max job duration** — 24 hours (auto-cancel if not completed)
- **Bandwidth limits** — Throttle to 10 MB/s per job
- **Storage quota** — Enforce per-customer storage limits
- **Email limits** — Max emails per job configurable

---

## Conflict Resolution & Deduplication

### Duplicate Detection Strategy

**Layer 1: Message-ID Header**
```
IF email has Message-ID header:
  IF SHA256(message_id) in database:
    SKIP email (already in system)
  ELSE:
    IMPORT email, cache message_id
```

**Layer 2: Content Hash (Fallback)**
```
IF email has no Message-ID (or hash matches):
  IF SHA256(headers + body) in database:
    SKIP email (duplicate by content)
  ELSE:
    IMPORT email, cache content_hash
```

**Layer 3: Dovecot's Native Dedup (Optional)**
```
Dovecot can be configured with Content-ID plugin
to further deduplicate at delivery time
```

### Folder Name Conflicts

**Problem:** Source folder name already exists in destination.

**Solutions:**
1. **Merge** — Append emails to existing folder (default)
2. **Rename** — Create new folder with suffix (e.g., "Inbox 2")
3. **Skip** — Don't import this folder
4. **Map** — Explicit mapping to different destination folder

### Timestamp Conflicts

**Option 1: Preserve Original**
```
Use email's Date header as-is
Pro: Historical accuracy
Con: May appear out-of-chronological-order in UI
```

**Option 2: Use Import Time**
```
Set all emails to import timestamp
Pro: Chronologically sorted
Con: Loses original timestamp
```

**Recommendation:** Preserve original (configurable per job)

---

## Implementation Checklist

### Phase 1: Core Infrastructure (Weeks 1-3)

- [ ] IMAP client library selection (Go/Python/Rust)
  - [ ] Support for TLS/SSL connections
  - [ ] Folder listing and filtering
  - [ ] Email fetching with headers + body
  - [ ] Append operations
  - [ ] OAuth2 token support (Gmail, Outlook)

- [ ] Job worker pod deployment
  - [ ] Kubernetes Deployment (3 replicas)
  - [ ] Job queue (Redis or database-backed)
  - [ ] Horizontal scaling capability
  - [ ] Resource limits and requests

- [ ] Database schema
  - [ ] Create all 4 tables
  - [ ] Create indexes
  - [ ] Write migration scripts

- [ ] Vault integration
  - [ ] Credential encryption/decryption
  - [ ] Transit engine setup
  - [ ] Auto-deletion policy for sensitive data

### Phase 2: Core Functionality (Weeks 4-6)

- [ ] IMAP connection management
  - [ ] TLS/SSL validation
  - [ ] Authentication (password + OAuth2)
  - [ ] Connection pooling
  - [ ] Timeout handling

- [ ] Import workflow
  - [ ] Folder discovery and mapping
  - [ ] Email fetching (batches of 100)
  - [ ] Folder creation on demand
  - [ ] Email append to Dovecot
  - [ ] Flag preservation

- [ ] Export workflow
  - [ ] Connect to external IMAP
  - [ ] Create/select destination folders
  - [ ] Append emails to external
  - [ ] Handle quota errors

- [ ] Deduplication engine
  - [ ] Message-ID extraction
  - [ ] Content hash calculation (SHA256)
  - [ ] Database caching
  - [ ] Duplicate detection and skipping

### Phase 3: API Endpoints (Weeks 7-8)

- [ ] Customer endpoints (9 total)
  - [ ] Create import job
  - [ ] Create export job
  - [ ] List jobs
  - [ ] Get job details
  - [ ] Pause/resume/cancel job
  - [ ] Audit log viewer
  - [ ] Test IMAP connection
  - [ ] Folder preview (discover folders before importing)

- [ ] Admin endpoints (3 total)
  - [ ] List all jobs
  - [ ] Pause/resume/cancel job (any customer)
  - [ ] Disable import/export per customer

- [ ] Error handling & validation
  - [ ] Invalid IMAP credentials
  - [ ] Connection timeouts
  - [ ] Folder not found
  - [ ] Permission errors (read-only folders)
  - [ ] Quota exceeded on destination

### Phase 4: Web UI (Weeks 9-10)

- [ ] Import/Export dashboard
  - [ ] Active jobs list with progress
  - [ ] Recent jobs history
  - [ ] Job status indicators (in progress, paused, completed, failed)

- [ ] Create job wizard
  - [ ] Workflow selection
  - [ ] IMAP server configuration
  - [ ] Folder mapping UI
  - [ ] Options (preserve flags, timestamps, dedup)
  - [ ] Test connection button
  - [ ] Schedule selection

- [ ] Job details page
  - [ ] Progress bar with percentage
  - [ ] Folder-by-folder progress
  - [ ] Real-time event log
  - [ ] Pause/resume/cancel buttons
  - [ ] Statistics (transferred, skipped, failed)

### Phase 5: Security & Hardening (Weeks 11-12)

- [ ] Credential encryption
  - [ ] Vault transit integration
  - [ ] Auto-deletion after job
  - [ ] OAuth2 token refresh

- [ ] Rate limiting & quotas
  - [ ] Max concurrent jobs per customer (5)
  - [ ] Max job duration (24 hours)
  - [ ] Bandwidth throttling (10 MB/s)

- [ ] Audit logging
  - [ ] Immutable log enforcement
  - [ ] Retention policies
  - [ ] Compliance reporting

- [ ] Admin controls
  - [ ] Disable import/export per customer
  - [ ] Suspend jobs if abuse detected
  - [ ] Activity monitoring dashboard

### Phase 6: Testing & Documentation (Weeks 13-14)

- [ ] Integration tests
  - [ ] Test with Gmail (OAuth2)
  - [ ] Test with Outlook (OAuth2)
  - [ ] Test with cPanel/Plesk (password auth)
  - [ ] Test with custom IMAP servers
  - [ ] Test large mailboxes (10,000+ emails)
  - [ ] Test folder mapping and conflicts
  - [ ] Test deduplication
  - [ ] Test pause/resume

- [ ] Security tests
  - [ ] Credential encryption verified
  - [ ] TLS enforcement tested
  - [ ] Rate limiting verified
  - [ ] Audit log immutability verified

- [ ] Performance tests
  - [ ] 100 concurrent jobs (stress test)
  - [ ] Large mailbox import (50,000+ emails)
  - [ ] Database query performance (audit log searches)

- [ ] Documentation
  - [ ] Customer guide (how to import from Gmail, Outlook, etc.)
  - [ ] Admin guide (manage import/export jobs)
  - [ ] API documentation (OpenAPI/Swagger)
  - [ ] Troubleshooting guide (common errors)
  - [ ] Migration playbooks (Plesk → Platform, cPanel → Platform)

- [ ] Deployment & cutover
  - [ ] Stage 1: Deploy worker pods + infrastructure
  - [ ] Stage 2: Enable API endpoints for beta customers
  - [ ] Stage 3: Rollout to all customers
  - [ ] Customer notifications & guides

---

## Operational Considerations

### Deployment Topology

**Job Worker StatefulSet:**
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mailbox-import-export-worker
  namespace: mail
spec:
  serviceName: mailbox-worker
  replicas: 3  # Adjust based on workload
  selector:
    matchLabels:
      app: mailbox-worker
  template:
    metadata:
      labels:
        app: mailbox-worker
    spec:
      containers:
      - name: worker
        image: mailbox-worker:latest-alpine
        env:
        - name: MAX_CONCURRENT_JOBS
          value: "5"  # Per pod
        - name: BATCH_SIZE
          value: "100"  # Emails per batch
        - name: TIMEOUT_SECONDS
          value: "30"
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: 500m
            memory: 1Gi
        volumeMounts:
        - name: state
          mountPath: /var/lib/mailbox-worker
  volumeClaimTemplates:
  - metadata:
      name: state
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 5Gi
```

### Monitoring & Alerts

**Key Metrics:**
- Active jobs (per pod, per customer)
- Job completion rate (success/failure)
- Average job duration
- Emails transferred per job
- Duplicate detection rate
- Failed imports (with error breakdown)
- Credential validation failures (invalid auth)
- Database connection latency

**Alerts:**
- Job timeout > 24 hours (auto-cancel)
- Failed auth attempts > 3 per job (pause job)
- Vault decryption failures (page oncall)
- Audit log write latency > 1 second
- Dedup cache full (cleanup old entries)

### Backup & Recovery

**Credentials:**
- Encrypted in Vault (auto-backed up)
- Rotated monthly
- Never stored in plaintext

**Job State:**
- Persistent in database
- Can resume from last position
- Audit log backed up separately

**Email Data:**
- Backed up by main backup system
- Imported emails protected by mailbox backup
- Audit trail immutable

---

## Compliance & Regulatory

### GDPR (Data Protection)

- **Data portability** — Customers can export emails to external service
- **Audit trail** — All imports/exports logged
- **Right to erasure** — Delete job history; emails retained per retention policy
- **Data processing** — Third-party processors (external IMAP servers) documented

### HIPAA (Healthcare)

- **Encryption in transit** — TLS for all IMAP connections
- **Encryption at rest** — Vault-encrypted credentials
- **Access controls** — Only authenticated user can import/export
- **Audit logging** — All operations logged with user and timestamp
- **Compliance reporting** — Can demonstrate import/export controls

### SOX (Financial)

- **Change tracking** — All imports/exports logged
- **Segregation of duties** — Different roles (customer, admin) with different permissions
- **Audit trail** — Immutable log; cannot be modified by users
- **Retention** — 1-year minimum (configurable per policy)

---

## Future Enhancements

### Phase 2 (Post-MVP)

- **Scheduled sync** — Recurring daily/weekly/monthly imports and exports
- **Two-way sync** — Keep mailbox in sync with external service (bidirectional)
- **Selective sync** — User can mark emails to exclude from future syncs
- **Bandwidth metering** — Real-time display of upload/download speed
- **Folder templates** — Pre-configured folder mappings for popular providers (Gmail, Outlook)
- **Bulk operations** — Import/export multiple email accounts at once
- **Webhook notifications** — Alert on job completion or failure

### Phase 3 (Advanced)

- **Zero-knowledge encryption** — Customer-encrypted emails (platform can't see content)
- **POP3 support** — In addition to IMAP
- **Caldav/CardDAV** — Import/export calendars and contacts
- **S3 export** — Direct export to Amazon S3 bucket
- **Ransomware detection** — Alert if suspicious email deletion patterns detected
- **Smart conflict resolution** — AI-powered duplicate detection (beyond Message-ID)

---

## Summary

The **Mailbox Import/Export via IMAP specification** provides:

✅ **Flexible workflows** — Create new account, merge, one-time, scheduled sync  
✅ **Security-first** — TLS encryption, Vault-encrypted credentials, audit logging  
✅ **Deduplication** — Multi-layer (Message-ID, content hash) to prevent duplicates  
✅ **Progress tracking** — Real-time job status with pause/resume capability  
✅ **Compliance-ready** — GDPR, HIPAA, SOX audit trails and retention  
✅ **Admin control** — Monitor, pause, resume, cancel jobs across all customers  
✅ **Production-ready** — Database schema, API endpoints, implementation checklist

This feature is essential for customer onboarding (migrations from legacy platforms), backup strategies, and email consolidation use cases.
