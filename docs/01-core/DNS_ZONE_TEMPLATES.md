# DNS Zone Templates

**Document Version:** 1.1  
**Last Updated:** 2026-03-07  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, DNS administrators

---

> **ADR-022:** Per ADR-022, DNS zones are managed via the external PowerDNS REST API. The platform does not deploy PowerDNS itself. Templates are applied by the Management API when creating zones through the external API.

## Overview

The platform supports a **global DNS zone template** system. When a new customer domain is added in Primary DNS mode, the template is automatically applied to the zone immediately after creation, populating all standard records — web, email, autodiscovery, and security — without any manual steps.

**Key principles:**
- One global default template applies to all new domains (configurable by platform admins)
- Templates use **placeholder variables** that are resolved at apply-time from customer and platform context
- The template is applied automatically at initial domain provisioning in Primary DNS mode
- Admins can manually re-apply the template to existing domains at any time — **non-destructive only**: records are added or updated from the template, but no existing records outside the template are deleted
- After provisioning, all DNS records are **fully editable** by admins and customers on a per-domain basis; the template imposes no ongoing restrictions
- The template is applied only in **Primary DNS mode**; CNAME and Secondary modes are excluded
- Templates support all standard record types including **SRV**, **CAA**, **TLSA**, and **DMARC**

---

## Why Templates Are Needed

Without a template system, a newly created zone contains only:
- `SOA` — zone authority record
- `NS` — nameserver records

This means email, webmail, autodiscovery, SPF, DKIM, and DMARC records must be created manually per domain. For a hosting platform with hundreds of domains sharing the same mail infrastructure, this is both error-prone and time-consuming.

The template system ensures every domain is **immediately operational** for web and email the moment it is created, with zero manual DNS configuration required.

---

## Template Variables

Templates use `{{variable}}` placeholders. Variables are resolved at apply-time from platform configuration and customer/domain context.

### Platform-Level Variables

| Variable | Resolved Value | Example |
|---|---|---|
| `{{platform.mail_hostname}}` | External mail server FQDN | `mail.platform.com` |
| `{{platform.imap_hostname}}` | IMAP server FQDN | `mail.platform.com` |
| `{{platform.smtp_hostname}}` | SMTP submission server FQDN | `mail.platform.com` |
| `{{platform.webmail_hostname}}` | Roundcube webmail FQDN | `webmail.platform.com` |
| `{{platform.ingress_ipv4}}` | Primary ingress IPv4 address | `203.0.113.10` |
| `{{platform.ingress_ipv6}}` | Primary ingress IPv6 address | `2001:db8::1` |
| `{{platform.spf_include}}` | SPF include value | `include:mail.platform.com` |
| `{{platform.dmarc_rua}}` | DMARC aggregate report address | `mailto:dmarc@platform.com` |
| `{{platform.ns1}}` | Primary external DNS server FQDN | `ns1.platform.com` |
| `{{platform.ns2}}` | Secondary external DNS server FQDN | `ns2.platform.com` |

### Domain-Level Variables

| Variable | Resolved Value | Example |
|---|---|---|
| `{{domain.name}}` | The domain being provisioned | `acme.com` |
| `{{domain.dkim_selector}}` | DKIM selector for this domain | `default` |
| `{{domain.dkim_public_key}}` | DKIM public key (generated at provisioning) | `v=DKIM1; k=rsa; p=MIGf...` |
| `{{domain.webmail_subdomain}}` | Webmail CNAME for this domain | `webmail.acme.com` |

### Customer-Level Variables

| Variable | Resolved Value | Example |
|---|---|---|
| `{{customer.id}}` | Internal customer identifier | `cust_001` |

---

## Default Global Template

This is the platform's default template. It is applied to every new domain in Primary DNS mode. Platform admins can edit this template in the Admin Panel.

