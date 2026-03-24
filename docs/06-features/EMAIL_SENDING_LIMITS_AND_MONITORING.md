# Email Sending Limits & Delivery Monitoring

## Overview

The platform prevents mass-email spam and abuse through **defense-in-depth rate limiting** combined with comprehensive delivery monitoring. Customers can track individual email delivery status, while admins monitor system-wide queue health and IP/domain reputation.

**Key Design:**
- ✅ Application-level quota tracking (warns customers before limits)
- ✅ Postfix-level hard limits (rejects/defers emails when limits exceeded)
- ✅ Message-level tracking (customers see individual email status)
- ✅ Reputation monitoring (admins track IP blacklists, DKIM/SPF/DMARC failures)
- ✅ Real-time alerts (both customer and admin notifications)
- ✅ Plan-based limits (Starter/Business/Premium have different quotas)

---

## Email Sending Limits

### Plan-Based Hourly & Daily Limits

Each plan has configurable hourly and daily email sending limits to prevent abuse while allowing legitimate bulk sending (newsletters, transactional emails).

| Limit Type | Starter | Business | Premium |
|-----------|---------|----------|---------|
| **Hourly limit** | 50 emails/hour | 500 emails/hour | 2,000 emails/hour |
| **Daily limit** | 200 emails/day | 5,000 emails/day | 50,000 emails/day |
| **Max recipients per email** | 10 | 100 | 500 |
| **Attachment size limit** | 10 MB | 25 MB | 50 MB |
| **Accounts per limit** | 1 limit for whole customer | 1 limit for whole customer | 1 limit for whole customer |

**Note:** Limits apply per **customer** (all email accounts combined), not per individual email account. This prevents one account from bypassing limits via multi-account circumvention.

### Limit Enforcement: Defense-in-Depth

#### Layer 1: Application-Level Quota Tracking (Pre-Send Warning)

**Purpose:** Track email submissions and warn customers *before* they hit hard limits.

**When a customer sends an email via SMTP/API:**

1. **Email submission** → Postfix receives SMTP request
2. **API middleware intercepts** → Management API sidecar/middleware checks quota
3. **Quota check:**
   - Query `email_sending_quota` table for customer
   - Get hourly sent count (last 60 minutes)
   - Get daily sent count (last 24 hours)
4. **Decision:**
   - If < 80% of hourly limit: ✅ ACCEPT (log to quota table)
   - If 80-99% of hourly limit: ⚠️ WARN (accept but trigger warning notification)
   - If >= 100% of hourly limit: ❌ REJECT with 452 error (temporary failure)
   - If >= 100% of daily limit: ❌ REJECT with 452 error (temporary failure)
5. **Response to SMTP client:** `452 4.2.1 Quota exceeded, try again in 1 hour` (or similar)

**Database table: `email_sending_quota`**

```sql
CREATE TABLE email_sending_quota (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT NOT NULL,           -- FK: customers.id
  
  -- Rolling hour (UTC)
  hour_start TIMESTAMP NOT NULL,         -- Start of rolling hour (e.g., 2026-03-01 12:00:00)
  emails_sent_this_hour INT DEFAULT 0,  -- Count of emails sent in this hour
  
  -- Rolling day (UTC)
  day_start TIMESTAMP NOT NULL,          -- Start of rolling day (e.g., 2026-03-01 00:00:00)
  emails_sent_today INT DEFAULT 0,       -- Count of emails sent today
  
  -- Current limits (from plan)
  hourly_limit INT NOT NULL,
  daily_limit INT NOT NULL,
  
  -- Warnings & alerts
  hour_warning_triggered BOOLEAN DEFAULT FALSE,
  day_warning_triggered BOOLEAN DEFAULT FALSE,
  hour_limit_reached_at TIMESTAMP NULL,  -- When did customer hit hourly limit?
  day_limit_reached_at TIMESTAMP NULL,   -- When did customer hit daily limit?
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_customer_id (customer_id),
  INDEX idx_hour_start (hour_start),
  INDEX idx_day_start (day_start),
  UNIQUE KEY uk_customer_hour (customer_id, hour_start),
  UNIQUE KEY uk_customer_day (customer_id, day_start)
);
```

#### Layer 2: Postfix Hard Limit Enforcement

**Purpose:** Prevent any emails from being submitted if limits are already exceeded. This is a hard block at the MTA level.

**Configuration in Postfix (`/etc/postfix/main.cf`):**

```bash
# Rate limiting per customer (tracked by authentication user domain)
# Limit emails per customer using policy daemon or milter

# Option 1: Policy daemon (recommended for k8s)
smtpd_client_restrictions =
  permit_mynetworks,
  permit_sasl_authenticated,
  check_policy_service inet:127.0.0.1:10033,  # Local policy daemon
  reject_unauth_destination

# Option 2: Postfix built-in rate limiting (simpler but less granular)
# Note: Postfix's built-in rate limits are by IP/domain, not customer
# For per-customer limits, use a policy daemon

# Queue limits (prevent stuck emails)
maximal_queue_lifetime = 5d
bounce_queue_lifetime = 1d
defer_transports = smtp
transport_maps = hash:/etc/postfix/transport
```

