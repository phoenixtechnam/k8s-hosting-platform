# PHP Composer Support for Customer Websites

## Overview

The platform provides **seamless PHP Composer dependency management** for customer websites. Customers can install and manage Composer dependencies directly from the admin/client panel without needing SSH access. Composer is automatically installed on-demand, version-matched to the customer's PHP version, and integrated with the deployment pipeline.

**Key Features:**
- ✅ On-demand Composer installation (install button in control panel)
- ✅ Web UI for dependency management (no SSH required)
- ✅ Automatic PHP version matching (Composer version updates with PHP)
- ✅ Smart vendor directory caching (only reinstall if composer.lock changed)
- ✅ CVE security audits (detect vulnerable packages before install)
- ✅ Deployment integration (auto-install dependencies on git push)
- ✅ Detailed audit logging (track all installs, versions, vulnerabilities)
- ✅ Autoloader generation with optimization (composer dump-autoload)
- ✅ Error recovery and troubleshooting tools

---

## Architecture

### Composer Deployment Model

Composer runs **inside the customer's web server pod** as a temporary process:

```
Customer clicks: [Install Dependencies] in panel
                           ↓
            Management API receives request
                           ↓
    API connects to customer's pod via kubectl exec
                           ↓
    Executes: php /usr/local/bin/composer install
                           ↓
    Streams output back to UI (real-time progress)
                           ↓
    Checks composer.lock (cached vendor detection)
                           ↓
    If lock unchanged: Skip install (use cached vendor/)
    If lock changed:   Full install (update vendor/)
                           ↓
    Runs: composer audit (check for CVEs)
                           ↓
    Reports: Vulnerabilities found (if any)
                           ↓
    Runs: composer dump-autoload --optimize
                           ↓
    Logs: Dependencies installed, versions, vulnerabilities
```

### PHP Version Matching

Composer version is automatically matched to customer's PHP version:

| PHP Version | Composer Version | Notes |
|-------------|-----------------|-------|
| PHP 7.2-7.3 | Composer 1.10.26 (EOL) | Deprecated; upgrade recommended |
| PHP 7.4     | Composer 2.0 - 2.4 | Stable; recommended minimum |
| PHP 8.0     | Composer 2.2+ | Full PHP 8 support |
| PHP 8.1     | Composer 2.3+ | Attributes support |
| PHP 8.2     | Composer 2.4+ | Latest features |
| PHP 8.3     | Composer 2.6+ | Current LTS |

**Auto-Upgrade Trigger:**

When customer switches PHP version:

```
Customer changes: PHP 7.4 → PHP 8.1

            ↓

Management API detects change
            ↓
Checks: Current Composer = 2.0.x (for PHP 7.4)
        Target Composer = 2.3+ (for PHP 8.1)
            ↓
Schedules: Composer upgrade (background job)
            ↓
Runs: composer self-update (upgrade Composer version)
            ↓
Runs: composer update (refresh lock file for PHP 8.1)
            ↓
Logs: Composer upgraded from 2.0 to 2.3+
            ↓
Notifies: Customer via email/notification
```

### Caching Strategy

**Smart Vendor Directory Caching:**

```
Customer runs: [Install Dependencies]

            ↓

System checks: composer.lock hash (current vs last install)

            ↓

If hashes match:
├─ Vendor directory unchanged ✓
├─ Skip composer install
├─ Only run: composer dump-autoload --optimize
└─ Fast (~5 seconds)

If hashes differ:
├─ composer.lock changed (new dependencies)
├─ Run: composer install (full install with changes)
├─ Update vendor/ directory
└─ May take longer (1-5 minutes)
```

**Lock File Storage:**

```
composer.lock is stored in two places:

1. In customer's repository (committed)
   └─ /home/{customer}/public_html/composer.lock

2. In platform database
   └─ Tracks hash + timestamp for cache decisions
```

**Vendor Directory Location:**

