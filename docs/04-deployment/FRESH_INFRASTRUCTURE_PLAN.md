# Fresh Infrastructure Deployment Plan

**Document Version:** 2.0
**Created:** 2026-03-11
**Updated:** 2026-03-24 (ADR-022: Architectural separation)
**Status:** ACTIVE — Fresh deployment from scratch
**Audience:** DevOps engineers, infrastructure architects

---

## Overview

This document defines the infrastructure architecture for the fresh deployment of Phoenix Host's **k3s hosting platform**, replacing the previous Ansible-based infrastructure that has been removed.

**Architectural separation (ADR-022):** PowerDNS, NetBird, and Dex are **external services** managed by a separate infrastructure project. This project focuses solely on the k3s cluster and platform workloads.

**Key changes from previous deployment:**
- Server admin1 will be **re-imaged** with fresh OS
- No complex firewall rules or advanced pre/post-routing configurations
- Simplified nftables rules to avoid access issues
- All previous Ansible roles, k8s manifests, and infrastructure config removed
- DNS, VPN mesh, and identity provider are external dependencies (not deployed by this project)

---

## Server Layout

### Server Inventory (This Project)

| Server | Public IP | Role | Location | Specs |
|--------|-----------|------|----------|-------|
| **admin1.phoenix-host.net** | `46.224.122.58` | k3s + Management API + Admin Panel + Client Panel + Phase 1 Workloads | Hetzner (TBD location) | CX32 (4 vCPU, 8GB RAM, 80GB NVMe) |

**Note:** This is a **single-node k3s** cluster in Phase 1, expanding to HA (multi-node) later.

### Prerequisites / External Services

The following services must be running **before** the k3s platform can be deployed. They are managed by a separate infrastructure project.

| Service | Endpoint | Required By |
|---------|----------|-------------|
| **PowerDNS API** | `http://<netbird-ip>:8081` (configurable) | Management API (zone/record management) |
| **NetBird Mesh** | `netbird.phoenix-host.net` | Secure inter-node communication, admin access |
| **Dex (OIDC)** | `https://dex.phoenix-host.net` | Authentication for admin/client panels |

**NetBird mesh IP for admin1:** Will be assigned when admin1 joins the mesh as a peer.

**Note:** The infrastructure project manages ns1, ns2, PowerDNS (primary + secondary), NetBird (management + signal + relay), and Dex. See that project's documentation for DNS server setup, NetBird architecture, and identity provider configuration.

---

## Architecture Decisions

### DNS Server: External Service (PowerDNS)

**External Service** — PowerDNS is deployed and managed by the separate infrastructure project. This platform assumes a PowerDNS REST API is available at a configurable endpoint.

**This project's responsibility:**
- Configure the Management API with the PowerDNS API endpoint and API key (via environment variables / k8s secrets)
- Create zones and records programmatically via the PowerDNS REST API

**See also:** ADR-016, `docs/01-core/DISPERSED_DNS_ARCHITECTURE.md`, `docs/01-core/POWERDNS_INTEGRATION.md`

---

## Infrastructure Components

### 1. DNS (External Service)

**External Service** — PowerDNS (primary + secondary) is deployed and managed by the separate infrastructure project.

**This project consumes:**
- PowerDNS REST API at a configurable endpoint (via NetBird mesh)
- The Management API uses this to create zones, add/update/delete DNS records

**Configuration required:**
- `POWERDNS_API_URL` — e.g., `http://<ns1-netbird-ip>:8081`
- `POWERDNS_API_KEY` — stored as a k8s secret

### 2. NetBird VPN Mesh (External Service)

**External Service** — NetBird management, signal, and relay servers are deployed and managed by the separate infrastructure project. This project assumes the NetBird mesh is already operational.

**This project's responsibility:**
- Join admin1 to the existing NetBird mesh as a **peer**
- Use the mesh for secure communication with PowerDNS API and admin SSH access

**Purpose (unchanged):**
- Secure admin access to the k3s node
- Management API connects to PowerDNS API on ns1 via NetBird mesh
- k3s cluster on admin1 can communicate with ns1/ns2 for DNS operations

### 3. k3s Kubernetes Cluster (admin1)

**Deployment:** Single-node k3s cluster on admin1 (Phase 1)

**Workloads:**
- Management API (Fastify backend + MariaDB)
- Admin Panel (Vite + React frontend)
- Client Panel (Vite + React frontend)
- Phase 1 customer workloads (Starter/Business plan pods)

