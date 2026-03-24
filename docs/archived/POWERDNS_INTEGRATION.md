# PowerDNS Integration Workflow

**Document Version:** 3.1
**Last Updated:** 2026-03-09
**Status:** UPDATED — reflects Docker Compose deployment on ns1 + ns2, pdns-admin deployed
**Audience:** Backend developers, DevOps engineers, platform architects

> **Operations runbook:** See [NS_SERVERS_OPERATIONS.md](../02-operations/NS_SERVERS_OPERATIONS.md)
> for deployment gotchas, troubleshooting steps, and firewall reference.

---

## Overview

**PowerDNS** is the DNS infrastructure component. It runs as a **Docker Compose stack** on two
dedicated VPS nodes (`ns1` and `ns2`) that are co-hosted with NetBird.

### Deployment Reality (Phase 1)

| Node | Location | Role | Backend | Config path |
|------|----------|------|---------|-------------|
| **ns1** (`23.88.111.142`) | Hetzner Falkenstein | PowerDNS **primary** + NetBird management | PostgreSQL 16 (Docker named volume `pdns_pgdata`) | `/opt/powerdns/` |
| **ns2** (`89.167.125.29`) | Hetzner Helsinki | PowerDNS **secondary** + NetBird peer | SQLite (Docker named volume `pdns_sqlite`) | `/opt/powerdns/` |

PowerDNS runs as `powerdns/pdns-auth-49` (Docker image). Both nodes run **Debian 13 (trixie)**.
There is **no bare-metal PowerDNS installation** and **no RNDC** — zone replication uses
PowerDNS 4.9 native AXFR/NOTIFY.

### Three Customer DNS Modes

The platform supports customer choice in DNS management:

| Mode | Role | Use Case | Setup |
|------|------|----------|-------|
| **Primary (Full Delegation)** | Platform is authoritative | Customers delegate domain to `ns1.phoenix-host.net` | Customer changes registrar nameservers |
| **CNAME (Platform DNS-Agnostic)** | Platform routes traffic, no DNS zone | Customers manage DNS elsewhere (GoDaddy, Route53, Cloudflare) | Customer creates CNAME `www → ingress.phoenix-host.net` |
| **Secondary (Backup DNS)** | Platform acts as secondary NS | Customers want redundancy without giving up control | Customer's primary NS stays authoritative, adds ns1/ns2 as secondary |

### Core Capabilities

**PowerDNS** provides:
- **Two-node setup** — ns1 is the authoritative primary; ns2 is a read-only secondary
- **Record management** — API-driven A/AAAA/CNAME/MX/TXT/SPF/DKIM/ACME validation record updates
- **Zone transfer (AXFR/NOTIFY)** — ns1 sends NOTIFY → ns2 pulls zone via AXFR (< 5 seconds)
- **High availability** — ns2 continues serving DNS independently if ns1 is down
- **Performance** — Native caching, sub-millisecond response times
- **Security** — DNSSEC support, AXFR IP whitelisting

This document specifies:
- Architecture and deployment topology (ns1 primary + ns2 secondary)
- Phase 1 configuration details
- Zone provisioning workflow
- Record management (create/update/delete)
- API failure handling and recovery
- Monitoring and alerting

---

## Architecture Overview

### Phase 1: Two-Node Setup (Current)

