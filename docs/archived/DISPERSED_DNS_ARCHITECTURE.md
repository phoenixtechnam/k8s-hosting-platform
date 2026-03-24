# Dispersed DNS Architecture (Single + Multi-Region Strategy)

**Document Version:** 2.0
**Last Updated:** 2026-03-09
**Status:** UPDATED — reflects Docker Compose deployment on ns1 + ns2
**Audience:** DevOps engineers, platform architects, DNS administrators

---

## Overview

This document specifies the DNS architecture for the Kubernetes web hosting platform,
supporting both current (single-region) and future (multi-region) deployments.

### Core Strategy

**One PowerDNS primary per region, running in Docker Compose.** PowerDNS runs as
`powerdns/pdns-auth-49` (Docker image) on dedicated VPS nodes. Secondary regions receive
read-only zone replicas via native AXFR/NOTIFY. Customer's primary region (where hosted)
is the authoritative DNS primary and only region that can edit DNS records.

### Key Properties

- **Simple:** One primary per region, not multi-master replication
- **Docker-based:** PowerDNS runs in Docker Compose — distro-independent, easy to backup
- **No RNDC:** Zone replication uses PowerDNS 4.9 native AXFR/NOTIFY, not RNDC
- **Clear Authority:** Customer's primary region owns DNS changes
- **Proven Protocols:** AXFR (zone transfer), NOTIFY (trigger sync)
- **Scalable:** Works identically in single and multi-region deployments

---

## Phase 1: Two-Node Setup (Current)

### Architecture

```
ns1 (Hetzner Falkenstein — 23.88.111.142)
├── Docker Compose at /opt/powerdns/
│   ├── powerdns/pdns-auth-49:latest  (Port 53 public, API :8081 → 127.0.0.1 only)
│   └── postgres:16-alpine            (Named volume: pdns_pgdata)
│
├── PowerDNS PRIMARY for all zones
│   ├── Receives zone writes from Management API (via NetBird mesh)
│   └── Sends NOTIFY → ns2 on every zone change
│
└── NetBird Management server (co-hosted)

ns2 (Hetzner Helsinki — 89.167.125.29)
├── Docker Compose at /opt/powerdns/
│   └── powerdns/pdns-auth-49:latest  (Port 53 public, no API)
│       Named volume: pdns_sqlite
│
├── PowerDNS SECONDARY for all zones
│   └── Pulls zones from ns1 via AXFR on NOTIFY
│
└── NetBird peer (co-hosted)

Zone Replication:
  ns1 change → NOTIFY → ns2 AXFR → < 5 seconds propagation
```

### Zone Management

**API Writes:**
- All DNS changes → ns1 PowerDNS API at `http://127.0.0.1:8081` (via NetBird mesh)
- Management API connects to ns1 API endpoint through the WireGuard mesh
- Records written to PostgreSQL (ns1) → PowerDNS automatically NOTIFYs ns2

**Zone Replication to ns2:**
- ns1 sends NOTIFY to ns2 (89.167.125.29) on every zone add/change/delete
- ns2 pulls full zone via AXFR
- Propagation: < 5 seconds (not minutes)

**Nameservers given to customers:**
- `ns1.phoenix-host.net` (23.88.111.142) — primary, authoritative
- `ns2.phoenix-host.net` (89.167.125.29) — secondary, read-only

### Failure Scenarios (Phase 1)

| Scenario | Impact | Recovery |
|----------|--------|----------|
| **ns1 Docker container crashes** | API writes fail; ns2 continues serving DNS | `docker compose restart pdns` on ns1 |
| **ns1 VPS reboots** | All operations pause during reboot (~2-3 min); ns2 serves DNS | Automatic (Docker auto-restarts on boot) |
| **ns2 Docker container crashes** | DNS queries fail on ns2; ns1 still serves | `docker compose restart pdns` on ns2 |
| **PostgreSQL (ns1) down** | PowerDNS on ns1 cannot serve zones | Restore from `pdns_pgdata` volume backup |
| **Network between ns1 and ns2** | AXFR blocked; ns2 serves stale zones until connectivity restores | Fix network; zones re-sync automatically |

