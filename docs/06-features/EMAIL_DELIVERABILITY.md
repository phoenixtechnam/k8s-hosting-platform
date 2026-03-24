# Email Deliverability

**Version:** 1.0  
**Last Updated:** 2026-03-07  
**Status:** Design / Pre-Implementation  
**Audience:** Platform Admins, DevOps Engineers

---

## Overview

This document covers all infrastructure decisions that affect outbound email deliverability: IP pool architecture, PTR records, SMTP banners, SPF, DKIM, DMARC, IP warm-up, feedback loop (FBL) registration, blacklist monitoring, and the external SMTP relay option.

Related documents:
- `EMAIL_SERVICES.md` — MTA stack, Postfix/Dovecot/Rspamd overview
- `EMAIL_ENHANCEMENTS_SPECIFICATION.md` — DKIM key lifecycle, DMARC policy, website sendmail
- `EMAIL_SENDING_LIMITS_AND_MONITORING.md` — Rate limiting, blacklist detection, Prometheus alerts
- `DNS_ZONE_TEMPLATES.md` — Per-domain SPF, DKIM, DMARC, MX records provisioned automatically

---

## 1. Outbound IP Pool Architecture

### 1.1 IP Pool Tiers

The platform maintains **two outbound IP pools** for mail delivery. Customers are assigned to a pool based on their sending volume tier. This limits the blast radius if a single customer's behavior damages reputation — high-volume senders cannot degrade deliverability for low-volume senders and vice versa.

| Pool | Name | Assigned customers | Typical volume |
|------|------|--------------------|---------------|
| **Pool A** | `mail-pool-a` | Starter + low-volume Business | Low (< 500 emails/day per customer) |
| **Pool B** | `mail-pool-b` | High-volume Business + Premium | High (≥ 500 emails/day per customer) |

Each pool contains one or more IPv4 addresses. All IPs in a pool share the same Postfix `myhostname` and PTR record.

Pool assignment is admin-controlled. New customers start in Pool A by default. Admins move customers to Pool B when they reach volume thresholds or explicitly request Premium delivery performance.

> **Why not one IP per customer?** Per-customer IPs require individual warm-up, PTR management, and blacklist monitoring for every IP. At this platform's scale, tiered pools provide meaningful isolation without the operational overhead.

### 1.2 Postfix Transport Map

Postfix uses `transport_maps` to route outbound mail from each customer namespace through the correct pool:

```
# /etc/postfix/transport_maps
# Pool A (default — all customers not explicitly listed)
# Pool B — high-volume customers
customer-a.com    smtp:[mail-pool-b-ip]:25
customer-b.com    smtp:[mail-pool-b-ip]:25
```

The management API updates this file and reloads Postfix (`postfix reload`) when a customer is moved between pools.

For multi-IP pools, Postfix round-robins across the pool IPs via multiple MX-style transport entries or `smtp_bind_address` cycling managed by the policy daemon.

---

## 2. PTR Records (Reverse DNS)

### 2.1 Requirement

Every outbound mail IP **must** have a PTR record that:
1. Resolves to a valid hostname (forward-confirmed reverse DNS — FCrDNS).
2. Matches the `myhostname` value in Postfix (the EHLO/HELO banner).
3. Follows the pattern `mail{N}.platform.com`.

A mismatch between PTR and EHLO is an immediate spam signal for most receiving MTAs. Many providers (Outlook/Hotmail in particular) reject or heavily penalise mail from IPs without a matching PTR.

### 2.2 PTR Configuration

PTR records are set at the hosting provider level (Hetzner, Netcup, etc.), not in PowerDNS. This is done per-IP in the provider's control panel.

| IP | PTR hostname | Forward A record | Pool |
|----|-------------|-----------------|------|
| `203.0.113.10` | `mail1.platform.com` | `mail1.platform.com → 203.0.113.10` | A |
| `203.0.113.11` | `mail2.platform.com` | `mail2.platform.com → 203.0.113.11` | B |

The forward A record (`mail1.platform.com → IP`) must exist in the platform's own DNS so FCrDNS validation succeeds:

```
PTR:     10.113.0.203.in-addr.arpa.  IN  PTR  mail1.platform.com.
Forward: mail1.platform.com.         IN  A    203.0.113.10
```