```
ns1 (Hetzner Falkenstein — 23.88.111.142)
├── Docker Compose stack at /opt/powerdns/
│   ├── pdns (powerdns/pdns-auth-49:latest)
│   │   ├── Port 53 TCP+UDP (public — serves DNS queries)
│   │   └── Port 8081 → mapped to 127.0.0.1:8081 (API — localhost only)
│   ├── pdns-admin (powerdnsadmin/pda-legacy:latest)
│   │   └── Port 80 → mapped to 127.0.0.1:8082 (web UI)
│   │       nftables DNAT: wt0:8082 → 127.0.0.1:8082 (NetBird peers only)
│   │       Access: http://100.76.182.198:8082/ from any NetBird peer
│   └── postgres (postgres:16-alpine)
│       ├── Database: powerdns  (PowerDNS zones/records)
│       ├── Database: powerdns_admin  (pdns-admin users/settings)
│       └── Named volume: pdns_pgdata
│
└── Primary for all customer zones
    ├── Receives API writes from Management API (via NetBird mesh)
    └── Sends NOTIFY to ns2 on zone change

ns2 (Hetzner Helsinki — 89.167.125.29)
├── Docker Compose stack at /opt/powerdns/
│   └── pdns (powerdns/pdns-auth-49:latest)
│       ├── Port 53 TCP+UDP (public — serves DNS queries)
│       └── Named volume: pdns_sqlite
│
└── Secondary for all customer zones
    └── Pulls zones via AXFR on NOTIFY from ns1

Zone Replication Flow:
  ns1 zone change → NOTIFY sent to ns2 → ns2 does AXFR → < 5 seconds propagation
```

### Phase 2+: Multi-Region (Future)

In future multi-region deployments, each region will have its own PowerDNS primary (also
running in Docker Compose). Zone replication between regions uses native AXFR/NOTIFY —
there is no RNDC involvement. Region-to-region AXFR uses the `autosecondary` feature
(PowerDNS 4.9 term for what was previously called `superslave`).

---

## PowerDNS Configuration

### ns1 — Primary Server (`/opt/powerdns/pdns.conf`)

```ini
# PowerDNS Authoritative Server — Primary Configuration
# Runs inside Docker — no setuid/setgid/daemon/guardian needed.
# PowerDNS 4.9 terminology: primary/secondary (master/slave removed).

# Listening — Docker maps 0.0.0.0:53 on the host
local-address=0.0.0.0
local-port=53

# Primary mode
primary=yes
secondary=no

# AXFR — allow ns2 to pull zones
allow-axfr-ips=89.167.125.29

# Notify ns2 on zone changes
also-notify=89.167.125.29

# REST API — bound to 0.0.0.0 inside container; host maps it to 127.0.0.1:8081
api=yes
api-key=<pdns_api_key>
webserver=yes
webserver-port=8081
webserver-address=0.0.0.0
webserver-allow-from=0.0.0.0/0,::/0

# Performance
receiver-threads=4
distributor-threads=4
cache-ttl=20
query-cache-ttl=20
negquery-cache-ttl=60

# Logging — stdout for Docker log collection
log-dns-queries=no
log-dns-details=no
loglevel=4

# Backend — PostgreSQL (postgres service in same Compose network)
launch=gpgsql
gpgsql-host=postgres
gpgsql-port=5432
gpgsql-dbname=powerdns
gpgsql-user=pdns
gpgsql-password=<pdns_db_password>
gpgsql-dnssec=yes
```

**Important notes:**
- `gpgsql-host=postgres` — this is the Docker Compose service name, not `localhost`
- The API is only reachable at `http://127.0.0.1:8081` on the ns1 host (Docker maps port to localhost)
- The Management API must go through the NetBird mesh to reach ns1 and call the PowerDNS API

### ns2 — Secondary Server (`/opt/powerdns/pdns-slave.conf`)

```ini
# PowerDNS Authoritative Server — Secondary Configuration
# Runs inside Docker — no setuid/setgid/daemon/guardian needed.
# PowerDNS 4.9 terminology: primary/secondary (master/slave removed).

local-address=0.0.0.0
local-port=53

# Secondary mode — pulls zones from ns1 via AXFR
primary=no
secondary=yes

# Accept NOTIFY only from ns1
allow-notify-from=23.88.111.142

# Autosecondary — auto-create zones on first NOTIFY from ns1
autosecondary=yes

# AXFR transfer settings
xfr-cycle-interval=60
axfr-fetch-timeout=10

# No API on secondary
api=no
webserver=no

# Logging
log-dns-queries=no
loglevel=4

# Backend — SQLite (persisted on Docker named volume)
launch=gsqlite3
gsqlite3-database=/var/lib/powerdns/pdns.sqlite3
gsqlite3-dnssec=yes
```