```yaml
# Global DNS Zone Template
# Version: 1.0
# Applied to: All new domains in Primary DNS mode
# Variables resolved at apply-time from platform and domain context

records:

  # ─────────────────────────────────────────────
  # WEB — A and AAAA records
  # ─────────────────────────────────────────────

  # Apex A record uses a PowerDNS LUA record to dynamically mirror the ingress.platform.com
  # A record set at query time. This gives apex domains (customer.com) the same behaviour
  # as CNAME/ALIAS without violating the DNS spec (CNAME at apex is illegal per RFC 1912).
  #
  # How it works: when a resolver queries customer.com IN A, PowerDNS executes the LUA
  # function, calls ifportup() against ingress.platform.com, and returns only healthy IPs.
  # The DNS Ingress Controller continues to manage ingress.platform.com; apex domains
  # follow automatically with no per-domain record updates needed.
  #
  # PowerDNS requirement: lua-records=yes must be set in the external PowerDNS
  # server's pdns.conf — see POWERDNS_INTEGRATION.md §LUA Records Configuration.
  # LUA records have no negative performance impact at this scale and no security
  # implications given the external PowerDNS API is accessed over a secured channel.

  - name: "{{domain.name}}."
    type: LUA
    ttl: 60
    content: "A \"ifportup(80, {'{{platform.ingress_ipv4}}'})\""
    comment: "Apex — LUA record mirrors ingress.platform.com A record set dynamically"

  - name: "{{domain.name}}."
    type: AAAA
    ttl: 60
    content: "{{platform.ingress_ipv6}}"
    comment: "Apex — platform ingress IPv6"
    enabled_if: "platform.ingress_ipv6 != null"

  - name: "www.{{domain.name}}."
    type: CNAME
    ttl: 300
    content: "ingress.{{platform.ns1}}."
    comment: "www subdomain → ingress.platform.com (CNAME is valid for non-apex)"

  # ─────────────────────────────────────────────
  # MAIL — MX record
  # ─────────────────────────────────────────────

  - name: "{{domain.name}}."
    type: MX
    ttl: 3600
    priority: 10
    content: "{{platform.mail_hostname}}."
    comment: "Primary mail server"

  # ─────────────────────────────────────────────
  # EMAIL AUTHENTICATION — SPF, DKIM, DMARC
  # ─────────────────────────────────────────────

  - name: "{{domain.name}}."
    type: TXT
    ttl: 3600
    content: "v=spf1 {{platform.spf_include}} ~all"
    comment: "SPF — authorise platform mail server"

  - name: "{{domain.dkim_selector}}._domainkey.{{domain.name}}."
    type: TXT
    ttl: 3600
    content: "{{domain.dkim_public_key}}"
    comment: "DKIM public key"

  - name: "_dmarc.{{domain.name}}."
    type: TXT
    ttl: 3600
    content: "v=DMARC1; p=none; rua={{platform.dmarc_rua}}; ruf={{platform.dmarc_rua}}; fo=1"
    comment: "DMARC policy — starts permissive (p=none), can be tightened to quarantine/reject"

  # ─────────────────────────────────────────────
  # WEBMAIL — CNAME for webmail subdomain
  # ─────────────────────────────────────────────

  - name: "webmail.{{domain.name}}."
    type: CNAME
    ttl: 3600
    content: "{{platform.webmail_hostname}}."
    comment: "Webmail (Roundcube) for this domain"

  - name: "mail.{{domain.name}}."
    type: CNAME
    ttl: 3600
    content: "{{platform.mail_hostname}}."
    comment: "mail.domain alias → platform mail server"

  # ─────────────────────────────────────────────
  # EMAIL AUTODISCOVERY — SRV records
  # RFC 6186 (IMAP/SMTP) + Microsoft Autodiscover
  # ─────────────────────────────────────────────

  # IMAP (SSL — RFC 6186)
  - name: "_imaps._tcp.{{domain.name}}."
    type: SRV
    ttl: 3600
    priority: 10
    weight: 10
    port: 993
    content: "{{platform.imap_hostname}}."
    comment: "IMAP over TLS (port 993) — used by Thunderbird, Apple Mail, K-9, etc."

  # IMAP with STARTTLS (RFC 6186)
  - name: "_imap._tcp.{{domain.name}}."
    type: SRV
    ttl: 3600
    priority: 20
    weight: 10
    port: 143
    content: "{{platform.imap_hostname}}."
    comment: "IMAP with STARTTLS (port 143) — fallback for RFC 6186 clients"

  # SMTP Submission (SSL — RFC 8314)
  - name: "_submissions._tcp.{{domain.name}}."
    type: SRV
    ttl: 3600
    priority: 10
    weight: 10
    port: 465
    content: "{{platform.smtp_hostname}}."
    comment: "SMTP Submission over TLS (port 465) — RFC 8314 implicit TLS"

  # SMTP Submission with STARTTLS (RFC 6186)
  - name: "_submission._tcp.{{domain.name}}."
    type: SRV
    ttl: 3600
    priority: 20
    weight: 10
    port: 587
    content: "{{platform.smtp_hostname}}."
    comment: "SMTP Submission with STARTTLS (port 587) — used by most email clients"

  # POP3 over TLS (RFC 6186) — disabled by default, enable if POP3 is supported
  # - name: "_pop3s._tcp.{{domain.name}}."
  #   type: SRV
  #   ttl: 3600
  #   priority: 10
  #   weight: 10
  #   port: 995
  #   content: "{{platform.imap_hostname}}."
  #   comment: "POP3 over TLS — uncomment if POP3 is offered"

  # ─────────────────────────────────────────────
  # EMAIL AUTODISCOVERY — Autodiscover / Autoconfig
  # (Microsoft Outlook, Mozilla Thunderbird)
  # ─────────────────────────────────────────────

  # Microsoft Autodiscover (Outlook, Exchange clients)
  - name: "_autodiscover._tcp.{{domain.name}}."
    type: SRV
    ttl: 3600
    priority: 10
    weight: 10
    port: 443
    content: "{{platform.mail_hostname}}."
    comment: "Microsoft Autodiscover — Outlook/Exchange email client auto-configuration"

  - name: "autodiscover.{{domain.name}}."
    type: CNAME
    ttl: 3600
    content: "{{platform.mail_hostname}}."
    comment: "Autodiscover CNAME — required by some Outlook versions alongside SRV"

  # Mozilla Autoconfig (Thunderbird)
  - name: "autoconfig.{{domain.name}}."
    type: CNAME
    ttl: 3600
    content: "{{platform.mail_hostname}}."
    comment: "Mozilla Autoconfig — Thunderbird email client auto-configuration"

  # ─────────────────────────────────────────────
  # CERTIFICATE AUTHORITY AUTHORISATION (CAA)
  # ─────────────────────────────────────────────

  - name: "{{domain.name}}."
    type: CAA
    ttl: 3600
    flags: 0
    tag: issue
    content: "letsencrypt.org"
    comment: "CAA — only Let's Encrypt may issue certificates for this domain"

  - name: "{{domain.name}}."
    type: CAA
    ttl: 3600
    flags: 0
    tag: issuewild
    content: "letsencrypt.org"
    comment: "CAA — only Let's Encrypt may issue wildcard certificates"

  - name: "{{domain.name}}."
    type: CAA
    ttl: 3600
    flags: 0
    tag: iodef
    content: "mailto:{{platform.dmarc_rua}}"
    comment: "CAA — report certificate issuance policy violations"
```