---

## Phase 2+: Multi-Region Deployment (Future)

### Architecture

```
Frankfurt Region (Primary)       Strasbourg Region (Primary)
└── ns1-de.platform.com          └── ns1-fr.platform.com
    Docker Compose                   Docker Compose
    ├── pdns-auth-49 (PRIMARY)       ├── pdns-auth-49 (PRIMARY)
    │   PostgreSQL backend           │   PostgreSQL backend
    └── API writes (de customers)    └── API writes (fr customers)

Zone Replication:
  ns1-de → NOTIFY → ns1-fr AXFR (secondary for de zones)
  ns1-fr → NOTIFY → ns1-de AXFR (secondary for fr zones)
```

In multi-region: each region's PowerDNS is the primary for customers hosted in that region.
Other regions' PowerDNS instances are autosecondaries (they auto-create zones on first NOTIFY).

**PowerDNS 4.9 `autosecondary=yes`** enables this — it replaces the old `superslave=yes` directive.

### Zone Assignment by Customer Region

Each customer domain is managed by their **primary region** (where customer is hosted):

```
Customer: acme.com (hosted in Frankfurt)
├── Primary: ns1-de.platform.com (Frankfurt) ← CAN EDIT via API
├── Secondary: ns1-fr.platform.com (Strasbourg, read-only via AXFR)
└── Nameservers returned: ns1-de, ns1-fr, ns2-de, ns2-fr

Customer: corp.fr (hosted in Strasbourg)
├── Primary: ns1-fr.platform.com (Strasbourg) ← CAN EDIT via API
├── Secondary: ns1-de.platform.com (Frankfurt, read-only via AXFR)
└── Nameservers returned: ns1-fr, ns1-de, ns2-fr, ns2-de
```

### Zone Management: Full CRUD Access in Primary Region

**DNS Record Types Fully Editable:**
- A, AAAA (IP addresses)
- CNAME (aliases)
- MX (mail servers)
- TXT (text records for SPF, DKIM, etc.)
- NS (nameservers for subdomains)
- SRV (service records)
- And all other standard DNS record types

**API Writes (Primary Region Only):**
```
Customer in Frankfurt edits acme.com DNS
  ↓
Request → ns1-de PowerDNS API (read-write)
  ↓
Record created/updated/deleted in PostgreSQL
  ↓
Zone updated on ns1-de (primary)
  ↓
NOTIFY → ns1-fr, ns2-de, ns2-fr (autosecondary, read-only via AXFR)
```

**Cross-Region Editing Blocked (Secondary Region):**
```javascript
// Management API validation (Phase 2+)
if (customerPrimaryRegion !== requestRegion) {
  return 403 {
    "error": "Forbidden",
    "message": "Cannot edit DNS for customers in other regions",
    "details": {
      "customerRegion": "frankfurt",
      "requestRegion": "strasbourg",
      "hint": "Customer is hosted in frankfurt. Log in to frankfurt admin panel to edit DNS."
    }
  };
}
```

---

## DNS Configuration Details

### Phase 1: Primary Configuration (ns1)

**PowerDNS Configuration (`/opt/powerdns/pdns.conf`):**
```ini
# Runs inside Docker (powerdns/pdns-auth-49)
# PowerDNS 4.9 — primary/secondary terminology

local-address=0.0.0.0
local-port=53

# Primary mode (4.9 setting — old 'master=yes' is removed)
primary=yes
secondary=no

# AXFR — allow ns2 to pull zones
allow-axfr-ips=89.167.125.29

# Notify ns2 on zone changes
also-notify=89.167.125.29

# REST API — mapped to 127.0.0.1 on host via Docker port binding
api=yes
api-key=<pdns_api_key>
webserver=yes
webserver-port=8081
webserver-address=0.0.0.0

# Backend — PostgreSQL (Docker Compose service name 'postgres')
launch=gpgsql
gpgsql-host=postgres
gpgsql-port=5432
gpgsql-dbname=powerdns
gpgsql-user=pdns
gpgsql-password=<password>
gpgsql-dnssec=yes
```