### Docker Compose Stack (ns1)

```yaml
# /opt/powerdns/docker-compose.yml
services:

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: "powerdns"
      POSTGRES_USER: "pdns"
      POSTGRES_PASSWORD: "<pdns_db_password>"
    volumes:
      - pdns_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pdns -d powerdns"]
      interval: 5s
      timeout: 5s
      retries: 10

  pdns:
    image: powerdns/pdns-auth-49:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "0.0.0.0:53:53/udp"
      - "0.0.0.0:53:53/tcp"
      - "127.0.0.1:8081:8081"    # API — localhost only
    volumes:
      - ./pdns.conf:/etc/powerdns/pdns.conf:ro

volumes:
  pdns_pgdata:
    driver: local
```

### Docker Compose Stack (ns2)

```yaml
# /opt/powerdns/docker-compose.yml
services:

  pdns:
    image: powerdns/pdns-auth-49:latest
    restart: unless-stopped
    ports:
      - "0.0.0.0:53:53/udp"
      - "0.0.0.0:53:53/tcp"
    volumes:
      - ./pdns-slave.conf:/etc/powerdns/pdns.conf:ro
      - pdns_sqlite:/var/lib/powerdns

volumes:
  pdns_sqlite:
    driver: local
```

### LUA Records Configuration

LUA records are enabled on ns1 to support apex domain ALIAS behaviour without CNAME-at-apex
spec violations. This is required by the DNS Zone Template (see `DNS_ZONE_TEMPLATES.md`
§Default Global Template).

Add to `pdns.conf` on ns1:

```ini
# Enable LUA records (required for apex ALIAS behaviour)
lua-records=yes

# Optional: restrict LUA record network calls to localhost only (security hardening)
# lua-records-exec-limit=1000   # max LUA instructions per record evaluation
```

**How apex LUA records work:**

When a resolver queries `customer.com IN A`, PowerDNS evaluates the LUA function
`ifportup(80, {'<ingress-ip>'})` at query time. It checks whether port 80 is reachable
on each IP in the list and returns only the healthy ones. This achieves the same result
as ALIAS/ANAME without requiring CNAME at the zone apex.

The DNS Ingress Controller manages `ingress.phoenix-host.net` A records. When a worker
node joins or leaves, only `ingress.phoenix-host.net` is updated — all apex LUA records
across all customer zones follow automatically because they evaluate against the live
worker IPs at query time. No per-customer DNS update is required when the worker fleet
changes.

---

## Zone Provisioning Workflow

### 1. New Domain Registration (e.g., acme.com)

#### Step 1: Customer DNS Mode Selection

Admin selects how customer wants to manage DNS:

```json
// Option A: Primary Mode (Platform Manages)
{
  "dns_mode": "primary",
  "customer_id": "customer_001"
}

// Option B: CNAME Mode (Customer-Managed)
{
  "dns_mode": "cname",
  "customer_id": "customer_001"
}

// Option C: Secondary Mode (Backup DNS)
{
  "dns_mode": "secondary",
  "primary_nameserver": "1.2.3.4",  // Customer's primary NS IP
  "customer_id": "customer_001"
}
```

#### Step 2: Create Zone on Primary (ns1)

For PRIMARY mode, create zone on ns1 via the PowerDNS API. The Management API must
reach ns1's API via the NetBird WireGuard mesh:

```http
POST /api/v1/zones HTTP/1.1
Host: 127.0.0.1:8081
X-API-Key: <pdns_api_key>
Content-Type: application/json

{
  "name": "acme.com.",
  "kind": "Native",
  "dnssec": true,
  "nameservers": [
    "ns1.phoenix-host.net.",
    "ns2.phoenix-host.net."
  ]
}
```