> **When adding a new IP:** Set the PTR at the provider, add the forward A record to the platform DNS zone, verify FCrDNS with `dig -x <IP>` and `dig mail1.platform.com`, then proceed with warm-up before routing production traffic.

### 2.3 Verification Command

```bash
# Verify PTR resolves correctly
dig -x 203.0.113.10 +short
# Expected: mail1.platform.com.

# Verify forward A record matches
dig mail1.platform.com A +short
# Expected: 203.0.113.10

# Test SMTP banner from the receiving side
telnet mail1.platform.com 25
# Expected EHLO: 220 mail1.platform.com ESMTP Postfix
```

---

## 3. SMTP Banner (EHLO Hostname)

### 3.1 Requirement

The Postfix `myhostname` (advertised in the `220` greeting and `EHLO` response) must:
- Match the PTR record of the outbound IP.
- Be a fully qualified domain name (FQDN).
- Resolve via forward DNS to the sending IP.

### 3.2 Per-Pool Postfix Configuration

Each pool's mail node has its own Postfix configuration:

**Pool A node (`mail1.platform.com`):**
```ini
# /etc/postfix/main.cf (Pool A)
myhostname = mail1.platform.com
myorigin = mail1.platform.com
smtp_helo_name = mail1.platform.com
```

**Pool B node (`mail2.platform.com`):**
```ini
# /etc/postfix/main.cf (Pool B)
myhostname = mail2.platform.com
myorigin = mail2.platform.com
smtp_helo_name = mail2.platform.com
```

The `220` greeting that receiving servers see:
```
220 mail1.platform.com ESMTP Postfix
```

> **Do not** use `localhost`, the node's bare hostname, or any hostname that does not have a matching PTR. Doing so causes immediate spam scoring failures at Gmail, Outlook, and Yahoo.

---

## 4. SPF (Sender Policy Framework)

### 4.1 Per-Domain SPF Record

Every customer domain automatically receives an SPF record at provisioning:

```
example.com.  IN  TXT  "v=spf1 include:mail.platform.com ~all"
```

The `include:mail.platform.com` mechanism delegates SPF authorisation to the platform's published SPF record, which covers all outbound pool IPs:

```
mail.platform.com.  IN  TXT  "v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 ~all"
```

**When a new IP is added to any pool**, the platform-level SPF record at `mail.platform.com` is updated to include the new IP. Customer SPF records do not need to change — the `include:` mechanism pulls in the updated list automatically.

### 4.2 SPF Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Qualifier | `~all` (softfail) | Avoids hard rejection for edge cases (forwarded mail); DMARC enforces policy |
| Include vs ip4 | `include:mail.platform.com` per domain | Single point of update when IPs change |
| Lookup count | Keep `include:` chain ≤ 10 DNS lookups total | SPF spec limit; exceeding it causes `PermError` |

### 4.3 External SMTP Relay SPF

If a customer uses an external SMTP relay (see Section 8), their SPF record must also include the relay's sender IPs. The management API adds the relay provider's include mechanism automatically when external relay is enabled:

```
example.com.  IN  TXT  "v=spf1 include:mail.platform.com include:sendgrid.net ~all"
```

---

## 5. DKIM (DomainKeys Identified Mail)

Full DKIM key lifecycle is documented in `EMAIL_ENHANCEMENTS_SPECIFICATION.md`. Deliverability-relevant summary:

### 5.1 Key Parameters

| Parameter | Value |
|-----------|-------|
| Algorithm | RSA-SHA256 |
| Key size | 2048-bit (4096 available on request) |
| Selector | `default._domainkey.{domain}` |
| Rotation | Annual (automatic) — old key kept active 30+ days post-rotation |
| Key storage | HashiCorp Vault (never written to disk or logged) |
| Signing scope | All outbound mail via Postfix/OpenDKIM milter |

### 5.2 DKIM DNS Record

Automatically provisioned at domain creation:

```
default._domainkey.example.com.  IN  TXT
  "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ..."
```

### 5.3 DKIM and IP Pools