```
/home/{customer}/public_html/vendor/

Persistence:
├─ Stored on PersistentVolume (survives pod restarts)
├─ NOT stored in Git (ignored in .gitignore)
├─ Backed up in automated backups
└─ Size limits: 100MB per plan (configurable)
```

---

## Database Schema

### Table: `composer_installs`

Track all Composer installation attempts and results.

```sql
CREATE TABLE composer_installs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  customer_id BIGINT NOT NULL,           -- FK: customers.id
  domain_id BIGINT NOT NULL,             -- FK: domains.id (which domain in customer's account)
  
  -- Composer details
  php_version VARCHAR(10) NOT NULL,      -- e.g., "8.1.3"
  composer_version VARCHAR(10) NOT NULL, -- e.g., "2.5.1"
  
  -- Installation details
  status ENUM('pending', 'running', 'success', 'failed', 'timeout') DEFAULT 'pending',
  
  -- Lock file tracking
  composer_lock_hash VARCHAR(64),        -- SHA-256 of composer.lock
  lock_file_changed BOOLEAN DEFAULT TRUE, -- Was lock file changed vs last install?
  
  -- Result details
  dependencies_count INT,                -- How many packages installed?
  vendor_size_bytes BIGINT,              -- Size of vendor/ directory
  install_duration_seconds INT,          -- How long did install take?
  
  -- Security audit
  vulnerabilities_found INT DEFAULT 0,   -- From composer audit
  vulnerability_critical INT DEFAULT 0,  -- Critical CVEs
  vulnerability_high INT DEFAULT 0,      -- High severity CVEs
  vulnerabilities_details JSON,          -- Full audit results
  audit_performed BOOLEAN DEFAULT FALSE,
  
  -- Error details
  error_message TEXT,                    -- If failed, what went wrong?
  error_log TEXT,                        -- Full error log from Composer
  
  -- Metadata
  initiated_by ENUM('admin', 'customer', 'system') DEFAULT 'system',
  initiated_by_user_id BIGINT,           -- Who triggered this?
  initiated_at TIMESTAMP NOT NULL,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  
  -- Caching
  cache_hit BOOLEAN DEFAULT FALSE,       -- Did we use cached vendor/?
  autoload_optimized BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_customer_id (customer_id),
  INDEX idx_domain_id (domain_id),
  INDEX idx_status (status),
  INDEX idx_initiated_at (initiated_at),
  INDEX idx_created_at (created_at)
);
```

### Table: `composer_dependencies`

Track what packages are installed for each customer domain.

```sql
CREATE TABLE composer_dependencies (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  composer_install_id BIGINT NOT NULL,  -- FK: composer_installs.id
  customer_id BIGINT NOT NULL,
  domain_id BIGINT NOT NULL,
  
  -- Package info
  package_name VARCHAR(255) NOT NULL,   -- e.g., "symfony/console"
  version_installed VARCHAR(50) NOT NULL, -- e.g., "5.4.15"
  version_required VARCHAR(50),         -- From composer.json (e.g., "^5.0")
  
  -- Type
  is_dev_dependency BOOLEAN DEFAULT FALSE, -- require-dev vs require
  
  -- Security status
  vulnerability_found BOOLEAN DEFAULT FALSE,
  vulnerability_count INT DEFAULT 0,
  latest_cve_id VARCHAR(20),            -- e.g., "CVE-2024-12345"
  
  -- Metadata
  description TEXT,                     -- Package description
  license VARCHAR(50),                  -- OSS license
  repository_url VARCHAR(512),          -- GitHub, GitLab, etc.
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_composer_install_id (composer_install_id),
  INDEX idx_customer_id (customer_id),
  INDEX idx_package_name (package_name),
  INDEX idx_vulnerability_found (vulnerability_found)
);
```

### Table: `composer_vulnerabilities`

Detailed CVE tracking for detected vulnerabilities.