**Note:** PowerDNS API requires trailing dot (`.`) on FQDNs.

#### Step 3: PowerDNS Response

```json
{
  "account": "",
  "dnssec": true,
  "id": "acme.com.",
  "kind": "Native",
  "name": "acme.com.",
  "nameservers": [
    "ns1.phoenix-host.net.",
    "ns2.phoenix-host.net."
  ],
  "serial": 2026030901,
  "soa_edit": "AUTO"
}
```

#### Step 4: Apply DNS Zone Template

Immediately after zone creation (SOA + NS only), the **global DNS zone template** is applied.
This populates all standard records — web, email, autodiscovery, and security — in a single
batch request to PowerDNS.

**Pre-step: Generate DKIM Keypair**

Before applying the template, a DKIM keypair is generated for the domain:

```bash
opendkim-genkey -b 2048 -d acme.com -s default -D /etc/opendkim/keys/acme.com/
# Private key → /etc/opendkim/keys/acme.com/default.private  (OpenDKIM signing)
# Public key  → stored as domain.dkim_public_key for template variable resolution
```

**Template Application**

The Management API resolves all `{{variable}}` placeholders and POSTs the full record set
to PowerDNS via a single batch PATCH to `http://127.0.0.1:8081/api/v1/zones/acme.com.`
(via NetBird mesh).

See **`DNS_ZONE_TEMPLATES.md`** for full template specification, variable reference, and
complete PowerDNS batch request.

> **Note:** Template application is skipped for CNAME and Secondary DNS modes.

#### Step 5: Zone Replication to ns2

PowerDNS ns1 automatically sends NOTIFY to ns2 after the zone is created/updated:

```
ns1 zone change → NOTIFY sent to 89.167.125.29 → ns2 pulls zone via AXFR
Propagation: < 5 seconds
```

#### Step 6: Verify Zone Propagation

```python
# Management API waits for both nameservers to have zone before returning success
def verify_zone_propagation(zone_name, timeout=60):
    import dns.resolver
    import time

    nameservers = [
        "23.88.111.142",  # ns1
        "89.167.125.29",  # ns2
    ]

    start_time = time.time()
    while time.time() - start_time < timeout:
        propagated = []

        for ns in nameservers:
            try:
                query = dns.resolver.query(zone_name, "SOA", nameserver=ns)
                propagated.append(ns)
            except:
                pass

        if len(propagated) == len(nameservers):
            return True  # Both nameservers have zone

        time.sleep(2)

    return False  # Timeout

if verify_zone_propagation("acme.com."):
    response = {"status": "active", "nameservers": ["ns1.phoenix-host.net", "ns2.phoenix-host.net"]}
else:
    response = {"status": "pending", "message": "Waiting for DNS propagation to ns2"}
```

**Manual verification:**
```bash
dig @23.88.111.142 acme.com SOA    # ns1 — should be immediate
dig @89.167.125.29 acme.com SOA    # ns2 — should arrive within 5 seconds
```

---

### DNS Record Editing — Full CRUD Access

**Who Can Edit DNS Records:**

| Role | Access | Scope |
|------|--------|-------|
| **Customer** | Full CRUD (Create, Read, Update, Delete) | Only their own domains |
| **Admin** | Full CRUD (Create, Read, Update, Delete) | Any customer's domains |

All writes go to ns1 via `http://127.0.0.1:8081` (reached through NetBird mesh).
ns2 is read-only — it receives zone updates automatically via AXFR.

**Full Record Type Support:**
- **A** - IPv4 address
- **AAAA** - IPv6 address
- **CNAME** - Alias
- **MX** - Mail server (with priority)
- **TXT** - Text records (SPF, DKIM, verification)
- **NS** - Nameserver (for delegated subdomains)
- **SRV** - Service records
- **CAA** - Certificate Authority Authorization
- **And all other standard DNS record types**

