# Web Application Firewall (WAF) Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, platform architects, support team

---

## Overview

This document specifies the **Web Application Firewall (WAF)** feature, enabling customers to protect their web applications from common attacks (SQL injection, XSS, DDoS, etc.) with flexible per-customer configuration and granular rule management.

### Key Features

- **Optional Per-Customer** — WAF disabled by default; customers opt-in
- **Three Operational Modes** — OFF, DETECTION_ONLY (log only), ON (block + log)
- **Granular Rule Exclusions** — Disable specific rules by ID, tag, or regex pattern
- **ModSecurity + OWASP CRS** — Industry-standard ruleset + custom rules
- **Real-time Monitoring** — Dashboard showing blocked requests, attack patterns
- **Audit Logging** — All WAF actions logged for compliance
- **Zero False Positives** — Extensive rule tuning and exclusion support
- **Plan-Based Tiers** — WAF included in Business/Premium plans
- **Performance Optimized** — Minimal latency impact (< 5ms per request)
- **Rule Management UI** — Easy-to-use interface for enabling/disabling rules
- **Auto-Rule Updates** — OWASP CRS updated monthly
- **Admin Oversight** — Enable/disable WAF per customer, view global alerts

### Use Cases

| Use Case | Example |
|----------|---------|
| **SQL injection protection** | Prevent database attacks via user input |
| **XSS (Cross-site scripting)** | Block malicious JavaScript injection |
| **Path traversal** | Stop `../../../etc/passwd` attacks |
| **Local file inclusion (LFI)** | Prevent file disclosure exploits |
| **Remote code execution (RCE)** | Block PHP/shell injection attempts |
| **DDoS/rate limiting** | Slow down attackers with rate rules |
| **Vulnerability scanning** | Detect and block web scanners |
| **Exploit detection** | Identify CVE-specific attack patterns |
| **API protection** | Validate JSON/XML structure and content |
| **Bot mitigation** | Challenge suspicious automated traffic |

### Security Model

- **Positive security** (OWASP CRS) — Allow by default, block known attack patterns
- **Rule granularity** — Control at rule ID level (e.g., disable rule 941100 only)
- **Tag-based control** — Group rules by category (e.g., disable all SQLi rules)
- **Regex pattern matching** — Advanced: disable rules matching specific URI patterns
- **Safe exclusions** — Prevent accidentally disabling critical security
- **Audit trail** — All exclusions logged; changes tracked by user/timestamp
- **Admin approval** (optional) — Require approval for exclusion changes
- **Performance guardrails** — Alert if WAF processing time exceeds threshold

---

## Architecture Overview

### High-Level Design

```
┌──────────────────────────────────────────────────────────────────┐
│ Customer's Browser                                               │
├──────────────────────────────────────────────────────────────────┤
│ GET /api/users?id=1' OR '1'='1  (SQL injection attempt)         │
└──────────────────────────────────────────────────────────────────┘
          ↓ (HTTP Request)
┌──────────────────────────────────────────────────────────────────┐
│ Load Balancer / Ingress                                          │
├──────────────────────────────────────────────────────────────────┤
│ Routes to appropriate NGINX + ModSecurity                        │
└──────────────────────────────────────────────────────────────────┘
          ↓ (Request through WAF)
┌──────────────────────────────────────────────────────────────────┐
│ NGINX + ModSecurity WAF (Per-Customer Pod)                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Step 1: Load Customer WAF Config                                │
│  ├─ Mode: ON / DETECTION_ONLY / OFF                             │
│  ├─ Excluded Rules: [941100, 942200] (IDs)                      │
│  ├─ Excluded Tags: [] (categories)                              │
│  └─ Excluded Patterns: [/admin/*, /internal/*] (regex)          │
│                                                                  │
│ Step 2: Apply OWASP CRS Rules                                   │
│  ├─ Rule 941100: SQL injection attempt detected                 │
│  ├─ BLOCKED? Check exclusions:                                  │
│  │  ├─ Is rule ID 941100 excluded? YES → ALLOW                 │
│  │  ├─ Is tag 'sqli' excluded? NO → WOULD BLOCK                │
│  │  ├─ Does request match pattern /admin/*? NO → WOULD BLOCK   │
│  │  └─ Result: ALLOWED (due to ID exclusion)                   │
│  │                                                              │
│  └─ Next rule...                                               │
│                                                                  │
│ Step 3: Take Action Based on Mode                               │
│  ├─ OFF: Always allow (no checking)                             │
│  ├─ DETECTION_ONLY: Log block, but allow request through       │
│  └─ ON: Block request, return 403 Forbidden                    │
│                                                                  │
│ Step 4: Log Action                                              │
│  └─ Send to: waf_request_log table + syslog                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
          ↓ (Allowed or Blocked)
┌──────────────────────────────────────────────────────────────────┐
│ Backend Application (Apache/PHP, Node, Python, etc.)             │
├──────────────────────────────────────────────────────────────────┤
│ (Receives request if allowed)                                    │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Database (WAF Logs & Config)                                     │
├──────────────────────────────────────────────────────────────────┤
│ - waf_customer_config (customer WAF settings)                   │
│ - waf_rule_exclusions (excluded rule IDs, tags, patterns)      │
│ - waf_request_log (all WAF decisions, timestamps, IPs)         │
│ - waf_alert_log (high-severity attacks, blocked requests)      │
└──────────────────────────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────────────────────────┐
│ Management API + Dashboards                                      │
├──────────────────────────────────────────────────────────────────┤
│ - Customer UI: Enable/disable WAF, view logs, manage rules      │
│ - Admin UI: Global overview, per-customer stats, alerts         │
└──────────────────────────────────────────────────────────────────┘
```