---

## SRV Record Reference

SRV records are the standard mechanism for email client autodiscovery (RFC 6186, RFC 8314). They allow email clients (Thunderbird, Apple Mail, Outlook, K-9 Mail, etc.) to automatically determine the correct server, port, and protocol for a domain — without the user needing to enter any settings manually.

### SRV Record Format

```
_service._proto.domain.  TTL  IN  SRV  priority  weight  port  target.
```

| Field | Description |
|---|---|
| `_service` | Service name (e.g. `_imaps`, `_submission`, `_autodiscover`) |
| `_proto` | Transport protocol: `_tcp` or `_udp` |
| `priority` | Lower = preferred. Clients try lowest priority first |
| `weight` | Load balancing between records of equal priority |
| `port` | TCP/UDP port number |
| `target` | FQDN of the server handling the service (must end in `.`) |

### Email SRV Records Defined in Default Template

| Record Name | Port | Protocol | Purpose | RFC |
|---|---|---|---|---|
| `_imaps._tcp` | 993 | IMAP over TLS | IMAP SSL — primary IMAP method | RFC 6186 |
| `_imap._tcp` | 143 | IMAP + STARTTLS | IMAP STARTTLS — fallback | RFC 6186 |
| `_submissions._tcp` | 465 | SMTP over TLS | SMTP implicit TLS — preferred submission | RFC 8314 |
| `_submission._tcp` | 587 | SMTP + STARTTLS | SMTP STARTTLS — standard submission | RFC 6186 |
| `_autodiscover._tcp` | 443 | HTTPS | Microsoft Outlook/Exchange autodiscovery | MS spec |