**Storage:**
- Local path provisioner (default k3s storage class)
- MariaDB: StatefulSet with persistent volume

**Ingress:**
- NGINX Ingress Controller (k3s built-in Traefik disabled via `--disable traefik`; see ADR-010)
- DNS-based routing (A records in PowerDNS point to admin1 public IP)

**Backup:**
- Restic → Hetzner Storagebox (MariaDB dumps, PVC data, k3s manifests)

### 4. Management API (admin1 — k3s pod)

**Stack:** Node.js 22 + Fastify 4 + TypeScript + Knex + MariaDB

**Database:** MariaDB 11 (StatefulSet in k3s)

**API endpoints:**
- `POST /api/v1/auth/token` — JWT authentication
- `GET /api/v1/admin/status` — Health check
- Client CRUD: `GET/POST/PATCH/DELETE /api/v1/admin/clients`
- Domain CRUD: `GET/POST/PATCH/DELETE /api/v1/admin/domains`
- PowerDNS integration: Create zones, add/update/delete records

**Connects to:**
- PowerDNS API (via NetBird mesh at configurable `POWERDNS_API_URL`)
- MariaDB in k3s cluster

**Public endpoint:** `https://admin.phoenix-host.net/api/v1` (NGINX ingress)

### 5. Admin Panel & Client Panel (admin1 — k3s pods)

**Admin Panel:**
- React 18 + Vite + TypeScript + shadcn/ui + Tailwind CSS
- Deployed as static site (nginx container)
- Public endpoint: `https://admin.phoenix-host.net`
- Features: Client management, DNS management, billing, monitoring (see `docs/02-operations/ADMIN_PANEL_REQUIREMENTS.md`)

**Client Panel:**
- React 18 + Vite + TypeScript + shadcn/ui + Tailwind CSS
- Deployed as static site (nginx container)
- Public endpoint: `https://client.phoenix-host.net`
- Features: File manager, email management, database management (see `docs/02-operations/CLIENT_PANEL_FEATURES.md`)

### 6. Backup Infrastructure

**Tool:** Restic → Hetzner Storagebox (SFTP)

**Backup schedule (this project — admin1 only):**
- admin1: 02:30 UTC — MariaDB dump, k3s PVCs, configs

**Note:** Backups for ns1/ns2 (PowerDNS, NetBird) are managed by the infrastructure project.

**Retention:** 7 daily, 4 weekly, 12 monthly (see `docs/02-operations/BACKUP_STRATEGY.md`)

**Backup target:** `u335448-sub9@u335448.your-storagebox.de` (verify credentials with user)

---

## Firewall & Network Security

### Critical Lesson from Previous Deployment

**ISSUE:** Advanced nftables pre-routing and post-routing configurations caused access loss to ns1 server after NetBird configuration changes.

**ROOT CAUSE:** Complex DNAT rules and custom routing chains interacted unpredictably with NetBird's WireGuard interface and Docker's iptables chains.

**SOLUTION FOR FRESH DEPLOYMENT:**

