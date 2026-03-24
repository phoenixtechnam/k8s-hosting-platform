# Email Services Enhancements Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, platform architects, support team

---

## Overview

This document specifies enhancements to the Email Services feature, adding DKIM signing, email autodiscover, SRV records, service enable/disable, SMTP error handling, and website sendmail integration.

### Key Features

- **DKIM (DomainKeys Identified Mail)** — Enabled by default; automatic key rotation; SPF/DMARC tracking
- **DMARC policy tightening** — Platform monitors aggregate reports and recommends `p=quarantine` after 30 days at ≥ 95% pass rate; see `EMAIL_DELIVERABILITY.md` Section 6 for full workflow
- **Email Autodiscover** — Auto-configure Outlook, Apple Mail, Thunderbird, mobile clients
- **SRV Records** — Publish service discovery records for IMAP, SMTP, POP3
- **Enable/Disable Email Service** — Suspend without deletion or permanently delete with data wipe
- **SMTP Error Handling** — Reject invalid recipients during SMTP (avoid bounce messages)
- **Website Sendmail** — Website/WordPress can send emails from customer domain
- **Service Visibility** — Customers control which domains have email capability
- **Audit Logging** — Track email service changes, DKIM rotations, API access

### Use Cases

| Use Case | Example |
|----------|---------|
| **DKIM protection** | Sign outgoing emails; prevent spoofing; improve deliverability |
| **Auto email setup** | User enters email in Outlook; autodiscover configures IMAP/SMTP |
| **Client discovery** | Mobile app discovers email server via SRV records |
| **Service suspension** | Disable email without deleting customer data; restore if unpaid |
| **Email-only domain** | Some domains host email only (no web hosting) |
| **Website emails** | WordPress sends notifications from customer domain |
| **Bounce prevention** | Reject bad recipients at SMTP time (no bounce messages) |
| **Multi-domain** | customer.com has email; shop.customer.com forwards to customer |

---

## Architecture Overview

### DKIM Implementation

**DKIM Flow:**
```
1. Generate RSA key pair (2048-bit, default; 4096 available)
2. Store private key in Vault (never exposed)
3. Publish public key in DNS (selector._domainkey.domain.com)
4. Sign outgoing emails with private key
5. Rotate keys annually (old key remains valid 30+ days for in-transit emails)
```

**Key Storage:**
```
Private Key: Vault (encrypted, audit logged on access)
Public Key: DNS TXT record
Key Rotation: Automatic annually or manual
Signing: Done by Postfix/OpenDKIM
```

### Email Autodiscover

**Supported Clients:**
- Microsoft Outlook (Exchange ActiveSync)
- Apple Mail, iPhone, iPad
- Mozilla Thunderbird
- Android native mail app
- Gmail integration

**Autodiscover Methods:**

1. **SRV Records** (RFC 6186)
   ```
   _imap._tcp.domain.com    SRV  0 0 993 imap.platform.com
   _imaps._tcp.domain.com   SRV  0 0 993 imap.platform.com
   _smtp._tcp.domain.com    SRV  0 0 587 smtp.platform.com
   _smtps._tcp.domain.com   SRV  0 0 465 smtp.platform.com
   _pop3._tcp.domain.com    SRV  0 0 110 pop3.platform.com
   _pop3s._tcp.domain.com   SRV  0 0 995 pop3.platform.com
   ```

2. **Autodiscover XML** (Exchange-style)
   ```
   GET https://domain.com/.well-known/autoconfig.xml
   Returns: IMAP/SMTP server config, ports, encryption
   ```

3. **SRV Records** (Thunderbird)
   ```
   Thunderbird checks _imap._tcp, _smtp._tcp
   Automatically configures if found
   ```

### SMTP Error Handling

**Problem:** Bad recipient → bounce message generated → confuses users

**Solution:** Reject at SMTP time with 5xx code
```
RCPT TO:<nonexistent@domain.com>
550 5.7.1 User not found

(No bounce message generated; connection rejected immediately)
```

### Website Sendmail Integration

**PHP Mail Function:**
```php
mail("user@external.com", "Subject", "Body", ["From: noreply@customer.com"]);
```

**Flow:**
```
1. PHP mail() → local sendmail wrapper
2. Sendmail adds custom headers: From: noreply@customer.com
3. Route to Postfix (smarthost configuration)
4. Postfix signs with DKIM (customer domain)
5. Send via SMTP relay
```