```sql
CREATE TABLE composer_vulnerabilities (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  composer_install_id BIGINT NOT NULL,
  dependency_id BIGINT NOT NULL,        -- FK: composer_dependencies.id
  customer_id BIGINT NOT NULL,
  
  -- CVE details
  cve_id VARCHAR(20) NOT NULL,          -- e.g., "CVE-2024-12345"
  package_name VARCHAR(255) NOT NULL,
  affected_versions VARCHAR(255),       -- e.g., ">=5.0.0,<5.4.20"
  fixed_version VARCHAR(50),            -- e.g., "5.4.20"
  
  -- Severity
  severity ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  
  -- Details
  description TEXT,                     -- CVE description
  advisory_url VARCHAR(512),            -- Link to security advisory
  cwe VARCHAR(10),                      -- CWE classification (e.g., "CWE-89" for SQL injection)
  
  -- Status
  status ENUM('open', 'patched', 'acknowledged') DEFAULT 'open',
  discovered_at TIMESTAMP,
  fixed_at TIMESTAMP NULL,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_customer_id (customer_id),
  INDEX idx_cve_id (cve_id),
  INDEX idx_severity (severity),
  INDEX idx_status (status)
);
```

---

## Customer Panel Features

### Composer Management Section

**Location:** Client Panel > Website & Services > Composer

#### Dashboard View

```
📦 Composer Dependencies Management

Project Status:
├─ PHP Version: 8.1.3
├─ Composer Version: 2.5.1 (Latest for PHP 8.1)
├─ Installed Dependencies: 47 packages
├─ Last Install: 2026-03-01 14:32 UTC (2 hours ago)
└─ Status: ✅ Healthy

Installation Info:
├─ Vendor directory size: 23.5 MB
├─ Install duration: 1 minute 45 seconds
├─ Cache hit: Yes (composer.lock unchanged)
├─ Autoload optimized: Yes
└─ Vulnerabilities detected: 1 high-severity ⚠️

Quick Actions:
[ Install/Update Dependencies ] [ View Dependencies ] [ View Audit Report ] [ Download Logs ]
```

#### Install Dependencies Button

Click `[Install/Update Dependencies]` to:

```
Installation Dialog:

┌────────────────────────────────────────────────────────┐
│ Install/Update Dependencies                            │
│                                                        │
│ This will run: composer install                        │
│                                                        │
│ Current composer.json status:                          │
│ ├─ 47 required packages                               │
│ ├─ 12 dev dependencies                                │
│ └─ Last updated: 2 days ago                            │
│                                                        │
│ Composer version: 2.5.1 (matches PHP 8.1)             │
│                                                        │
│ What happens:                                          │
│ 1. Check composer.lock (detect if vendor needs update)│
│ 2. Install/update packages from composer.lock         │
│ 3. Run security audit (check for CVEs)               │
│ 4. Optimize autoloader                                │
│ 5. Log all changes                                    │
│                                                        │
│ Estimated time: 2-5 minutes                           │
│ Your website will remain accessible during this.      │
│                                                        │
│ [ Cancel ] [ Install Dependencies ]                   │
└────────────────────────────────────────────────────────┘

↓ (After click)

Real-time progress display:

Composer Installation in Progress...

[████████░░░░░░░░░░░░░░░░░░░░░] 25%

Step 1/5: Checking composer.lock... ✓

Step 2/5: Downloading packages...
├─ symfony/console (v5.4.15) ✓
├─ symfony/process (v5.4.15) ✓
├─ doctrine/orm (2.14.1) → Downloading...

Step 3/5: Security audit...
(When finished)

Step 4/5: Optimizing autoloader...
Step 5/5: Finalizing...

[✓] Installation complete!

Results:
├─ 47 packages installed
├─ Vendor size: 23.5 MB
├─ Duration: 2 min 45 sec
├─ Vulnerabilities found: 1 high-severity ⚠️
└─ Autoload optimized: Yes

[ View Dependencies ] [ View Audit Report ] [ View Full Log ]
```