### Operational Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **OFF** | All requests pass through; no WAF inspection | Development, testing, or disabled protection |
| **DETECTION_ONLY** | Requests inspected; blocks logged but requests allowed through | Tuning phase, analyzing false positives, audit mode |
| **ON** | Requests inspected; attacks blocked (403); legitimate requests pass | Production with active protection |

### ModSecurity Architecture

**NGINX + ModSecurity v3:**
```
NGINX (Reverse Proxy)
  ↓
ModSecurity v3 Module
  ├─ Core Rule Set (OWASP CRS v4.0)
  │  ├─ Rule 900000: Initialization
  │  ├─ Rule 901000: Common header types
  │  ├─ Rule 910000: HTTP protocol violations
  │  ├─ Rule 920000: HTTP attack detection
  │  ├─ Rule 930000: Application attack detection
  │  ├─ Rule 940000: Normalization
  │  ├─ Rule 941000: SQL injection
  │  ├─ Rule 942000: RFI/LFI
  │  ├─ Rule 943000: Session fixation
  │  ├─ Rule 944000: Scanners/bots
  │  └─ Rule 949000: Data leakage
  │
  ├─ Custom Rules (per-customer or global)
  │  ├─ Rate limiting rules
  │  ├─ IP reputation rules
  │  └─ Customer-specific protection rules
  │
  └─ Rule Exclusion Engine
     ├─ Rule ID exclusions
     ├─ Tag-based exclusions
     └─ Regex pattern exclusions
```

---

## Database Schema

### 1. `waf_customer_config` — Per-customer WAF configuration

```sql
CREATE TABLE waf_customer_config (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL UNIQUE,
  
  -- WAF operational mode
  mode ENUM('OFF', 'DETECTION_ONLY', 'ON') DEFAULT 'OFF',
  
  -- Feature flags
  enabled BOOLEAN DEFAULT FALSE,
  auto_update_rules BOOLEAN DEFAULT TRUE,  -- Auto-update OWASP CRS monthly
  
  -- Performance tuning
  max_response_time_ms INT DEFAULT 100,  -- Alert if WAF takes > 100ms
  request_body_limit_kb INT DEFAULT 8192,  -- Max body size to inspect
  
  -- Sensitivity settings
  paranoia_level INT DEFAULT 1,  -- 1=default, 2=medium, 3=strict, 4=paranoid
  -- Higher levels = more rules enabled, more false positives
  
  -- Rule version tracking
  rule_set_version VARCHAR(50),  -- e.g., "OWASP CRS 4.0.0"
  rule_set_updated_at TIMESTAMP,
  
  -- Configuration metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id BIGINT UNSIGNED,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT UNSIGNED,
  
  -- Plan tier checking
  plan_id BIGINT UNSIGNED,  -- WAF available on Business/Premium
  waf_enabled_for_plan BOOLEAN DEFAULT FALSE,  -- Based on plan
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_customer (customer_id),
  KEY idx_enabled_mode (enabled, mode)
);
```

### 2. `waf_rule_exclusions` — Excluded rules per customer

```sql
CREATE TABLE waf_rule_exclusions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  
  -- Exclusion type
  exclusion_type ENUM('RULE_ID', 'TAG', 'REGEX_PATTERN') NOT NULL,
  
  -- Exclusion value (depends on type)
  exclusion_value VARCHAR(512) NOT NULL,
  -- Examples:
  -- Type RULE_ID: "941100" (disable SQL injection rule)
  -- Type TAG: "sqli" (disable all SQL injection rules)
  -- Type REGEX_PATTERN: "/admin/*" (disable rules for /admin paths)
  
  -- Description (why rule is excluded)
  reason VARCHAR(255),
  -- Examples: "False positive on custom API", "Legacy code uses special characters"
  
  -- Status
  enabled BOOLEAN DEFAULT TRUE,
  -- Can soft-disable without deleting
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id BIGINT UNSIGNED,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT UNSIGNED,
  
  expires_at TIMESTAMP NULL,
  -- Optional: auto-enable rule after date (e.g., after API patch is deployed)
  
  -- Audit
  change_log JSON,  -- Track changes: {"enabled": true→false, "reason": "old→new"}
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  UNIQUE KEY unique_exclusion_per_customer (customer_id, exclusion_type, exclusion_value),
  KEY idx_customer_enabled (customer_id, enabled),
  KEY idx_expires (expires_at)
);
```

### 3. `waf_request_log` — All WAF decisions (high volume)

```sql
CREATE TABLE waf_request_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  customer_id BIGINT UNSIGNED NOT NULL,
  domain_id BIGINT UNSIGNED NOT NULL,
  
  -- Request details
  request_method VARCHAR(10),  -- GET, POST, etc.
  request_uri VARCHAR(2048),
  request_headers JSON,  -- Subset: User-Agent, Referer, etc.
  request_body_preview VARCHAR(512),  -- First 512 chars of body (truncated)
  
  -- Client info
  client_ip VARCHAR(45),  -- IPv4 or IPv6
  client_user_agent VARCHAR(512),
  client_country VARCHAR(2),  -- GeoIP lookup result
  
  -- WAF decision
  action ENUM('ALLOWED', 'BLOCKED', 'LOGGED') NOT NULL,
  -- ALLOWED: Passed through (no rules triggered)
  -- BLOCKED: Attacked detected and blocked (mode=ON)
  -- LOGGED: Attacked detected but allowed (mode=DETECTION_ONLY)
  
  triggered_rule_ids JSON,  -- ["941100", "942200"] (rules that matched)
  triggered_rule_messages JSON,  -- [{ id, message, severity }]
  
  block_reason VARCHAR(512),  -- Reason for block (if BLOCKED)
  
  waf_processing_time_ms DECIMAL(5,2),  -- How long WAF spent on this request
  
  -- Response status
  response_status_code INT,
  -- 200-399 if allowed
  -- 403 if blocked
  
  -- Severity classification
  severity ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') DEFAULT 'LOW',
  
  -- Timestamp with microsecond precision
  timestamp TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),
  
  -- Archival policy
  archived BOOLEAN DEFAULT FALSE,  -- For large log cleanup
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  
  -- Indexes for common queries
  KEY idx_customer_timestamp (customer_id, timestamp),
  KEY idx_customer_action (customer_id, action),
  KEY idx_client_ip (client_ip),
  KEY idx_triggered_rules (triggered_rule_ids(50)),  -- JSON index
  KEY idx_severity (severity),
  KEY idx_blocked_only (action) -- Frequent query: "show me blocked requests"
);
```