DKIM is **per-domain**, not per-IP. A customer's mail is signed with their domain's private key regardless of which pool IP sends it. This means DKIM reputation is domain-scoped, not IP-scoped — consistent with how Gmail and other receivers build sender reputation over time.

---

## 6. DMARC

### 6.1 Starting Policy

Every customer domain is provisioned with a permissive DMARC record:

```
_dmarc.example.com.  IN  TXT
  "v=DMARC1; p=none; rua=mailto:dmarc@platform.com; ruf=mailto:dmarc@platform.com; fo=1"
```

| Tag | Value | Meaning |
|-----|-------|---------|
| `p=none` | Monitor only | No mail is rejected or quarantined |
| `rua` | Platform address | Aggregate reports delivered to the platform |
| `ruf` | Platform address | Forensic (failure) reports delivered to the platform |
| `fo=1` | Report on any failure | DKIM or SPF failure generates a forensic report |

### 6.2 Aggregate Report Processing

The platform receives DMARC aggregate reports (sent by Gmail, Outlook, Yahoo, etc.) at `dmarc@platform.com`. Reports are parsed and stored per-domain. Admins can view per-domain DMARC pass/fail rates in the Admin Panel.

Report ingestion pipeline:
1. Receiving MTA accepts reports at `dmarc@platform.com`.
2. Parser extracts XML from `application/zip` or `application/gzip` attachment.
3. Results stored in `dmarc_aggregate_reports` table (see Section 6.4).
4. Admin Panel dashboard displays 30-day rolling pass rate per domain.

### 6.3 Policy Tightening Recommendation

The platform recommends customers tighten DMARC policy after an initial monitoring period. The platform **does not automatically change** DMARC policy — it generates a recommendation and notifies the customer and admin.

**Tightening trigger:** After 30 days at `p=none` with a DMARC pass rate ≥ 95% (evaluated on aggregate reports), the platform generates a recommendation:

```
Recommendation: DMARC policy for example.com is ready to tighten.
  Current policy: p=none
  30-day pass rate: 98.3%
  Action: Update _dmarc.example.com TXT to p=quarantine
```

The recommendation appears in:
- Admin Panel → Domains → {domain} → DMARC (admin sees all domains)
- Client Panel → Domains → {domain} → Email → DMARC (customer sees own domains)

**Policy advancement path:**

```
p=none (monitoring)
  └── 30 days + ≥ 95% pass rate → Recommendation to tighten
      └── Admin/customer applies p=quarantine manually
          └── 30 more days + ≥ 95% pass rate → Recommendation to tighten further
              └── Admin/customer applies p=reject manually
```

The platform **never auto-applies** policy changes — an incorrect tightening (e.g. with a broken mail flow) would cause legitimate mail to be rejected. The recommendation is advisory only.

Admin Panel provides a one-click "Apply recommended policy" button that updates the PowerDNS record via the DNS controller. The customer's approval is not required for admin-initiated policy updates; admin-only changes are logged in the audit trail.

### 6.4 DMARC Database Schema