**WordPress Integration:**
```
WordPress can use WP Mail SMTP plugin
Or: Custom sendmail configuration
From: notifications@shop.customer.com
```

---

## Database Schema

### 1. `email_service_config` — Per-customer email service settings

```sql
CREATE TABLE email_service_config (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL UNIQUE,
  
  -- Service status
  email_service_enabled BOOLEAN DEFAULT TRUE,
  -- TRUE: Email service active; mailboxes exist
  -- FALSE: Email service disabled; can delete data
  
  -- Data handling on disable
  on_disable_action ENUM('SUSPEND', 'DELETE') DEFAULT 'SUSPEND',
  -- SUSPEND: Keep data, users cannot login (can restore)
  -- DELETE: Permanently delete all mailboxes and data
  
  -- Feature toggles
  dkim_enabled BOOLEAN DEFAULT TRUE,
  autodiscover_enabled BOOLEAN DEFAULT TRUE,
  srv_records_enabled BOOLEAN DEFAULT TRUE,
  website_sendmail_enabled BOOLEAN DEFAULT TRUE,
  
  -- DKIM settings
  dkim_selector VARCHAR(255) DEFAULT 'default',
  -- e.g., "default" → default._domainkey.domain.com
  
  dkim_key_rotation_days INT DEFAULT 365,
  -- Rotate keys annually (default)
  
  dkim_signing_algorithm VARCHAR(50) DEFAULT 'rsa-sha256',
  -- RSA-SHA256 or RSA-SHA1
  
  -- Bounce handling
  bounce_handling ENUM('REJECT_AT_SMTP', 'ACCEPT_AND_BOUNCE', 'DISCARD') DEFAULT 'REJECT_AT_SMTP',
  -- REJECT_AT_SMTP: 550 error at RCPT time (no bounces)
  -- ACCEPT_AND_BOUNCE: Accept then bounce (traditional)
  -- DISCARD: Silently discard (not recommended)
  
  -- Sendmail configuration
  sendmail_allowed_domains JSON,
  -- Domains that website can send from (null = customer domains only)
  -- e.g., ["customer.com", "shop.customer.com"]
  
  sendmail_require_auth BOOLEAN DEFAULT FALSE,
  -- TRUE: Website must authenticate to send (SMTP auth)
  -- FALSE: Allow unauthenticated sendmail from web pods
  
  sendmail_rate_limit_per_hour INT DEFAULT 1000,
  -- Max emails per hour from website
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  disabled_at TIMESTAMP NULL,
  disabled_by_user_id BIGINT UNSIGNED,
  disabled_reason VARCHAR(512),
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (disabled_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_customer (customer_id),
  KEY idx_enabled (email_service_enabled)
);
```

### 2. `email_dkim_keys` — DKIM key management per domain

```sql
CREATE TABLE email_dkim_keys (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  
  selector VARCHAR(255) NOT NULL,
  -- e.g., "default", "default2" (for rotation)
  
  -- Key storage (encrypted)
  private_key_encrypted TEXT NOT NULL,
  -- Private key encrypted via Vault transit engine
  
  public_key_text TEXT NOT NULL,
  -- Public key for DNS publishing
  
  key_length INT DEFAULT 2048,
  -- 2048 or 4096 bits
  
  algorithm VARCHAR(50) DEFAULT 'rsa-sha256',
  
  -- Lifecycle
  status ENUM('ACTIVE', 'ROTATING', 'DEPRECATED', 'REVOKED') DEFAULT 'ACTIVE',
  -- ACTIVE: Use for signing
  -- ROTATING: New key, keep old for 30 days
  -- DEPRECATED: Old key, no longer signing, kept for email verification
  -- REVOKED: Compromised, not used
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMP NULL,  -- When switched to ACTIVE
  deprecated_at TIMESTAMP NULL,  -- When switched to DEPRECATED
  revoked_at TIMESTAMP NULL,  -- When switched to REVOKED
  
  expires_at TIMESTAMP NULL,
  -- Key expiration date (if set)
  
  rotation_schedule ENUM('MANUAL', 'ANNUAL', 'QUARTERLY') DEFAULT 'ANNUAL',
  next_rotation_date DATE NULL,
  
  -- Audit
  created_by_user_id BIGINT UNSIGNED,
  rotation_reason VARCHAR(255),
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  UNIQUE KEY unique_selector_per_domain (domain_id, selector),
  KEY idx_domain_status (domain_id, status),
  KEY idx_next_rotation (next_rotation_date),
  KEY idx_active (status)
);
```