### 4. `waf_alert_log` — High-severity attacks and blocks

```sql
CREATE TABLE waf_alert_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  customer_id BIGINT UNSIGNED NOT NULL,
  
  alert_type ENUM('MULTIPLE_BLOCKS', 'REPEATED_PATTERN', 'SCANNER_DETECTED', 'RATE_LIMIT', 'CRITICAL_RULE') NOT NULL,
  
  -- Alert details
  description VARCHAR(512),
  summary JSON,  -- {triggered_rules: [...], client_ips: [...], count: X}
  
  -- Time period of alert
  window_start TIMESTAMP,
  window_end TIMESTAMP,
  
  -- Affected parties
  affected_domains JSON,  -- ["example.com", "shop.example.com"]
  affected_ips JSON,  -- ["203.0.113.45"]
  
  severity ENUM('INFO', 'WARNING', 'CRITICAL') DEFAULT 'WARNING',
  
  -- Response status
  status ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED') DEFAULT 'OPEN',
  
  acknowledged_by_user_id BIGINT UNSIGNED,
  acknowledged_at TIMESTAMP NULL,
  
  -- Auto-response actions
  auto_action_taken VARCHAR(255),
  -- e.g., "IP blocked for 1 hour", "Rate limit applied"
  
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (acknowledged_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_customer_severity (customer_id, severity),
  KEY idx_status (status),
  KEY idx_timestamp (timestamp)
);
```

### 5. `waf_rule_audit_log` — Track rule exclusion changes

```sql
CREATE TABLE waf_rule_audit_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  customer_id BIGINT UNSIGNED NOT NULL,
  
  action ENUM('EXCLUSION_ADDED', 'EXCLUSION_REMOVED', 'EXCLUSION_MODIFIED', 'EXCLUSION_EXPIRED', 'MODE_CHANGED', 'CONFIG_UPDATED') NOT NULL,
  
  -- What changed
  change_details JSON,
  -- Examples:
  -- { exclusion_id: 123, type: "RULE_ID", value: "941100", reason: "API update" }
  -- { mode: "OFF" → "DETECTION_ONLY" }
  
  reason VARCHAR(255),
  
  created_by_user_id BIGINT UNSIGNED,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_customer_timestamp (customer_id, timestamp),
  KEY idx_action (action)
);
```

---

## API Endpoints

### Customer Endpoints

#### 1. Get WAF Status (GET)
```
GET /api/v1/customers/{customer_id}/waf/status
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "enabled": true,
    "mode": "ON",
    "plan_supports_waf": true,
    "rule_set_version": "OWASP CRS 4.0.0",
    "paranoia_level": 1,
    "excluded_rules_count": 5,
    "last_updated": "2026-03-01T10:00:00Z",
    "stats": {
      "requests_today": 45000,
      "blocked_today": 12,
      "blocked_percentage": 0.027,
      "false_positive_estimate": "2-3 rules likely false positives"
    }
  }
}
```

#### 2. Update WAF Mode (PATCH)
```
PATCH /api/v1/customers/{customer_id}/waf/mode
```

**Request Body:**
```json
{
  "mode": "ON",  // or "DETECTION_ONLY" or "OFF"
  "reason": "Enabling production protection after testing"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "mode": "ON",
    "updated_at": "2026-03-01T12:30:00Z",
    "message": "WAF mode changed to ON. Active protection is now enabled."
  }
}
```

**Status Codes:** 200, 400, 401, 403, 409 (WAF not enabled)

#### 3. Update WAF Configuration (PATCH)
```
PATCH /api/v1/customers/{customer_id}/waf/config
```

**Request Body:**
```json
{
  "paranoia_level": 2,
  "max_response_time_ms": 150,
  "request_body_limit_kb": 16384,
  "auto_update_rules": true
}
```

**Response (200 OK):** Updated configuration object

#### 4. List Excluded Rules (GET)
```
GET /api/v1/customers/{customer_id}/waf/exclusions
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | enum | Filter: `RULE_ID`, `TAG`, `REGEX_PATTERN` |
| `enabled` | bool | Filter: enabled or disabled exclusions |
| `limit` | int | Results per page (default: 50) |
| `offset` | int | Pagination offset |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1,
      "exclusion_type": "RULE_ID",
      "exclusion_value": "941100",
      "reason": "False positive on custom API endpoint /search?q=",
      "enabled": true,
      "expires_at": null,
      "created_at": "2026-02-20T08:00:00Z",
      "created_by": "admin@platform.com"
    },
    {
      "id": 2,
      "exclusion_type": "TAG",
      "exclusion_value": "xss",
      "reason": "Legacy form uses inline JavaScript (scheduled for refactor Q2 2026)",
      "enabled": true,
      "expires_at": "2026-06-30T23:59:59Z",
      "created_at": "2026-01-15T10:30:00Z",
      "created_by": "customer@example.com"
    },
    {
      "id": 3,
      "exclusion_type": "REGEX_PATTERN",
      "exclusion_value": "/admin/reports/.*\\.csv",
      "reason": "CSV export endpoint uses special characters in filenames",
      "enabled": false,
      "expires_at": null,
      "created_at": "2026-02-01T14:20:00Z",
      "created_by": "admin@platform.com"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 3
  }
}
```