### How Email Clients Use SRV Records

**Thunderbird** queries `_imap._tcp.<domain>` and `_submission._tcp.<domain>` to auto-configure:
```
_imaps._tcp.acme.com → mail.platform.com:993 (TLS)
_submission._tcp.acme.com → mail.platform.com:587 (STARTTLS)
```
User enters only their email address — no server, port, or protocol selection required.

**Outlook** queries `_autodiscover._tcp.<domain>` first, then falls back to `autodiscover.<domain>` CNAME/A:
```
_autodiscover._tcp.acme.com → mail.platform.com:443
autodiscover.acme.com → CNAME → mail.platform.com
```
Platform serves an Autodiscover XML response at `https://mail.platform.com/autodiscover/autodiscover.xml`.

**Apple Mail / iOS** queries `_imaps._tcp` and `_submissions._tcp`.

**K-9 Mail / FairEmail (Android)** query Mozilla Autoconfig endpoint at `autoconfig.<domain>` first, then SRV fallback.

---

## Template Application Workflow

When a new domain is added in Primary DNS mode:

```
1. Zone created via external PowerDNS API (SOA + NS records only)
      ↓
2. DKIM keypair generated for domain
   (private key → Docker-Mailserver / OpenDKIM)
   (public key → stored for template variable {{domain.dkim_public_key}})
      ↓
3. Template variables resolved:
   - platform.* → from platform configuration
   - domain.* → from domain context + newly generated DKIM key
   - customer.* → from customer record
      ↓
4. Template records rendered (all {{variables}} substituted)
      ↓
5. Records POSTed to external PowerDNS API in a single batch request
      ↓
6. Zone propagated to external DNS servers via AXFR
      ↓
7. Zone status = "active"
```

### DKIM Key Generation (Step 2)

DKIM keypairs are generated per domain at provisioning time. The private key is stored in Docker-Mailserver's OpenDKIM key store; the public key is written into the DNS zone via the template.

```bash
# Key generation (2048-bit RSA)
opendkim-genkey -b 2048 -d acme.com -s default -D /etc/opendkim/keys/acme.com/

# Private key → /etc/opendkim/keys/acme.com/default.private
# Public key  → /etc/opendkim/keys/acme.com/default.txt
#   Contents:  default._domainkey  IN  TXT  "v=DKIM1; k=rsa; p=MIGfMA0..."
```

The public key content is extracted and stored as `domain.dkim_public_key` for template resolution.

---

## Template Application: External PowerDNS API Batch Request

All template records are applied in a single `PATCH` to the external PowerDNS API zone endpoint:

```http
PATCH /api/v1/zones/acme.com.
Host: <external-powerdns-host>:8081
X-API-Key: SECURE_API_KEY
Content-Type: application/json

{
  "rrsets": [
    {
      "name": "acme.com.",
      "type": "A",
      "ttl": 300,
      "changetype": "REPLACE",
      "records": [{ "content": "203.0.113.10", "disabled": false }]
    },
    {
      "name": "acme.com.",
      "type": "AAAA",
      "ttl": 300,
      "changetype": "REPLACE",
      "records": [{ "content": "2001:db8::1", "disabled": false }]
    },
    {
      "name": "www.acme.com.",
      "type": "CNAME",
      "ttl": 300,
      "changetype": "REPLACE",
      "records": [{ "content": "acme.com.", "disabled": false }]
    },
    {
      "name": "acme.com.",
      "type": "MX",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "10 mail.platform.com.", "disabled": false }]
    },
    {
      "name": "acme.com.",
      "type": "TXT",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [
        { "content": "\"v=spf1 include:mail.platform.com ~all\"", "disabled": false }
      ]
    },
    {
      "name": "default._domainkey.acme.com.",
      "type": "TXT",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [
        { "content": "\"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN...\"", "disabled": false }
      ]
    },
    {
      "name": "_dmarc.acme.com.",
      "type": "TXT",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [
        { "content": "\"v=DMARC1; p=none; rua=mailto:dmarc@platform.com; ruf=mailto:dmarc@platform.com; fo=1\"", "disabled": false }
      ]
    },
    {
      "name": "webmail.acme.com.",
      "type": "CNAME",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "webmail.platform.com.", "disabled": false }]
    },
    {
      "name": "mail.acme.com.",
      "type": "CNAME",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "mail.platform.com.", "disabled": false }]
    },
    {
      "name": "autodiscover.acme.com.",
      "type": "CNAME",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "mail.platform.com.", "disabled": false }]
    },
    {
      "name": "autoconfig.acme.com.",
      "type": "CNAME",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "mail.platform.com.", "disabled": false }]
    },
    {
      "name": "_imaps._tcp.acme.com.",
      "type": "SRV",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "10 10 993 mail.platform.com.", "disabled": false }]
    },
    {
      "name": "_imap._tcp.acme.com.",
      "type": "SRV",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "20 10 143 mail.platform.com.", "disabled": false }]
    },
    {
      "name": "_submissions._tcp.acme.com.",
      "type": "SRV",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "10 10 465 mail.platform.com.", "disabled": false }]
    },
    {
      "name": "_submission._tcp.acme.com.",
      "type": "SRV",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "20 10 587 mail.platform.com.", "disabled": false }]
    },
    {
      "name": "_autodiscover._tcp.acme.com.",
      "type": "SRV",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [{ "content": "10 10 443 mail.platform.com.", "disabled": false }]
    },
    {
      "name": "acme.com.",
      "type": "CAA",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [
        { "content": "0 issue \"letsencrypt.org\"", "disabled": false },
        { "content": "0 issuewild \"letsencrypt.org\"", "disabled": false },
        { "content": "0 iodef \"mailto:dmarc@platform.com\"", "disabled": false }
      ]
    }
  ]
}
```

---

## Complete Record Set Applied by Default Template

The following table shows every record created for a new domain `acme.com` when the default template is applied, with `mail.platform.com` as the platform mail server and `203.0.113.10` as the ingress IP.

| Name | Type | TTL | Content | Purpose |
|---|---|---|---|---|
| `acme.com.` | A | 300 | `203.0.113.10` | Apex → ingress IPv4 |
| `acme.com.` | AAAA | 300 | `2001:db8::1` | Apex → ingress IPv6 |
| `www.acme.com.` | CNAME | 300 | `acme.com.` | www → apex |
| `acme.com.` | MX | 3600 | `10 mail.platform.com.` | Inbound mail |
| `acme.com.` | TXT | 3600 | `v=spf1 include:mail.platform.com ~all` | SPF |
| `default._domainkey.acme.com.` | TXT | 3600 | `v=DKIM1; k=rsa; p=…` | DKIM public key |
| `_dmarc.acme.com.` | TXT | 3600 | `v=DMARC1; p=none; rua=mailto:dmarc@platform.com; fo=1` | DMARC |
| `webmail.acme.com.` | CNAME | 3600 | `webmail.platform.com.` | Roundcube webmail |
| `mail.acme.com.` | CNAME | 3600 | `mail.platform.com.` | mail.domain alias |
| `autodiscover.acme.com.` | CNAME | 3600 | `mail.platform.com.` | Outlook autodiscover |
| `autoconfig.acme.com.` | CNAME | 3600 | `mail.platform.com.` | Thunderbird autoconfig |
| `_imaps._tcp.acme.com.` | SRV | 3600 | `10 10 993 mail.platform.com.` | IMAP over TLS |
| `_imap._tcp.acme.com.` | SRV | 3600 | `20 10 143 mail.platform.com.` | IMAP + STARTTLS |
| `_submissions._tcp.acme.com.` | SRV | 3600 | `10 10 465 mail.platform.com.` | SMTP implicit TLS |
| `_submission._tcp.acme.com.` | SRV | 3600 | `20 10 587 mail.platform.com.` | SMTP + STARTTLS |
| `_autodiscover._tcp.acme.com.` | SRV | 3600 | `10 10 443 mail.platform.com.` | Outlook SRV autodiscovery |
| `acme.com.` | CAA | 3600 | `0 issue "letsencrypt.org"` | CA authorisation |
| `acme.com.` | CAA | 3600 | `0 issuewild "letsencrypt.org"` | CA wildcard authorisation |
| `acme.com.` | CAA | 3600 | `0 iodef "mailto:dmarc@platform.com"` | CA violation reports |