### 3. `email_autodiscover_config` — Autodiscover settings per domain

```sql
CREATE TABLE email_autodiscover_config (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT UNSIGNED NOT NULL UNIQUE,
  
  -- Autodiscover methods enabled
  srv_records_enabled BOOLEAN DEFAULT TRUE,
  autodiscover_xml_enabled BOOLEAN DEFAULT TRUE,
  
  -- Custom autodiscover settings
  imap_server VARCHAR(255) DEFAULT 'imap.platform.com',
  imap_port INT DEFAULT 993,
  imap_encryption ENUM('TLS', 'SSL', 'NONE') DEFAULT 'TLS',
  
  smtp_server VARCHAR(255) DEFAULT 'smtp.platform.com',
  smtp_port INT DEFAULT 587,
  smtp_encryption ENUM('TLS', 'SSL', 'NONE') DEFAULT 'TLS',
  
  pop3_server VARCHAR(255) DEFAULT NULL,
  pop3_port INT DEFAULT 995,
  pop3_encryption ENUM('TLS', 'SSL', 'NONE') DEFAULT 'TLS',
  
  -- Optional: secondary servers
  secondary_imap_servers JSON,
  secondary_smtp_servers JSON,
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  
  KEY idx_domain (domain_id)
);
```

### 4. `email_sendmail_audit_log` — Website sendmail audit trail

```sql
CREATE TABLE email_sendmail_audit_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  customer_id BIGINT UNSIGNED NOT NULL,
  domain_id BIGINT UNSIGNED NOT NULL,
  
  sender_ip VARCHAR(45),
  -- IP of sending application (website pod)
  
  from_address VARCHAR(255),
  to_address VARCHAR(255),
  
  message_subject VARCHAR(512),
  message_id VARCHAR(255),
  
  status ENUM('ACCEPTED', 'REJECTED', 'RATE_LIMITED', 'AUTH_FAILED') NOT NULL,
  error_message VARCHAR(512),
  
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  
  KEY idx_customer_timestamp (customer_id, timestamp),
  KEY idx_status (status),
  KEY idx_from_address (from_address)
);
```

### 5. `email_service_audit_log` — Service enable/disable history

```sql
CREATE TABLE email_service_audit_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  
  customer_id BIGINT UNSIGNED NOT NULL,
  
  action ENUM('SERVICE_ENABLED', 'SERVICE_DISABLED', 'SERVICE_DELETED', 
              'DKIM_ROTATION', 'DKIM_REVOKED', 'AUTODISCOVER_ENABLED',
              'SENDMAIL_ENABLED', 'SENDMAIL_DISABLED') NOT NULL,
  
  old_value VARCHAR(1024),
  new_value VARCHAR(1024),
  
  reason VARCHAR(512),
  
  affected_accounts INT,
  -- Number of mailboxes affected by action
  
  action_by_user_id BIGINT UNSIGNED,
  action_by_ip VARCHAR(45),
  
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (action_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  
  KEY idx_customer_timestamp (customer_id, timestamp),
  KEY idx_action (action)
);
```

---

## API Endpoints

### Customer Endpoints

#### 1. Get Email Service Configuration (GET)
```
GET /api/v1/customers/{customer_id}/email/service-config
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "email_service_enabled": true,
    "dkim_enabled": true,
    "dkim_selector": "default",
    "dkim_next_rotation": "2027-03-01",
    "autodiscover_enabled": true,
    "srv_records_enabled": true,
    "website_sendmail_enabled": true,
    "sendmail_allowed_domains": ["customer.com", "shop.customer.com"],
    "bounce_handling": "REJECT_AT_SMTP",
    "domains_with_email": [
      {
        "domain": "customer.com",
        "dkim_status": "active",
        "autodiscover_status": "published"
      }
    ]
  }
}
```

#### 2. Update Email Service Configuration (PATCH)
```
PATCH /api/v1/customers/{customer_id}/email/service-config
```

**Request Body:**
```json
{
  "website_sendmail_enabled": true,
  "sendmail_allowed_domains": ["customer.com", "shop.customer.com"],
  "sendmail_rate_limit_per_hour": 500,
  "bounce_handling": "REJECT_AT_SMTP"
}
```