#### 5. Add Rule Exclusion (POST)
```
POST /api/v1/customers/{customer_id}/waf/exclusions
```

**Request Body:**
```json
{
  "exclusion_type": "RULE_ID",  // or "TAG" or "REGEX_PATTERN"
  "exclusion_value": "941120",
  "reason": "False positive: API endpoint accepts SQL-like syntax",
  "expires_at": "2026-04-01T00:00:00Z"  // Optional: auto-expire
}
```

**Response (201 Created):**
```json
{
  "status": "success",
  "data": {
    "id": 15,
    "exclusion_type": "RULE_ID",
    "exclusion_value": "941120",
    "reason": "False positive: API endpoint accepts SQL-like syntax",
    "enabled": true,
    "expires_at": "2026-04-01T00:00:00Z",
    "created_at": "2026-03-01T12:45:00Z"
  }
}
```

**Status Codes:** 201, 400, 401, 403, 409 (duplicate exclusion)

#### 6. Disable/Enable Rule Exclusion (PATCH)
```
PATCH /api/v1/customers/{customer_id}/waf/exclusions/{exclusion_id}
```

**Request Body:**
```json
{
  "enabled": false,
  "reason": "Re-enabling 941120 after API endpoint was refactored"
}
```

**Response (200 OK):** Updated exclusion object