---

### Create/Update/Delete DNS Records (Full CRUD Examples)

All API calls target ns1's API endpoint: `http://127.0.0.1:8081` (Management API reaches
this via NetBird mesh from the k3s cluster to ns1).

#### Create A Record for acme.com → 192.0.2.15

```http
PATCH /api/v1/zones/acme.com. HTTP/1.1
Host: 127.0.0.1:8081
X-API-Key: <pdns_api_key>
Content-Type: application/json

{
  "rrsets": [
    {
      "name": "acme.com.",
      "type": "A",
      "ttl": 300,
      "changetype": "REPLACE",
      "records": [
        {
          "content": "192.0.2.15",
          "disabled": false
        }
      ]
    }
  ]
}
```

**Response (204 No Content)** — Record updated

#### Create CNAME for www.acme.com → acme.com

```json
{
  "rrsets": [
    {
      "name": "www.acme.com.",
      "type": "CNAME",
      "ttl": 300,
      "changetype": "REPLACE",
      "records": [
        {
          "content": "acme.com.",
          "disabled": false
        }
      ]
    }
  ]
}
```

#### Create MX Record for mail

```json
{
  "rrsets": [
    {
      "name": "acme.com.",
      "type": "MX",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [
        {
          "content": "10 mail.acme.com.",
          "disabled": false
        }
      ]
    }
  ]
}
```

#### Create TXT Record for SPF Validation

```json
{
  "rrsets": [
    {
      "name": "acme.com.",
      "type": "TXT",
      "ttl": 3600,
      "changetype": "REPLACE",
      "records": [
        {
          "content": "\"v=spf1 include:acme.com ~all\"",
          "disabled": false
        }
      ]
    }
  ]
}
```

#### Create ACME Challenge Record (for Let's Encrypt)

```json
{
  "rrsets": [
    {
      "name": "_acme-challenge.acme.com.",
      "type": "TXT",
      "ttl": 60,
      "changetype": "REPLACE",
      "records": [
        {
          "content": "\"ABC123DEF456GHI789JKL...\"",
          "disabled": false
        }
      ]
    }
  ]
}
```

**Verification:**
```bash
dig @23.88.111.142 acme.com A +short        # ns1 — immediate
dig @89.167.125.29 acme.com A +short        # ns2 — within ~5 seconds
```

---

## DNSSEC Support (Optional Per Domain)

### DNSSEC Overview

DNSSEC cryptographically signs DNS records. PowerDNS **automatically manages** DNSSEC when enabled:
- Generates Key Signing Key (KSK) and Zone Signing Key (ZSK)
- Signs all records with RRSIG
- Generates NSEC/NSEC3 records for authenticated denial of existence
- Automatic key rotation (ZSK every 30 days, KSK every 365 days)

### Enable DNSSEC for Zone

**Management API enables DNSSEC:**

```python
def enable_dnssec(zone_name, api_key):
    url = f"http://127.0.0.1:8081/api/v1/zones/{zone_name}/dnssec"

    payload = {
        "dnssec": True,
        "nsec3param": "1 0 1 abcd1234"  # Optional: NSEC3 instead of NSEC
    }

    headers = {"X-API-Key": api_key}

    response = requests.patch(url, json=payload, headers=headers)

    if response.status_code == 204:
        print(f"DNSSEC enabled for {zone_name}")
        return True
    else:
        print(f"Failed to enable DNSSEC: {response.text}")
        return False
```

### Get DNSSEC Keys and DS Records

```bash
# Get all DNSSEC keys for zone (run on ns1 or via NetBird mesh)
curl -H "X-API-Key: $PDNS_API_KEY" \
  http://127.0.0.1:8081/api/v1/zones/acme.com./dnssec
```

### DNSSEC Validation