#### Dependencies List View

```
📋 Installed Dependencies (47 packages)

Search: [________] Filter: [All ▼] [Required ▼] [Dev ▼]

┌────────────────────────────────────────────────────────────────┐
│ Package Name          Version  Type      Vulnerabilities       │
├────────────────────────────────────────────────────────────────┤
│ symfony/console       v5.4.15  required  ✅ None              │
│ symfony/process       v5.4.15  required  ✅ None              │
│ doctrine/orm          2.14.1   required  ⚠️ 1 High CVE       │
│ laravel/framework     10.6.2   required  ✅ None              │
│ guzzlehttp/guzzle     7.5.1    required  ✅ None              │
│ monolog/monolog       3.4.0    dev       ✅ None              │
│ phpunit/phpunit       10.0.11  dev       ✅ None              │
│ ...                                                            │
└────────────────────────────────────────────────────────────────┘

[Download as JSON] [Export as CSV]
```

Click on package to see details:

```
Package: doctrine/orm

Version: 2.14.1
License: MIT
Repository: https://github.com/doctrine/orm
Description: Object-Relational-Mapper for PHP

Required by: composer.json (version: ^2.14)
Install date: 2026-03-01 14:35 UTC
Size: 4.2 MB

⚠️ Vulnerability Detected:

CVE-2024-12345
Severity: HIGH
Affected versions: >=2.0.0,<2.14.2
Fixed in version: 2.14.2 (upgrade recommended)

Description: SQL injection vulnerability in query builder

Action: [Update to 2.14.2] [Ignore] [More Info]
```

#### Security Audit Report

```
🔒 Composer Security Audit Report
Generated: 2026-03-01 14:35 UTC

Scan Results:
├─ Total packages: 47
├─ Vulnerabilities found: 1
├─ Critical: 0
├─ High: 1 ⚠️
├─ Medium: 0
└─ Low: 0

Vulnerability Details:

1️⃣ CVE-2024-12345 (HIGH)
   Package: doctrine/orm (2.14.1)
   Status: OPEN (recommended update available)
   
   Severity: HIGH
   CWE: CWE-89 (SQL Injection)
   CVSS Score: 8.6
   
   Description:
   SQL injection vulnerability in the query builder when 
   using untrusted user input in raw queries.
   
   Affected Versions: >=2.0.0,<2.14.2
   Fixed Version: 2.14.2
   
   Your Version: 2.14.1 (VULNERABLE)
   
   Advisory: https://nvd.nist.gov/vuln/detail/CVE-2024-12345
   
   Recommendation: Upgrade to version 2.14.2 immediately
   
   [Upgrade to 2.14.2] [Learn More] [Mark as Acknowledged]

History:
Last audit: 2026-03-01 14:35 UTC (48 packages checked)
Next audit: Auto-run on next composer install
```

#### Installation History

```
📜 Installation History

Date               Version  Packages  Size     Status      Duration
────────────────────────────────────────────────────────────────
2026-03-01 14:35   2.5.1    47        23.5 MB  ✅ Success  2m 45s  [Details]
2026-02-28 10:15   2.5.1    47        23.5 MB  ✅ Success  1m 30s  [Details]
2026-02-27 09:00   2.5.0    46        22.1 MB  ✅ Success  2m 10s  [Details]
2026-02-25 14:20   2.5.0    46        22.1 MB  ❌ Failed   Error   [Details]

Click [Details] to see full log:
(Same as real-time progress shown during install)
```

---

## Admin Panel Features

### Composer Management (Admin)

**Location:** Admin Panel > Developer Tools > Composer Management

#### Global Composer Status