#### 7. Delete Rule Exclusion (DELETE)
```
DELETE /api/v1/customers/{customer_id}/waf/exclusions/{exclusion_id}
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `reason` | string | Reason for deletion (for audit log) |

**Response (204 No Content):** Empty response

**Status Codes:** 204, 401, 403, 404

#### 8. Get WAF Logs (GET)
```
GET /api/v1/customers/{customer_id}/waf/logs
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | enum | Filter: `ALLOWED`, `BLOCKED`, `LOGGED` |
| `severity` | enum | Filter: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `start_date` | string | ISO 8601 date (default: 7 days ago) |
| `end_date` | string | ISO 8601 date (default: now) |
| `triggered_rule` | string | Filter by rule ID (e.g., "941100") |
| `client_ip` | string | Filter by IP address |
| `limit` | int | Results per page (default: 100, max: 1000) |
| `offset` | int | Pagination offset |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "id": 5432,
      "request_method": "POST",
      "request_uri": "/api/search?q=1' OR '1'='1",
      "client_ip": "203.0.113.45",
      "client_country": "RU",
      "action": "BLOCKED",
      "triggered_rule_ids": ["941100", "941110"],
      "triggered_rule_messages": [
        {
          "id": "941100",
          "message": "SQL Injection Attack Detected",
          "severity": "CRITICAL"
        },
        {
          "id": "941110",
          "message": "Possible SQL Injection Attack",
          "severity": "HIGH"
        }
      ],
      "severity": "CRITICAL",
      "waf_processing_time_ms": 3.25,
      "response_status_code": 403,
      "timestamp": "2026-03-01T12:15:30Z"
    },
    {
      "id": 5431,
      "request_method": "GET",
      "request_uri": "/products?category=<script>alert('xss')</script>",
      "client_ip": "198.51.100.23",
      "client_country": "US",
      "action": "LOGGED",
      "triggered_rule_ids": ["941320"],
      "triggered_rule_messages": [
        {
          "id": "941320",
          "message": "XSS Attack Detected",
          "severity": "HIGH"
        }
      ],
      "severity": "HIGH",
      "waf_processing_time_ms": 2.10,
      "response_status_code": 200,
      "timestamp": "2026-03-01T12:10:15Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 247
  },
  "statistics": {
    "blocked_count": 12,
    "logged_count": 235,
    "average_processing_time_ms": 2.85,
    "top_rules": [
      {"rule_id": "941100", "count": 8},
      {"rule_id": "944100", "count": 4}
    ],
    "top_ips": [
      {"ip": "203.0.113.45", "count": 12, "country": "RU"}
    ]
  }
}
```

#### 9. Get Available Rules (GET)
```
GET /api/v1/customers/{customer_id}/waf/rules
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `category` | string | Filter: `sqli`, `xss`, `rfi`, `lfi`, `scanner`, etc. |
| `search` | string | Search rule messages |
| `limit` | int | Results per page (default: 50, max: 100) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "id": "941100",
      "name": "SQL Injection Attack Detected",
      "description": "Detects SQL injection attempts in request parameters",
      "category": "sqli",
      "severity": "CRITICAL",
      "tags": ["sqli", "database", "injection"],
      "enabled": true,
      "excluded": false
    },
    {
      "id": "941110",
      "name": "Possible SQL Injection Attack",
      "description": "Detects possible SQL injection patterns",
      "category": "sqli",
      "severity": "HIGH",
      "tags": ["sqli", "database"],
      "enabled": true,
      "excluded": false
    }
  ],
  "total": 247,
  "rule_set": "OWASP CRS 4.0.0"
}
```

#### 10. Get Rule Details (GET)
```
GET /api/v1/customers/{customer_id}/waf/rules/{rule_id}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "941100",
    "name": "SQL Injection Attack Detected",
    "description": "Detects SQL injection attempts in request parameters using pattern matching",
    "category": "sqli",
    "severity": "CRITICAL",
    "tags": ["sqli", "database", "injection"],
    "paranoia_level_required": 1,
    "rule_set": "OWASP CRS 4.0.0",
    "enabled": true,
    "excluded_for_customer": false,
    "rule_text": "(Complex ModSecurity rule definition...)",
    "false_positive_rate": "0.5%",  // Estimated based on telemetry
    "known_issues": [
      "May flag legitimate URLs with encoded single quotes in parameters"
    ],
    "documentation": "https://owasp.org/www-project-modsecurity-core-rule-set/..."
  }
}
```

---

### Admin Endpoints

#### 1. List All WAF Configurations (Admin) (GET)
```
GET /api/v1/admin/waf/customers
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `enabled` | bool | Filter: WAF enabled or disabled |
| `mode` | enum | Filter: `OFF`, `DETECTION_ONLY`, `ON` |
| `plan_id` | int | Filter by plan tier |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "customer_id": 123,
      "customer_name": "ACME Corp",
      "waf_enabled": true,
      "mode": "ON",
      "plan": "Premium",
      "excluded_rules_count": 3,
      "blocks_today": 12,
      "rule_set_version": "OWASP CRS 4.0.0",
      "updated_at": "2026-03-01T10:00:00Z"
    }
  ]
}
```

#### 2. Enable/Disable WAF for Customer (Admin) (PATCH)
```
PATCH /api/v1/admin/waf/customers/{customer_id}
```

**Request Body:**
```json
{
  "enabled": true,
  "mode": "DETECTION_ONLY",
  "reason": "Enabling for testing before production rollout"
}
```

**Response (200 OK):** Updated configuration object

#### 3. View Global WAF Alerts (Admin) (GET)
```
GET /api/v1/admin/waf/alerts
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `severity` | enum | Filter: `INFO`, `WARNING`, `CRITICAL` |
| `status` | enum | Filter: `OPEN`, `ACKNOWLEDGED`, `RESOLVED` |
| `limit` | int | Results per page (default: 50) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1001,
      "customer_id": 123,
      "alert_type": "MULTIPLE_BLOCKS",
      "description": "Customer #123 (ACME Corp) experiencing 8 blocks in 5 minutes from IP 203.0.113.45",
      "severity": "CRITICAL",
      "status": "OPEN",
      "affected_ips": ["203.0.113.45"],
      "auto_action_taken": "IP rate-limited for 1 hour",
      "timestamp": "2026-03-01T12:20:00Z"
    }
  ]
}
```

#### 4. Acknowledge Alert (Admin) (POST)
```
POST /api/v1/admin/waf/alerts/{alert_id}/acknowledge
```

**Request Body:**
```json
{
  "reason": "Confirmed: attacker's IP. Rate limit already applied."
}
```

**Response (200 OK):** Updated alert object

#### 5. View Global WAF Statistics (Admin) (GET)
```
GET /api/v1/admin/waf/statistics
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `start_date` | string | ISO 8601 date (default: 7 days ago) |
| `end_date` | string | ISO 8601 date (default: now) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "total_requests": 1250000,
    "total_blocked": 324,
    "total_logged": 2156,
    "block_rate": "0.026%",
    "top_customers_by_blocks": [
      {"customer_id": 123, "name": "ACME Corp", "blocks": 52},
      {"customer_id": 456, "name": "TechStart Inc", "blocks": 28}
    ],
    "top_rules": [
      {"rule_id": "941100", "triggered": 128, "blocked": 52},
      {"rule_id": "944100", "triggered": 156, "blocked": 89}
    ],
    "top_attack_ips": [
      {"ip": "203.0.113.45", "country": "RU", "attacks": 52, "blocked": 52}
    ],
    "attack_trends": {
      "sqli": 45,
      "xss": 32,
      "scanner": 156,
      "rfi": 8,
      "lfi": 15
    }
  }
}
```

---

## Web UI (Customer Panel)

### 1. WAF Dashboard

**Location:** `Control Panel → Security → Web Application Firewall`

```
┌──────────────────────────────────────────────────────────────┐
│ Web Application Firewall (WAF)                               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Status: ✓ Active (Mode: ON)                                 │
│ Plan: Premium (WAF included)                                │
│ Rule Set: OWASP CRS 4.0.0 (Updated 2026-03-01)            │
│                                                              │
│ Quick Stats (Today):                                         │
│ ├─ Requests Scanned: 45,000                                 │
│ ├─ Blocked: 12 (0.027%)                                     │
│ ├─ Logged: 45 (mode=DETECTION_ONLY)                        │
│ └─ Avg Processing Time: 2.8ms                              │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ [Enable WAF]  [Configure]  [View Logs]  [View Rules]        │
│                                                              │
│ Recent Blocks:                                              │
│ 12:15 | 203.0.113.45 | SQL Injection in /api/search?q= | 403
│ 12:10 | 198.51.100.23 | XSS in /products?category= | 200    │
│                                                              │
│ [View All Logs] [Export Report]                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2. WAF Settings Page