```bash
# Query with DNSSEC validation
dig @23.88.111.142 acme.com +dnssec

# Expected response flags:
# - ad (Authenticated Data) = DNSSEC validated
# - RRSIG records in response = zone is signed

# Check DNSKEY records
dig @23.88.111.142 acme.com DNSKEY +dnssec
```

---

## Error Handling and Recovery

### Scenario 1: API Timeout (ns1 API Unreachable)

**Problem:**
```
POST /api/v1/zones failed: Connection refused
Error: Cannot reach 127.0.0.1:8081 via NetBird mesh
```

**Detection:**
- API call times out after 5 seconds
- HTTP 500 or connection reset

**Recovery Steps:**

1. **Retry with exponential backoff**
   ```python
   def create_zone_with_retry(zone_name, max_retries=5):
       for attempt in range(max_retries):
           try:
               response = pdns_api.post(f"/zones/{zone_name}", ...)
               return response
           except ConnectionError:
               wait_time = 2 ** attempt  # 1, 2, 4, 8, 16 seconds
               logger.warning(f"API retry {attempt+1}/{max_retries} in {wait_time}s")
               time.sleep(wait_time)

       raise ZoneProvisioningFailed(f"Cannot create zone after {max_retries} attempts")
   ```

2. **Check PowerDNS health on ns1**
   ```bash
   # On ns1 (via SSH over NetBird mesh):
   docker compose -f /opt/powerdns/docker-compose.yml ps
   docker compose -f /opt/powerdns/docker-compose.yml logs pdns --tail=50

   # Check if container is running
   docker ps | grep pdns

   # Restart if crashed
   docker compose -f /opt/powerdns/docker-compose.yml restart pdns
   ```

3. **ns2 continues serving DNS** while ns1 is down. New zones/records cannot be created
   until ns1 recovers.

4. **Alert operations team**
   ```python
   alerting.send(
       level="CRITICAL",
       title="PowerDNS Primary (ns1) API Unreachable",
       message="Cannot reach ns1 API on 127.0.0.1:8081 via NetBird mesh. Zone provisioning blocked.",
       tags=["powerdns", "infrastructure"]
   )
   ```

---

### Scenario 2: Zone Already Exists (Conflict)

**Problem:**
```
POST /api/v1/zones failed: 422 Unprocessable Entity
Error: { "error": "Zone acme.com. already exists" }
```

**Recovery:**
```python
def create_zone_idempotent(zone_name, records):
    try:
        pdns_api.post(f"/zones", {"name": zone_name, ...})
    except ZoneAlreadyExists:
        existing_zone = pdns_api.get(f"/zones/{zone_name}")

        if existing_zone.tags.get("customer_id") == current_customer_id:
            logger.info(f"Zone {zone_name} already exists for customer")
            return existing_zone
        else:
            raise ZoneNameTaken(f"Zone {zone_name} is already registered")
```

---

### Scenario 3: Zone Not Propagating to ns2

**Problem:**
```
Zone created on ns1, but ns2 doesn't have records yet
Clients updated nameservers to ns1/ns2, but ns2 returns NXDOMAIN
```

**Root Cause:**
- AXFR transfer delayed or failed
- NOTIFY from ns1 lost or blocked

**Diagnosis:**
```bash
# On ns1 — check logs for NOTIFY
docker compose -f /opt/powerdns/docker-compose.yml logs pdns | grep NOTIFY

# On ns2 — check AXFR
docker compose -f /opt/powerdns/docker-compose.yml logs pdns | grep -i axfr

# Manually trigger NOTIFY from ns1
docker compose -f /opt/powerdns/docker-compose.yml exec pdns pdns_control notify acme.com.

# Verify zone on ns2
dig @89.167.125.29 acme.com SOA
```

---

## Backup and Data Management

### Backup PowerDNS Data

**ns1 — PostgreSQL backup:**
```bash
# Dump database (run on ns1)
docker compose -f /opt/powerdns/docker-compose.yml exec postgres \
  pg_dump -U pdns powerdns > powerdns-backup-$(date +%Y%m%d).sql

# Or backup the Docker named volume directly:
docker run --rm \
  -v powerdns_pdns_pgdata:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/pdns_pgdata-$(date +%Y%m%d).tar.gz /data
```