**Custom Policy Daemon (Python/Node.js):**

The policy daemon runs as a sidecar in the mail pod and evaluates each email submission:

```python
# Pseudocode: policy daemon
while True:
    # Receive SMTP policy request from Postfix
    request = receive_policy_request()  # From Postfix policy socket
    
    # Extract customer/sender info
    sender = request['sender']  # e.g., user@customer-domain.com
    recipient = request['recipient']
    client_address = request['client_address']
    
    # Identify customer from sender domain
    customer = get_customer_by_domain(sender)
    
    # Check quota from database
    quota = get_quota(customer.id)
    
    # Decision
    if quota.emails_sent_this_hour >= quota.hourly_limit:
        respond("DEFER_IF_PERMIT Hourly limit reached")
    elif quota.emails_sent_today >= quota.daily_limit:
        respond("DEFER_IF_PERMIT Daily limit reached")
    else:
        # Increment counter (atomic transaction)
        increment_quota(customer.id, 1)
        respond("DUNNO")  # Allow Postfix to continue
```

**Kubernetes sidecar deployment:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: docker-mailserver
  namespace: mail
spec:
  containers:
  - name: postfix
    image: docker.io/mailserver/docker-mailserver:latest
    ports:
    - name: smtp
      containerPort: 25
  
  - name: policy-daemon
    image: custom-registry/policy-daemon:latest
    ports:
    - name: policy
      containerPort: 10033
    env:
    - name: MYSQL_HOST
      value: mysql.default.svc.cluster.local
    - name: MYSQL_USER
      valueFrom:
        secretKeyRef:
          name: mail-db-creds
          key: username
```

#### Handling Quota Resets

**Hourly reset:** Each quota entry created at UTC hour boundary. When checking quota:
- If `hour_start` is older than 1 hour, create new entry for current hour
- Old entries automatically pruned after 24 hours (cron job)

**Daily reset:** Each quota entry created at UTC day boundary (00:00 UTC). Similar pruning logic.

---

## Customer-Facing Email Monitoring

### Email Status Tracking Database

Track every email sent by customers for status visibility and bounce/failure analysis.

**Table: `email_messages`**

```sql
CREATE TABLE email_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- Identification
  message_id VARCHAR(255) UNIQUE NOT NULL,  -- Postfix queue ID (e.g., 3FC44234D123)
  customer_id BIGINT NOT NULL,
  sender_account VARCHAR(255) NOT NULL,     -- Email address that sent it
  recipient_address VARCHAR(255) NOT NULL,  -- To: address
  
  -- Content
  subject VARCHAR(500),                      -- Email subject (first 500 chars)
  size_bytes INT,                           -- Email size
  
  -- Status tracking
  status ENUM('queued', 'sending', 'sent', 'bounced', 'failed', 'spam', 'rejected') DEFAULT 'queued',
  submission_timestamp TIMESTAMP NOT NULL,   -- When customer sent it
  delivery_timestamp TIMESTAMP NULL,         -- When actually delivered
  bounce_timestamp TIMESTAMP NULL,           -- When bounce received
  
  -- Delivery details
  smtp_response_code INT,                   -- SMTP code (250, 451, 552, etc.)
  smtp_response_message TEXT,               -- Full SMTP response
  bounce_reason ENUM('hard_bounce', 'soft_bounce', 'complaint', 'unknown') NULL,
  bounce_details TEXT,                      -- DSN (Delivery Status Notification) details
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_customer_id (customer_id),
  INDEX idx_sender_account (sender_account),
  INDEX idx_recipient_address (recipient_address),
  INDEX idx_status (status),
  INDEX idx_submission_timestamp (submission_timestamp),
  UNIQUE KEY uk_message_id (message_id)
);
```

### Client Panel: Email Statistics Dashboard

**Location:** Client Panel > Email > Sending Statistics

#### Summary Widget

Display quick stats:

```
📊 Email Sending Statistics

Today's Activity:
├─ Sent: 245 emails (12% of daily limit)
├─ Bounced: 3 (1.2% bounce rate)
├─ Failed: 1 (delivery error)
└─ Pending: 5 (in queue)

This Hour:
├─ Sent: 35 emails (70% of hourly limit)
└─ Time until reset: 28 minutes