```
📦 Composer Usage Across Platform

Summary:
├─ Customers using Composer: 234 / 1000 (23.4%)
├─ Total installations: 1,247 (all-time)
├─ Successful installs: 1,201 (96.3%)
├─ Failed installs: 46 (3.7%)
└─ Avg install time: 2m 15s

Vulnerabilities Detected (Current):
├─ Total: 18 packages with CVEs
├─ Critical: 1 (immediate action required)
├─ High: 6 (upgrade recommended)
├─ Medium: 8 (plan upgrade)
└─ Low: 3 (optional)

Most Common Packages:
├─ laravel/framework: 98 customers
├─ symfony/console: 76 customers
├─ doctrine/orm: 62 customers
├─ monolog/monolog: 54 customers
└─ guzzlehttp/guzzle: 48 customers

Most Recent Installs:
├─ Example Corp (2 min ago) - 47 packages
├─ Acme Inc (15 min ago) - 62 packages
└─ TechStart (1h ago) - 35 packages
```

#### Per-Customer Composer Monitoring

```
Search: [customer name...]

Customer: Example Corp
├─ Domain: example.com
├─ PHP Version: 8.1.3
├─ Composer Version: 2.5.1
├─ Installed: Yes
├─ Dependencies: 47 packages
├─ Last install: 2h ago
├─ Status: ✅ Healthy
├─ Vulnerabilities: 1 High
└─ Actions: [Force Install] [Clear Cache] [View Logs] [View Audit]

[Force Install] button:
└─ Runs: composer install for this customer
   (Even if lock file unchanged - bypasses cache)
   (Useful for troubleshooting)

[Clear Cache] button:
└─ Deletes cached vendor/ directory
   (Next install will be full reinstall)
   (Use if vendor/ is corrupted)
```

#### Composer Version Management

```
🔧 Composer Version Configuration

Auto-update Policy:
◉ Auto-update with PHP version (Recommended)
   └─ When customer's PHP version changes, Composer auto-updates
○ Manual version control
   └─ Admin must manually update Composer versions

Composer Version Mapping:
┌──────────────┬─────────────────────────────────────┐
│ PHP Version  │ Composer Version                    │
├──────────────┼─────────────────────────────────────┤
│ 7.4.x        │ 2.2.21 (Latest for 7.4)            │
│ 8.0.x        │ 2.4.4  (Latest for 8.0)            │
│ 8.1.x        │ 2.5.8  (Latest for 8.1)            │
│ 8.2.x        │ 2.6.6  (Latest for 8.2)            │
│ 8.3.x        │ 2.6.6  (Latest for 8.3)            │
└──────────────┴─────────────────────────────────────┘

[Update All Mappings] (fetches latest stable versions)
```

#### Vulnerability Management

```
🚨 Detected Vulnerabilities (18 packages)

Critical (1):
├─ CVE-2024-12345 in doctrine/orm (2.14.1)
│  Affects: 5 customers
│  Status: OPEN
│  Recommendation: IMMEDIATE UPDATE
│  [View Affected Customers] [Notify Customers]

High (6):
├─ CVE-2024-54321 in laravel/framework (10.0.0)
│  Affects: 12 customers
│  [View Affected Customers] [Notify Customers]
├─ ...
```

Click [Notify Customers]:

```
Send Security Alert

Vulnerability: CVE-2024-12345 in doctrine/orm
Severity: CRITICAL
Affected Customers: 5

Message template:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Security Alert: Critical vulnerability detected

Package: doctrine/orm 2.14.1
Vulnerability: CVE-2024-12345 (SQL Injection)

Your website has a critical security vulnerability.
Update to doctrine/orm 2.14.2 immediately.

Your action:
1. Click [Install/Update Dependencies] in your Composer dashboard
2. Select doctrine/orm and upgrade to 2.14.2
3. Verify your site still works

Questions? Contact support.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ Preview ] [ Send to 5 Customers ] [ Cancel ]
```

---

## API Endpoints

### Customer Endpoints

#### Initiate Composer Install

**POST `/api/v1/customers/{customer_id}/domains/{domain_id}/composer/install`**