**Response (200 OK):** Updated configuration

#### 3. Get DKIM Keys for Domain (GET)
```
GET /api/v1/customers/{customer_id}/domains/{domain_id}/dkim-keys
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "domain": "customer.com",
    "dkim_enabled": true,
    "keys": [
      {
        "selector": "default",
        "status": "ACTIVE",
        "key_length": 2048,
        "algorithm": "rsa-sha256",
        "created_at": "2025-03-01T00:00:00Z",
        "next_rotation": "2027-03-01T00:00:00Z",
        "public_key": "v=DKIM1; k=rsa; p=MIGfMA0GCSq..."
      },
      {
        "selector": "default2",
        "status": "DEPRECATED",
        "expires_at": "2026-04-01T00:00:00Z",
        "public_key": "v=DKIM1; k=rsa; p=MIGfMA0GCSq..."
      }
    ],
    "dns_instructions": [
      {
        "selector": "default",
        "dns_record": "default._domainkey.customer.com TXT v=DKIM1; k=rsa; p=...",
        "status": "published"
      }
    ]
  }
}
```

#### 4. Rotate DKIM Key (POST)
```
POST /api/v1/customers/{customer_id}/domains/{domain_id}/dkim-rotate
```

**Request Body:**
```json
{
  "new_selector": "default2",
  "key_length": 4096,
  "reason": "Annual rotation"
}
```

**Response (202 Accepted):** Rotation job started

#### 5. Get Autodiscover Configuration (GET)
```
GET /api/v1/customers/{customer_id}/domains/{domain_id}/autodiscover
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "domain": "customer.com",
    "autodiscover_enabled": true,
    "autodiscover_url": "https://customer.com/.well-known/autoconfig.xml",
    "srv_records": [
      {"type": "_imap._tcp", "target": "imap.platform.com:993"},
      {"type": "_smtp._tcp", "target": "smtp.platform.com:587"}
    ],
    "imap_config": {
      "server": "imap.platform.com",
      "port": 993,
      "encryption": "TLS"
    },
    "smtp_config": {
      "server": "smtp.platform.com",
      "port": 587,
      "encryption": "TLS"
    }
  }
}
```

#### 6. Disable Email Service (POST)
```
POST /api/v1/customers/{customer_id}/email/disable
```

**Request Body:**
```json
{
  "reason": "Account suspension",
  "action": "SUSPEND",  // or "DELETE" for permanent deletion
  "confirmation": true  // Required if action=DELETE
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "email_service_enabled": false,
    "affected_accounts": 12,
    "action": "SUSPEND",
    "message": "Email service disabled; 12 mailboxes suspended. Can be restored.",
    "disabled_at": "2026-03-01T12:00:00Z"
  }
}
```

#### 7. Enable Email Service (POST)
```
POST /api/v1/customers/{customer_id}/email/enable
```

**Request Body:**
```json
{
  "reason": "Payment received"
}
```

**Response (200 OK):** Email service enabled

#### 8. Get Sendmail Statistics (GET)
```
GET /api/v1/customers/{customer_id}/email/sendmail-stats
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | int | Last N days (default: 7) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "period": "Last 7 days",
    "total_sent": 2450,
    "total_rejected": 15,
    "total_rate_limited": 5,
    "rate_limit_threshold": 1000,
    "rate_limit_triggered": false,
    "domains_breakdown": [
      {
        "domain": "customer.com",
        "sent": 1500,
        "rejected": 8
      },
      {
        "domain": "shop.customer.com",
        "sent": 950,
        "rejected": 7
      }
    ]
  }
}
```

---

### Admin Endpoints

#### 1. List All Email Service Configs (Admin) (GET)
```
GET /api/v1/admin/email/service-configs
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `enabled` | bool | Filter enabled/disabled |
| `plan_id` | int | Filter by plan |

**Response (200 OK):** List of all email service configurations

#### 2. Get Customer Email Config (Admin) (GET)
```
GET /api/v1/admin/customers/{customer_id}/email-config
```

**Response (200 OK):** Full email configuration with audit log

#### 3. Disable/Enable Email Service (Admin) (PATCH)
```
PATCH /api/v1/admin/customers/{customer_id}/email-service
```

**Request Body:**
```json
{
  "enabled": false,
  "reason": "Non-payment",
  "action": "SUSPEND"
}
```

**Response (200 OK):** Updated configuration

#### 4. View Sendmail Audit Log (Admin) (GET)
```
GET /api/v1/admin/customers/{customer_id}/email/sendmail-audit
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | enum | Filter: ACCEPTED, REJECTED, RATE_LIMITED |
| `days` | int | Last N days |