⚠️ Warnings:
└─ No warnings — you're good!
```

#### Detailed Sending View

**Tabs:**

1. **All Messages** (searchable/filterable list)
   - Columns: Date, Time, Recipient, Subject, Status, Action
   - Status badges: ✅ Sent, ⏳ Pending, ⚠️ Bounced, ❌ Failed, 🚫 Rejected
   - Quick filters: Last 24 hours, Last 7 days, This month
   - Search by recipient email or subject
   - Show details button (opens delivery log)

2. **Bounced Messages**
   - List only bounced emails
   - Bounce reason: "Invalid recipient", "Mailbox full", "Service unavailable", etc.
   - Retry button (for soft bounces)
   - Download bounced list as CSV

3. **Failed Messages**
   - List only permanently failed (rejected by recipient's mail server)
   - Reason: "Recipient refused", "Domain not found", "Policy rejection", etc.
   - Manual action options: Contact recipient, use different address

4. **Sending Limits**
   - Current hour: 35/500 emails sent (70%)
   - Current day: 245/5000 emails sent (12%)
   - Progress bars with color coding (green <50%, yellow 50-80%, red >80%)
   - Estimated reset times
   - Download limit history (CSV)

#### Message Details Popup

Click on a message to see:

```
To: john@example.com
Subject: Newsletter - March 1, 2026

Sent: 2026-03-01 14:32:05 UTC
Status: ✅ Delivered

Delivery Timeline:
├─ 14:32:05 Submitted to mail server
├─ 14:32:07 Processing (checking recipient)
├─ 14:32:12 Connecting to recipient mail server
├─ 14:32:15 SMTP: 220 mail.example.com ESMTP
├─ 14:32:18 Recipient accepted (250 OK)
└─ 14:32:20 Delivery confirmed

Size: 45 KB
Message ID: 3FC44234D123
```

#### Bounce Analysis & Recommendations

For bounced/failed messages, show:

```
❌ Bounce Detected

Reason: Mailbox full (hard bounce)
Recipient: john@example.com

Recommendation:
└─ This mailbox is full. The recipient needs to clean up 
   their inbox. Try again in a few hours, or contact them directly.

Related Messages:
└─ 2 other bounces to this recipient in the last 7 days
```

### API Endpoints for Email Status

**GET `/api/v1/customers/{customer_id}/email-messages`**

List sent emails with filtering.

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/email-messages?status=bounced&days=7&limit=50" \
  -H "Authorization: Bearer {token}"
```

**Response:**

```json
{
  "data": [
    {
      "id": "msg_123456",
      "message_id": "3FC44234D123",
      "sender_account": "newsletter@customer.com",
      "recipient_address": "john@example.com",
      "subject": "Weekly Newsletter",
      "status": "bounced",
      "submission_timestamp": "2026-03-01T14:32:05Z",
      "bounce_timestamp": "2026-03-01T14:32:30Z",
      "bounce_reason": "hard_bounce",
      "bounce_details": "550 5.1.1 The email account that you tried to reach does not exist",
      "smtp_response_code": 550,
      "size_bytes": 45000
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 123,
    "pages": 3
  }
}
```

**GET `/api/v1/customers/{customer_id}/email-sending-stats`**

Get current quota and statistics.

```bash
curl -X GET "https://api.platform.example.com/v1/customers/123/email-sending-stats" \
  -H "Authorization: Bearer {token}"
```

**Response:**

```json
{
  "data": {
    "hourly_limit": 500,
    "daily_limit": 5000,
    "emails_sent_this_hour": 35,
    "emails_sent_today": 245,
    "hour_reset_at": "2026-03-01T16:00:00Z",
    "day_reset_at": "2026-03-02T00:00:00Z",
    "bounce_rate_today": 0.012,
    "fail_rate_today": 0.004,
    "queue_size": 5,
    "avg_delivery_time_seconds": 12.5,
    "warnings": []
  }
}
```

---

## System-Wide Admin Monitoring

### Admin Dashboard: Email Health

**Location:** Admin Panel > Email > System Health

#### Postfix Queue Health

Real-time visualization of mail queue:

```
📬 Postfix Queue Status

Queue Size: 1,247 messages (⚠️ ELEVATED)
├─ Active (being delivered): 42
├─ Deferred (retry later): 1,005
├─ Hold (manual review): 200
└─ Corrupt: 0

Delivery Stats (Last 24h):
├─ Successfully delivered: 145,323 (99.1%)
├─ Bounced: 987 (0.67%)
├─ Failed: 352 (0.24%)
└─ Avg delivery time: 2.3 seconds

Queue Alerts:
├─ ⚠️ Queue size > 1000: Consider investigating
├─ ⚠️ Deferred count high: Check recipient mail servers
└─ ⚠️ Bounce rate > 1%: Possible configuration issue
```

**Metrics exported to Prometheus:**

```
postfix_queue_size_total{status="active"} 42
postfix_queue_size_total{status="deferred"} 1005
postfix_queue_size_total{status="hold"} 200
postfix_queue_size_total{status="corrupt"} 0
postfix_queue_delivery_success_rate 0.991
postfix_queue_bounce_rate 0.0067
postfix_queue_fail_rate 0.0024
postfix_queue_avg_delivery_time_seconds 2.3
postfix_queue_held_message_oldest_seconds 3600
```