```sql
-- Parsed DMARC aggregate reports
CREATE TABLE dmarc_aggregate_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id        UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  report_id        VARCHAR(255) NOT NULL,
  org_name         VARCHAR(255) NOT NULL,   -- Reporting org (e.g. "Google Inc.")
  report_begin     TIMESTAMPTZ NOT NULL,
  report_end       TIMESTAMPTZ NOT NULL,
  source_ip        INET NOT NULL,
  count            INTEGER NOT NULL,        -- Number of messages in this row
  disposition      VARCHAR(20),            -- none / quarantine / reject
  dkim_result      VARCHAR(20),            -- pass / fail
  spf_result       VARCHAR(20),            -- pass / fail
  header_from      VARCHAR(255),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-domain DMARC summary (rolling 30-day, updated daily)
CREATE TABLE dmarc_domain_summary (
  domain_id        UUID PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  period_start     TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  total_messages   INTEGER NOT NULL DEFAULT 0,
  dkim_pass        INTEGER NOT NULL DEFAULT 0,
  spf_pass         INTEGER NOT NULL DEFAULT 0,
  dmarc_pass       INTEGER NOT NULL DEFAULT 0,
  pass_rate        NUMERIC(5,2),           -- Percentage, 0.00–100.00
  policy_current   VARCHAR(20),            -- none / quarantine / reject
  recommend_tighten BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 7. IP Warm-Up

### 7.1 Why Warm-Up Is Required

Receiving MTAs (Gmail, Outlook, Yahoo) build reputation scores per sending IP. A new IP with no sending history that suddenly delivers thousands of emails is treated as suspicious. Warm-up is the process of gradually increasing volume from a new IP so reputation scores accumulate organically.

### 7.2 Warm-Up Schedule

Follow this ramp schedule for each new IP added to any pool. Do not advance faster than indicated — early reputation damage is difficult to recover from.

| Week | Max emails/day | Notes |
|------|---------------|-------|
| 1 | 50 | Seed with known-good senders only (low bounce history) |
| 2 | 200 | Monitor bounce and complaint rates daily |
| 3 | 500 | Check blacklist status every 12 hours |
| 4 | 1,000 | |
| 5 | 3,000 | If bounce rate > 2% at any point, pause and investigate |
| 6 | 7,000 | |
| 7 | 15,000 | |
| 8 | 30,000 | |
| Full | Unlimited | Consider IP "warm" — remove volume cap |

### 7.3 Warm-Up Implementation

During warm-up, Postfix `transport_maps` routes a limited fraction of traffic through the new IP. The remaining traffic continues through the established pool IPs.

```ini
# Postfix transport_maps during warm-up of mail3.platform.com
# Route only explicitly listed domains through the new IP
seed-customer-1.com    smtp:[203.0.113.12]:25
seed-customer-2.com    smtp:[203.0.113.12]:25
# All other traffic remains on existing pool
```

The admin selects 2–5 customers with clean sending histories as warm-up seed senders. These customers are moved back to the main pool once the new IP is warm.

### 7.4 Warm-Up Abort Criteria

Immediately stop routing mail through a warming IP if any of the following are true:

| Signal | Threshold | Action |
|--------|-----------|--------|
| Bounce rate | > 2% on any day | Pause — investigate bounced addresses |
| Blacklist hit | Any listing on Spamhaus ZEN or Barracuda | Pause — delist before continuing |
| FBL complaint rate | > 0.1% | Pause — identify and remove complainers |
| Outlook/Gmail deferral rate | > 10% of deliveries | Slow down — drop back one week in schedule |

### 7.5 Post-Warm-Up Checklist

Before declaring an IP fully warm and routing production traffic:

- [ ] FCrDNS verified (`dig -x <IP>` returns correct hostname)
- [ ] SMTP banner matches PTR (`telnet <IP> 25` → `220 mailN.platform.com`)
- [ ] IP passes Spamhaus ZEN lookup: `dig <reversed-IP>.zen.spamhaus.org`
- [ ] IP passes Barracuda lookup: `dig <reversed-IP>.b.barracudacentral.org`
- [ ] MX Toolbox deliverability test passes (check `mxtoolbox.com/deliverability`)
- [ ] Mail-tester.com score ≥ 9/10 for a test send
- [ ] FBL registration updated to include new IP (see Section 9)
- [ ] IP added to `mail.platform.com` SPF TXT record
- [ ] Admin Panel IP pool configuration updated

---

## 8. External SMTP Relay Option

### 8.1 Overview

Customers can configure their domain's outbound mail to route through an external SMTP relay (SendGrid, Mailgun, Brevo, AWS SES) instead of the platform's self-hosted Postfix. This is useful for:
- High-volume transactional email (e.g. e-commerce order confirmations)
- Customers who already have an established relay account and IP reputation
- Customers who require dedicated IPs or provider-specific analytics

The platform self-hosted Postfix remains the default. External relay is opt-in per domain.

### 8.2 How It Works

When external relay is enabled for a domain, the management API:

1. Updates the domain's Postfix `transport_maps` to route outbound mail through the relay's SMTP endpoint:
   ```
   example.com    smtp:[smtp.sendgrid.net]:587
   ```
2. Stores relay credentials (SMTP username/password or API key) as a Kubernetes Secret in the client namespace.
3. Updates the domain's SPF record to include the relay provider's sender mechanism:
   ```
   "v=spf1 include:mail.platform.com include:sendgrid.net ~all"
   ```
4. Notes that DKIM signing is now the relay provider's responsibility (or the customer configures the relay to use the platform DKIM key — relay-specific).

> **Platform sending limits still apply** even when using an external relay. The Postfix policy daemon counts all mail routed through the platform MTA regardless of final relay destination. Customers who need limits beyond their plan must upgrade.

### 8.3 Platform Notification Emails

Platform-generated emails (welcome emails, quota alerts, certificate expiry warnings, backup notifications) are sent via an **external transactional relay** (e.g. SendGrid or Mailgun), not through the customer mail pools. This prevents platform operational emails from consuming pool IP reputation.

The relay account for platform notifications is configured in the Management API environment:

```yaml
# management-api ConfigMap
PLATFORM_SMTP_HOST: smtp.sendgrid.net
PLATFORM_SMTP_PORT: "587"
PLATFORM_SMTP_USER: apikey
PLATFORM_SMTP_PASS: <sealed-secret>
PLATFORM_SMTP_FROM: noreply@platform.com
```

This relay account is separate from any customer relay configuration.

### 8.4 External Relay Configuration (Customer)

| Field | Description |
|-------|-------------|
| Provider | Dropdown: SendGrid / Mailgun / Brevo / AWS SES / Custom |
| SMTP host | Provider endpoint (e.g. `smtp.sendgrid.net`) |
| SMTP port | 587 (STARTTLS) or 465 (implicit TLS) |
| Username | Provider SMTP username or `apikey` (SendGrid) |
| Password / API key | Stored as Sealed Secret in client namespace |
| From domain | Must match the domain being configured |

Admin-only: enable/disable external relay per domain. Customers cannot self-configure relay credentials — they provide credentials to support, who configures via Admin Panel.

---

## 9. Feedback Loop (FBL) Registration

### 9.1 What Is an FBL?

A feedback loop is a service offered by large mailbox providers (Outlook/Hotmail, Yahoo) that forwards spam complaints back to the sending mail operator. When a recipient clicks "Mark as spam", the provider sends a copy of the message (or a complaint notification) to the registered FBL address.

FBL complaints are the most direct signal of poor content or targeting quality. High complaint rates cause IP and domain blacklisting at the provider level (separate from third-party RBLs).

### 9.2 FBL Registration

The platform must register each outbound pool IP with the following providers:

| Provider | FBL Program | Registration URL | Complaint format |
|----------|-------------|-----------------|-----------------|
| Microsoft (Outlook/Hotmail/Live) | JMRP / SNDS | `postmaster.live.com` | ARF (Abuse Reporting Format) |
| Yahoo / AOL | Yahoo CFL | `senders.yahooinc.com` | ARF |

Registration requires:
- IP address(es) to cover
- A complaint-receiving email address (e.g. `fbl@platform.com`)
- A contact email for the platform postmaster
- Domain and abuse contact information

> **Google (Gmail)** does not offer a traditional FBL. Instead, use Google Postmaster Tools (`postmaster.google.com`) to monitor domain reputation and spam rate per sending domain. Register `platform.com` and any high-volume customer domains.

### 9.3 FBL Complaint Handling Workflow

When a complaint arrives at `fbl@platform.com`:

```
1. FBL ingest service parses the ARF message
   └── Extracts: original recipient, sending domain, sending IP, message headers