**Key differences from old bare-metal docs:**
- `primary=yes` (not `master=yes` — renamed in 4.9)
- `gpgsql-host=postgres` (Docker service name, not localhost/127.0.0.1)
- Config at `/opt/powerdns/pdns.conf` (not `/etc/powerdns/pdns.conf`)
- No `axfr-master-only` (removed in 4.9), no `api-readonly` (removed in 4.9)
- **No RNDC** — removed entirely; native AXFR/NOTIFY handles all zone replication

### Phase 1: Secondary Configuration (ns2)

**PowerDNS Configuration (`/opt/powerdns/pdns-slave.conf`):**
```ini
# Runs inside Docker (powerdns/pdns-auth-49)
# PowerDNS 4.9 — primary/secondary terminology

local-address=0.0.0.0
local-port=53

# Secondary mode (4.9 setting — old 'slave=yes' is removed)
primary=no
secondary=yes

# Accept NOTIFY only from ns1
allow-notify-from=23.88.111.142

# Autosecondary — auto-create zones on first NOTIFY
# (old name was 'superslave=yes')
autosecondary=yes

# AXFR transfer settings
xfr-cycle-interval=60
axfr-fetch-timeout=10

# No API on secondary
api=no
webserver=no

# Backend — SQLite (Docker named volume pdns_sqlite)
launch=gsqlite3
gsqlite3-database=/var/lib/powerdns/pdns.sqlite3
gsqlite3-dnssec=yes
```

### Phase 2: Multi-Region Secondary Configuration

In Phase 2, additional regional servers that act as autosecondaries for other regions:

```ini
# Runs inside Docker (powerdns/pdns-auth-49)
# Strasbourg server — primary for fr customers, secondary for de customers

primary=yes     # authoritative for its own customers' zones
secondary=yes   # pulls other regions' zones via AXFR

# Accept NOTIFY from Frankfurt primary
allow-notify-from=<frankfurt-ns1-ip>

# Autosecondary — auto-create zones pulled from Frankfurt
autosecondary=yes
# (old name was 'superslave=yes')

# Allow Frankfurt to pull zones back (for Frankfurt customers' zones on this server)
allow-axfr-ips=<frankfurt-ns1-ip>

# API — for this region's Management API
api=yes
api-key=<strasbourg-api-key>
webserver=yes
webserver-port=8081
webserver-address=0.0.0.0

# Backend — PostgreSQL
launch=gpgsql
gpgsql-host=postgres
gpgsql-port=5432
gpgsql-dbname=powerdns
gpgsql-user=pdns
gpgsql-password=<password>
gpgsql-dnssec=yes
```

---

## DNSSEC Support (Optional Per Domain)

### Overview

DNSSEC cryptographically signs DNS records. Support is **optional per domain** and can be
enabled/disabled by customers or admins.

### DNSSEC in Multi-Region

When zone replicates to secondary regions via AXFR:
1. Primary region signs zone with KSK + ZSK
2. DNSSEC signatures replicate via AXFR to secondary regions
3. Secondary regions serve the signed zone (same signatures)
4. Validating resolvers can verify chain: DS → DNSKEY → RRSIG

### DNSSEC Validation

```bash
# Test DNSSEC validation
dig @23.88.111.142 acme.com +dnssec
# Response should include RRSIG records and 'ad' (authenticated data) flag

# Verify DS chain
dig @23.88.111.142 acme.com DS +dnssec
```

---

## API Endpoints for DNS Management