#### Per-Customer Email Activity

View sending patterns by customer:

| Customer | Sent Today | Bounce Rate | Bounce Count | At Limit? | Action |
|----------|-----------|------------|--------------|----------|--------|
| Acme Corp | 5,234 | 0.3% | 16 | ❌ No (10.4%) | View |
| TechStart | 45,000 | 2.1% | 945 | ⚠️ Yes (100%)! | Investigate |
| SmallBiz | 180 | 0.0% | 0 | ❌ No (36%) | View |
| DataFlow | 15,600 | 5.2% | 812 | ❌ No (312% → **OVER LIMIT**) | Alert |

**Filter options:**
- Sort by: Sent count, bounce rate, time at limit
- Filter by: Plan (Starter/Business/Premium), location, suspension status
- Date range: Last 24h, 7d, 30d

**Action buttons:**
- View queue (see pending emails for this customer)
- View sending history (open email messages table)
- Review bounce patterns (detailed analysis)
- Temporarily disable sending (emergency brake for spammy accounts)

### IP/Domain Reputation Tracking

#### Blacklist Detection

Monitor if our outbound email IPs are listed on DNSBL (DNS-based Blacklist) services:

**Table: `email_blacklist_checks`**

```sql
CREATE TABLE email_blacklist_checks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  server_name VARCHAR(255) NOT NULL,        -- e.g., "mail.platform.example.com"
  outbound_ip VARCHAR(45) NOT NULL,         -- IPv4 or IPv6 address
  
  -- Blacklist services checked
  blacklist_service VARCHAR(255) NOT NULL,  -- e.g., "spamhaus.org", "barracuda.com"
  last_check TIMESTAMP NOT NULL,
  
  -- Status
  is_listed BOOLEAN DEFAULT FALSE,
  listing_reason VARCHAR(255),              -- e.g., "Suspected spam source"
  list_url VARCHAR(512),                    -- URL to view listing details
  
  -- Response data
  return_code VARCHAR(50),                  -- DNSBL return code (e.g., "127.0.0.2")
  first_listed_at TIMESTAMP,                -- When first detected on this list
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_outbound_ip (outbound_ip),
  INDEX idx_is_listed (is_listed),
  INDEX idx_last_check (last_check)
);
```

**Blacklist services to check:**
- Spamhaus (ZEN)
- Barracuda Reputation Block List (BRBL)
- Sorbs (IP Reputation)
- Invaluement/UCEPROTECT

**Automated checks (hourly):**

```python
# Hourly cron job
for blacklist_service in BLACKLIST_SERVICES:
    for server_ip in OUTBOUND_IPS:
        result = check_blacklist(server_ip, blacklist_service)
        
        if result.is_listed:
            # Create/update record
            update_blacklist_check(server_ip, blacklist_service, is_listed=True)
            
            # Alert admin
            trigger_alert({
                'type': 'email_ip_blacklisted',
                'ip': server_ip,
                'service': blacklist_service,
                'reason': result.reason,
                'severity': 'critical'
            })
        else:
            update_blacklist_check(server_ip, blacklist_service, is_listed=False)
```

**Admin notification:**

```
🚨 CRITICAL: Outbound Email IP Blacklisted

Server: mail.platform.example.com
IP: 203.0.113.45
Blacklist: Spamhaus ZEN
Reason: "Suspected spam source"

Impact:
└─ Emails from this server may be rejected by recipients
└─ Affects ALL customers using this mail server

Action Required:
1. Review recent email from affected customers
2. Check for compromised accounts sending spam
3. Contact blacklist service for delisting
4. Implement stronger outbound filters

Delisting URL: https://www.spamhaus.org/query/ip/203.0.113.45
```

#### Feedback Loop (FBL) Complaint Monitoring

In addition to DNSBL checks, the platform receives real-time spam complaint notifications from mailbox providers via registered Feedback Loop (FBL) programs.

| Provider | FBL Program | Complaint format |
|----------|-------------|-----------------|
| Microsoft (Outlook/Hotmail/Live) | JMRP / SNDS | ARF |
| Yahoo / AOL | Yahoo CFL | ARF |

Complaints are parsed and stored in `email_fbl_complaints` (see `EMAIL_DELIVERABILITY.md` Section 9). Rolling 7-day and 30-day complaint rates are tracked per domain in `email_reputation`.

**Automatic enforcement thresholds:**

| Complaint rate (7-day) | Action |
|-----------------------|--------|
| > 0.1% | Throttle: reduce customer hourly sending limit by 50% |
| > 0.3% | Suspend outbound mail for domain — admin review required |