```bash
curl -X POST "https://api.platform.example.com/v1/customers/123/domains/456/composer/install" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "force_update": false,  // Skip cache check (do full install)
    "run_audit": true       // Run security audit after install
  }'
```

**Response (202 Accepted - async operation):**

```json
{
  "data": {
    "install_id": "ci_abc123",
    "status": "running",
    "started_at": "2026-03-01T14:32:00Z",
    "estimated_completion": "2026-03-01T14:35:00Z",
    "message": "Composer install in progress..."
  }
}
```

**Websocket for real-time progress:**

```
WS: wss://api.platform.example.com/ws/composer/install/ci_abc123

Messages:
{
  "step": 1,
  "total_steps": 5,
  "status": "running",
  "message": "Checking composer.lock...",
  "progress_percent": 20
}

{
  "step": 2,
  "status": "running",
  "message": "Downloading symfony/console v5.4.15...",
  "progress_percent": 40,
  "package": "symfony/console",
  "version": "v5.4.15"
}

...

{
  "step": 5,
  "status": "completed",
  "message": "Installation complete!",
  "progress_percent": 100,
  "result": {
    "packages_installed": 47,
    "vendor_size_bytes": 24589824,
    "duration_seconds": 165,
    "vulnerabilities_found": 1,
    "cache_hit": false
  }
}
```

---

#### Get Installation Status

**GET `/api/v1/customers/{customer_id}/domains/{domain_id}/composer/install/{install_id}`**

```json
{
  "data": {
    "install_id": "ci_abc123",
    "status": "completed",
    "started_at": "2026-03-01T14:32:00Z",
    "completed_at": "2026-03-01T14:34:45Z",
    "duration_seconds": 165,
    "php_version": "8.1.3",
    "composer_version": "2.5.1",
    "packages_installed": 47,
    "vendor_size_bytes": 24589824,
    "cache_hit": false,
    "autoload_optimized": true,
    "vulnerabilities_found": 1,
    "vulnerability_critical": 0,
    "vulnerability_high": 1
  }
}
```

---

#### List Installed Dependencies

**GET `/api/v1/customers/{customer_id}/domains/{domain_id}/composer/dependencies`**

```json
{
  "data": [
    {
      "package_name": "symfony/console",
      "version": "v5.4.15",
      "type": "required",
      "vulnerabilities": 0,
      "license": "MIT",
      "repository": "https://github.com/symfony/console"
    },
    {
      "package_name": "doctrine/orm",
      "version": "2.14.1",
      "type": "required",
      "vulnerabilities": 1,
      "vulnerability_severity": "high",
      "latest_version": "2.14.2",
      "license": "MIT"
    }
  ],
  "summary": {
    "total": 47,
    "required": 35,
    "dev": 12,
    "with_vulnerabilities": 1
  }
}
```

---

#### Get Security Audit Report

**GET `/api/v1/customers/{customer_id}/domains/{domain_id}/composer/audit`**

```json
{
  "data": {
    "audit_timestamp": "2026-03-01T14:34:45Z",
    "total_packages": 47,
    "vulnerabilities_total": 1,
    "vulnerabilities_critical": 0,
    "vulnerabilities_high": 1,
    "vulnerabilities_medium": 0,
    "vulnerabilities_low": 0,
    "vulnerabilities": [
      {
        "cve_id": "CVE-2024-12345",
        "package": "doctrine/orm",
        "version": "2.14.1",
        "severity": "high",
        "description": "SQL injection in query builder",
        "affected_versions": ">=2.0.0,<2.14.2",
        "fixed_version": "2.14.2",
        "advisory_url": "https://nvd.nist.gov/vuln/detail/CVE-2024-12345"
      }
    ]
  }
}
```

---

### Admin Endpoints

#### Force Install for Customer

**POST `/api/v1/admin/customers/{customer_id}/domains/{domain_id}/composer/force-install`**

Runs composer install regardless of lock file cache.