**Response (200 OK):** Audit log with timestamps and details

#### 5. Validate All DKIM Keys (Admin) (POST)
```
POST /api/v1/admin/email/validate-dkim-keys
```

**Request Body:**
```json
{
  "customer_id": 123,  // Optional: check specific customer
  "fix_errors": false
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "total_domains": 42,
    "valid_keys": 40,
    "invalid_keys": 2,
    "issues": [
      {
        "domain": "broken.example.com",
        "selector": "default",
        "issue": "DNS record not found",
        "suggestion": "Publish public key to DNS"
      }
    ]
  }
}
```

---

## Web UI (Customer Panel)

### 1. Email Service Dashboard

**Location:** `Control Panel → Email → Service Settings`

```
┌──────────────────────────────────────────────────────────────┐
│ Email Service Configuration                                  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Status: ✓ ACTIVE (12 mailboxes)                             │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Features:                                                   │
│ ✓ DKIM Signing         (Rotate key: 2027-03-01)            │
│ ✓ Email Autodiscover   (Enabled)                           │
│ ✓ SRV Records         (Published)                           │
│ ✓ Website Sendmail     (1,000 emails/hour)                 │
│                                                              │
│ Bounce Handling: Reject at SMTP (no bounces sent)          │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Domains with Email:                                         │
│ • customer.com         [DKIM: Active] [Autodiscover: ✓]   │
│ • shop.customer.com    [DKIM: Active] [Autodiscover: ✓]   │
│                                                              │
│ [Manage DKIM] [View Autodiscover] [Sendmail Settings]      │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│ Danger Zone:                                                │
│ [Temporarily Disable Email] [Permanently Delete Email]     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2. DKIM Management Page

```
┌──────────────────────────────────────────────────────────────┐
│ DKIM Key Management: customer.com                     [↻]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ DKIM Status: ✓ Active (signing all outgoing mail)          │
│                                                              │
│ Current Key:                                                │
│ Selector: default                                           │
│ Key Length: 2048 bits                                      │
│ Algorithm: RSA-SHA256                                       │
│ Created: 2025-03-01                                        │
│ Next Rotation: 2027-03-01 (in 730 days)                    │
│                                                              │
│ DNS Publishing Status:                                      │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ Record: default._domainkey.customer.com              │  │
│ │ Type: TXT                                            │  │
│ │ Status: ✓ Published                                  │  │
│ │ Value: v=DKIM1; k=rsa; p=MIGfMA0GCSq...            │  │
│ │ [Copy to Clipboard]                                 │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                              │
│ Rotate Key:                                                 │
│ [Rotate Now] (Creates new key; keeps old for 30 days)     │
│ (Recommended annually for security)                        │
│                                                              │
│ Key History:                                                │
│ └─ default2 (DEPRECATED, expires 2026-04-01)              │
│    [Revoke] [View Key]                                     │
│                                                              │
│ [Verify DNS] [Download Public Key]                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3. Website Sendmail Settings