FBL complaint rate is displayed in the Admin Panel alongside DNSBL status. See `EMAIL_DELIVERABILITY.md` Sections 9–10 for full FBL registration, ingestion workflow, database schema, and Prometheus alert rules (`CustomerFBLThreshold`, `CustomerFBLSuspend`).

#### DKIM/SPF/DMARC Validation Tracking

Track authentication failures for customer sending domains:

**Table: `email_auth_failures`**

```sql
CREATE TABLE email_auth_failures (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  customer_id BIGINT NOT NULL,
  customer_domain VARCHAR(255) NOT NULL,    -- e.g., "example.com"
  
  -- Auth type
  auth_type ENUM('spf', 'dkim', 'dmarc') NOT NULL,
  
  -- Failure details
  failure_count INT DEFAULT 1,              -- Number of failures in this period
  last_failure_timestamp TIMESTAMP,
  failure_reason TEXT,                      -- Why it failed (e.g., "SPF none")
  
  -- Period
  period_start TIMESTAMP,                   -- Hourly bucket
  period_end TIMESTAMP,
  
  -- Recommendation
  status ENUM('ok', 'warning', 'critical') DEFAULT 'warning',
  recommendation TEXT,                      -- Admin/customer guidance
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_customer_id (customer_id),
  INDEX idx_customer_domain (customer_domain),
  INDEX idx_auth_type (auth_type),
  INDEX idx_last_failure_timestamp (last_failure_timestamp)
);
```

**Admin view: DKIM/SPF/DMARC Status**

For each customer domain:

```
example.com

✅ SPF: PASS
   Record: v=spf1 include:platform.example.com ~all
   Validated: 2 days ago

⚠️ DKIM: WARNING
   Selector: default
   Status: Key exists but not validated
   Recommendation: Add DKIM TXT record to DNS:
   
   default._domainkey.example.com TXT "v=DKIM1; k=rsa; p=MIGf..."

⚠️ DMARC: MISSING
   Recommendation: Add DMARC policy:
   
   _dmarc.example.com TXT "v=DMARC1; p=quarantine; rua=mailto:admin@example.com"
   
   Without DMARC:
   └─ Your emails may be marked as spam
   └─ No insight into spoofing attempts
```

**Alerts triggered if:**
- SPF check fails for customer domain
- DKIM signature invalid (key expired, key mismatch)
- DMARC policy not set (or too permissive: `p=none`)
- Customer hitting bounce/complaint thresholds

---

## Email Delivery Event Notifications

### Events Triggered by System

The platform generates events that trigger notifications to both customers and admins:

| Event | Trigger | Customer Notification | Admin Notification |
|-------|---------|----------------------|-------------------|
| `email.hourly_limit_warning` | Customer at 80% of hourly limit | ⚠️ "You've sent 400/500 emails this hour" | - |
| `email.hourly_limit_reached` | Customer hits hourly limit | ❌ "Hourly limit reached; try again in X min" | ⚠️ "Customer at hourly limit" |
| `email.daily_limit_warning` | Customer at 80% of daily limit | ⚠️ "You've sent 4000/5000 emails today" | - |
| `email.daily_limit_reached` | Customer hits daily limit | ❌ "Daily limit reached; reset at midnight" | ⚠️ "Customer at daily limit" |
| `email.bounce_rate_high` | Bounce rate > 5% | 📊 "High bounce rate detected" | 🚨 "Customer bounce rate > 5%" |
| `email.queue_stalled` | Queue size > threshold OR messages stuck > 1h | - | 🚨 "Mail queue stalled; investigate" |
| `email.ip_blacklisted` | Outbound IP listed on DNSBL | - | 🚨 "CRITICAL: Server IP blacklisted" |
| `email.dkim_invalid` | DKIM signature fails validation | ⚠️ "Email authentication failing" | ⚠️ "Customer domain DKIM invalid" |
| `email.spf_misconfigured` | SPF check fails | ⚠️ "SPF configuration issue" | ⚠️ "Customer domain SPF failing" |
| `email.spam_complaint` | ISP reports complaint about customer | - | 🚨 "Spam complaint: customer" |

### Example: Bounce Rate High Alert

When a customer's bounce rate exceeds 5% in a 24-hour period:

**To Customer (email):**

```
Subject: ⚠️ High Email Bounce Rate Detected

Hi,

Your emails are being bounced at an unusually high rate:

Current bounce rate: 5.2% (52 of 1000 emails)
Bounced addresses: view details

Common reasons:
• Sending to old or invalid email lists
• Recipients' mailboxes are full
• Domain/authentication configuration issues

What to do:
1. Review your bounced recipients (see dashboard)
2. Remove invalid addresses from your lists
3. Check your SPF/DKIM configuration
4. Contact support if you need help

[View Details] [Contact Support]
```

**To Admin (dashboard alert):**