```bash
curl -X POST "https://api.platform.example.com/v1/admin/customers/123/domains/456/composer/force-install" \
  -H "Authorization: Bearer {admin-token}"
```

---

#### Get Global Composer Statistics

**GET `/api/v1/admin/composer/stats`**

```json
{
  "data": {
    "customers_using_composer": 234,
    "total_installs": 1247,
    "successful_installs": 1201,
    "failed_installs": 46,
    "avg_install_time_seconds": 135,
    "vulnerabilities_detected": 18,
    "vulnerabilities_critical": 1,
    "vulnerabilities_high": 6,
    "most_common_packages": [
      {"name": "laravel/framework", "count": 98},
      {"name": "symfony/console", "count": 76}
    ]
  }
}
```

---

#### Send Vulnerability Notification

**POST `/api/v1/admin/composer/notify-vulnerability`**

Notify affected customers of CVE.

```bash
curl -X POST "https://api.platform.example.com/v1/admin/composer/notify-vulnerability" \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "cve_id": "CVE-2024-12345",
    "package": "doctrine/orm",
    "severity": "critical",
    "affected_customers": 5,
    "notification_method": "email"
  }'
```

---

## Deployment Integration

### Git Push Auto-Install

When customer pushes code with updated composer.lock:

```
Customer pushes: git push origin main

            ↓

Git hook detects: composer.lock changed
            ↓
Triggers: Management API endpoint
            ↓
Initiates: Composer install (automatic)
            ↓
Logs: Auto-install from git push
            ↓
Notifies: Customer (email/dashboard)
```

### Automated Upgrade on PHP Version Change

When admin/customer changes PHP version:

```
Customer changes: PHP 7.4 → 8.1

            ↓

Management API detects: PHP version change
            ↓
Checks: Composer version for PHP 8.1
            ↓
Current: Composer 2.0.x (for 7.4)
Target:  Composer 2.5.x (for 8.1)
            ↓
Schedules: Background job to upgrade
            ↓
Runs: composer self-update
      composer update (refresh lock for new PHP)
            ↓
Logs: Composer upgraded + lock file updated
            ↓
Notifies: Customer of successful upgrade
```

---

## Security Considerations

### CVE Vulnerability Scanning

**Timing:**
- Automatic scan after each `composer install`
- Weekly background scan of all installed dependencies
- Real-time alerts when new CVEs published for installed packages

**Data Sources:**
- composer audit (built-in)
- NIST CVE database
- Security advisories from package authors

### Sandboxed Execution

Composer runs in customer's pod with restricted privileges:

```
Restrictions:
├─ Cannot access other customers' data
├─ Cannot install packages outside vendor/ directory
├─ Cannot modify PHP configuration
├─ File write access limited to vendor/ + storage directories
└─ No network access except to Packagist/GitHub (configured)
```

### Lock File Validation

```
Security checks:
├─ Verify composer.lock hash (detect tampering)
├─ Validate lock file syntax
├─ Check against composer.json (consistency)
└─ Audit packages before install
```

---

## Error Handling

### Common Failures & Recovery

| Error | Cause | Recovery |
|-------|-------|----------|
| **Network timeout** | Packagist unreachable | Retry with backoff; cached vendor/ still available |
| **Disk full** | vendor/ too large | Clear old installations; notify customer |
| **PHP incompatibility** | Package not compatible with PHP version | Show error; suggest compatible version |
| **CVE detected** | Vulnerable package found | Block install; require acknowledgement |
| **Lock file corruption** | composer.lock damaged | Reset to last known good; notify customer |
| **Autoload failure** | composer dump-autoload fails | Manual fix required; contact support |

### Automatic Rollback

If install fails:

```
1. Check: Was previous install successful?
2. Yes:   Restore vendor/ from last backup
3. Notify: Customer of failure + rollback
4. Log:   Full error details for support
5. Alert: Admin if repeated failures
```

---

## Monitoring & Observability

### Prometheus Metrics