```
┌──────────────────────────────────────────────────────────────┐
│ Website Sendmail Configuration                       [Info] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ ☑ Allow website to send emails from your domain            │
│                                                              │
│ Allowed Sender Domains:                                     │
│ ☑ customer.com                                             │
│ ☑ shop.customer.com                                        │
│ ☐ Other domain... [Add Domain]                             │
│                                                              │
│ (ℹ️ Website can send emails using PHP mail() or SMTP)     │
│                                                              │
│ Rate Limiting:                                              │
│ [1000] emails per hour (recommended limit)                 │
│ [Disable Rate Limit]  (⚠️ May cause deliverability issues) │
│                                                              │
│ Authentication:                                             │
│ ☐ Require SMTP authentication (web must log in)           │
│    (Recommended: Only if using external SMTP relay)       │
│                                                              │
│ Bounce Handling:                                            │
│ ◉ Reject invalid recipients at SMTP time (no bounces)     │
│ ○ Accept and send bounces back to sender                  │
│ ○ Silently discard invalid recipients                     │
│                                                              │
│ Statistics (Last 7 days):                                   │
│ Emails Sent: 2,450                                         │
│ Rejected: 15                                               │
│ Rate Limited: 0                                            │
│                                                              │
│ [View Detailed Logs] [Save Settings]                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Security Considerations

### 1. DKIM Key Security

**Problem:** Private key compromise = spoofing emails

**Solutions:**
- **Vault encryption** — Private key encrypted at-rest
- **Access audit** — Log all key access
- **Rotation** — Annual rotation recommended
- **Deprecation period** — Keep old keys 30+ days
- **Revocation** — Immediately revoke compromised keys

### 2. Website Sendmail Security

**Problem:** Website malware sends spam from customer domain

**Solutions:**
- **Rate limiting** — Max emails/hour per domain
- **IP whitelisting** — Only pods can send
- **SMTP authentication** — Require login for external SMTP
- **Audit logging** — All sendmail tracked
- **Bounce rejection** — No accepting non-existent users

### 3. Service Suspension

**Problem:** Customer owes money; need to suspend email

**Solutions:**
- **Soft suspend** — Keep data; users cannot login
- **Hard delete** — Permanently delete all mailboxes
- **Audit trail** — Log who disabled and why

### 4. Autodiscover Security

**Problem:** Attacker registers malicious autodiscover domain

**Solutions:**
- **HTTPS only** — Autodiscover.xml over HTTPS
- **SRV records** — DNS-based discovery (harder to spoof)
- **Validation** — Verify domain ownership before publishing

---

## Implementation Checklist

### Phase 1: DKIM (Weeks 1-2)

- [ ] Key generation (RSA 2048/4096)
- [ ] Vault integration (encrypt/decrypt)
- [ ] Postfix/OpenDKIM configuration
- [ ] Database schema
- [ ] DNS publishing (automated or manual)
- [ ] Key rotation scheduling
- [ ] API endpoints (get keys, rotate, revoke)

### Phase 2: Email Autodiscover & SRV Records (Weeks 3-4)

- [ ] SRV record generation
- [ ] Autodiscover XML endpoint
- [ ] DNS publishing (SRV records)
- [ ] Client testing (Outlook, Thunderbird, iOS)
- [ ] API endpoints (get config, update servers)

### Phase 3: Service Enable/Disable (Weeks 5-6)

- [ ] Disable logic (soft suspend)
- [ ] Delete logic (hard delete)
- [ ] Data backup before deletion
- [ ] Audit logging
- [ ] API endpoints (enable/disable)
- [ ] UI confirmation dialogs

### Phase 4: SMTP Error Handling (Weeks 7-8)

- [ ] Dovecot/Postfix configuration
- [ ] Recipient validation before RCPT TO
- [ ] 550 rejection codes
- [ ] Testing (verify no bounces)

### Phase 5: Website Sendmail (Weeks 9-10)

- [ ] Sendmail wrapper (custom script)
- [ ] SMTP smarthost routing
- [ ] Rate limiting implementation
- [ ] Audit logging
- [ ] WordPress/WP Mail SMTP integration
- [ ] Testing (PHP mail(), WordPress)

### Phase 6: Testing & Documentation (Weeks 11-12)

- [ ] Integration tests (DKIM signing)
- [ ] Autodiscover tests (Outlook, mobile)
- [ ] Service suspend/enable tests
- [ ] Website sendmail tests
- [ ] Documentation (customer guide, admin guide)

---

## Compliance & Regulatory

### GDPR (Data Protection)
- Audit logs for email service changes
- Ability to delete all email data (right to erasure)
- Data export before deletion

### HIPAA (Healthcare)
- DKIM signing ensures email integrity
- Audit trail of service changes
- Encrypted key storage

### SOX (Financial)
- Email retention policies
- Change tracking (enable/disable)
- Sendmail audit logging

---

## Summary

The **Email Services Enhancements** specification provides:

✅ **DKIM signing** — Automatic keys, rotation, SPF/DMARC  
✅ **Email autodiscover** — SRV records + XML endpoint  
✅ **Service control** — Enable/disable with data preservation or deletion  
✅ **SMTP error handling** — Reject invalid recipients (no bounces)  
✅ **Website sendmail** — PHP mail() from customer domain  
✅ **Audit logging** — All service changes tracked  
✅ **Security-first** — Vault encryption, rate limiting, validation  
✅ **Production-ready** — Database schema, API endpoints, implementation checklist

These enhancements are essential for modern email hosting with professional deliverability, client auto-configuration, and service management capabilities.