**Total: 19 records** provisioned automatically per domain.

---

## Template Management

### Admin Panel — Template Editor

Platform admins manage the global DNS template in **Admin Panel → Settings → DNS → Zone Template**.

**Features:**
- **View current template** — YAML editor showing all record definitions
- **Edit records** — Add, modify, or remove records from the template
- **Enable/disable individual records** — Toggle records without removing them (e.g. disable IPv6 AAAA if platform has no IPv6)
- **Preview** — Render template with a test domain to see the exact records that would be created for a new domain

Changes to the template take effect for **new domains** automatically. Admins can also manually re-apply the updated template to existing domains at any time using the **Re-apply Template** tool (non-destructive — see below).

### Per-Domain DNS Editing

Once a domain is provisioned, all its DNS records are fully editable — by admins and by the domain owner in the client panel. The template has no ongoing authority over the zone.

**Admin:** Admin Panel → Client → Domains → [domain] → DNS Records  
**Customer:** Client Panel → Domains → [domain] → DNS Records

Both interfaces provide full CRUD on all record types: A, AAAA, CNAME, MX, TXT, SRV, CAA, NS, and any other standard type supported by the external PowerDNS API. There is no concept of "template-locked" or "platform-managed" records — everything is editable.

### Re-applying the Template to Existing Domains

Admins can manually re-apply the current template to any selection of existing Primary-mode domains at any time. Re-apply is always **non-destructive**:

- Records defined in the template are **added if missing** or **updated if the content differs**
- Records that exist on the domain but are **not in the template are never touched**
- This means a customer's custom records (extra CNAMEs, subdomains, etc.) are always preserved

**When is this useful?**
- The platform mail server hostname changes — re-apply updates MX, SPF, SRV, and mail CNAMEs across all domains
- A new record type is added to the template (e.g. a new SRV record) — re-apply provisions it on existing domains
- A domain was accidentally missing some template records — re-apply fills the gaps without disturbing anything else

**Re-apply UI (Admin Panel → Settings → DNS → Zone Template → Re-apply to Domains):**

```
┌────────────────────────────────────────────────────────────────────┐
│  Re-apply DNS Zone Template                                        │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Mode: Non-destructive only                                        │
│  ℹ Adds missing records and updates changed records.               │
│    Never deletes existing records.                                 │
│                                                                    │
│  Select domains:                                           Search  │
│  [Select All]  [Select None]                            [________] │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ [✓] acme.com             — Business  — Primary  — Active    │  │
│  │ [✓] betacorp.net         — Premium   — Primary  — Active    │  │
│  │ [ ] example.org          — Starter   — Primary  — Active    │  │
│  │ [✓] shop.clientx.co.za   — Business  — Primary  — Suspended │  │
│  │ [ ] otherdomain.com      — CNAME mode — (excluded)          │  │
│  │ ...                                                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  3 of 5 domains selected  (CNAME/Secondary domains not eligible)   │
│                                                                    │
│  [Cancel]                          [Re-apply to 3 domains →]      │
└────────────────────────────────────────────────────────────────────┘
```

**Behaviour notes:**
- Only **Primary DNS mode** domains are selectable; CNAME and Secondary mode domains are listed but greyed out and excluded
- The domain list shows customer name, plan, DNS mode, and status to help admins identify which domains to target
- Search/filter by domain name or customer name
- After confirming, a progress indicator shows per-domain status (applying / done / failed)
- Any failures are reported per-domain with the reason (e.g. external PowerDNS API error); the operation continues for remaining domains