1. **Keep firewall rules simple** — Only essential INPUT, OUTPUT, and FORWARD chains
2. **No advanced pre-routing or post-routing** — Avoid custom DNAT, SNAT, or MASQUERADE rules unless absolutely necessary
3. **No complex NAT chains** — Let Docker and NetBird manage their own NAT
4. **Default policy: DROP on INPUT, ACCEPT on OUTPUT** — Block inbound by default, allow established connections
5. **Whitelist only required ports (admin1):**
   - Port 80 (HTTP — NGINX Ingress, Let's Encrypt challenge) — public
   - Port 443 (HTTPS — NGINX ingress) — public
   - Port 51820 (WireGuard — NetBird peer) — public
   - SSH only via NetBird mesh (no public SSH)

### Recommended nftables Baseline (Simple)

```nft
#!/usr/sbin/nft -f

flush ruleset

table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;
    
    # Allow loopback
    iif "lo" accept
    
    # Allow established/related
    ct state established,related accept
    
    # Allow ICMP (ping)
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    
    # Allow HTTP (NGINX Ingress / Let's Encrypt)
    tcp dport 80 accept

    # Allow HTTPS (NGINX ingress)
    tcp dport 443 accept

    # Allow WireGuard (NetBird peer)
    udp dport 51820 accept
    
    # Allow SSH from NetBird mesh only (not public)
    # (Add NetBird interface name after NetBird is configured)
    # iifname "wt0" tcp dport 22 accept
    
    # Log and drop everything else
    counter drop
  }
  
  chain forward {
    type filter hook forward priority filter; policy accept;
    
    # Allow established/related
    ct state established,related accept
    
    # Docker will add its own rules here
  }
  
  chain output {
    type filter hook output priority filter; policy accept;
  }
}
```

**Rules:**
- ✅ Simple INPUT chain with explicit port allow-list
- ✅ No custom DNAT or SNAT
- ✅ Docker manages FORWARD chain (containers can communicate)
- ✅ OUTPUT policy accept (services can make outbound connections)
- ❌ No pre-routing or post-routing hooks
- ❌ No custom NAT chains

**Docker compatibility:**
- Docker injects its own rules into the FORWARD chain
- After nftables reload, **restart Docker** to restore Docker's chains (see AGENTS.md gotcha #2)

**NetBird compatibility:**
- NetBird creates its own WireGuard interface (`wt0`)
- After NetBird is configured, optionally add: `iifname "wt0" tcp dport 22 accept` to allow SSH only from mesh
- Do not add custom routing rules for NetBird traffic

---

## Deployment Automation Approach

### Decision Point: Ansible, Docker Compose, or Manual?

**Options:**

1. **Rebuild Ansible roles from scratch** (like previous deployment)
   - Pro: Reproducible, idempotent, version-controlled
   - Con: Time-consuming to recreate all roles
   
2. **Docker Compose only** (no configuration management)
   - Pro: Faster to deploy, simpler
   - Con: OS hardening and package installation still manual
   
3. **Manual deployment with documentation** (step-by-step runbook)
   - Pro: Full control, no abstraction
   - Con: Error-prone, not reproducible

**Recommendation:** **Rebuild Ansible roles (Option 1)** — aligned with Phase 1 roadmap.

**Reasoning:**
- Previous Ansible roles worked well (common, k3s, backup)
- Reproducible deployment is critical for disaster recovery
- Phase 1 roadmap (Week 1-2) includes Ansible infrastructure automation
- We can reuse the structure of previous roles while simplifying firewall rules

**Ansible roles in scope for this project:**
- `common` — OS hardening, nftables, Docker CE, fail2ban
- `k3s` — k3s cluster deployment on admin1
- `backup` — Restic backup for admin1

**Out of scope (managed by infrastructure project):**
- ~~`powerdns_master`~~, ~~`powerdns_slave`~~ — DNS servers
- ~~`netbird_management`~~, ~~`netbird_peer`~~ — VPN mesh (admin1 joins as peer via manual setup or infrastructure project playbook)

**Alignment check:** ✅ Phase 1 roadmap (`docs/04-deployment/PHASE_1_ROADMAP.md`) specifies Ansible in Week 1-2.

---

## Phase 1 Deployment Order

### Week 1-2: Infrastructure (Ansible)

**Prerequisites:** External services (PowerDNS, NetBird, Dex) must be running before starting.

1. **Re-image admin1** — Fresh Debian 13 (or Debian 12 stable) on admin1
2. **Ansible: common role** — OS hardening, nftables (simple rules), Docker CE, fail2ban
3. **Join NetBird mesh** — Register admin1 as a peer in the existing NetBird mesh
4. **Verify NetBird connectivity** — admin1 can reach ns1/ns2 via NetBird mesh IPs
5. **Verify DNS** — Confirm PowerDNS API is reachable from admin1 via NetBird mesh
6. **Ansible: backup role** — Deploy Restic backup on admin1
7. **Verify backups** — Trigger manual backup, confirm files appear on Storagebox

### Week 3-4: k3s Cluster & Management API Deployment

8. **Ansible: k3s role** — Deploy k3s on admin1 (single-node cluster)
9. **Deploy MariaDB StatefulSet** — Persistent volume, root password in k8s secret
10. **Run Knex migrations** — Create clients, domains, databases, audit_logs tables
11. **Deploy Management API pod** — Connect to MariaDB and PowerDNS API (via NetBird)
12. **Verify API health** — `GET https://admin.phoenix-host.net/api/v1/admin/status` returns 200 OK
13. **Test API endpoints** — Create client, create domain, add DNS record, verify on ns1/ns2

### Week 5-6: Admin Panel MVP (Next Task)

14. **Scaffold admin panel** — Vite + React + TypeScript + shadcn/ui
15. **Deploy admin panel pod** — Static site, nginx container
16. **Implement client management** — List, create, edit, delete clients
17. **Implement domain management** — List, create, delete domains, add DNS records

---

## Architecture Decisions (User Confirmed)

**Date Confirmed:** 2026-03-11

1. ✅ **Server OS:** **Debian 13 (trixie)** — Official Debian stable release (admin1)

2. ✅ **NetBird setup:** **External service** — admin1 joins existing NetBird mesh as a peer (ADR-022)

3. ✅ **Backup credentials:** **`phoenix-host.key.pub`** — SSH public key for Storagebox authentication
   - Storagebox: `u335448-sub9@u335448.your-storagebox.de`
   
4. ✅ **SSH access:** **Option A + Keep SSH open** — Public SSH during deployment, remain open as break-glass access
   - SSH will remain available on all servers for emergency access
   - Primary access via NetBird mesh once deployed
   
5. ✅ **Ansible connection:** **Confirmed**
   - `ansible_user=root`
   - `ansible_ssh_private_key_file=~/phoenix-host.key`

---

## Deployment Sequence

**Status:** READY TO PROCEED — User confirmed architecture decisions above.

### Phase 1: Ansible Infrastructure (Week 1-2)

**Prerequisites:** External services (PowerDNS, NetBird, Dex) must be operational.

1. ✅ **Create Ansible inventory** — `ansible/inventory/hosts.yml` with admin1 IP and vars
2. ✅ **Create `common` role** — OS hardening, simple nftables (SSH + break-glass), Docker CE, fail2ban
3. ⏳ **Join NetBird mesh** — Register admin1 as a peer in existing NetBird mesh
4. ⏳ **Verify NetBird connectivity** — admin1 can reach ns1/ns2 via mesh, PowerDNS API reachable
5. ⏳ **Create `k3s` role** — Deploy single-node k3s cluster on admin1
6. ⏳ **Create `backup` role** — Deploy Restic backup on admin1 (MariaDB, k3s PVCs, configs)
7. ⏳ **Verify backups** — Trigger manual backup, confirm files appear on Storagebox

---

## Summary

| Component | Technology | Deployment | Location |
|-----------|-----------|-----------|----------|
| **DNS** | PowerDNS 4.9 (external service) | Infrastructure project | ns1, ns2 |
| **VPN Mesh** | NetBird (external service) | Infrastructure project | ns1, ns2; admin1 as peer |
| **Identity Provider** | Dex (external service) | Infrastructure project | ns1 |
| **k3s Cluster** | k3s (single-node Phase 1) | Ansible | admin1 |
| **Management API** | Fastify + MariaDB | k3s pod | admin1 |
| **Admin Panel** | React + Vite | k3s pod (nginx) | admin1 |
| **Client Panel** | React + Vite | k3s pod (nginx) | admin1 |
| **Backups** | Restic → Storagebox | Systemd timer | admin1 |
| **Firewall** | nftables (simple rules) | Ansible | admin1 |
| **Automation** | Ansible 2.15+ | Local workstation | — |

**Alignment:** ✅ All decisions align with `docs/01-core/DISPERSED_DNS_ARCHITECTURE.md`, `docs/ARCHITECTURE_DECISION_RECORDS.md` (ADR-016, ADR-021, ADR-022), and Phase 1 roadmap.

**Firewall:** ✅ Simple nftables rules only — no advanced pre/post-routing to avoid access issues.

**DNS:** ✅ PowerDNS (external service) — REST API consumed by Management API.

**NetBird:** ✅ External service — admin1 joins as a peer.

---

## Future Upgrade Path: HA k3s Cluster

**When to upgrade:**
- Customer workload count exceeds single-node capacity
- High availability becomes a business requirement
- Additional Hetzner servers are provisioned

**Migration steps:**
1. Provision additional server(s) with the `common` Ansible role
2. Join new nodes to the existing k3s cluster (agent or server mode)
3. Update Ansible inventory with new node(s)
4. Redistribute workloads across the cluster

**Note:** NetBird floating IP, DNS failover, and certificate bootstrap topics are managed by the infrastructure project. See ADR-021 and the infrastructure project documentation for those details.