### Phase 1 (Two-Node — ns1 + ns2)

All management API calls go to ns1 via NetBird mesh:

```bash
# Create/Update DNS records
PUT /api/v1/clients/{clientId}/domains/{domainId}/records

# Check DNS propagation (checks both ns1 and ns2)
GET /api/v1/clients/{clientId}/domains/{domainId}/dns-status
```

### Phase 2+ (Multi-Region)

```bash
# Create/Update DNS records (only in primary region)
# Returns 403 if customer is in different region
PUT /api/v1/clients/{clientId}/domains/{domainId}/records

# Get zone status (works in all regions, read-only elsewhere)
GET /api/v1/clients/{clientId}/domains/{domainId}/dns-status
```

---

## Customer-Facing Configuration

### Phase 1: Nameserver Setup

When customer adds domain in admin panel:

```
Step 1: Select DNS mode
├── Primary (Platform manages)
├── CNAME (Customer-managed)
└── Secondary (Backup DNS)

Step 2: Platform provides nameservers
├── ns1.phoenix-host.net (23.88.111.142) — Primary
└── ns2.phoenix-host.net (89.167.125.29) — Secondary
    "Update your domain registrar to point to these nameservers"

Step 3: Verify DNS
├── Check if customer has updated registrar
├── DNSSEC validation (optional)
└── Confirm zone is live on both ns1 and ns2
```

### Phase 2+: Regional Nameserver Setup

When customer migrates or is created in new region, nameservers are updated to reflect
their new primary region's ns1 as the authoritative server.

---

## Implementation Checklist

### Phase 1: Two-Node Setup (Ansible — Week 1)

- [ ] **Ansible deploy** — run `powerdns_master` role against ns1
- [ ] **Ansible deploy** — run `powerdns_slave` role against ns2
- [ ] **Verify DNS** — `dig @23.88.111.142 phoenix-host.net SOA` returns SOA
- [ ] **Verify replication** — create test zone on ns1 → confirm it appears on ns2 within 5s
- [ ] **Verify API** — `curl -H "X-API-Key: $KEY" http://127.0.0.1:8081/api/v1/servers/localhost`
- [ ] **DNSSEC** — enable and test for platform zone

### Phase 1: Management API Integration (Week 3-4)

- [ ] Implement DNS record CRUD endpoints
- [ ] Add zone creation/deletion endpoints
- [ ] Implement zone verification (TXT record check)
- [ ] Add DNS status check endpoint (poll both ns1 and ns2)

### Phase 2: Multi-Region (Future)

- [ ] Deploy PowerDNS Docker stack in second region
- [ ] Configure autosecondary between regions
- [ ] Test zone replication latency (target: < 5 seconds)
- [ ] Implement region validation in DNS edit API

---

## Monitoring & Alerting

### Key Metrics

```yaml
DNS Metrics:
  - ns1 API response time (target: < 100ms)
  - ns1 DNS query response time (target: < 10ms)
  - ns2 DNS query response time (target: < 10ms)
  - Zone replication lag (ns1 → ns2, target: < 5 seconds)
  - Docker container health (both nodes)

Alerts:
  - PowerDNS container down on ns1 (critical)
  - PowerDNS container down on ns2 (warning)
  - Zone not updated on ns2 (warning, if > 30 seconds)
  - DNS query latency > 100ms (warning)
  - PostgreSQL down on ns1 (critical)
```

### DNS Status Dashboard (Grafana)

```
DNS Status Dashboard
├── ns1 Status
│   ├── Container health (running/stopped)
│   ├── API availability
│   ├── Query response time
│   ├── Zone count
│   └── Record count
├── ns2 Status
│   ├── Container health
│   ├── Query response time
│   └── Zone count (should match ns1)
└── Replication Health
    ├── NOTIFY success rate
    ├── AXFR transfer count
    └── Zone staleness (ns2 behind ns1)
```

---

## Security Considerations