```
🚨 HIGH BOUNCE RATE

Customer: TechStart Inc.
Bounce rate: 5.2%
Bounced count: 52 emails
Period: Last 24 hours
Impact: Potential spam complaints; IP reputation risk

Top bounced addresses:
• old-list@example.com (28 bounces)
• invalid@test.xyz (12 bounces)
• mailbox-full@company.com (8 bounces)

Actions:
• Contact customer about bounce issue
• Monitor for further escalation (>10%)
• Review for potential spam sending patterns
```

---

## Postfix Configuration for Rate Limiting

### Complete Postfix Configuration

**File: `/etc/postfix/main.cf`** (key sections):

```bash
# ============================================
# GENERAL CONFIGURATION
# ============================================

myhostname = mail.platform.example.com
mydomain = platform.example.com
mynetworks = 127.0.0.0/8, [::1]/128, 10.0.0.0/8
mydestination = $myhostname, $mydomain

# ============================================
# SECURITY & POLICY
# ============================================

# Use policy daemon for rate limiting
smtpd_client_restrictions =
  permit_mynetworks,
  permit_sasl_authenticated,
  check_policy_service inet:127.0.0.1:10033,
  reject_unauth_destination

smtpd_relay_restrictions =
  permit_mynetworks,
  permit_sasl_authenticated,
  reject_unauth_destination

# ============================================
# QUEUE & DELIVERY LIMITS
# ============================================

# How long to keep messages in queue
maximal_queue_lifetime = 5d
bounce_queue_lifetime = 1d
defer_transports = smtp

# Limit concurrent SMTP connections (prevent resource exhaustion)
smtpd_client_connection_limit = 100
smtpd_client_connection_rate_limit = 20

# Limit recipients per message (prevent BCC abuse)
smtpd_recipient_limit = 500

# ============================================
# RATE LIMITING (Local)
# ============================================

# Policy daemon configuration
policy_time_limit = 3600s

# Delay if queue too large (backpressure)
in_flow_delay = 1s

# ============================================
# LOGGING & MONITORING
# ============================================

maillog_file = /var/log/postfix.log
loglevel = 1  # Verbose logging
log_address_format = ipv6

# Send logs to syslog (for Loki/ELK aggregation)
syslog_facility = mail
```

### Policy Daemon (Python Implementation)

**File: `/app/policy_daemon.py`**

