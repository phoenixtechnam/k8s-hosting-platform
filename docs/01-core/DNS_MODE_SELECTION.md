# DNS Mode Selection Guide

**Document Version:** 1.1
**Last Updated:** 2026-03-24
**Status:** DRAFT — Ready for implementation
**Audience:** Admins, customers, support team

> **ADR-022:** The platform no longer deploys PowerDNS directly. It consumes an
> **external PowerDNS REST API** provided by a separate infrastructure project.
> The API endpoint and credentials are configurable in the admin panel
> (Admin Panel → Settings → DNS → PowerDNS Connection).

---

## Overview

The platform supports **three DNS modes** to accommodate different customer needs and preferences:

1. **Primary Mode** — Platform manages authoritative zones; full DNS control
2. **CNAME Mode** — Platform-agnostic; customers manage DNS elsewhere
3. **Secondary Mode** — Platform is backup DNS; customer's DNS stays primary

Each mode has distinct setup procedures, trade-offs, and use cases. This guide helps admins and customers choose the right mode.

---

## Quick Decision Matrix

| Need | Primary | CNAME | Secondary |
|------|---------|-------|-----------|
| **Platform manages DNS** | ✅ Yes | ❌ No | ❌ No |
| **Customer controls DNS** | ❌ No | ✅ Yes | ✅ Yes |
| **Redundant DNS** | ✅ External NS1/NS2/NS3 | ❌ None | ✅ Customer + External NS |
| **DDoS mitigation** | ✅ Via external NS | ❌ None | ✅ Via customer NS |
| **Setup complexity** | 🟡 Medium | 🟢 Low | 🟡 Medium |
| **Ongoing management** | 🟢 Automatic | 🟡 Manual | 🟢 Automatic |
| **Email (MX/SPF/DKIM)** | ✅ Platform manages | ⚠️ Manual | ✅ Customer manages |
| **SSL certificates** | ✅ DNS-01 ACME | ⚠️ HTTP-01 ACME | ✅ DNS-01 ACME |

---

## Mode 1: Primary DNS (Full Delegation)

### Overview

Platform **manages zones on the external PowerDNS authoritative nameservers** for the customer's domain. Customer delegates nameserver records at their registrar to the configured nameservers.

```
Customer Registrar (GoDaddy, Namecheap)
  ↓ (NS records point to)
External DNS servers (managed by infrastructure project):
  - ns1.example.com (Primary)
  - ns2.example.com (Secondary)
  - ns3.example.com (Tertiary, geo-redundant)
```

### Setup Steps (Admin & Customer)

**Admin Steps:**
1. Customer creates domain in admin panel
2. Select `dns_mode: "primary"`
3. Admin sends customer instructions (nameservers are configured in admin panel):
   ```
   Update your domain registrar:
   Nameserver 1: ns1.example.com
   Nameserver 2: ns2.example.com
   Nameserver 3: ns3.example.com
   ```
4. Admin monitors DNS propagation (TXT record verification)
5. Once propagated, admin enables domain

**Customer Steps:**
1. Log into domain registrar (GoDaddy, Namecheap, etc.)
2. Update nameserver records to the configured nameservers (provided by admin):
   - `ns1.example.com`
   - `ns2.example.com`
   - `ns3.example.com`
3. Wait 24-48 hours for DNS propagation
4. Test with: `dig www.acme.com +short`
5. Email admin once ready

### Configuration Example

**Management API Request:**
```bash
curl -X POST http://api.platform.com/api/v1/clients/client_001/domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "acme.com",
    "dns_mode": "primary"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "domain_042",
    "name": "acme.com",
    "dns_mode": "primary",
    "status": "delegated",
    "dns": {
      "mode": "primary",
      "provider": "powerdns",
      "nameservers": ["ns1.example.com", "ns2.example.com", "ns3.example.com"],
      "records": {
        "A": ["192.0.2.15"],
        "MX": ["mail.platform.com"],
        "TXT": ["v=spf1 include:platform.com ~all", "acme_verification_12345"]
      }
    }
  }
}
```

### What Platform Manages

All records below are provisioned automatically via the **global DNS zone template** the moment the domain is created. No manual DNS configuration is required.