### AXFR Restrictions

```ini
# On ns1 — only allow AXFR from ns2 IP
allow-axfr-ips=89.167.125.29
```

### API Security

```ini
# API only reachable from localhost on the ns1 host
# Docker port binding: 127.0.0.1:8081:8081
# Management API must go through NetBird WireGuard mesh to reach it
api-key=<strong-random-key>
```

### Audit Logging

```json
{
  "timestamp": "2026-03-09T10:00:00Z",
  "action": "DNS_RECORD_UPDATED",
  "user": "admin@example.com",
  "customer": "acme.com",
  "zone": "acme.com",
  "recordType": "TXT",
  "recordName": "default._domainkey.acme.com",
  "oldValue": "v=DKIM1; k=rsa; p=...",
  "newValue": "v=DKIM1; k=rsa; p=...new",
  "source": "admin_panel"
}
```

---

## Disaster Recovery

### ns1 Backup & Restore

```bash
# Backup PostgreSQL data (Docker volume)
docker run --rm \
  -v powerdns_pdns_pgdata:/data \
  -v /backups:/backup \
  alpine tar czf /backup/pdns_pgdata-$(date +%Y%m%d).tar.gz /data

# Restore
docker compose -f /opt/powerdns/docker-compose.yml down
docker run --rm \
  -v powerdns_pdns_pgdata:/data \
  -v /backups:/backup \
  alpine sh -c "cd / && tar xzf /backup/pdns_pgdata-20260309.tar.gz"
docker compose -f /opt/powerdns/docker-compose.yml up -d
```

### ns2 Backup & Restore

```bash
# Backup SQLite data (Docker volume)
docker run --rm \
  -v powerdns_pdns_sqlite:/data \
  -v /backups:/backup \
  alpine tar czf /backup/pdns_sqlite-$(date +%Y%m%d).tar.gz /data

# Note: ns2 can also rebuild its zones from scratch by receiving AXFR from ns1.
# Rebuild procedure:
# 1. Stop container, wipe volume
# 2. Start container with empty SQLite
# 3. Manually notify for all zones: pdns_control notify <zone> (on ns1)
# 4. ns2 will re-pull all zones via AXFR
```

---

## Summary

| Aspect | Phase 1 | Phase 2+ |
|--------|---------|----------|
| **DNS Runtime** | Docker Compose (`powerdns/pdns-auth-49`) | Docker Compose (same image) |
| **DNS Primaries** | 1 (ns1, Falkenstein) | 1 per region |
| **DNS Secondaries** | 1 (ns2, Helsinki) | 1+ per region |
| **Zone Replication** | NOTIFY + AXFR (< 5s) | NOTIFY + AXFR between regions |
| **Zone Authority** | ns1 primary only | Customer's region primary |
| **API Endpoint** | `http://127.0.0.1:8081` on ns1 (via NetBird mesh) | One per region primary |
| **Backend (primary)** | PostgreSQL 16 (Docker named volume `pdns_pgdata`) | PostgreSQL per region |
| **Backend (secondary)** | SQLite (Docker named volume `pdns_sqlite`) | SQLite or PostgreSQL |
| **RNDC** | **None** (removed) | **None** |
| **Config path** | `/opt/powerdns/` | `/opt/powerdns/` |
| **RTO** | ~2-3 min (Docker restart) | ~2-3 min per node |
| **RPO** | < daily backup | < daily backup |

---

## Next Steps

1. **Deploy Phase 1** — Run Ansible playbooks against fresh ns1 and ns2 (after OS rebuild)
2. **Verify zone replication** — Create platform zone, confirm < 5s propagation to ns2
3. **Integrate Management API** — Connect zone/record CRUD to PowerDNS API via NetBird mesh
4. **Monitor** — Set up Prometheus scraping for PowerDNS metrics on ns1
5. **Plan Phase 2** — When second region is needed, deploy same Docker Compose stack