```python
#!/usr/bin/env python3
"""
Postfix policy daemon for customer email rate limiting.
Listens on localhost:10033 for policy requests from Postfix.
"""

import asyncio
import logging
import socket
import time
from typing import Dict, Optional
import pymysql
from dotenv import load_dotenv
import os

load_dotenv()

logger = logging.getLogger(__name__)

class QuotaDaemon:
    """Rate limiting policy daemon for Postfix."""
    
    def __init__(self, host='127.0.0.1', port=10033):
        self.host = host
        self.port = port
        self.db_config = {
            'host': os.getenv('MYSQL_HOST', 'localhost'),
            'user': os.getenv('MYSQL_USER'),
            'password': os.getenv('MYSQL_PASSWORD'),
            'database': os.getenv('MYSQL_DATABASE', 'platform'),
        }
    
    async def handle_client(self, reader, writer):
        """Handle one Postfix policy request."""
        try:
            # Read request until blank line
            request = {}
            while True:
                line = await reader.readline()
                line = line.decode('utf-8').strip()
                if not line:
                    break
                key, value = line.split('=', 1)
                request[key] = value
            
            # Extract key fields
            sender = request.get('sender', '')
            client_address = request.get('client_address', '')
            
            # Identify customer from sender domain
            customer = await self.get_customer_by_sender(sender)
            
            if not customer:
                # Sender not recognized; reject
                self.send_response(writer, 'REJECT')
                return
            
            # Check quota
            quota = await self.get_quota(customer['id'])
            decision = await self.check_quota(customer['id'], quota)
            
            if decision == 'ACCEPT':
                # Log email for quota tracking
                await self.log_email_sent(customer['id'], sender, request.get('recipient', ''))
                self.send_response(writer, 'DUNNO')
            elif decision == 'WARN':
                # Accept but log warning
                await self.log_email_sent(customer['id'], sender, request.get('recipient', ''))
                await self.trigger_warning(customer['id'], 'hourly_warning')
                self.send_response(writer, 'DUNNO')
            else:
                # Reject
                self.send_response(writer, 'DEFER_IF_PERMIT Email limit reached')
            
            writer.close()
        
        except Exception as e:
            logger.error(f"Error handling request: {e}")
            self.send_response(writer, 'DEFER_IF_PERMIT Service error')
            writer.close()
    
    async def get_customer_by_sender(self, sender: str) -> Optional[Dict]:
        """Get customer ID from sender email address."""
        if not sender or '@' not in sender:
            return None
        
        domain = sender.split('@')[1]
        
        # Query database for customer with this domain
        conn = pymysql.connect(**self.db_config)
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT c.id FROM customers c
                    JOIN domains d ON d.customer_id = c.id
                    WHERE d.name = %s AND d.status = 'active'
                    LIMIT 1
                """, (domain,))
                result = cursor.fetchone()
                return {'id': result[0]} if result else None
        finally:
            conn.close()
    
    async def get_quota(self, customer_id: int) -> Dict:
        """Get current quota for customer."""
        conn = pymysql.connect(**self.db_config)
        try:
            with conn.cursor() as cursor:
                # Get customer's plan limits
                cursor.execute("""
                    SELECT
                        c.plan,
                        COALESCE(hp.email_hourly_limit, 50) as hourly_limit,
                        COALESCE(hp.email_daily_limit, 200) as daily_limit
                    FROM customers c
                    LEFT JOIN hosting_plans hp ON hp.name = c.plan
                    WHERE c.id = %s
                """, (customer_id,))
                
                plan_result = cursor.fetchone()
                if not plan_result:
                    return {'hourly_limit': 50, 'daily_limit': 200, 'sent_this_hour': 0, 'sent_today': 0}
                
                plan, hourly_limit, daily_limit = plan_result
                
                # Get sent counts
                now = time.time()
                hour_ago = now - 3600
                day_ago = now - 86400
                
                cursor.execute("""
                    SELECT
                        SUM(CASE WHEN submission_timestamp > FROM_UNIXTIME(%s) THEN 1 ELSE 0 END) as sent_this_hour,
                        SUM(CASE WHEN submission_timestamp > FROM_UNIXTIME(%s) THEN 1 ELSE 0 END) as sent_today
                    FROM email_messages
                    WHERE customer_id = %s AND status != 'rejected'
                """, (hour_ago, day_ago, customer_id))
                
                sent_result = cursor.fetchone()
                sent_this_hour = sent_result[0] or 0
                sent_today = sent_result[1] or 0
                
                return {
                    'hourly_limit': hourly_limit,
                    'daily_limit': daily_limit,
                    'sent_this_hour': sent_this_hour,
                    'sent_today': sent_today,
                }
        finally:
            conn.close()
    
    async def check_quota(self, customer_id: int, quota: Dict) -> str:
        """
        Determine if email should be accepted, warned, or rejected.
        
        Returns: 'ACCEPT', 'WARN', or 'REJECT'
        """
        sent_hour = quota['sent_this_hour']
        sent_day = quota['sent_today']
        hourly_limit = quota['hourly_limit']
        daily_limit = quota['daily_limit']
        
        # Check limits
        if sent_hour >= hourly_limit or sent_day >= daily_limit:
            return 'REJECT'
        
        # Warn if approaching limit
        if sent_hour >= int(hourly_limit * 0.8) or sent_day >= int(daily_limit * 0.8):
            return 'WARN'
        
        return 'ACCEPT'
    
    async def log_email_sent(self, customer_id: int, sender: str, recipient: str):
        """Log email submission to tracking table."""
        conn = pymysql.connect(**self.db_config)
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO email_messages
                    (customer_id, sender_account, recipient_address, status, submission_timestamp)
                    VALUES (%s, %s, %s, 'queued', NOW())
                """, (customer_id, sender, recipient))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to log email: {e}")
        finally:
            conn.close()
    
    async def trigger_warning(self, customer_id: int, event_type: str):
        """Trigger event notification."""
        # This would call the notification service
        # Example: POST /notifications/events with event data
        logger.info(f"Event: {event_type} for customer {customer_id}")
    
    def send_response(self, writer, decision: str):
        """Send policy response back to Postfix."""
        response = f"action={decision}\n\n".encode('utf-8')
        writer.write(response)
    
    async def start_server(self):
        """Start listening for policy requests."""
        server = await asyncio.start_server(
            self.handle_client,
            self.host,
            self.port
        )
        
        logger.info(f"Policy daemon listening on {self.host}:{self.port}")
        
        async with server:
            await server.serve_forever()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    daemon = QuotaDaemon()
    asyncio.run(daemon.start_server())
```

### Kubernetes Deployment

**File: `mail-policy-daemon.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mail-policy-daemon
  namespace: mail
spec:
  replicas: 2  # Two instances for HA
  selector:
    matchLabels:
      app: mail-policy-daemon
  template:
    metadata:
      labels:
        app: mail-policy-daemon
    spec:
      containers:
      - name: policy-daemon
        image: custom-registry/mail-policy-daemon:latest
        ports:
        - name: policy
          containerPort: 10033
        env:
        - name: MYSQL_HOST
          valueFrom:
            configMapKeyRef:
              name: mail-config
              key: mysql_host
        - name: MYSQL_USER
          valueFrom:
            secretKeyRef:
              name: mail-db-creds
              key: username
        - name: MYSQL_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mail-db-creds
              key: password
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
        livenessProbe:
          tcpSocket:
            port: 10033
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          tcpSocket:
            port: 10033
          initialDelaySeconds: 5
          periodSeconds: 10

---
apiVersion: v1
kind: Service
metadata:
  name: mail-policy-daemon
  namespace: mail
spec:
  selector:
    app: mail-policy-daemon
  ports:
  - name: policy
    port: 10033
    protocol: TCP
  type: ClusterIP
```