**ns2 — SQLite backup:**
```bash
# Backup the Docker named volume:
docker run --rm \
  -v powerdns_pdns_sqlite:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/pdns_sqlite-$(date +%Y%m%d).tar.gz /data
```

### Restore PowerDNS Data

**ns1 — Restore PostgreSQL:**
```bash
# Stop the pdns container first (leave postgres running)
docker compose -f /opt/powerdns/docker-compose.yml stop pdns

# Restore
docker compose -f /opt/powerdns/docker-compose.yml exec postgres \
  psql -U pdns powerdns < powerdns-backup-20260309.sql

# Start pdns again
docker compose -f /opt/powerdns/docker-compose.yml start pdns
```

---

## Monitoring and Alerting

### Health Check Commands

```bash
# Check ns1 API (run on ns1 or via NetBird mesh)
curl -s -H "X-API-Key: $PDNS_API_KEY" \
  http://127.0.0.1:8081/api/v1/servers/localhost | jq '.id, .zone_count'

# Check Docker container status (run on ns1)
docker compose -f /opt/powerdns/docker-compose.yml ps

# Check ns2 container status (run on ns2)
docker compose -f /opt/powerdns/docker-compose.yml ps

# DNS query tests
dig @23.88.111.142 phoenix-host.net SOA  # ns1
dig @89.167.125.29 phoenix-host.net SOA  # ns2

# Check zone count on ns1
curl -s -H "X-API-Key: $PDNS_API_KEY" \
  http://127.0.0.1:8081/api/v1/zones | jq length
```

### Alerting Rules

```yaml
groups:
  - name: powerdns
    rules:
      # ns1 primary down
      - alert: PowerDNSPrimaryDown
        expr: pdns_primary_up == 0
        for: 1m
        annotations:
          summary: "PowerDNS primary (ns1) is down"
          action: "SSH to ns1 via NetBird mesh, check: docker compose ps"

      # ns2 secondary down
      - alert: PowerDNSSecondaryDown
        expr: pdns_secondary_up == 0
        for: 2m
        annotations:
          summary: "PowerDNS secondary (ns2) is down"

      # API latency high
      - alert: PowerDNSAPILatencyHigh
        expr: pdns_api_response_time_ms > 1000
        for: 5m
        annotations:
          summary: "PowerDNS API response time > 1 second"

      # Zone replication lag (ns2 out of sync)
      - alert: PowerDNSZoneReplicationLag
        expr: pdns_secondary_zone_lag_seconds > 30
        for: 5m
        annotations:
          summary: "Zone replication lag > 30s on ns2"
          action: "Check NOTIFY/AXFR on both nodes"
```

---

## Troubleshooting Guide

### Issue: PowerDNS Container Down on ns1

```bash
# SSH to ns1 via NetBird mesh
ssh admin@23.88.111.142

# Check container status
docker compose -f /opt/powerdns/docker-compose.yml ps

# Check logs
docker compose -f /opt/powerdns/docker-compose.yml logs pdns --tail=100

# Check postgres health
docker compose -f /opt/powerdns/docker-compose.yml logs postgres --tail=50

# Restart stack
docker compose -f /opt/powerdns/docker-compose.yml restart
```

### Issue: Zone Not Resolving on ns1

```bash
# Check zone exists in API (run on ns1)
curl -s -H "X-API-Key: $PDNS_API_KEY" \
  http://127.0.0.1:8081/api/v1/zones/acme.com. | jq .

# Query ns1 directly
dig @23.88.111.142 acme.com A

# Check database contents
docker compose -f /opt/powerdns/docker-compose.yml exec postgres \
  psql -U pdns powerdns -c "SELECT name, type FROM zones WHERE name='acme.com.'"
```