```
composer_install_total{customer_id, status}
composer_install_duration_seconds{customer_id, quantile}
composer_install_cache_hit_ratio
composer_packages_total{customer_id}
composer_vulnerabilities_detected{severity}
composer_install_failures{error_type}
```

### Alerts

```
🚨 Critical Vulnerability Detected
   Package: doctrine/orm (CVE-2024-12345)
   Affects: 5 customers
   Action: Send notifications

⚠️ Composer Install Failures High
   Failure rate: >5% (threshold exceeded)
   Last 24h: 8 failures out of 120 installs
   Action: Investigate root cause

⚠️ Disk Usage High
   Vendor directory size: >500MB
   Affects: 3 customers
   Action: Contact customers; suggest cleanup
```

---

## Implementation Checklist

- [ ] **Composer Installation**
  - [ ] Create Dockerfile with Composer binary
  - [ ] Auto-detect PHP version and install compatible Composer
  - [ ] Test Composer in all supported PHP versions

- [ ] **Database Schema**
  - [ ] Create composer_installs table
  - [ ] Create composer_dependencies table
  - [ ] Create composer_vulnerabilities table
  - [ ] Add indexes for performance

- [ ] **API Endpoints**
  - [ ] POST .../composer/install (initiate)
  - [ ] GET .../composer/install/{id} (status)
  - [ ] GET .../composer/dependencies (list)
  - [ ] GET .../composer/audit (security report)
  - [ ] POST /admin/composer/... (admin operations)

- [ ] **Customer Panel**
  - [ ] Composer dashboard widget
  - [ ] Install dependencies button
  - [ ] Dependencies list view
  - [ ] Audit report viewer
  - [ ] Installation history
  - [ ] Real-time progress display (WebSocket)

- [ ] **Admin Panel**
  - [ ] Global Composer status dashboard
  - [ ] Per-customer Composer monitoring
  - [ ] Vulnerability management UI
  - [ ] Composer version configuration
  - [ ] Force install controls
  - [ ] Vulnerability notification system

- [ ] **Security**
  - [ ] Integrate composer audit command
  - [ ] CVE detection and alerts
  - [ ] Vulnerability blocking (optional)
  - [ ] Lock file validation
  - [ ] Sandboxed execution
  - [ ] Restricted file access

- [ ] **Caching**
  - [ ] Lock file hash tracking
  - [ ] Vendor directory persistence
  - [ ] Cache invalidation logic
  - [ ] Storage quota enforcement

- [ ] **Deployment Integration**
  - [ ] Git push hook for auto-install
  - [ ] PHP version change handler
  - [ ] Composer auto-upgrade on PHP change
  - [ ] Lock file update logic

- [ ] **Monitoring & Logging**
  - [ ] Prometheus metrics export
  - [ ] Installation logging
  - [ ] Error tracking and alerts
  - [ ] Dependency tracking

- [ ] **Testing**
  - [ ] Unit tests (lock file parsing, version matching)
  - [ ] Integration tests (end-to-end install)
  - [ ] Security tests (CVE detection)
  - [ ] Load tests (concurrent installs)
  - [ ] Error scenario tests

- [ ] **Documentation**
  - [ ] Customer guide (how to use Composer)
  - [ ] Admin guide (managing Composer across customers)
  - [ ] Security guide (vulnerability alerts, best practices)
  - [ ] API reference
  - [ ] Troubleshooting guide

---

## Related Documentation

- **EMAIL_SERVICES.md**: Email configuration examples often need packages like PHPMailer, SwiftMailer
- **APPLICATION_CATALOG.md**: Pre-built apps may use Composer-managed dependencies
- **DEPLOYMENT_PROCESS.md**: Integration with customer provisioning workflow
- **MONITORING_OBSERVABILITY.md**: Composer metrics and alerts
- **SECURITY_ARCHITECTURE.md**: Vulnerability management and compliance
- **BACKUP_STRATEGY.md**: Backing up vendor/ directory as part of site backup
