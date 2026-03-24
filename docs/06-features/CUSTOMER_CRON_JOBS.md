# Customer Cron Jobs

## Overview

Customers can schedule recurring tasks (cron jobs) that execute scripts on a defined schedule. Common use cases include automated backups, daily reports, cache clearing, and periodic maintenance tasks.

**Key Features:**
- ✅ Kubernetes CronJob resources with per-customer namespace isolation
- ✅ Supports PHP, shell, Node.js, and Python scripts
- ✅ Scheduled execution with flexible time-based patterns (standard crontab syntax)
- ✅ Webhook triggers for external event-driven execution
- ✅ Comprehensive logging and output capture (last run only)
- ✅ Automatic retry with exponential backoff on failure
- ✅ Resource limits to prevent runaway jobs
- ✅ Plan-based limits (Starter: 2 jobs, Business: 10 jobs, Premium: unlimited)
- ✅ Migration from legacy platforms (Plesk, cPanel, Virtualmin) with automated and manual options
- ✅ Admin controls: view, disable, edit, delete any customer's cron job
- ✅ Comprehensive audit logging for compliance

---

## Architecture

### Kubernetes CronJob Model

Cron jobs are implemented as Kubernetes CronJob resources within each customer's namespace. This provides:

1. **Isolation**: Each customer's cron jobs are confined to their namespace with RBAC policies
2. **Scalability**: Native k8s scheduling handles thousands of concurrent jobs
3. **Durability**: Jobs are stored in etcd and survive pod/node failures
4. **Monitoring**: CronJob status and Job history visible via kubectl and API

### Execution Model

```
Customer creates cron job
    ↓
API stores config in management database
    ↓
API creates Kubernetes CronJob resource in customer namespace
    ↓
Kubernetes scheduler triggers Job at scheduled time
    ↓
Job spins up temporary Pod in customer namespace
    ↓
Pod executes script with customer's environment (PHP/Node/Python/Shell)
    ↓
Output captured to log volume
    ↓
Pod completes; Job status recorded
    ↓
API fetches logs and updates job history
    ↓
Admin/client can view last run output and status
```

### Script Execution Paths

Scripts can be executed from:

1. **Application directory** (recommended): `/var/www/html/cron/backup.php` (relative to customer's webroot)
2. **Absolute path**: `/var/www/vhosts/{customer}/{domain}/scripts/daily-task.sh`
3. **Inline command**: `php -r "echo 'Hello'; echo date('Y-m-d');"` (shell command)

### Execution Environment

Each cron job Pod runs as:

- **User**: `www-data` (same as web server)
- **Working directory**: `/var/www/html` (customer's webroot)
- **Environment variables**: Same as web server + system env vars
- **Privileges**: Limited to customer's namespace (no access to other customers)
- **Network access**: Can access customer's databases, Redis, and external URLs
- **Timezone**: From cluster configuration (UTC by default; configurable per customer)

### Resource Limits

Each cron job Pod has strict resource limits:

| Resource | Starter | Business | Premium | Notes |
|----------|---------|----------|---------|-------|
| **CPU** | 100m | 500m | 1000m | Burst up to 2x limit |
| **Memory** | 64Mi | 256Mi | 512Mi | Hard limit; Pod killed if exceeded |
| **Timeout** | 5 min | 15 min | 30 min | Max execution time |
| **Disk usage** | 50Mi | 200Mi | 500Mi | Temp storage for logs/output |

### Job Concurrency & Scheduling

- **Max concurrent jobs**: 1 per cron job (no overlapping runs)
- **Retry behavior**: On failure, retry up to 3 times with exponential backoff (1s, 2s, 4s)
- **Timeout behavior**: If job exceeds timeout, Pod is forcefully terminated with grace period of 10s

---

## Database Schema

Cron job configurations and history are stored in a dedicated management database.

### Table: `cron_jobs`

Stores active cron job configurations.

```sql
CREATE TABLE cron_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- Identification
  customer_id BIGINT NOT NULL,          -- FK: customers.id
  name VARCHAR(255) NOT NULL,           -- User-friendly name (e.g., "Daily backup")
  description TEXT,                     -- Optional description
  
  -- Schedule
  schedule VARCHAR(100) NOT NULL,       -- Crontab format (e.g., "0 2 * * *")
  timezone VARCHAR(50) DEFAULT 'UTC',   -- IANA timezone (e.g., "America/New_York")
  next_run_at TIMESTAMP NULL,           -- Calculated next run time (updated after each run)
  
  -- Execution configuration
  script_path VARCHAR(512) NOT NULL,    -- Path to script (e.g., "/cron/backup.php")
  script_type ENUM('php', 'shell', 'python', 'node', 'inline') NOT NULL,
  inline_command TEXT,                  -- For script_type='inline' only
  
  -- Execution details
  timeout_seconds INT DEFAULT 300,      -- Max execution time (5 min default)
  max_retries INT DEFAULT 3,            -- How many times to retry on failure
  
  -- Webhook (optional)
  webhook_enabled BOOLEAN DEFAULT FALSE,
  webhook_url VARCHAR(512),             -- URL to POST job result to (optional)
  webhook_secret VARCHAR(255),          -- HMAC-SHA256 secret for signature verification
  
  -- Status
  enabled BOOLEAN DEFAULT TRUE,         -- Is the job active?
  last_run_at TIMESTAMP NULL,           -- When did this job last execute?
  last_status ENUM('pending', 'running', 'success', 'failed', 'timeout', 'disabled') DEFAULT 'pending',
  last_exit_code INT,                   -- Exit code from last run
  
  -- Kubernetes
  k8s_cronjob_name VARCHAR(255) UNIQUE, -- Name of k8s CronJob resource
  k8s_cronjob_uid VARCHAR(36),          -- UID from k8s API
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,            -- Soft delete
  
  INDEX idx_customer_id (customer_id),
  INDEX idx_enabled (enabled),
  INDEX idx_next_run_at (next_run_at),
  INDEX idx_deleted_at (deleted_at),
  UNIQUE KEY uk_customer_name (customer_id, name, deleted_at) -- Unique per customer
);
```

### Table: `cron_job_runs`

Stores historical execution records.

```sql
CREATE TABLE cron_job_runs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  cron_job_id BIGINT NOT NULL,          -- FK: cron_jobs.id
  customer_id BIGINT NOT NULL,          -- Denormalized for easy query
  
  -- Execution details
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP NULL,
  duration_seconds INT,                 -- (completed_at - started_at)
  
  -- Results
  exit_code INT,                        -- Exit code from script (0=success)
  status ENUM('pending', 'running', 'success', 'failed', 'timeout') NOT NULL DEFAULT 'pending',
  error_message TEXT,                   -- Error or timeout message
  
  -- Output capture (truncated to last 50KB)
  stdout TEXT,                          -- Last 50KB of stdout
  stderr TEXT,                          -- Last 50KB of stderr
  output_size_bytes INT,                -- Total output size (may exceed truncation)
  
  -- Kubernetes tracking
  k8s_pod_name VARCHAR(255),            -- Name of k8s Pod that executed the job
  k8s_pod_uid VARCHAR(36),              -- UID from k8s API
  
  -- Webhook status (if enabled)
  webhook_sent BOOLEAN DEFAULT FALSE,
  webhook_response_code INT,            -- HTTP response code from webhook URL
  webhook_error TEXT,                   -- Error if webhook failed
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_cron_job_id (cron_job_id),
  INDEX idx_customer_id (customer_id),
  INDEX idx_started_at (started_at),
  INDEX idx_status (status)
);
```

### Table: `cron_job_audit_log`

Comprehensive audit trail for compliance and security.

```sql
CREATE TABLE cron_job_audit_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  cron_job_id BIGINT,                   -- FK: cron_jobs.id (NULL if job was deleted)
  customer_id BIGINT NOT NULL,
  
  -- Action details
  action ENUM('created', 'updated', 'enabled', 'disabled', 'deleted', 'executed', 'failed') NOT NULL,
  actor_type ENUM('admin', 'customer', 'system') NOT NULL,
  actor_id BIGINT,                      -- Admin/customer ID who made the change
  
  -- What changed
  old_values JSON,                      -- Previous values (for audit trail)
  new_values JSON,                      -- New values
  
  -- Context
  description TEXT,                     -- Human-readable description of change
  ip_address VARCHAR(45),               -- IPv4 or IPv6 address of requester
  user_agent TEXT,                      -- Browser user agent
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_cron_job_id (cron_job_id),
  INDEX idx_customer_id (customer_id),
  INDEX idx_action (action),
  INDEX idx_created_at (created_at)
);
```

---

## API Specification

### Base URL

```
https://api.platform.example.com/v1/customers/{customer_id}/cron-jobs
```

All requests require authentication via API token or OAuth token.

### 1. List Cron Jobs

**Endpoint:** `GET /v1/customers/{customer_id}/cron-jobs`

**Description:** Retrieve all cron jobs for a customer.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | - | Filter by enabled/disabled (optional) |
| `page` | integer | 1 | Pagination page number |
| `limit` | integer | 20 | Items per page (max 100) |
| `sort` | string | `-created_at` | Sort by field (prefix `-` for descending) |

**Request:**

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/cron-jobs" \
  -H "Authorization: Bearer {token}"
```

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "cron_abc123",
      "customer_id": 123,
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

**Error Responses:**
- `404 Not Found`: Customer does not exist or not authorized
- `401 Unauthorized`: Invalid or missing authentication token
- `429 Too Many Requests`: Rate limited

---

### 2. Get Cron Job Details

**Endpoint:** `GET /v1/customers/{customer_id}/cron-jobs/{job_id}`

**Description:** Retrieve details of a specific cron job.

**Request:**

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/cron-jobs/cron_abc123" \
  -H "Authorization: Bearer {token}"
```

**Response (200 OK):**

```json
{
  "data": {
    "id": "cron_abc123",
    "customer_id": 123,
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
    "next_run_at": "2026-03-02T02:00:00Z",
    "last_run_at": "2026-03-01T02:05:30Z",
    "last_status": "success",
    "last_exit_code": 0,
    "created_at": "2026-01-15T10:30:00Z",
    "updated_at": "2026-01-15T10:30:00Z",
    
    -- Additional details
    "plan_limit": {
      "max_jobs": 2,        -- Based on customer's plan
      "current_count": 1,   -- How many jobs customer has
      "can_create_more": true
    },
    "plan_capabilities": {
      "max_timeout": 300,   -- In seconds
      "supports_webhooks": true,
      "max_retries": 3
    }
  }
}
```

---

### 3. Create Cron Job

**Endpoint:** `POST /v1/customers/{customer_id}/cron-jobs`

**Description:** Create a new cron job for a customer.

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

- `name`: Required, 1-255 characters, unique per customer
- `schedule`: Required, valid crontab format (validated with crontab parser)
- `script_path`: Required if `script_type` != 'inline', 1-512 characters
- `inline_command`: Required if `script_type` = 'inline', 1-2000 characters
- `script_type`: One of 'php', 'shell', 'python', 'node', 'inline'
- `timezone`: Valid IANA timezone (e.g., "UTC", "America/New_York")
- `timeout_seconds`: 60-1800 (1-30 min, limited by plan)
- `max_retries`: 0-5
- `webhook_url`: Optional, must be valid HTTPS URL if provided
- Plan check: Customer must have available job slots

**Request:**

```bash
curl -X POST "https://api.platform.example.com/v1/customers/123/cron-jobs" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily backup",
    "schedule": "0 2 * * *",
    "script_path": "/cron/backup.php",
    "script_type": "php",
    "timeout_seconds": 600
  }'
```

**Response (201 Created):**

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

**Error Responses:**
- `400 Bad Request`: Invalid input (schedule format, script_path not found, etc.)
- `403 Forbidden`: Plan limit exceeded (customer has max allowed jobs)
- `404 Not Found`: Customer does not exist

---

### 4. Update Cron Job

**Endpoint:** `PATCH /v1/customers/{customer_id}/cron-jobs/{job_id}`

**Description:** Update a cron job configuration.

**Request Body:**

```json
{
  "name": "Daily backup (updated)",
  "description": "Backs up database to S3 every night at 2 AM with email notification",
  "schedule": "0 3 * * *",
  "timeout_seconds": 900,
  "webhook_url": "https://example.com/webhooks/cron",
  "webhook_secret": "whsec_abc123xyz"
}
```

**Allowed fields:** All fields from create request except `script_path` and `script_type` (use delete + recreate to change script).

**Request:**

```bash
curl -X PATCH "https://api.platform.example.com/v1/customers/123/cron-jobs/cron_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"schedule": "0 3 * * *"}'
```

**Response (200 OK):**

```json
{
  "data": {
    "id": "cron_abc123",
    "customer_id": 123,
    "name": "Daily backup (updated)",
    "schedule": "0 3 * * *",
    "script_path": "/cron/backup.php",
    "script_type": "php",
    "timeout_seconds": 900,
    "enabled": true,
    "next_run_at": "2026-03-02T03:00:00Z",
    "updated_at": "2026-03-01T11:15:00Z"
  }
}
```

---

### 5. Enable/Disable Cron Job

**Endpoint:** `POST /v1/customers/{customer_id}/cron-jobs/{job_id}/enable`
**Endpoint:** `POST /v1/customers/{customer_id}/cron-jobs/{job_id}/disable`

**Description:** Quickly enable or disable a cron job without deleting it.

**Request:**

```bash
curl -X POST "https://api.platform.example.com/v1/customers/123/cron-jobs/cron_abc123/disable" \
  -H "Authorization: Bearer {token}"
```

**Response (200 OK):**

```json
{
  "data": {
    "id": "cron_abc123",
    "enabled": false,
    "updated_at": "2026-03-01T11:20:00Z"
  }
}
```

---

### 6. Delete Cron Job

**Endpoint:** `DELETE /v1/customers/{customer_id}/cron-jobs/{job_id}`

**Description:** Permanently delete a cron job. Uses soft delete; job data retained for 30 days.

**Request:**

```bash
curl -X DELETE "https://api.platform.example.com/v1/customers/123/cron-jobs/cron_abc123" \
  -H "Authorization: Bearer {token}"
```

**Response (204 No Content)**

**Note:** Kubernetes CronJob resource is immediately deleted; Pod runs are retained in `cron_job_runs` table.

---

### 7. Get Cron Job Execution History

**Endpoint:** `GET /v1/customers/{customer_id}/cron-jobs/{job_id}/runs`

**Description:** Retrieve execution history for a specific cron job.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | Filter by status (pending, running, success, failed, timeout) |
| `page` | integer | 1 | Pagination page number |
| `limit` | integer | 20 | Items per page (max 100) |
| `days` | integer | 30 | Show last N days of history |

**Request:**

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/cron-jobs/cron_abc123/runs?status=success&limit=10" \
  -H "Authorization: Bearer {token}"
```

**Response (200 OK):**

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

---

### 8. Get Last Cron Job Run

**Endpoint:** `GET /v1/customers/{customer_id}/cron-jobs/{job_id}/last-run`

**Description:** Quick endpoint to get only the most recent execution (for monitoring/dashboards).

**Request:**

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/cron-jobs/cron_abc123/last-run" \
  -H "Authorization: Bearer {token}"
```

**Response (200 OK):**

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

---

### 9. Manually Trigger Cron Job

**Endpoint:** `POST /v1/customers/{customer_id}/cron-jobs/{job_id}/trigger`

**Description:** Immediately execute a cron job, regardless of schedule.

**Request:**

```bash
curl -X POST "https://api.platform.example.com/v1/customers/123/cron-jobs/cron_abc123/trigger" \
  -H "Authorization: Bearer {token}"
```

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

---

### 10. Validate Cron Schedule

**Endpoint:** `POST /v1/customers/{customer_id}/cron-jobs/validate-schedule`

**Description:** Validate a crontab schedule string without creating a job.

**Request Body:**

```json
{
  "schedule": "0 2 * * *",
  "timezone": "America/New_York"
}
```

**Request:**

```bash
curl -X POST "https://api.platform.example.com/v1/customers/123/cron-jobs/validate-schedule" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"schedule": "0 2 * * *"}'
```

**Response (200 OK):**

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

**Error Response (400 Bad Request):**

```json
{
  "valid": false,
  "error": "Invalid schedule: field 'day of month' value 32 is out of range (1-31)"
}
```

---

### 11. Admin: List All Customer Cron Jobs

**Endpoint:** `GET /v1/admin/cron-jobs` (admin-only)

**Description:** View all cron jobs across all customers (admin endpoint).

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `customer_id` | integer | Filter by customer |
| `status` | string | Filter by status (pending, running, success, failed) |
| `enabled` | boolean | Filter by enabled/disabled |
| `limit` | integer | Items per page (max 100) |

**Request:**

```bash
curl -X GET "https://api.platform.example.com/v1/admin/cron-jobs?customer_id=123" \
  -H "Authorization: Bearer {admin-token}"
```

**Response (200 OK):** Similar to customer list, but includes `customer_id` for each job.

---

### 12. Admin: Force Run Cron Job

**Endpoint:** `POST /v1/admin/cron-jobs/{job_id}/force-run` (admin-only)

**Description:** Immediately execute any customer's cron job (admin debugging).

**Request:**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/cron-jobs/cron_abc123/force-run" \
  -H "Authorization: Bearer {admin-token}"
```

**Response (202 Accepted):** Same as customer manual trigger.

---

### 13. Admin: Disable All Customer Cron Jobs

**Endpoint:** `POST /v1/admin/cron-jobs/disable-all` (admin-only)

**Description:** Disable all cron jobs for a customer (e.g., during maintenance).

**Request Body:**

```json
{
  "customer_id": 123,
  "reason": "Scheduled maintenance window"
}
```

**Request:**

```bash
curl -X POST "https://api.platform.example.com/v1/admin/cron-jobs/disable-all" \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{"customer_id": 123}'
```

**Response (200 OK):**

```json
{
  "data": {
    "customer_id": 123,
    "disabled_count": 5,
    "message": "All cron jobs disabled"
  }
}
```

---

## Plan-Based Limits

Cron job capabilities vary by hosting plan:

| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| **Max jobs** | Unlimited | Unlimited | Unlimited |
| **Max timeout** | 5 min (300s) | 15 min (900s) | 30 min (1800s) |
| **CPU per job** | 100m | 500m | 1000m |
| **Memory per job** | 64Mi | 256Mi | 512Mi |
| **Max retries** | 3 | 5 | 5 |
| **Webhook support** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Manual trigger** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Execution history** | Last 30 days | Last 90 days | Last 365 days |
| **Audit log retention** | 30 days | 90 days | 365 days |

> Cron job count is **unlimited on all plans** per platform policy (see `HOSTING_PLANS.md`). Resource limits per job execution (timeout, CPU, memory) are configurable per-customer.

---

## Cron Schedule Format

Jobs use standard POSIX crontab format:

```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6) (Sunday to Saturday; 7 is Sunday on some systems)
│ │ │ │ │
│ │ │ │ │
* * * * *
```

### Examples

| Schedule | Description |
|----------|-------------|
| `0 2 * * *` | Every day at 2:00 AM |
| `0 */4 * * *` | Every 4 hours |
| `0 0 1 * *` | First day of every month at midnight |
| `0 0 * * 1` | Every Monday at midnight |
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 1 1 *` | January 1st at midnight (yearly) |

---

## Webhook Integration

Cron jobs can optionally POST execution results to a customer-specified webhook URL.

### Webhook Payload

```json
{
  "event": "cron_job_completed",
  "cron_job_id": "cron_abc123",
  "customer_id": 123,
  "run_id": "run_xyz789",
  "status": "success",
  "exit_code": 0,
  "duration_seconds": 325,
  "started_at": "2026-03-01T02:00:05Z",
  "completed_at": "2026-03-01T02:05:30Z",
  "stdout": "Backup started...\nUpload complete.",
  "stderr": null,
  "timestamp": "2026-03-01T02:05:30Z"
}
```

### Webhook Signature

All webhook requests include an `X-Signature` header with HMAC-SHA256 signature:

```
X-Signature: sha256=abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx
```

**Verification (Node.js example):**

```javascript
const crypto = require('crypto');

const signature = req.headers['x-signature'];
const secret = process.env.CRON_WEBHOOK_SECRET;
const payload = JSON.stringify(req.body);

const expectedSignature = 'sha256=' + 
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

if (signature !== expectedSignature) {
  return res.status(401).send('Unauthorized');
}
```

### Webhook Retry Policy

If webhook delivery fails:

1. **Retry 1**: After 1 minute
2. **Retry 2**: After 5 minutes
3. **Retry 3**: After 30 minutes
4. **Final**: Mark as failed; no further retries

Webhook delivery logs stored in `cron_job_runs.webhook_sent` and `webhook_error`.

---

## Migration from Legacy Platforms

### Plesk, cPanel, and Virtualmin Support

The migration process extracts cron jobs from legacy platforms and converts them to Kubernetes CronJob format.

### Automated Migration

**MIGRATION_PLAN.md**, line 123 specifies "cron jobs (extracted as scripts)". The automated migration service extracts jobs using:

#### Plesk

```bash
# Extract cron jobs via RPC API
/usr/local/psa/bin/admin -e "Cron" -l
```

Extract from client's crontab file via SSH:

```bash
crontab -l -u {system_user}
```

#### cPanel

```bash
# Extract cron jobs via cPanel WHM API
whmapi1 cron_tasks_list_for_account user={cpanel_user}
```

Or directly from system crontab:

```bash
crontab -l -u {cpanel_user}
```

#### Virtualmin

```bash
# Extract cron jobs via Virtualmin API
virtualmin list-cron --domain {domain}
```

### Migration Workflow

1. **Discover**: Connect to legacy panel; authenticate as admin
2. **Extract**: Query cron jobs from each customer/domain
3. **Validate**: Check script paths, syntax, and compatibility
4. **Transform**:
   - Extract script command (e.g., `/usr/bin/php -f /home/user/public_html/cron.php`)
   - Determine script type: `php`, `shell`, `python`, `node`, `inline`
   - Preserve schedule (crontab format is standard)
   - Extract environment variables (if any)
5. **Map to K8s**:
   - Convert system user to customer namespace
   - Update script paths to K8s paths (e.g., `/var/www/html/cron.php`)
   - Estimate resource limits based on legacy execution time
6. **Create K8s CronJob**: Provision new cron job on K8s platform
7. **Verify**: Test execution on K8s; compare output with legacy run
8. **Notify customer**: Alert customer of new cron job URL and management links

### Manual Migration Option

For customers preferring to manually migrate:

1. **Export from legacy panel**: Download cron job configuration
2. **Review**: Check script path and dependencies
3. **Create on K8s**: Use API or UI to create cron job
4. **Test**: Manually trigger job; verify output
5. **Enable**: Activate job on schedule

### Migration Checklist

**From MIGRATION_PLAN.md, Step 44:**

- [ ] Extract cron jobs from source panel (Plesk/cPanel/Virtualmin)
- [ ] Validate script paths and syntax
- [ ] Determine target script type (php/shell/python/node)
- [ ] Map to customer's namespace on K8s platform
- [ ] Create CronJob resource with matched schedule
- [ ] Verify execution logs and output
- [ ] Notify customer of new cron job URLs
- [ ] Update customer documentation with K8s-specific paths

---

## Client Panel Features

### Cron Jobs Management Dashboard

**Location:** Client Panel > Website & Services > Cron Jobs

#### List View

| Column | Data | Actions |
|--------|------|---------|
| **Name** | Job name and description | Click to view details |
| **Schedule** | Human-readable schedule (e.g., "Daily at 2:00 AM") | N/A |
| **Last Run** | Date, time, and status icon (✅ success, ❌ failed, ⏱️ timeout) | Click to view run details |
| **Next Run** | Scheduled next execution time | Countdown timer |
| **Status** | Enabled/Disabled badge | Click to toggle |
| **Actions** | Run now, Edit, View runs, Delete | Dropdown menu |

**Features:**

- [ ] Create new cron job button (top of page)
- [ ] Search by name
- [ ] Filter by status (enabled, disabled)
- [ ] Sort by name, schedule, last run date
- [ ] Bulk enable/disable (multi-select)
- [ ] Bulk delete with confirmation
- [ ] Plan usage indicator (e.g., "Using 2 of 2 allowed jobs")

#### Create/Edit Cron Job

Form fields:

- **Job Name** (required): Text input, 1-255 chars
- **Description** (optional): Text area, 0-500 chars
- **Schedule** (required): Crontab input with schedule builder
  - Dropdown presets (Every minute, Every hour, Daily, Weekly, Monthly, Custom)
  - Manual crontab input with validation
  - Next run preview showing next 5 executions
- **Timezone** (optional): Dropdown with common timezones (defaults to UTC)
- **Script Type** (required): Radio buttons
  - PHP file
  - Shell script
  - Python script
  - Node.js script
  - Inline command
- **Script Path** (conditional): File picker or text input
  - Auto-populated with common paths (e.g., `/cron/backup.php`)
  - Validates file exists and is readable
- **Inline Command** (conditional): Text area, only visible if "Inline command" selected
- **Timeout** (optional): Slider 60-300 seconds (plan-dependent)
  - Shows plan limit (e.g., "Maximum 5 minutes for Starter plan")
- **Max Retries** (optional): Slider 0-5
- **Webhook Integration** (optional): Expandable section
  - [ ] Enable webhook
  - Webhook URL: Text input
  - Generate Secret button
  - Test webhook button
- **Buttons**: Save, Cancel, Delete (if existing job)

#### Cron Job Details & History

View:

- Job name, description, schedule (in both crontab and human-readable formats)
- Current status (enabled/disabled, next run time, last run time/status)
- Resource limits (timeout, retries, CPU/memory if displayed)

Tabs:

1. **Configuration** (read-only):
   - Display all settings
   - Edit button (modal or separate page)
   - Delete button (with confirmation)

2. **Execution History**:
   - Table of last 20 runs (paginated)
   - Columns: Date, Time, Duration, Status, Exit Code, Output preview
   - Status icons: ✅ Success, ❌ Failed, ⏱️ Timeout, ⏳ Running, ⏸️ Disabled
   - Click row to view full output (stdout/stderr)
   - Download as JSON/CSV button
   - View logs link (opens modal with full output)
   - Search/filter by status, date range

3. **Last Run Details** (summary card):
   - Started at, Completed at, Duration
   - Exit code, Status with message
   - Stdout/Stderr (truncated to 500 lines; scroll to expand)
   - "Rerun this job" button

4. **Webhook Status** (if enabled):
   - Last webhook delivery: timestamp, HTTP status code
   - Webhook URL, secret (masked)
   - Test webhook button

#### Quick Actions

- **Run Now**: Manually trigger job immediately
  - Shows confirmation dialog
  - Redirects to "Last Run Details" with live progress
  - Show countdown "Next scheduled run in X hours"

- **Edit**: Opens create/edit form in modal or new page

- **View Runs**: Jump to "Execution History" tab

- **Enable/Disable**: Quick toggle (single click)
  - Shows confirmation for disable
  - Temporarily shows disabled badge

- **Delete**: With confirmation
  - "This will permanently delete the cron job"
  - Shows last 3 runs before deleting (for reference)

#### Notifications

- Email alerts on job failures (configurable)
- In-app notifications for failed runs
- Weekly summary of job execution (if any failed)

---

## Admin Panel Features

### Cron Job Management (Admin-Only)

**Location:** Admin Panel > Customers > Cron Jobs

#### Global Cron Job Dashboard

View all cron jobs across all customers:

- **Search**: By job name, customer name, script path
- **Filter**: By customer, status, plan, enabled/disabled, execution status
- **Sort**: By customer, job name, last run date, next run time
- **Columns**:
  - Customer (name, ID)
  - Job Name
  - Schedule
  - Status (enabled/disabled icon)
  - Last Run (date, status)
  - Next Run (time, countdown)
  - Actions (Force run, Disable, Edit, View runs, Delete)

#### Customer Cron Jobs Detail Page

When viewing a specific customer:

- List all their cron jobs
- Show plan usage (e.g., "4 of 10 jobs used")
- Bulk actions:
  - [ ] Select all
  - [ ] Disable all (with reason field)
  - [ ] Force run all
  - [ ] Delete all (with confirmation)

#### Cron Job Debug & Monitoring

For each job, admin can:

1. **View configuration**: Same fields as customer view (read-only)
2. **Edit configuration**: All fields editable (change timeout, schedule, etc.)
3. **Force run**: Immediately execute regardless of schedule
4. **View execution logs**: Full logs including Kubernetes Pod details
5. **Disable**: Stop job without deleting
6. **Delete**: Permanently remove with soft-delete option
7. **View Kubernetes metadata**:
   - CronJob UID
   - Pod name
   - Namespace
   - Link to kubectl commands for debugging

#### Audit Trail & Compliance

- **Cron Job Audit Log**: View all changes to any customer's jobs
  - Who (admin) made the change
  - What changed (old vs. new values)
  - When (timestamp)
  - Why (reason field for sensitive actions)
  - Filter by customer, action type, date range
  - Export as CSV

#### Performance Monitoring

Dashboard widgets showing:

- **Total cron jobs**: Count by status (enabled, disabled, failed)
- **Execution success rate**: % of jobs succeeding (by plan)
- **Slowest jobs**: Table of slowest 10 jobs (by duration)
- **Most failed jobs**: Jobs with highest failure rate
- **Failed runs this week**: Alert if any customer's jobs failing
- **Resource usage**: CPU/memory usage by cron jobs (total and by customer)
- **Webhook failures**: List of failed webhook deliveries

---

## Implementation Checklist

### Phase 1: Database & API (Weeks 1-2)

- [ ] Create database schema (3 tables: `cron_jobs`, `cron_job_runs`, `cron_job_audit_log`)
- [ ] Create migration scripts (apply to production database)
- [ ] Implement cron job validation logic (schedule parsing, script path verification)
- [ ] Build 13 API endpoints (create, list, update, delete, get runs, trigger, webhook validation, etc.)
- [ ] Add authentication/authorization checks (customer isolation, plan limits, admin-only endpoints)
- [ ] Add comprehensive error handling and validation
- [ ] Create API documentation with cURL examples
- [ ] Write unit tests for all endpoints (80% coverage)
- [ ] Integration tests with k8s mocking

### Phase 2: Kubernetes Integration (Weeks 2-3)

- [ ] Create Kubernetes CronJob resource templates
- [ ] Implement CronJob creation/update/delete via k8s API client
- [ ] Implement resource limit enforcement (CPU, memory, timeout)
- [ ] Build Job monitoring (track Pod status, capture logs)
- [ ] Implement output capture (stdout/stderr to database)
- [ ] Build automatic retry logic with exponential backoff
- [ ] Handle job timeout and Pod cleanup
- [ ] Add webhook notification logic
- [ ] Test with live k3s cluster (50+ concurrent jobs)

### Phase 3: Client Panel UI (Weeks 3-4)

- [ ] Design Figma mockups for all screens
- [ ] Implement cron jobs list view
- [ ] Implement create/edit cron job form with schedule builder
- [ ] Implement execution history with pagination
- [ ] Implement last run details view with log output
- [ ] Implement webhook configuration UI
- [ ] Add "Run now" button with progress indicator
- [ ] Add search, filter, sort functionality
- [ ] Add plan usage indicator
- [ ] Test with real API endpoints
- [ ] Performance test (list 100+ jobs, load time <2s)

### Phase 4: Admin Panel Features (Weeks 4-5)

- [ ] Implement global cron job dashboard (admin-only)
- [ ] Implement customer cron jobs detail page
- [ ] Implement job debug tools (force run, view logs, view k8s metadata)
- [ ] Implement audit log viewer
- [ ] Implement performance monitoring dashboard
- [ ] Add bulk actions (disable all, force run all, delete all)
- [ ] Test admin actions don't interfere with customer jobs

### Phase 5: Migration Tools (Weeks 5-6)

- [ ] Build Plesk migration extractor (API + SSH)
- [ ] Build cPanel migration extractor (API + SSH)
- [ ] Build Virtualmin migration extractor (API + SSH)
- [ ] Implement migration service API endpoint
- [ ] Implement job compatibility validation
- [ ] Create migration CLI tool
- [ ] Test with live Plesk/cPanel/Virtualmin servers
- [ ] Create migration runbook with step-by-step instructions

### Phase 6: Testing & Documentation (Weeks 6-7)

- [ ] Unit tests for all API endpoints (>80% coverage)
- [ ] Integration tests (API + k8s)
- [ ] Load testing (1000+ concurrent jobs)
- [ ] Migration testing (extract 50+ jobs from live panels)
- [ ] Edge case testing (timeout, retry, webhook failure, etc.)
- [ ] Security testing (RBAC, webhook signature verification, isolation)
- [ ] Performance testing (list response time, execution latency)
- [ ] Create API documentation (Swagger/OpenAPI)
- [ ] Create user documentation (customer & admin guides)
- [ ] Create migration guide (step-by-step for each platform)
- [ ] Record demo video (5-10 minutes)

### Phase 7: Deployment & Rollout (Weeks 7)

- [ ] Deploy API + k8s integration to staging
- [ ] Smoke tests (create job, execute, view logs)
- [ ] Deploy migration service to staging
- [ ] Pilot migration with 1-2 test customers
- [ ] Fix bugs and optimize performance
- [ ] Deploy to production
- [ ] Monitor for 1 week (watch logs, error rates)
- [ ] Announce feature to customers
- [ ] Begin batch migrations

**Total: 7 weeks** (can be parallelized with other features)

---

## Failure Handling & Recovery

### Common Failures

| Scenario | Recovery |
|----------|----------|
| **Script not found** | Job marked as `failed`; admin can update script path and retry |
| **Script timeout** | Pod terminated; job marked as `timeout`; auto-retry up to 3 times |
| **Exit code != 0** | Job marked as `failed`; full stderr captured; auto-retry |
| **Webhook delivery fails** | Job marked as `success`; webhook retry policy kicks in (3 retries over 30 min) |
| **Pod eviction** | Job automatically rescheduled by Kubernetes; run marked as `pending` until completion |
| **k8s CronJob deleted** | API detects missing resource; recreates it automatically |
| **Database connection fails** | Job marked as `failed`; log stored in temporary buffer; synced when DB recovers |
| **Out of memory** | Pod killed by kubelet; job marked as `failed`; memory limit logged |

### Admin Recovery Options

1. **Manual job retry**: Force run a failed job via admin panel
2. **Edit and retry**: Update script path, timeout, or retries; then re-execute
3. **Rollback schedule**: Revert schedule to previous version (audit log tracks changes)
4. **Disable problematic job**: Stop execution while investigating
5. **Delete and recreate**: For severely broken jobs, delete and create new one

---

## Security & Isolation

### Multi-Tenant Isolation

- **Namespace isolation**: Each customer's jobs run in their own k8s namespace
- **RBAC**: Service account for k8s API access limited to customer's namespace
- **Network policy**: Optional network policies restrict job-to-job communication
- **File isolation**: Jobs can only access `/var/www/html` (customer's webroot), not other customers' files
- **Environment variables**: Jobs inherit customer's environment (no access to secrets)

### Credential Management

- **Webhook secrets**: HMAC-SHA256 signing with customer-specific secrets
- **API tokens**: Customer tokens only allow accessing own jobs; admin tokens required for cross-customer access
- **Script secrets**: Customers can store secrets in environment variables or `.env` files (best practice)

### Audit Logging

All actions logged to `cron_job_audit_log`:

- Job creation, update, deletion
- Schedule changes
- Admin force runs
- Webhook configuration changes
- Failed execution attempts

**Retention**: 30 days (Starter), 90 days (Business), 365 days (Premium)

---

## Monitoring & Alerting

### Metrics

Exported to Prometheus:

- `cron_job_execution_duration_seconds`: How long job took to execute
- `cron_job_execution_status`: Success/failure count
- `cron_job_pod_cpu_usage`: CPU used during execution
- `cron_job_pod_memory_usage`: Memory used during execution
- `cron_job_webhook_delivery_time`: How long webhook delivery took
- `cron_job_webhook_delivery_status`: Success/failure count

### Alerts

Admin notified of:

- Job failure (after 3 failed runs)
- Job timeout (execution exceeded time limit)
- Webhook delivery failure (after 3 retries)
- Customer approaching plan limit (e.g., "90% of job quota used")
- Excessive resource usage (job using >90% of CPU/memory limit)

---

## Related Documentation

- **MANAGEMENT_API_SPEC.md**: Complete REST API specification
- **CLIENT_PANEL_FEATURES.md**: Customer-facing features
- **ADMIN_PANEL_REQUIREMENTS.md**: Admin-only features
- **MIGRATION_PLAN.md**: Data migration from legacy panels
- **DISASTER_RECOVERY.md**: Backup and recovery for cron job configurations
- **MONITORING_OBSERVABILITY.md**: Monitoring cron job execution
- **SECURITY_ARCHITECTURE.md**: Security policies for cron jobs