### Issue: ns2 Not Receiving Zone Updates

```bash
# On ns1 — manually trigger NOTIFY
docker compose -f /opt/powerdns/docker-compose.yml exec pdns \
  pdns_control notify acme.com.

# Check ns1 allows AXFR from ns2
docker compose -f /opt/powerdns/docker-compose.yml exec pdns \
  pdns_control show allow-axfr-ips

# On ns2 — check logs for AXFR activity
docker compose -f /opt/powerdns/docker-compose.yml logs pdns | grep -i axfr

# Verify zone on ns2
dig @89.167.125.29 acme.com SOA
```

### Issue: API Returns Unauthorized (403)

```bash
# Verify API key is correct (run on ns1)
curl -s -H "X-API-Key: wrongkey" http://127.0.0.1:8081/api/v1/servers/localhost
# Returns: {"error": "Unauthorized"}

# Get correct API key from Ansible group_vars
grep pdns_api_key /config/hosting-platform/ansible/group_vars/all.yml
```

### Issue: Container Restart Loop After Config Error

```bash
# On ns1 — check for config errors in logs
docker compose -f /opt/powerdns/docker-compose.yml logs pdns | grep -i "error\|fatal"

# Temporarily run with shell to inspect
docker compose -f /opt/powerdns/docker-compose.yml run --rm pdns sh

# Reset failed state if needed
# (not applicable to Docker; just restart the container)
docker compose -f /opt/powerdns/docker-compose.yml down pdns
docker compose -f /opt/powerdns/docker-compose.yml up -d pdns
```

---

## Implementation Checklist

### Phase 1: ns1 + ns2 Setup (Ansible — Week 1)

- [ ] Deploy Ansible roles `powerdns_master` + `powerdns_slave` against fresh ns1 and ns2
- [ ] Verify Docker Compose stacks start on both nodes
- [ ] Verify DNS queries work on both nodes (port 53)
- [ ] Verify PowerDNS API is accessible on ns1 via NetBird mesh
- [ ] Create `phoenix-host.net` zone via API and verify it propagates to ns2
- [ ] Set up DNSSEC keys and validate

### Phase 2: Management API Integration (Week 3-4)

- [ ] Implement zone creation endpoint (Primary/CNAME/Secondary modes)
- [ ] Implement DNS record CRUD endpoints (A, CNAME, MX, TXT, etc.)
- [ ] Implement zone deletion endpoint
- [ ] Add DNS status check endpoint
- [ ] Add zone propagation verification (poll ns2 for < 5s propagation)

### Phase 3: Testing & Validation

- [ ] Integration tests: zone CRUD operations
- [ ] Test zone propagation ns1 → ns2
- [ ] Test DNS query performance (< 10ms target)
- [ ] Test API failure handling and recovery
- [ ] Load test: 100+ domains, 1000+ records

---

## Related Documents

- [`./DISPERSED_DNS_ARCHITECTURE.md`](./DISPERSED_DNS_ARCHITECTURE.md) — DNS architecture (single + multi-region)
- [`./DNS_MODE_SELECTION.md`](./DNS_MODE_SELECTION.md) — Customer DNS mode guide
- [`../04-deployment/MANAGEMENT_API_SPEC.md`](../04-deployment/MANAGEMENT_API_SPEC.md) — API endpoints for zone management
- [`../03-security/SECURITY_ARCHITECTURE.md`](../03-security/SECURITY_ARCHITECTURE.md) — DNS security and DNSSEC

---

**Status:** Updated to reflect Docker Compose deployment on ns1 + ns2 (Phase 1 actual state)
**Deployment:** Ansible roles `powerdns_master` + `powerdns_slave` in `/config/hosting-platform/ansible/`
**Image:** `powerdns/pdns-auth-49:latest` (distro-independent, works on Debian 13 trixie)
**No RNDC** — zone replication uses native PowerDNS AXFR/NOTIFY only