```
┌──────────────────────────────────────────────────────────────┐
│ WAF Settings                                            [Info]│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Enable WAF: ☑ (Check to enable, WAF included in Premium plan)
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Operational Mode:                                           │
│ ◉ OFF (No protection, all requests pass through)           │
│ ○ DETECTION_ONLY (Log attacks, allow requests)            │
│ ◉ ON (Block attacks, protect in production)               │
│   (Recommended: Use DETECTION_ONLY for 1 week first)       │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Sensitivity Settings:                                       │
│ Paranoia Level: [1 (Recommended) ▼]                        │
│ (1=default, 2=medium, 3=strict, 4=paranoid)               │
│ ℹ️ Higher levels catch more attacks but may block legit    │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Advanced Settings:                                          │
│ ☑ Auto-update OWASP CRS monthly                           │
│ Max WAF Processing Time: [100] ms (alert if exceeded)      │
│ Request Body Inspection Limit: [8192] KB                   │
│                                                              │
│ [Save Settings] [Reset to Defaults]                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3. Rule Exclusions Management Page

**Location:** `Control Panel → Security → WAF → Rule Exclusions`

```
┌──────────────────────────────────────────────────────────────┐
│ Manage Rule Exclusions                     [+ Add Exclusion] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Excluded Rules: 5                                            │
│ Filters: [All Types ▼] [Enabled ▼] [All ▼]               │
│                                                              │
│ ┌────────────┬───────┬────────────────┬────────────────┐   │
│ │Type        │Value  │Reason          │Action          │   │
│ ├────────────┼───────┼────────────────┼────────────────┤   │
│ │RULE_ID     │941100 │SQL in search   │[Edit] [Disable]│   │
│ │            │       │query params    │                │   │
│ │            │       │                │                │   │
│ │TAG         │xss    │Legacy form     │[Edit] [Disable]│   │
│ │            │       │uses JS         │(Expires Q2)    │   │
│ │            │       │                │                │   │
│ │REGEX       │/admin │CSV export      │[Edit] [Remove] │   │
│ │PATTERN     │/*     │filenames       │                │   │
│ └────────────┴───────┴────────────────┴────────────────┘   │
│                                                              │
│ ⓘ Tips:                                                    │
│ • RULE_ID: Disable specific rule (e.g., 941100)           │
│ • TAG: Disable all rules in category (e.g., 'sqli')       │
│ • REGEX_PATTERN: Disable rules for specific paths         │
│                                                              │
│ [View All Available Rules] [Import Exclusions] [Export]     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4. Add Rule Exclusion Modal

```
┌──────────────────────────────────────────────────────────────┐
│ Add Rule Exclusion                                    [Close] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Exclusion Type:                                             │
│ ◉ Rule ID (disable specific rule)                          │
│ ○ Tag (disable all rules in category)                      │
│ ○ Regex Pattern (disable for specific path)                │
│                                                              │
│ Rule ID / Tag / Pattern:                                    │
│ [941100 or xss or /admin/* ________]                        │
│                                                              │
│ [List Available Rules] [Browse Tags]                        │
│                                                              │
│ Reason (required):                                          │
│ [False positive in customer search API____________________]│
│                                                              │
│ Auto-Expire (optional):                                     │
│ ☐ Enable [2026-04-01T00:00:00] UTC                         │
│   (Automatically re-enable rule after this date)            │
│                                                              │
│ ⚠️ Warning: Disabling rule 941100 removes SQL injection     │
│    protection on affected path. Ensure your code is secure.│
│                                                              │
│ [Add Exclusion] [Cancel]                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 5. WAF Logs Page

**Location:** `Control Panel → Security → WAF → Logs`

```
┌──────────────────────────────────────────────────────────────┐
│ WAF Logs & Activity                      [Export] [Settings] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Filters:                                                    │
│ [Action: All ▼] [Severity: All ▼] [Rule: All ▼]           │
│ [Date Range: Last 7 Days ▼] [IP: ___________]              │
│                                                              │
│ Results: 247 | Blocked: 12 | Logged: 235                   │
│                                                              │
│ ┌─────┬────────┬──────────┬──────┬────────────────────────┐│
│ │Time │Method  │URI       │Action│Triggered Rules         ││
│ ├─────┼────────┼──────────┼──────┼────────────────────────┤│
│ │12:15│POST    │/api/     │403   │941100 (SQL Injection)  ││
│ │     │        │search... │Block │Critical               ││
│ │     │        │          │      │                        ││
│ │12:10│GET     │/products?│200   │941320 (XSS)           ││
│ │     │        │category= │Log   │High                   ││
│ │     │        │          │      │                        ││
│ │12:05│GET     │/admin/   │200   │944100 (Scanner)       ││
│ │     │        │          │Log   │Medium                 ││
│ └─────┴────────┴──────────┴──────┴────────────────────────┘│
│                                                              │
│ [Show More]  [View Detailed Report]                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Security Considerations

### 1. Rule Exclusion Validation

**Problem:** Customer disables critical security rules, causing vulnerabilities.

**Solutions:**
- **Safety warnings** — Warn before disabling critical rules
- **Approval workflow** (optional) — Require admin approval for exclusions
- **Auto-expiry** — Set time limits (e.g., "re-enable in 30 days")
- **Audit trail** — Log all exclusion changes by user/timestamp
- **Safety guidelines** — Recommend only excluding specific rule IDs (safer than tags)

**Implementation:**
```python
# Validate rule exclusion
critical_rules = [
  "941100",  # SQL injection
  "941200",  # XSS
  "942200",  # RFI
]

def add_exclusion(customer_id, rule_id, reason):
    if rule_id in critical_rules:
        # Warn user
        show_warning(f"Rule {rule_id} is critical security. "
                     "Are you sure?")
        
        # Optional: Require admin approval
        if REQUIRE_ADMIN_APPROVAL:
            send_approval_request(admin, reason)
            return "pending_approval"
    
    # Set auto-expire to force review
    if not expires_at:
        expires_at = now() + timedelta(days=30)
    
    store_exclusion(customer_id, rule_id, reason, expires_at)
```

### 2. False Positive Management

**Problem:** Legitimate requests blocked; WAF causing issues.

**Solutions:**
- **DETECTION_ONLY mode** — Test WAF before enabling blocks
- **Paranoia levels** — Start at level 1, increase gradually
- **Rule tuning guides** — Document how to disable problematic rules
- **Support team help** — Offer analysis of blocked requests
- **Auto-tuning** (future) — ML-based suggestions for exclusions

**Recommended Rollout:**
```
Week 1: DETECTION_ONLY mode
  ↓ (Analyze logs, identify false positives)
Week 2: Disable obvious false positive rules
  ↓ (Re-test in DETECTION_ONLY)
Week 3: Switch to ON mode
  ↓ (Monitor for issues)
Week 4: Enable higher paranoia level
```

### 3. Performance Impact

**Problem:** WAF adds latency to every request.

**Solutions:**
- **Target SLA** — Keep WAF processing < 5ms per request
- **Batch rule processing** — Optimize rule engine
- **Rule caching** — Cache exclusion lists per customer
- **Alerts** — Alert if WAF time exceeds threshold
- **Bypass option** — Emergency bypass for high-load customers

**Monitoring:**
```sql
-- Alert if WAF processing exceeds 10ms
SELECT customer_id, COUNT(*) as slow_requests
FROM waf_request_log
WHERE waf_processing_time_ms > 10
GROUP BY customer_id
HAVING COUNT(*) > 100;
```

### 4. Access Control

**Problem:** Customers could disable all WAF rules, or admins could misuse access.

**Solutions:**
- **Role-based access** — Only admin can enable/disable WAF entirely
- **Granular permissions** — Customer can manage exclusions, but not disable WAF
- **Audit logging** — All WAF changes logged
- **Approval workflow** — Require approval for sensitive changes
- **IP restrictions** — Optional: restrict WAF changes to specific IPs

### 5. Rule Update Safety

**Problem:** Auto-updating OWASP CRS breaks customer websites or disables protection.

**Solutions:**
- **Staging environment** — Test new rules before deployment
- **Phased rollout** — Deploy to 10%, 50%, 100% of customers
- **Rollback capability** — Revert to previous rule set if issues arise
- **Notification** — Notify customers before major rule updates
- **Breakage alerts** — Monitor for blocks/errors after updates

---

## Rule Management

### OWASP CRS Rule Categories

| Rule ID Range | Category | Examples |
|---------------|----------|----------|
| 900000-909999 | Initialization | Rule set startup |
| 910000-919999 | HTTP protocol | Invalid method, missing headers |
| 920000-929999 | HTTP attack detection | Bad encoding, protocol violations |
| 930000-939999 | Application attack detection | Remote code execution, file upload |
| 940000-949999 | Normalization | URL normalization |
| 941000-941999 | SQL injection | SELECT, INSERT, DROP injection |
| 942000-942999 | RFI/LFI | Remote/local file inclusion |
| 943000-943999 | Session fixation | Session manipulation |
| 944000-944999 | Scanners/bots | Tool detection |
| 949000-949999 | Data leakage | Sensitive data exposure |

### Custom Rule Examples

**Rate Limiting Rule:**
```
# Block if > 100 requests per minute from same IP
SecRule IP:@throttle_requests "@gt 100" \
    "id:1000001,deny,status:429,msg:'Rate limit exceeded'"
```

**Bot Detection Rule:**
```
# Block requests with suspicious User-Agent
SecRule REQUEST_HEADERS:User-Agent \
    "@contains sqlmap|nmap|nikto" \
    "id:1000002,deny,status:403,msg:'Security scanner detected'"
```

---

## Implementation Checklist

### Phase 1: Infrastructure (Weeks 1-2)

- [ ] ModSecurity v3 deployment
  - [ ] Compile ModSecurity module for NGINX
  - [ ] Integration with existing NGINX pods
  - [ ] TLS passthrough testing

- [ ] OWASP CRS v4.0 setup
  - [ ] Download and configure ruleset
  - [ ] Default paranoia level = 1
  - [ ] Rule version tracking in database

- [ ] Database schema creation
  - [ ] All 5 tables with indexes
  - [ ] Migration scripts
  - [ ] Retention policies

### Phase 2: Core Functionality (Weeks 3-4)

- [ ] ModSecurity rule processing
  - [ ] Load customer exclusions
  - [ ] Apply rule IDs exclusions
  - [ ] Apply tag exclusions
  - [ ] Apply regex pattern exclusions

- [ ] Request logging
  - [ ] Capture all WAF decisions
  - [ ] Log triggered rules
  - [ ] Store client IP/country
  - [ ] Track processing time

- [ ] Alert generation
  - [ ] Detect attack patterns
  - [ ] Generate high-severity alerts
  - [ ] Escalate to admin

### Phase 3: API Endpoints (Weeks 5-6)

- [ ] Customer endpoints (10 total)
  - [ ] Get/update WAF status
  - [ ] List/add/delete exclusions
  - [ ] View logs with filtering
  - [ ] Get rule details

- [ ] Admin endpoints (5 total)
  - [ ] List all WAF configs
  - [ ] Enable/disable WAF per customer
  - [ ] View global alerts
  - [ ] View global statistics

- [ ] Error handling
  - [ ] Invalid rule ID
  - [ ] Duplicate exclusion
  - [ ] Plan tier checking

### Phase 4: Web UI (Weeks 7-8)

- [ ] Dashboard
  - [ ] Enable/disable toggle
  - [ ] Mode selector
  - [ ] Quick stats
  - [ ] Recent blocks list

- [ ] Settings page
  - [ ] Mode selection (OFF/DETECTION_ONLY/ON)
  - [ ] Paranoia level selector
  - [ ] Performance settings

- [ ] Rule management
  - [ ] List all available rules
  - [ ] Add/edit/delete exclusions
  - [ ] Auto-expire date picker
  - [ ] Safety warnings

- [ ] Logs viewer
  - [ ] Advanced filtering
  - [ ] Real-time updates
  - [ ] Export to CSV/JSON

### Phase 5: Security Hardening (Weeks 9-10)

- [ ] Rule exclusion validation
  - [ ] Warn on critical rules
  - [ ] Admin approval workflow (optional)
  - [ ] Auto-expiry enforcement

- [ ] Performance optimization
  - [ ] Rule caching
  - [ ] Exclusion list caching
  - [ ] Latency monitoring

- [ ] Audit logging
  - [ ] Track all changes by user
  - [ ] Immutable log enforcement
  - [ ] Retention policies

### Phase 6: Testing & Rollout (Weeks 11-12)

- [ ] Integration tests
  - [ ] SQL injection attempts blocked in ON mode
  - [ ] Allowed in DETECTION_ONLY mode
  - [ ] Exclusions work correctly
  - [ ] Regex patterns match correctly

- [ ] Performance tests
  - [ ] < 5ms average latency per request
  - [ ] 1000+ concurrent requests
  - [ ] Large request bodies

- [ ] Rollout
  - [ ] Deploy to staging
  - [ ] Deploy to 10% of customers (early adopters)
  - [ ] Monitor for issues
  - [ ] Deploy to 100%

---

## Plan-Based Tiers

| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| **WAF Available** | ✅ (off by default) | ✅ (off by default) | ✅ (enabled by default) |
| **Operational Modes** | ON, DETECTION_ONLY | ON, DETECTION_ONLY | ON, DETECTION_ONLY |
| **Rule Exclusions** | Limited (5) | Limited (5) | Unlimited |
| **Paranoia Levels** | Level 1 only | Levels 1-2 | Levels 1-4 |
| **Custom Rules** | ❌ | ❌ | ✅ (future) |
| **Logs Retention** | 7 days | 30 days | 90 days |
| **API Access** | Read-only | Read-only | Read + Write |
| **Priority Support** | ❌ | ❌ | ✅ |

> WAF is **available on all plans** per platform policy (see `HOSTING_PLANS.md`). Default state varies by plan but can be overridden per-customer.

---

## Monitoring & Alerts

### Key Metrics

**Customer-Level:**
- Requests scanned per hour
- Blocked requests count
- Logged requests count (DETECTION_ONLY)
- Block rate (blocked / total)
- Average WAF processing time
- Top triggered rules
- Top attacking IPs

**Global (Admin):**
- Total blocked requests platform-wide
- Most attacked domains
- Most targeted rule IDs
- Geographic distribution of attackers
- Vulnerability trend analysis

### Alerts

**Critical (Page Oncall):**
- ModSecurity service down
- Massive block rate spike (> 10x normal)
- WAF processing time > 100ms (> 10 requests)

**Warning (Email):**
- Block rate change > 50% from baseline
- New attack pattern detected
- Excluded rule expiring soon

---

## Compliance & Regulatory

### GDPR (Data Protection)
- **Audit trail** — All WAF changes logged
- **Data retention** — Configurable log retention (default: 7 days customer, 90 days admin)
- **Right to erasure** — Delete customer's WAF logs on request

### HIPAA (Healthcare)
- **Encryption in transit** — TLS for all traffic
- **Audit logging** — All actions logged; immutable logs
- **Access controls** — Role-based access; admin approval for changes

### SOX (Financial)
- **Change tracking** — All rule exclusion changes logged
- **Segregation of duties** — Customer can't disable entire WAF, only exclude rules
- **Audit trail** — Compliance reports available

---

## Operational Considerations

### Deployment Architecture

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: modsecurity-config
data:
  modsecurity.conf: |
    SecRuleEngine On
    SecRequestBodyLimit 8388608
    SecResponseBodyLimit 524288
    SecTmpDir /var/tmp/
    SecDataDir /var/lib/modsecurity/data/
    
    # Include OWASP CRS
    Include /etc/modsecurity/owasp-modsecurity-crs/crs-setup.conf
    Include /etc/modsecurity/owasp-modsecurity-crs/rules/*.conf
    
    # Include customer exclusions
    Include /etc/modsecurity/customer-exclusions.conf
```

### Rule Update Process

```
1. Download latest OWASP CRS
2. Test in staging environment for 1 week
3. Phased rollout: 10% → 50% → 100% of customers
4. Monitor for increased block rates (false positives)
5. Rollback if needed
6. Notify customers of update
```

---

## Future Enhancements

### Phase 2 (Post-MVP)

- **Custom rules** — Customers create their own WAF rules
- **IP reputation** — Auto-block known malicious IPs
- **Machine learning** — ML-based anomaly detection
- **Bot management** — Challenge suspicious bots with CAPTCHA
- **Real-time threat intel** — Integrate with threat feeds
- **Two-way sync** — Export logs to SIEM systems

### Phase 3 (Advanced)

- **API protection** — Specialized rules for JSON/GraphQL APIs
- **DDoS mitigation** — Layer 7 DDoS protection
- **Zero-trust validation** — Require client certificates
- **Encryption at rest** — Encrypted WAF log storage
- **Geo-blocking** — Block requests from specific countries

---

## Summary

The **Web Application Firewall (WAF)** specification provides:

✅ **Per-customer optional feature** — WAF disabled by default, customers opt-in  
✅ **Three operational modes** — OFF, DETECTION_ONLY (log only), ON (block)  
✅ **Granular rule exclusions** — By rule ID, tag, or regex pattern  
✅ **Industry-standard ruleset** — OWASP CRS v4.0 with monthly updates  
✅ **Zero false positives** — Extensive rule tuning and exclusion support  
✅ **Real-time monitoring** — Dashboard with attack trends and blocked requests  
✅ **Audit compliance** — All WAF actions logged, immutable audit trail  
✅ **Plan-based tiers** — WAF in Business/Premium plans  
✅ **Production-ready** — Database schema, API endpoints, implementation checklist

This feature is essential for protecting customer applications from common web attacks (SQL injection, XSS, RCE, etc.) while maintaining flexibility for tuning and exclusions.