- ✅ **A/AAAA records** — Apex pointing to platform ingress (IPv4 and IPv6)
- ✅ **CNAME www** — `www` subdomain → apex
- ✅ **MX records** — Inbound mail → platform mail server
- ✅ **SPF/DKIM/DMARC** — Email authentication (DKIM keypair generated per domain)
- ✅ **SRV records** — Email client autodiscovery (`_imaps`, `_imap`, `_submissions`, `_submission`, `_autodiscover`)
- ✅ **CNAME webmail / mail / autodiscover / autoconfig** — Email client and webmail routing
- ✅ **CAA records** — Certificate authority authorisation (Let's Encrypt only)
- ✅ **TXT records** — ACME challenges (automatic SSL renewal)
- ✅ **SSL certificates** — Automatic renewal via DNS-01 ACME

The global template is configurable by platform admins (Admin Panel → Settings → DNS → Zone Template). Individual records can be excluded per domain for customers with non-standard requirements (e.g. external mail provider).

See **`DNS_ZONE_TEMPLATES.md`** for the full template specification and record list.

**Admin panel shows:**
- DNS records (view/edit)
- Zone status (propagated/pending)
- DNSSEC status
- Record sync history
- Template exclusions per domain

### Advantages

- 🟢 **Automatic SSL renewal** — ACME DNS-01 method works seamlessly
- 🟢 **Email works immediately** — MX, SPF, DKIM, DMARC, SRV, and autodiscovery all provisioned automatically
- 🟢 **Email client autoconfiguration** — Thunderbird, Outlook, Apple Mail, K-9 all auto-configure via SRV records
- 🟢 **Redundancy** — 3 external nameservers across regions (automatic failover)
- 🟢 **No customer DNS skills needed** — Platform handles everything
- 🟢 **Easy migrations** — Switch between IP addresses instantly via DNS changes

### Disadvantages

- 🔴 **Customer loses DNS control** — Can't manage records directly
- 🔴 **DDoS at external DNS** — Query attacks target the external nameservers
- 🔴 **Single point of failure** — If external DNS down, domain offline
- 🔴 **Customer dependent on platform** — Need trust in DNS uptime SLA

### Ideal For

- Small businesses / bloggers without DNS expertise
- WordPress sites with simple DNS needs
- Customers who want "set it and forget it"
- High-traffic sites needing email (MX/SPF/DKIM)

### Monitoring & Alerts

| Alert | Trigger | Action |
|-------|---------|--------|
| Zone not delegated | NS records at registrar != configured NS after 48h | Email customer reminder |
| AXFR failed | External ns2/ns3 can't sync zone 1+ hour | Page on-call, investigate external DNS API |
| DNSSEC validation failed | Zone has DNSSEC but customer registrar doesn't validate | Disable DNSSEC or guide customer |
| Query spike | >10k queries/sec for single domain | Check ingress logs for DDoS |

---

## Mode 2: CNAME (Platform-Agnostic)

### Overview

Customer keeps their own DNS provider (GoDaddy, Route53, Cloudflare, etc.) and points a **single CNAME record** to platform. Platform routes traffic based on HTTP `Host` header.

```
Customer DNS (GoDaddy, Route53, Cloudflare — customer manages)
  ↓ (CNAME record)
hosting.platform.com  (Platform CNAME target)
  ↓ (routes by HTTP Host header)
Customer's website on platform
```

### Setup Steps (Admin & Customer)

**Admin Steps:**
1. Customer creates domain in admin panel
2. Select `dns_mode: "cname"`
3. Admin sends customer instructions:
   ```
   Create a CNAME record in your DNS provider:
   Name: www.acme.com
   Target: hosting.platform.com
   
   (Repeat for any subdomains you need: api, blog, etc.)
   ```
4. Platform provides stable CNAME target (rotates via least-connection LB)
5. Admin monitors CNAME validation

**Customer Steps:**
1. Log into their DNS provider (GoDaddy, Route53, etc.)
2. Create CNAME record:
   - **Name:** `www.acme.com` (or `api.acme.com`, etc.)
   - **Target:** `hosting.platform.com`
3. Wait 5-30 minutes for DNS propagation
4. Test with: `dig www.acme.com CNAME`
5. Email admin once ready

### Configuration Example

**Management API Request:**
```bash
curl -X POST http://api.platform.com/api/v1/clients/client_001/domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "www.acme.com",
    "dns_mode": "cname"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "domain_043",
    "name": "www.acme.com",
    "dns_mode": "cname",
    "status": "cname_pending",
    "dns": {
      "mode": "cname",
      "cname_target": "hosting.platform.com",
      "instruction": "Create CNAME: www.acme.com → hosting.platform.com"
    }
  }
}
```

### What Platform Does NOT Manage

- ❌ **Customer's DNS records** — Customer responsible for A/AAAA/MX/TXT
- ❌ **Email records** — Customer must configure MX/SPF/DKIM in their DNS
- ❌ **DDoS protection** — Tied to customer's DNS provider's capabilities
- ❌ **DNS failover** — Customer's DNS provider handles redundancy

### What Platform Does Manage

- ✅ **HTTP routing** — Routes traffic by Host header
- ✅ **SSL certificates** — Automatic renewal via HTTP-01 ACME (not DNS-01)
- ✅ **Ingress health checks** — Monitors if CNAME target is alive
- ✅ **IP rotation** (optional) — CNAME target can rotate if platform IPs change

### Advantages

- 🟢 **Customer keeps DNS control** — Full control of all records
- 🟢 **No DNS delegation needed** — Simpler than primary mode
- 🟢 **Customer's DDoS protection** — Benefits from their DNS provider's DDoS mitigation
- 🟢 **Flexibility** — Easy to add extra subdomains (api., blog., etc. — just add CNAME)
- 🟢 **Multi-cloud capable** — Can CNAME to different platforms

### Disadvantages

- 🔴 **Customer must manage email DNS** — Responsible for MX/SPF/DKIM setup
- 🔴 **SSL-01 only** — ACME validation via HTTP-01 (slightly less efficient than DNS-01)
- 🔴 **Email complexity** — Customer must coordinate email provider setup
- 🔴 **Dependency on customer's DNS** — If customer's DNS provider is down, domain is down

### Ideal For

- Developers / tech-savvy customers who want DNS control
- Organizations with existing DNS provider relationships
- Customers who need multi-cloud setup
- Businesses with strict DNS audit requirements

### Email Setup Example (Customer Managed)

Customer must configure in their DNS provider:

```
MX Record:
  Name: acme.com
  Value: mail.platform.com
  Priority: 10

SPF Record:
  Name: acme.com
  Value: v=spf1 include:platform.com ~all

DKIM Record (add platform's DKIM public key):
  Name: default._domainkey.acme.com
  Value: v=DKIM1; k=rsa; p=MIGfMA0BgQDfj...
```

Platform provides these values in admin panel under "Email Setup Instructions".

### Monitoring & Alerts

| Alert | Trigger | Action |
|-------|---------|--------|
| CNAME not resolving | `dig www.acme.com CNAME` returns no results | Email customer reminder |
| SSL certificate pending | HTTP-01 validation not completing | Check CNAME resolution, retry |
| Customer's MX missing | Customer asks why email not working | Provide email setup instructions |

---

## Mode 3: Secondary DNS (Backup DNS)

### Overview

Platform acts as **secondary (slave) nameserver** for customer's domain. Customer's primary DNS stays authoritative; platform pulls zone data via AXFR and responds to DNS queries as backup.

```
Customer's Primary DNS (ns.godaddy.com, route53.aws.com, etc.)
  ↓ (Customer's primary authority)
Zone data stays on customer's primary DNS
  ↓ (AXFR zone transfer every 3600s)
External Secondary DNS (configured nameservers, e.g., ns1.example.com)
  ↓ (Responds to queries, provides redundancy)
Both nameservers respond to queries
```

### Setup Steps (Admin & Customer)

**Admin Steps:**
1. Customer provides primary NS hostname and IP
2. Customer creates domain in admin panel
3. Select `dns_mode: "secondary"`
4. Specify customer's primary NS:
   - `primary_nameserver: "ns.godaddy.com"`
   - `primary_ns_ip: "1.2.3.4"`
5. Platform creates zone in PowerDNS as **Slave** type
6. Platform initiates first AXFR from customer's primary
7. Admin monitors AXFR synchronization
8. Admin sends customer instructions

**Customer Steps:**
1. Log into their registrar/DNS provider
2. Add secondary nameserver:
   - **Nameserver:** configured nameserver (e.g., `ns1.example.com`)
   - **IP:** external DNS server IP (provided by admin)
3. Some providers require SOA notification — admin sends this
4. Wait 24-48 hours for DNS propagation
5. Test with: `dig @ns1.example.com acme.com SOA`

### Configuration Example

**Management API Request:**
```bash
curl -X POST http://api.platform.com/api/v1/clients/client_001/domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "acme.com",
    "dns_mode": "secondary",
    "primary_nameserver": "ns.godaddy.com",
    "primary_ns_ip": "1.2.3.4"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "domain_044",
    "name": "acme.com",
    "dns_mode": "secondary",
    "status": "secondary_pending",
    "dns": {
      "mode": "secondary",
      "provider": "powerdns",
      "primary_nameserver": "ns.godaddy.com",
      "platform_nameserver": "ns1.example.com",
      "platform_ns_ip": "5.6.7.8",
      "instruction": "Add ns1.example.com (5.6.7.8) as secondary nameserver at your registrar",
      "axfr_status": "pending"
    }
  }
}
```

### Zone Transfer (AXFR) Workflow

```
1. Platform creates zone as type=Slave in PowerDNS
   - masters = ["1.2.3.4"]  (customer's primary NS IP)
   
2. Every 3600 seconds (1 hour):
   - External PowerDNS sends AXFR request to customer's primary NS
   - Zone data pulled: A, AAAA, MX, TXT, SOA records
   - Stored in external PowerDNS database
   - ns2/ns3 replicate via internal AXFR

3. DNS queries to external nameservers return zone data:
   - Query: dig @ns1.example.com acme.com A
   - Response: 192.0.2.15 (same as primary NS)
   
4. If customer's primary NS down:
   - AXFR fails
   - Platform continues serving cached zone data (until TTL expires)
   - Alert sent to admin if AXFR fails >1 hour
```

### PowerDNS Configuration

> **Note (ADR-022):** PowerDNS configuration is managed by the infrastructure project.
> The platform interacts with PowerDNS exclusively via its REST API. The examples
> below illustrate the zone structures that the platform creates through API calls.

**Master zone (Primary for platform-managed zones):**
```sql
-- Customer's domain in secondary mode
INSERT INTO zones (id, name, type, account, dnssec, masters)
VALUES (
  'acme-secondary',
  'acme.com.',
  'Slave',
  'customer_001',
  false,
  '1.2.3.4'  -- Customer's primary NS IP
);
```

**Slave servers (ns2, ns3) receive AXFR:**
```sql
-- Slave replicas of secondary zones
-- AXFR from master (ns1) every 5 minutes
-- Configured same as primary zone slaves
-- (Managed by infrastructure project)
```

### What Platform Manages

- ✅ **Accepts AXFR** from customer's primary NS
- ✅ **Stores zone data** in external PowerDNS secondary database
- ✅ **Responds to queries** for backup redundancy via external nameservers
- ✅ **Replicates to ns2/ns3** for internal HA (managed by infrastructure project)
- ✅ **Monitors AXFR health** — alerts if syncs fail

### What Customer Manages

- ✅ **Primary DNS authority** — Customer's primary NS is definitive
- ✅ **All DNS records** — A/AAAA/MX/TXT/CNAME/etc.
- ✅ **Zone updates** — Changes at primary NS, platform syncs
- ✅ **Email (MX/SPF/DKIM)** — Customer controls at primary NS

### Advantages

- 🟢 **Customer keeps full DNS control** — Primary NS stays authoritative
- 🟢 **Backup redundancy** — Platform acts as secondary NS for availability
- 🟢 **Zero setup burden** — Zone transfers automatic (AXFR every hour)
- 🟢 **Auto-sync** — Changes at primary automatically sync to platform
- 🟢 **Email works** — Customer controls MX/SPF/DKIM at primary NS
- 🟢 **Best of both worlds** — Customer DNS + platform redundancy

### Disadvantages

- 🔴 **Dependency on customer's primary NS IP** — Platform needs valid IP to AXFR
- 🔴 **Zone sync delay** — Updates take up to 1 hour to sync (AXFR interval)
- 🔴 **Customer must maintain primary NS** — Platform can't help if customer's NS misconfigured
- 🔴 **DNSSEC complexity** — Requires customer's primary NS to support DNSSEC signing

### Ideal For

- Enterprise customers with DNS teams
- Organizations with compliance/audit requirements
- Customers using cloud DNS (AWS Route53, Google Cloud DNS, Azure DNS)
- Mission-critical domains needing redundancy without delegation
- MSPs / resellers with existing customer DNS relationships

### Example: AWS Route53 + Platform Secondary

Customer has domain in Route53, adds platform as secondary:

```
1. Customer's Setup (AWS Route53):
   - Route53 is primary (ns-xxx.awsdns-xx.com, etc.)
   - All records managed in Route53
   - SOA serial: 1

2. Platform Secondary Setup (Admin):
   POST /domains
   {
     "name": "customer.com",
     "dns_mode": "secondary",
     "primary_nameserver": "ns-123.awsdns-45.com",
     "primary_ns_ip": "1.2.3.4"
   }

3. Customer's Registrar Update:
   - Add secondary: ns1.example.com (5.6.7.8)
   - Wait for sync

4. Ongoing:
   - Customer updates records in Route53
   - Platform syncs via AXFR every 3600s
   - Both Route53 + external nameservers respond to queries
   - If Route53 down, external nameservers provide DNS fallback
```

### Monitoring & Alerts

| Alert | Trigger | Action |
|-------|---------|--------|
| AXFR failed | Zone sync from primary fails >1 hour | Page on-call, check primary NS health and external PowerDNS service |
| Primary NS unreachable | `dig @primary_ip acme.com SOA` times out | Email customer to verify primary NS IP |
| Zone serial stuck | SOA serial unchanged for >24 hours | Likely customer's primary NS down/misconfigured |
| TTL expiration | Cached zone data expires (customer primary still down) | Query primary NS fails; serve stale data with warning |

---

## Comparison Table

| Aspect | Primary | CNAME | Secondary |
|--------|---------|-------|-----------|
| **Customer DNS Control** | ❌ No | ✅ Yes (full) | ✅ Yes (full) |
| **Platform DNS Authority** | ✅ Yes | ❌ No | ⚠️ Backup only |
| **Setup Complexity** | 🟡 Medium | 🟢 Low | 🟡 Medium |
| **DNS Propagation Time** | 24-48h | 5-30m | 24-48h |
| **Email (MX/SPF/DKIM)** | ✅ Platform manages | ⚠️ Customer manages | ✅ Customer manages |
| **SSL Cert Method** | ✅ DNS-01 (seamless) | ⚠️ HTTP-01 (manual) | ✅ DNS-01 (no change) |
| **Redundancy** | ✅ 3 external NS | ❌ Customer's only | ✅ Customer's + external NS |
| **DDoS Protection** | At external DNS | At customer's DNS | Both nameservers |
| **Migration Time** | 1-2 minutes | 1-2 minutes | 5-30 minutes (AXFR) |
| **Customer Knowledge Required** | 🟢 Low | 🟡 Medium (DNS) | 🟡 Medium (DNS) |
| **Ongoing Maintenance** | 🟢 None | 🟡 Customer manages | 🟢 Automatic |
| **Ideal Customer Type** | Novice/SMB | Developer/Savvy | Enterprise/Cloud-native |

---

## Decision Tree

```
START: Customer needs to host domain on platform
  │
  ├─ "I want the platform to manage DNS completely"
  │  └─ Choose: PRIMARY MODE
  │     (Platform manages zones on external authoritative nameservers)
  │
  ├─ "I manage my own DNS (GoDaddy, Route53, Cloudflare)"
  │  │
  │  ├─ "I want full control and flexibility"
  │  │  └─ Choose: CNAME MODE
  │  │     (Point CNAME to platform)
  │  │
  │  └─ "I want backup DNS without giving up control"
  │     └─ Choose: SECONDARY MODE
  │        (External DNS is secondary NS)
  │
  └─ "I'm not sure"
     └─ Default: PRIMARY MODE (simplest for users)
```

---

## Migration Between Modes

### Primary → CNAME

1. Keep primary zone active on external PowerDNS
2. Customer sets up CNAME at their registrar
3. Wait for CNAME to propagate (30 minutes)
4. Admin tests: `dig @8.8.8.8 www.acme.com` resolves via CNAME
5. Admin removes zone delegation request via PowerDNS API
6. Keep zone for internal records only (MX still resolves via primary)

**Gotcha:** Email won't work if customer doesn't set up MX in their DNS

### Primary → Secondary

1. Export primary zone data from external PowerDNS (via API)
2. Customer imports into their primary DNS provider
3. Update zone to type=Slave via PowerDNS API, masters=[customer_primary_ip]
4. Wait for first AXFR
5. Customer adds external NS as secondary at registrar
6. Monitor AXFR health

### CNAME → Secondary

1. Customer sets up their own DNS provider (Route53, etc.)
2. Customer imports domain records
3. Admin creates secondary zone pointing to customer's NS via PowerDNS API
4. Customer adds external NS as secondary
5. Monitor AXFR

### Secondary → Primary

1. Export zone from external PowerDNS secondary (via API)
2. Create new Primary zone on external PowerDNS from export (via API)
3. Customer updates registrar to use configured external nameservers
4. Remove secondary zone config

---

## Troubleshooting

### Primary Mode

**Symptom:** Domain not resolving after 48h
- **Check:** `dig acme.com NS` — should list configured external nameservers
- **Fix:** Verify customer updated registrar correctly

**Symptom:** Email not working
- **Check:** `dig acme.com MX` — should show mail.platform.com
- **Fix:** Platform should auto-create MX; check zone via external PowerDNS API

### CNAME Mode

**Symptom:** CNAME not resolving
- **Check:** `dig www.acme.com CNAME` — should show hosting.platform.com
- **Fix:** Wait for TTL to expire, check customer's DNS provider

**Symptom:** SSL cert pending validation
- **Check:** `dig www.acme.com` — should resolve to platform IP
- **Fix:** Wait for HTTP-01 ACME validation, may take 5 minutes

### Secondary Mode

**Symptom:** AXFR failing
- **Check:** `dig @primary_ns acme.com SOA` — can we query primary?
- **Check:** External PowerDNS logs (check via infrastructure project monitoring)
- **Fix:** Verify primary NS IP, check firewall, enable AXFR in primary

**Symptom:** Zone stuck (stale data)
- **Check:** Query zone serial via external PowerDNS API
- **Fix:** Trigger AXFR via external PowerDNS API

---

## Implementation Checklist

- [ ] **DNS Mode Selection UI** — Admin panel dropdown (primary/cname/secondary)
- [ ] **Domain Object Fields** — Add `dns_mode`, update `dns.mode`, `dns.provider`
- [ ] **API Endpoints** — Update POST /domains with mode parameter
- [ ] **Conditional Logic:**
  - [ ] Primary: Create zone on external PowerDNS via API (type=Primary)
  - [ ] CNAME: Skip PowerDNS zone, set cname_target
  - [ ] Secondary: Create zone on external PowerDNS via API (type=Slave), set masters IP
- [ ] **SSL Certificate Handling:**
  - [ ] Primary: DNS-01 ACME via external PowerDNS API
  - [ ] CNAME: HTTP-01 ACME
  - [ ] Secondary: DNS-01 ACME (no change)
- [ ] **DNS Zone Template (Primary mode):**
  - [ ] Generate DKIM keypair at domain provisioning
  - [ ] Apply global DNS zone template immediately after zone creation (SOA+NS)
  - [ ] Template creates: A, AAAA, CNAME www, MX, SPF TXT, DKIM TXT, DMARC TXT, SRV records (5), CNAME webmail/mail/autodiscover/autoconfig, CAA records
  - [ ] Respect per-domain template exclusions
  - [ ] See `DNS_ZONE_TEMPLATES.md` for full specification
- [ ] **Email Handling:**
  - [ ] Primary: All email DNS auto-provisioned via template (MX/SPF/DKIM/DMARC/SRV)
  - [ ] CNAME: Show instructions for customer to add in their DNS provider
  - [ ] Secondary: Show instructions (customer's primary authority)
- [ ] **Monitoring:**
  - [ ] Primary: Check zone delegation status
  - [ ] CNAME: Check CNAME resolution, SSL validation
  - [ ] Secondary: Monitor AXFR health, check zone sync
- [ ] **Admin Panel:**
  - [ ] Show current DNS mode for each domain
  - [ ] Display mode-specific status (delegated/cname_pending/secondary_active)
  - [ ] Mode-specific instructions/troubleshooting
- [ ] **Customer Panel:**
  - [ ] Show DNS setup instructions (mode-specific)
  - [ ] Display configured external nameserver info (if primary mode)
  - [ ] Display CNAME target (if CNAME mode)
  - [ ] Display external secondary NS info (if secondary mode)

---

## Related Documents

- [`./DNS_ZONE_TEMPLATES.md`](./DNS_ZONE_TEMPLATES.md) — Global DNS zone template specification (SRV, email autodiscovery, all default records)
- [`./POWERDNS_INTEGRATION.md`](./POWERDNS_INTEGRATION.md) — PowerDNS architecture and configuration
- [`../04-deployment/MANAGEMENT_API_SPEC.md`](../04-deployment/MANAGEMENT_API_SPEC.md) — Domain endpoint specs
- [`../02-operations/CLIENT_PANEL_FEATURES.md`](../02-operations/CLIENT_PANEL_FEATURES.md) — Customer-facing DNS setup

---

**Status:** Ready for implementation  
**Estimated Development Time:** 2-3 weeks (API + UI + testing)  
**Priority:** HIGH — Critical for MVP launch (affects all customers)