2. Identifies the customer from the sending domain (lookup in domains table)

3. Logs complaint to email_fbl_complaints table (see schema below)

4. Updates customer's complaint_rate_7d metric in email_reputation table

5. If complaint_rate_7d > 0.1%:
   └── Trigger automatic throttle: reduce customer's hourly sending limit by 50%
   └── Send admin alert: CustomerFBLThreshold (see Prometheus rules)
   └── Notify customer via panel notification and email

6. If complaint_rate_7d > 0.3%:
   └── Suspend outbound sending for that customer's domain
   └── Admin must manually review and re-enable
   └── Send admin alert: CustomerFBLSuspend (critical)
```

### 9.4 FBL Database Schema

```sql
-- Individual FBL complaint records
CREATE TABLE email_fbl_complaints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id       UUID REFERENCES domains(id) ON DELETE SET NULL,
  client_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider        VARCHAR(50) NOT NULL,     -- microsoft / yahoo / other
  sending_ip      INET NOT NULL,
  original_to     VARCHAR(255),            -- Redacted by some providers
  message_id      VARCHAR(255),
  arf_raw         TEXT,                    -- Full ARF message if available
  action_taken    VARCHAR(50)              -- none / throttled / suspended
);

-- Rolling complaint rate per customer domain (updated per complaint)
CREATE TABLE email_reputation (
  domain_id           UUID PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  complaint_rate_7d   NUMERIC(6,4) NOT NULL DEFAULT 0,  -- % over 7 days
  complaint_rate_30d  NUMERIC(6,4) NOT NULL DEFAULT 0,  -- % over 30 days
  total_complaints    INTEGER NOT NULL DEFAULT 0,
  last_complaint_at   TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'good'
                        CHECK (status IN ('good', 'throttled', 'suspended')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 9.5 Prometheus Alerts

```yaml
groups:
- name: email-reputation
  rules:
  - alert: CustomerFBLThreshold
    expr: platform_email_complaint_rate_7d > 0.001   # > 0.1%
    for: 0m
    labels:
      severity: warning
    annotations:
      summary: "FBL complaint rate exceeded for {{ $labels.domain }}"
      description: "Domain {{ $labels.domain }} (client {{ $labels.client_id }}) complaint rate is {{ $value | humanizePercentage }}"

  - alert: CustomerFBLSuspend
    expr: platform_email_complaint_rate_7d > 0.003   # > 0.3%
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "CRITICAL: Domain {{ $labels.domain }} outbound mail suspended due to complaint rate"
```

### 9.6 Google Postmaster Tools

Register the platform's sending domain (`platform.com`) and any high-volume customer domains with Google Postmaster Tools:

1. Verify domain ownership via DNS TXT record at `postmaster.google.com`.
2. Monitor daily:
   - **Domain reputation** — High / Medium / Low / Bad
   - **IP reputation** — High / Medium / Low / Bad
   - **Spam rate** — % of Gmail users marking mail from domain as spam
   - **Authentication** — DKIM / SPF / DMARC pass rates
   - **Delivery errors** — SMTP error rates and codes

Google Postmaster Tools does not send complaints in real time. It provides aggregate data with a 24–48 hour lag. Use it as a strategic view; use FBL for real-time complaint signals.

---

## 10. Blacklist Monitoring

Full specification is in `EMAIL_SENDING_LIMITS_AND_MONITORING.md`. Summary:

| RBL | Check type | Alert severity |
|-----|-----------|----------------|
| Spamhaus ZEN | IP | Critical |
| Barracuda BRBL | IP | Critical |
| Sorbs | IP | Warning |
| Invaluement / UCEPROTECT | IP + domain | Warning |

Checks run **hourly** against all pool IPs. If any IP is listed:

1. `EmailIPBlacklisted` Prometheus alert fires (critical).
2. Admin receives email + SMS notification.
3. Admin investigates cause (abusive customer, compromised account, spam complaint spike).
4. Admin submits delisting request to the RBL operator.
5. After delisting, admin documents root cause in the Admin Panel audit log.

**Delisting process** varies by RBL:
- Spamhaus: `www.spamhaus.org/lookup/` — requires demonstrating the spam source is resolved
- Barracuda: `barracudacentral.org/rbl/removal-request/` — automatic removal after 30 days of clean sending
- Sorbs: `sorbs.net` — fee-based or time-based delisting depending on list category

---

## 11. Admin Panel — Deliverability Dashboard

**Admin Panel → Email → Deliverability**

| Section | Data |
|---------|------|
| **IP Pool Status** | Pool A / Pool B: IP list, warm status, blacklist status, PTR verified |
| **Blacklist Status** | Per-IP RBL check results, last checked timestamp, listed/clean badge |
| **FBL Complaints** | 7-day and 30-day complaint counts per domain; flagged domains (throttled/suspended) |
| **DMARC Overview** | Per-domain 30-day pass rate; domains with tightening recommendation |
| **Google Postmaster** | Link to Postmaster Tools dashboard (external); domain reputation summary if API integrated |
| **Domain Reputation** | Table: domain, complaint rate (7d), complaint rate (30d), status badge |

**Admin Actions:**

| Action | Description |
|--------|-------------|
| Move customer to pool | Reassign customer domain to Pool A or Pool B |
| Suspend outbound mail | Halt all outbound for a customer domain |
| Resume outbound mail | Re-enable after suspension |
| Force DMARC tighten | Apply recommended DMARC policy update to PowerDNS |
| View FBL complaints | Filtered list of complaints for a domain |
| Download complaint report | CSV export for a given domain and date range |

---

## 12. Implementation Checklist

### Phase 1 — Infrastructure Prerequisites

- [ ] Allocate outbound IPv4 addresses for Pool A and Pool B
- [ ] Set PTR records at hosting provider for each pool IP
- [ ] Add forward A records to platform DNS for each pool hostname (`mail1.platform.com`, `mail2.platform.com`)
- [ ] Configure `myhostname` / `smtp_helo_name` per pool in Postfix
- [ ] Update `mail.platform.com` SPF TXT record with all pool IPs
- [ ] Configure `transport_maps` routing per customer tier
- [ ] Verify FCrDNS for all IPs (`dig -x` + `dig mailN.platform.com`)
- [ ] Run warm-up schedule for any new IPs (see Section 7)

### Phase 2 — Authentication Records

- [ ] Confirm DKIM is signing all outbound mail via OpenDKIM milter in Postfix
- [ ] Verify DKIM TXT records are present for all provisioned domains
- [ ] Confirm SPF `include:` chain resolves correctly (≤ 10 lookups)
- [ ] Confirm DMARC `p=none` + `rua` + `ruf` records are present for all domains
- [ ] Set up `dmarc@platform.com` mailbox for aggregate/forensic report receipt
- [ ] Deploy DMARC aggregate report parser and `dmarc_aggregate_reports` table

### Phase 3 — FBL Registration

- [ ] Register all pool IPs with Microsoft JMRP (`postmaster.live.com`)
- [ ] Register all pool IPs with Yahoo CFL (`senders.yahooinc.com`)
- [ ] Set up `fbl@platform.com` ingest mailbox
- [ ] Deploy FBL ARF parser service
- [ ] Create `email_fbl_complaints` and `email_reputation` tables
- [ ] Implement complaint rate calculation and throttle/suspend logic
- [ ] Deploy Prometheus alerts: `CustomerFBLThreshold`, `CustomerFBLSuspend`
- [ ] Register platform sending domain with Google Postmaster Tools

### Phase 4 — Admin Panel

- [ ] Build Deliverability Dashboard (IP pool status, blacklist, FBL, DMARC overview)
- [ ] Add DMARC tightening recommendation display (Admin + Client Panel)
- [ ] Add one-click "Apply recommended DMARC policy" (admin) — updates PowerDNS via DNS controller
- [ ] Build FBL complaints table view (filterable by domain, date, provider)
- [ ] Build domain reputation table with status badges

### Phase 5 — External Relay

- [ ] Build Admin Panel external relay configuration form (per domain)
- [ ] Implement transport_maps update and Postfix reload on relay enable/disable
- [ ] Implement SPF record update on relay enable/disable (add/remove provider include)
- [ ] Store relay credentials as Sealed Secrets in client namespace
- [ ] Configure platform notification relay (Management API SMTP env vars)
- [ ] Test platform notification emails route through external relay, not pool IPs

---

## Related Documentation

- **EMAIL_SERVICES.md** — MTA stack (Postfix/Dovecot/Rspamd), plan allowances
- **EMAIL_ENHANCEMENTS_SPECIFICATION.md** — DKIM key lifecycle and rotation, website sendmail
- **EMAIL_SENDING_LIMITS_AND_MONITORING.md** — Rate limiting, blacklist detection, Prometheus alerts, policy daemon
- **DNS_ZONE_TEMPLATES.md** — MX, SPF, DKIM, DMARC, SRV records auto-provisioned per domain
- **POWERDNS_INTEGRATION.md** — DNS record management via API
- **SECRETS_MANAGEMENT.md** — Sealed Secrets for relay credentials and DKIM private keys