**API:**
```bash
POST /api/v1/admin/dns-template/reapply
{
  "domain_ids": ["domain_001", "domain_003", "domain_007"]
  // or "domain_ids": ["all"]  — re-applies to all Primary-mode domains
}

# Response:
{
  "total": 3,
  "completed": 3,
  "failed": 0,
  "results": [
    { "domain_id": "domain_001", "domain": "acme.com",           "status": "ok", "records_added": 2, "records_updated": 1 },
    { "domain_id": "domain_003", "domain": "betacorp.net",       "status": "ok", "records_added": 0, "records_updated": 0 },
    { "domain_id": "domain_007", "domain": "shop.clientx.co.za", "status": "ok", "records_added": 5, "records_updated": 3 }
  ]
}
```

---

## Database Schema

### `dns_templates` Table

```sql
CREATE TABLE dns_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(100) NOT NULL,     -- e.g. "Global Default"
  is_default   BOOLEAN DEFAULT FALSE,     -- only one default at a time
  template     JSONB NOT NULL,            -- serialised template records
  created_by   UUID REFERENCES admin_users(id),
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);

-- Only one row can have is_default = TRUE (enforced by partial unique index)
CREATE UNIQUE INDEX dns_templates_default_idx ON dns_templates (is_default)
  WHERE is_default = TRUE;
```

---

## API Endpoints

### Template Management (Admin Only)

```bash
# Get current default template
GET /api/v1/admin/dns-template

# Update default template
PUT /api/v1/admin/dns-template
{ "records": [ ...template records... ] }

# Preview template rendered for a domain
POST /api/v1/admin/dns-template/preview
{ "domain": "example.com", "customer_id": "cust_001" }

# Re-apply template to selected domains (non-destructive)
POST /api/v1/admin/dns-template/reapply
{ "domain_ids": ["domain_001", "domain_003"] }
// or: { "domain_ids": ["all"] }
```

### Per-Domain DNS Record Management (Admin and Customer)

All DNS records on a domain are fully editable after provisioning. There are no template-locked records.

```bash
# List all DNS records for a domain
GET /api/v1/clients/{client_id}/domains/{domain_id}/records

# Add a new record
POST /api/v1/clients/{client_id}/domains/{domain_id}/records
{
  "name": "shop.acme.com.",
  "type": "CNAME",
  "ttl": 300,
  "content": "acme.com."
}

# Update an existing record
PUT /api/v1/clients/{client_id}/domains/{domain_id}/records/{record_id}
{
  "ttl": 600,
  "content": "203.0.113.20"
}

# Delete a record
DELETE /api/v1/clients/{client_id}/domains/{domain_id}/records/{record_id}
```

---

## Template Behaviour: When and How It Is Applied

| Event | Template Applied? | Notes |
|---|---|---|
| New domain added — Primary mode | ✅ Yes, automatically | Full template applied; DKIM key generated |
| New domain added — CNAME mode | ❌ No | Customer manages DNS externally |
| New domain added — Secondary mode | ❌ No | Platform is read-only slave |
| Template updated in Admin Panel | ❌ Not auto-pushed | Admin must use Re-apply tool to push to existing domains |
| Admin re-applies template manually | ✅ Yes, non-destructive | Adds missing / updates changed records; never deletes existing records |
| Admin edits a record post-provisioning | ✅ Always allowed | Full CRUD on all records, no restrictions |
| Customer edits a record post-provisioning | ✅ Always allowed | Full CRUD on all records, no restrictions |
| Domain migrated between regions | ❌ Not re-applied automatically | Admin may manually re-apply if needed after migration |

---

## Autodiscover / Autoconfig Endpoint Requirements

For SRV-based autodiscovery to work end-to-end, the platform's mail server must serve the autodiscovery endpoints that clients are redirected to.

### Microsoft Autodiscover

The platform must serve a valid Autodiscover XML response at:

```
https://mail.platform.com/autodiscover/autodiscover.xml
https://autodiscover.acme.com/autodiscover/autodiscover.xml  (via CNAME)
```