---

## Monitoring & Alerting Rules

### Prometheus Alert Rules

**File: `prometheus-rules-email.yaml`**

```yaml
groups:
- name: email_alerts
  interval: 30s
  rules:
  
  # Queue health
  - alert: EmailQueueTooLarge
    expr: postfix_queue_size_total > 1000
    for: 5m
    annotations:
      summary: "Email queue size > 1000"
  
  - alert: EmailQueueStalled
    expr: |
      rate(postfix_delivered_total[5m]) < 1 AND
      postfix_queue_size_total > 100
    for: 10m
    annotations:
      summary: "Email queue stalled; not delivering"
  
  # Bounce rate
  - alert: EmailBounceRateHigh
    expr: |
      (postfix_bounced_total / postfix_sent_total) > 0.05
    for: 1h
    annotations:
      summary: "Email bounce rate > 5%"
  
  # IP blacklist
  - alert: EmailIPBlacklisted
    expr: email_ip_blacklisted == 1
    for: 1m
    annotations:
      summary: "Outbound email IP is blacklisted"
      severity: critical
  
  # Per-customer quota
  - alert: CustomerEmailQuotaExceeded
    expr: email_customer_daily_quota_exceeded > 0
    for: 5m
    annotations:
      summary: "Customer exceeded daily email quota"
```

---

## Implementation Checklist

- [ ] **Database Schema**
  - [ ] Create `email_sending_quota` table
  - [ ] Create `email_messages` table
  - [ ] Create `email_blacklist_checks` table
  - [ ] Create `email_auth_failures` table
  - [ ] Add indexes for performance

- [ ] **Policy Daemon**
  - [ ] Implement Python policy daemon (or Node.js equivalent)
  - [ ] Add database connection pooling
  - [ ] Implement quota checking logic
  - [ ] Add error handling and timeouts
  - [ ] Unit tests (quota checking, customer lookup)
  - [ ] Load test (1000+ SMTP connections)

- [ ] **Postfix Integration**
  - [ ] Configure Postfix for policy daemon
  - [ ] Deploy policy daemon as Kubernetes sidecar
  - [ ] Test quota enforcement (accept, warn, reject)
  - [ ] Verify Postfix logs policy decisions

- [ ] **Email Message Tracking**
  - [ ] Integrate with Postfix logs/milter to capture message status
  - [ ] Track delivery, bounce, failure status
  - [ ] Parse DSN (Delivery Status Notification) for bounce reasons
  - [ ] Clean up old records (>90 days)

- [ ] **Client Panel Features**
  - [ ] Email statistics dashboard
  - [ ] Email messages list (searchable/filterable)
  - [ ] Bounce analysis and recommendations
  - [ ] Quota and limit display
  - [ ] API endpoints for email status

- [ ] **Admin Panel Features**
  - [ ] Postfix queue health dashboard
  - [ ] Per-customer email activity view
  - [ ] Blacklist detection checks (hourly cron)
  - [ ] DKIM/SPF/DMARC validation tracking
  - [ ] Email alert management (configure notifications)

- [ ] **Alerting & Notifications**
  - [ ] Implement event triggering (limit reached, bounce rate high, etc.)
  - [ ] Notification service integration (email/dashboard)
  - [ ] Alert template management
  - [ ] Audit log for all alerts

- [ ] **Monitoring & Observability**
  - [ ] Export Prometheus metrics from policy daemon
  - [ ] Add Grafana dashboards (queue health, bounce rate, per-customer activity)
  - [ ] Configure log aggregation (Loki) for mail logs
  - [ ] Set up alert rules in Prometheus

- [ ] **Testing**
  - [ ] Unit tests (quota logic, customer lookup)
  - [ ] Integration tests (policy daemon + Postfix)
  - [ ] Load tests (10,000+ emails/hour)
  - [ ] Bounce handling tests
  - [ ] Blacklist detection tests

- [ ] **Documentation**
  - [ ] Customer guide: email sending limits and best practices
  - [ ] Admin guide: monitoring email health, troubleshooting queue issues
  - [ ] API reference: email status endpoints
  - [ ] Postfix configuration documentation

---

## Related Documentation

- **EMAIL_SERVICES.md**: Email stack components, authentication, provisioning
- **MONITORING_OBSERVABILITY.md**: General monitoring setup for all services
- **SECURITY_ARCHITECTURE.md**: Email authentication and security
- **ADMIN_PANEL_REQUIREMENTS.md**: Admin panel specification
- **CLIENT_PANEL_FEATURES.md**: Customer panel features