**Example Autodiscover XML response:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>{{platform.imap_hostname}}</Server>
        <Port>993</Port>
        <LoginName>{{email_address}}</LoginName>
        <SSL>on</SSL>
        <SPA>off</SPA>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>{{platform.smtp_hostname}}</Server>
        <Port>465</Port>
        <LoginName>{{email_address}}</LoginName>
        <SSL>on</SSL>
        <SPA>off</SPA>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
```

### Mozilla Autoconfig

The platform must serve a valid autoconfig XML response at:

```
https://mail.platform.com/.well-known/autoconfig/mail/config-v1.1.xml
https://autoconfig.acme.com/mail/config-v1.1.xml                        (via CNAME)
```

**Example Autoconfig XML response:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="{{platform.mail_hostname}}">
    <domain>{{domain.name}}</domain>
    <displayName>{{domain.name}} Mail</displayName>
    <displayShortName>{{domain.name}}</displayShortName>

    <incomingServer type="imap">
      <hostname>{{platform.imap_hostname}}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>

    <outgoingServer type="smtp">
      <hostname>{{platform.smtp_hostname}}</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
```

Both endpoints must be served by the Management API or a dedicated autodiscovery service, with the domain determined from the `Host` header and the CNAME routing to the platform mail server.

---

## Implementation Checklist

### Phase 1 — Template Engine + Default Template

- [ ] Define `dns_templates` DB table
- [ ] Implement template variable resolution engine (substitute `{{variable}}`)
- [ ] Implement DKIM keypair generation at domain provisioning (`opendkim-genkey`)
- [ ] Implement template application at zone creation (called once, automatically, after zone is created)
- [ ] Implement batch PATCH request to external PowerDNS API for template records (non-destructive: REPLACE per rrset, never DELETE zone records)
- [ ] Store the default template in the DB at platform initialisation
- [ ] Implement admin API: GET/PUT `/admin/dns-template`
- [ ] Implement admin API: POST `/admin/dns-template/preview`
- [ ] Implement admin API: POST `/admin/dns-template/reapply` (non-destructive, domain list or "all")
- [ ] Add template application step to domain provisioning workflow in Management API

### Phase 2 — Per-Domain DNS Editor (Admin + Client Panel)

- [ ] Admin panel: per-domain DNS records page (full CRUD — add, edit, delete any record type)
- [ ] Client panel: per-domain DNS records page (full CRUD — add, edit, delete any record type)
- [ ] Validate record content server-side before writing to external PowerDNS API (type-specific format checks)
- [ ] Propagation status indicator per record (show when change has reached all external DNS servers)

### Phase 3 — Template Admin UI

- [ ] DNS Template editor page (YAML editor + record table view)
- [ ] Template preview panel (renders record table for a test domain)
- [ ] Re-apply to Domains page — domain list with Select All / Select None / individual checkboxes, search/filter, progress view

### Phase 4 — Autodiscovery Endpoints

- [ ] Implement `/autodiscover/autodiscover.xml` endpoint (Outlook)
- [ ] Implement `/.well-known/autoconfig/mail/config-v1.1.xml` endpoint (Thunderbird)
- [ ] Route `autodiscover.<customer-domain>` and `autoconfig.<customer-domain>` via Ingress to autodiscovery service
- [ ] Test with Outlook, Thunderbird, Apple Mail, K-9 Mail

---

## Related Documents

- [`./POWERDNS_INTEGRATION.md`](./POWERDNS_INTEGRATION.md) — Zone creation workflow (see "Template Application" step)
- [`./DISPERSED_DNS_ARCHITECTURE.md`](./DISPERSED_DNS_ARCHITECTURE.md) — Multi-region DNS architecture
- [`./DNS_MODE_SELECTION.md`](./DNS_MODE_SELECTION.md) — Primary / CNAME / Secondary mode selection
- [`../06-features/EMAIL_SERVICES.md`](../06-features/EMAIL_SERVICES.md) — Email stack (Postfix, Dovecot, OpenDKIM)
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Admin panel DNS template management UI

---

**Status:** Ready for implementation  
**Estimated Development Time:** 2–3 weeks (template engine + DKIM generation + admin UI + autodiscovery endpoints)  
**Priority:** HIGH — Required for seamless email setup on all new customer domains
