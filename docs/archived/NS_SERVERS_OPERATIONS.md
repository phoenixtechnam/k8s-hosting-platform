# NS Servers Operations Guide

**Applies to:** ns1 (`23.88.111.142`, Hetzner Falkenstein) and ns2 (`89.167.125.29`, Hetzner Helsinki)  
**Last Updated:** 2026-03-10 (WireGuard tunnel AXFR; TSIG removed)  
**Status:** Live — both servers provisioned and operational

---

## Overview

ns1 and ns2 are the two external VPS nodes that form the DNS and NetBird mesh foundation of the
platform. They are provisioned entirely via Ansible. **Do not make manual changes** — rerun the
playbook instead.

| Server | Role | NetBird IP | Public IP |
|--------|------|-----------|-----------|
| ns1 | PowerDNS primary + NetBird management | `100.76.182.198` | `23.88.111.142` |
| ns2 | PowerDNS secondary + NetBird peer | `100.76.92.172` | `89.167.125.29` |

**OS:** Debian 13 (trixie)  
**SSH key:** `~/phoenix-host.key`  
**Ansible playbooks:** `ansible/dns.yml`, `ansible/netbird.yml`

---

## Quick Reference

### Run the DNS playbook

```bash
cd ansible
ansible-playbook dns.yml
```

### Run the NetBird playbook

```bash
cd ansible
ansible-playbook netbird.yml
```

### SSH to a server

```bash
ssh -i ~/phoenix-host.key root@23.88.111.142   # ns1
ssh -i ~/phoenix-host.key root@89.167.125.29   # ns2
```

### Check PowerDNS stack on ns1

```bash
ssh -i ~/phoenix-host.key root@23.88.111.142 'docker compose -f /opt/powerdns/docker-compose.yml ps'
```

### Check NetBird peer status

```bash
ssh -i ~/phoenix-host.key root@23.88.111.142 'netbird status'
ssh -i ~/phoenix-host.key root@89.167.125.29 'netbird status'
```

### Access pdns-admin web UI

Browse to `http://100.76.182.198:8082/` from any machine enrolled in the NetBird mesh.
Credentials: created on first login via the setup flow.

---

## Docker Compose Stacks

### ns1 — `/opt/powerdns/`

| Service | Image | Purpose | Ports |
|---------|-------|---------|-------|
| `postgres` | `postgres:16-alpine` | PowerDNS + pdns-admin database backend | internal |
| `pdns` | `powerdns/pdns-auth-49:latest` | Authoritative DNS primary | `0.0.0.0:53` (UDP+TCP), `127.0.0.1:8081` (API) |
| `pdns-admin` | `powerdnsadmin/pda-legacy:latest` | Web UI for DNS zone management | `127.0.0.1:8082` (loopback; DNAT'd from `wt0:8082`) |

### ns2 — `/opt/powerdns/`

| Service | Image | Purpose | Ports |
|---------|-------|---------|-------|
| `pdns` | `powerdns/pdns-auth-49:latest` | Authoritative DNS secondary | `0.0.0.0:53` (UDP+TCP), `127.0.0.1:8081` (API, DNAT'd from `wt0:8081`) |

---

## Known Gotchas and Solutions

These are hard-won discoveries from the provisioning process. Each has a corresponding ADR.

---

### 1. Docker `DOCKER` chain wiped by nftables reload

**Symptom:** After `ansible-playbook dns.yml` changes the nftables config, the next container
start (or restart) fails with:

```
iptables: No chain/target/match by that name
```

**Root cause:** `nft -f /etc/nftables.conf` runs `flush ruleset` which wipes all iptables chains
including Docker's `DOCKER`, `DOCKER-USER`, and `DOCKER-ISOLATION-*` chains. When Docker then
tries to add a port mapping, it references a chain that no longer exists.

**Fix (already in place):** The `common/handlers/main.yml` has a handler that listens for
`Reload nftables` and restarts Docker immediately after:

```yaml
- name: Restart Docker after nftables reload
  ansible.builtin.systemd:
    name: docker
    state: restarted
  failed_when: false
  listen: Reload nftables
```

**If you hit this manually:**

```bash
ssh -i ~/phoenix-host.key root@23.88.111.142 \
  'systemctl restart docker && docker compose -f /opt/powerdns/docker-compose.yml down'
# Then re-run the playbook
ansible-playbook dns.yml
```

See: **ADR-018**

---

### 2. DNAT-to-loopback silently dropped (`route_localnet`)

**Symptom:** pdns-admin is confirmed healthy on `127.0.0.1:8082`, the nftables DNAT rule for
`wt0:8082 → 127.0.0.1:8082` is present, but `curl http://100.76.182.198:8082/` from another
NetBird peer returns `000` (no response).

**Root cause:** Linux default `net.ipv4.conf.all.route_localnet = 0` causes the kernel to drop
packets destined for `127.0.0.0/8` that arrive on a non-loopback interface (`wt0`), even after
prerouting DNAT rewrites the destination.

**Fix (already in place):** `ansible.posix.sysctl` sets `route_localnet = 1` on dns_master in
`common/tasks/main.yml`.

**Verify on ns1:**

```bash
sysctl net.ipv4.conf.all.route_localnet
# Expected: net.ipv4.conf.all.route_localnet = 1
```

See: **ADR-019**

---

### 3. Docker binding to specific non-loopback IP fails

**Symptom:** Docker Compose port binding of the form `{{ specific_ip }}:8082:80` fails at
container start when `specific_ip` is a NetBird WireGuard address (e.g. `100.76.182.198`).

**Root cause:** Docker initialises its `DOCKER` iptables chain only for interfaces known when
the daemon starts. A WireGuard-managed IP on `wt0` is not known to Docker's iptables backend,
so the DNAT rule addition fails.

**Fix:** Bind to `127.0.0.1` and use nftables DNAT from `wt0`. See ADR-017.

---

### 4. `psql` connects to wrong default database

**Symptom:** Ansible task running `psql -U pdns` fails with:

```
FATAL: database "pdns" does not exist
```

**Root cause:** `psql` defaults the database name to the username when `-d` is not specified.
The PowerDNS database user is named `pdns` but the maintenance database is `postgres`.

**Fix:** Always use `-d postgres` for admin queries (checking/creating databases):

```bash
docker compose exec -T postgres psql -U pdns -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='powerdns_admin'"
```

---

### 5. Stale container network state after Docker restart

**Symptom:** After restarting Docker (e.g. to recover from wiped iptables chains), a `docker
compose up` fails trying to "Recreate" a container that already exists in a partially broken
state.

**Fix:** Bring the stack fully down before restarting Docker and running the playbook:

```bash
ssh -i ~/phoenix-host.key root@23.88.111.142 \
  'docker compose -f /opt/powerdns/docker-compose.yml down && systemctl restart docker'
```

---

### 6. nftables DNAT rule and Docker PREROUTING chain coexist

The nftables config adds a `table ip nat { chain prerouting {...} }` block and Docker also
creates a `PREROUTING` chain via `iptables-nft`. Both operate at the `dstnat` priority. This
works because:

- Our `prerouting` chain handles `wt0` traffic and DNATs to `127.0.0.1:8082`
- Docker's `PREROUTING` chain (via iptables-nft) then sees the rewritten destination and jumps
  to `DOCKER` which has its own DNAT rule: `ip daddr 127.0.0.1 tcp dport 8082 → container_ip:80`

The packet is double-DNAT'd (`100.76.182.198:8082` → `127.0.0.1:8082` → `172.18.x.x:80`), which
the kernel connection-tracking handles correctly.

**Verify the full chain:**

```bash
ssh -i ~/phoenix-host.key root@23.88.111.142 'nft list table ip nat'
# Look for: iifname "wt0" tcp dport 8082 dnat to 127.0.0.1:8082
# And:      ip daddr 127.0.0.1 iifname != "br-*" tcp dport 8082 dnat to 172.18.x.x:80
```

---

### 7. ns2 has `/32` Hetzner interface route via internal `enp7s0`

ns2's primary network interface (`eth0`) is a `/32` address. The default gateway is reached via
an internal Hetzner interface (`enp7s0`). This is a Hetzner network topology specific to the
Helsinki location.

NetBird on ns2 reports `connection_ip: 172.19.0.1` (Docker bridge gateway) in `netbird status
--json` output — this is cosmetic. The actual WireGuard P2P tunnel uses the correct public IP
`89.167.125.29` for key exchange.

**Verify P2P is working despite the cosmetic IP:**

```bash
ssh -i ~/phoenix-host.key root@89.167.125.29 'ping -c1 100.76.182.198'
# Should succeed with ~24ms latency (Helsinki → Falkenstein direct)
```

---

### 8. PowerDNS container config file must be mode `0644`

The `powerdns/pdns-auth-49` image runs PowerDNS as uid `953`. The config file mounted at
`/etc/powerdns/pdns.conf` must be mode `0644` — not `0640` — or PowerDNS will fail to read it
at startup with a permissions error.

Ansible template task already enforces `mode: '0644'`.

---

### 9. NetBird `IFaceBlackList` must exclude Docker bridges

NetBird by default advertises all local IPs as WireGuard endpoint candidates, including Docker
bridge IPs (`172.17.x.x`, `172.18.x.x`, etc.). This causes the management server to see
incorrect `connection_ip` values and can interfere with peer connectivity.

The `netbird-client.json.j2` template explicitly blacklists Docker bridge interfaces:

```json
"IFaceBlackList": ["docker0", "br-*", "veth*"]
```

---

### 10. NetBird `store.encryptionKey` must be standard base64

The NetBird management server `config.yaml` requires `store.encryptionKey` to be standard
(not URL-safe) base64-encoded 32 random bytes, **with `=` padding**.

Generate with:

```bash
python3 -c "import base64,os; print(base64.b64encode(os.urandom(32)).decode())"
```

URL-safe base64 (using `-` and `_`) or keys without `=` padding cause the management server to
fail at startup with a cryptic decryption error.

---

### 11. `autosecondary` NOTIFY silently ignored without supermasters entry

**Symptom:** ns2 log shows:
```
Received NOTIFY for phoenix-host.net from 23.88.111.142 for which we are not authoritative, trying autoprimary
Unable to find backend willing to host phoenix-host.net for potential autoprimary 23.88.111.142.
```
Zone never appears on ns2 despite repeated NOTIFY.

**Root cause:** PowerDNS `autosecondary=yes` mode requires the sending primary to be registered
in the `supermasters` (4.9 renamed: `autoprimaries`) table. Without this row, ns2 rejects all
autoprimary NOTIFYs regardless of IP whitelist config.

**Fix (already in place):** Ansible runs `pdnsutil add-autoprimary {{ ns1_public_ip }} ns1.{{ platform_domain }}` on ns2. Verify:

```bash
docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdnsutil list-autoprimaries
# Expected: 23.88.111.142  ns1.phoenix-host.net  (account field empty)
```

---

### 12. Docker userland-proxy masquerades source IP — disabling it is required

**Symptom:** PowerDNS on ns1 or ns2 sees AXFR/NOTIFY source as `172.18.0.1` (Docker gateway)
instead of the real remote IP (e.g. `100.76.92.172`), causing `allow-axfr-ips` and
`allow-notify-from` checks to fail with "client IP has no permission" or "Refused".

**Root cause:** Docker's default `userland-proxy` (docker-proxy) is a userspace process that
receives inbound packets and forwards them to the container. It does not preserve the original
source IP — all forwarded packets appear to come from the Docker bridge gateway (`172.18.0.1`).

**Fix (already in place):** `daemon.json` on both ns1 and ns2 includes `"userland-proxy": false`.
With this setting, Docker uses kernel-level iptables DNAT instead of docker-proxy, which
preserves the original source IP end-to-end.

**Verify:**
```bash
cat /etc/docker/daemon.json | grep userland
# Expected: "userland-proxy": false

# On ns2 (no docker-proxy process for port 53):
ss -lunp | grep :53
# Expected: pdns_server directly (not docker-proxy or dockerd)
```

See: **ADR-021** (new — Docker userland-proxy)

---

### 13. ns2 PowerDNS container uses `network_mode: host` + `cap_add: NET_BIND_SERVICE`

**Context:** ns2's PowerDNS container must use `network_mode: host` so that source IPs are
preserved end-to-end through the NetBird WireGuard interface — even with `userland-proxy: false`,
NetBird's postrouting masquerade chain rewrites the source IP of forwarded packets entering via
`wt0`. Host networking bypasses all Docker NAT and masquerade chains entirely.

With host networking, the container binds port 53 in the host network namespace. The image runs
as uid 953 (pdns). Two things are required to allow uid 953 to bind port 53 without root:

1. `net.ipv4.ip_unprivileged_port_start=53` set via Ansible sysctl — allows any process to bind
   ports ≥ 53 without `CAP_NET_BIND_SERVICE`
2. `cap_add: NET_BIND_SERVICE` in docker-compose.yml — grants the capability explicitly

**Do NOT use `user: root`** — running PowerDNS as root is unnecessary and increases attack surface.

**What's deployed:**
```yaml
# docker-compose.yml on ns2 (Ansible-managed)
pdns:
  image: powerdns/pdns-auth-49:latest
  restart: unless-stopped
  network_mode: host
  cap_add:
    - NET_BIND_SERVICE
  volumes:
    - ./pdns.conf:/etc/powerdns/pdns.conf:ro
    - pdns_sqlite:/var/lib/powerdns
```

**Verify:**
```bash
# On ns2:
docker compose -f /opt/powerdns/docker-compose.yml ps
# Expected: STATUS = Up (not Restarting)

ss -lunp | grep :53
# Expected: pdns_server pid directly on host (no docker-proxy)

# Confirm not running as root:
docker compose -f /opt/powerdns/docker-compose.yml exec pdns id
# Expected: uid=953(pdns) gid=953(pdns)
```

---

### 14. Zone type must be `primary` (not `native`) for AXFR out

**Symptom:** AXFR from ns2 to ns1 fails with:
```
AXFR chunk error: Server Not Authoritative for zone / Not Authorized
```

**Root cause:** Zones created via pdns-admin default to `Native` type. A `Native` zone does not
serve AXFR even if `primary=yes` is set in `pdns.conf`. The zone must be explicitly set to
`Primary` type.

**Fix:** Run on ns1 once per zone:
```bash
docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns \
  pdnsutil set-kind <zone> primary
```

The Management API must also create zones as `kind: "Master"` (the API term for Primary):
```
POST /api/v1/servers/localhost/zones
{"name": "example.com.", "kind": "Master", "nameservers": [...]}
```

**Verify:**
```bash
# On ns1:
docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns \
  pdnsutil show-zone phoenix-host.net | head -1
# Expected: This is a Master zone
```

---

### 15. Zone deletion does not propagate — reconciliation cron required

**Root cause:** The DNS NOTIFY protocol has no "delete zone" message. When a zone is deleted on
ns1 (via REST API or pdns-admin), ns2 retains it indefinitely. There is no built-in PowerDNS
mechanism to remove secondary zones when the primary deletes them.

**Fix (already in place):** A reconciliation script runs every 5 minutes on ns2 (and any future
slaves). It queries ns1's REST API over the NetBird WireGuard tunnel for the authoritative zone
list and deletes any zone that is present locally but absent on ns1.

Key safety guards in the script:
- If ns1 API is unreachable, reconciliation is **skipped entirely** — no zones are deleted
- If ns1 returns an empty list, reconciliation is **skipped** (safety guard against mass deletion)

**Script location on ns2:** `/usr/local/bin/pdns-reconcile-zones.sh`  
**Cron file:** `/etc/cron.d/pdns-reconcile` (runs as root every 5 minutes)  
**Logs:** `journalctl -t pdns-reconcile`

The script uses only REST API calls (no `docker exec`):
- Queries ns1 at `http://100.76.182.198:8081/api/v1` over NetBird
- Queries ns2 locally at `http://127.0.0.1:8081/api/v1`
- Deletes orphan zones via `DELETE /api/v1/servers/localhost/zones/<zone>`

```bash
# Monitor reconciliation logs on ns2:
ssh -i ~/phoenix-host.key root@89.167.125.29 'journalctl -t pdns-reconcile -n 20'

# Run manually to test:
ssh -i ~/phoenix-host.key root@89.167.125.29 '/usr/local/bin/pdns-reconcile-zones.sh'

# Verify cron is installed:
ssh -i ~/phoenix-host.key root@89.167.125.29 'cat /etc/cron.d/pdns-reconcile'
```

**Important — Management API zone deletion requirements:**

When the Management API (to be built) deletes a zone, it **must** call the PowerDNS REST API on
**every primary nameserver** (`ns1` and any future ns nodes). The reconciliation cron on slaves
provides eventual consistency (within 5 minutes), but for immediate deletion, the API should also
trigger the cron or use `pdnsutil delete-zone` on each slave via SSH.

Minimum required steps for zone deletion in the Management API:
1. `DELETE /api/v1/servers/localhost/zones/<zone>` on ns1
2. (Optional but recommended for immediate effect) SSH to each slave and run:
   `docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdnsutil delete-zone <zone>`
3. If step 2 is skipped, the reconciliation cron will clean up within 5 minutes.

ns2's PowerDNS API is enabled and bound to `127.0.0.1:8081`. It is accessible from any NetBird
peer via nftables DNAT (`wt0:8081` → `127.0.0.1:8081`). The Management API can call both ns1
and ns2 REST APIs uniformly over NetBird — no SSH required.

**ns1 API now accessible from ns2 over NetBird (for reconciliation script):**

The nftables config on ns1 adds a DNAT rule and allow rule for `wt0:{{ pdns_api_port }}` from
ns2's NetBird IP. This means the reconciliation script on ns2 can reach:
`http://100.76.182.198:8081/api/v1` via the WireGuard tunnel. This port is **not** accessible
from the public internet — only from NetBird peers.

---

### 16. Docker `127.0.0.1` port binding breaks DNAT from external interfaces

**Symptom:** Service accessible from localhost (`curl http://127.0.0.1:PORT/` returns 200/302)
but connection times out from NetBird peers despite nftables DNAT rule being present and
conntrack confirming the DNAT fires (`[UNREPLIED]` state — SYN sent, no SYN-ACK received).

**Root cause:** When Docker binds a port to `127.0.0.1:PORT`, it uses a `dockerd`-managed socket
(even with `"userland-proxy": false`). When nftables DNAT rewrites an external packet's destination
from e.g. `100.76.182.198:8082` → `127.0.0.1:8082`, `dockerd` receives the SYN. But the kernel
cannot route the SYN-ACK response out through `wt0` because the source address would be `127.0.0.1`
— loopback source addresses cannot egress on non-loopback interfaces, even with `route_localnet=1`.
Conntrack records the entry as `[UNREPLIED]` because no SYN-ACK is ever sent.

**Fix:** Bind to `0.0.0.0:PORT` instead. Docker then uses kernel iptables DNAT directly to the
container IP (e.g. `172.18.0.x`), which has a routable source address. Conntrack reverse-NATing
works correctly. Protect the port from public internet access via the FORWARD chain (see gotcha #17).

**What's deployed on ns1:**
- `pdns-admin`: `0.0.0.0:8082:80`
- PowerDNS API: `0.0.0.0:8081:8081`
- Access restricted by nftables INPUT (localhost + wt0) and FORWARD chain rules

**Diagnostic commands:**
```bash
# Confirm DNAT fires but SYN-ACK never arrives (UNREPLIED):
apt-get install -y conntrack
conntrack -E -p tcp --dport 8082   # watch for [NEW] ... [UNREPLIED] while client connects

# Confirm no packet reaches lo (DNAT-to-loopback is silently failing):
tcpdump -i lo -n tcp port 8082 -c 5

# Confirm packet arrives on wt0 (tunnel is fine, problem is after DNAT):
tcpdump -i wt0 -n tcp port 8082 -c 5
```

---

### 17. Docker `0.0.0.0` port binding exposes ports via FORWARD chain — nftables INPUT rules do not protect them

**Symptom:** Port restricted in nftables INPUT chain (e.g. `tcp dport 8082 iifname "wt0" accept`
then `drop`) is still reachable from the public internet after switching Docker binding to
`0.0.0.0:PORT`.

**Root cause:** Docker's kernel iptables DNAT (for `0.0.0.0`-bound ports) rewrites the destination
to the container IP in PREROUTING. The packet then takes the **FORWARD** path (not INPUT), so
nftables INPUT rules are never evaluated. Docker's own FORWARD chain rules explicitly allow the
traffic regardless of source interface.

**Fix (already in place):** The `chain forward` in `nftables.conf.j2` on `dns_master` hosts
replaces the blanket `oifname "br-*" accept` with an explicit allowlist:

```nftables
# Allow only NetBird (wt0) and loopback → Docker bridge containers
iifname "wt0" oifname "br-*" accept
iifname "lo"  oifname "br-*" accept
oifname "br-*" drop   # blocks eth0 (public internet) and all other interfaces
```

This ensures only NetBird-mesh peers can reach Docker containers, regardless of which port
the service is bound to on the host.

**Verify:**
```bash
# From NetBird peer — must succeed:
curl -sf http://100.76.182.198:8082/ -o /dev/null -w "%{http_code}\n"
# Expected: 302

# From public internet — must timeout (000):
curl --max-time 4 http://23.88.111.142:8082/ -o /dev/null -w "%{http_code}\n"
# Expected: 000
```

---

### 18. nftables `dnat` verdict in nat table chains is terminal — counters placed after it show 0

**Symptom:** Added a counter rule immediately after a `dnat` rule in `table ip nat prerouting` for
debugging. Counter shows `packets 0 bytes 0` even though tcpdump confirms packets are arriving on
the interface and conntrack confirms the DNAT is firing.

**Root cause:** In nftables `nat` table chains, the `dnat` statement is a **terminal verdict** —
it terminates processing of the current chain immediately, just like `accept` or `drop`. Subsequent
rules in the same chain are never evaluated. This differs from `dnat` in `filter` table chains
where it is non-terminal.

**Implication for debugging:** Counters placed after `dnat` rules in nat chains will always show
zero. Use conntrack to verify DNAT is firing instead:

```bash
# Correct way to verify DNAT is firing:
conntrack -E -p tcp --dport 8082
# Look for: [NEW] tcp ... dst=100.76.182.198 dport=8082 [UNREPLIED] src=<dnat-target> ...
# If the reply tuple shows the DNAT target, the rule fired.

# Correct way to count pre-DNAT packets (place counter BEFORE the dnat rule):
nft add rule ip nat prerouting iifname "wt0" tcp dport 8082 counter
# Then add the dnat rule after — but counter must precede dnat in chain order.

# Alternatively, use tcpdump on the input interface:
tcpdump -i wt0 -n tcp port 8082 -c 5
```

---

## WireGuard Tunnel AXFR/NOTIFY Security

AXFR/NOTIFY between ns1 and ns2 is routed exclusively over the NetBird WireGuard mesh (no
public-internet zone transfers). TSIG has been removed — WireGuard provides both authentication
and encryption at the transport layer.

| Property | Status |
|---|---|
| Authenticity | **Yes** — WireGuard public-key authentication |
| Integrity | **Yes** — ChaCha20-Poly1305 AEAD |
| Confidentiality | **Yes** — encrypted in transit |
| Replay protection | **Yes** — WireGuard nonce |

**Transport:** ns1 → ns2 NOTIFY via `also-notify=100.76.92.172:53` (ns2 NetBird IP).
ns2 → ns1 AXFR via primary `100.76.182.198` (ns1 NetBird IP, stored in zone record).

**Enforcement:**
- `allow-notify-from=100.76.182.198` on ns2 — rejects NOTIFYs from any non-tunnel IP
- `allow-axfr-ips=100.76.92.172` on ns1 — rejects AXFR requests from any non-tunnel IP
- ns2 autoprimary registered with ns1's NetBird IP `100.76.182.198` (not public IP)

**Verify the full chain:**

```bash
# 1. Force a NOTIFY from ns1:
ssh -i ~/phoenix-host.key root@23.88.111.142 \
  'docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdns_control notify phoenix-host.net'

# 2. Check ns2 logs — NOTIFY from 23.88.111.142 must be REFUSED:
ssh -i ~/phoenix-host.key root@89.167.125.29 \
  'docker compose -f /opt/powerdns/docker-compose.yml logs --tail=10 pdns'
# Expected:
#   "from 23.88.111.142 but the remote is not providing a TSIG key or in allow-notify-from (Refused)"
#   (no error for 100.76.182.198 — it is accepted silently, triggers SOA check/AXFR)

# 3. Force a zone retrieve (bypasses NOTIFY, tests AXFR path directly):
ssh -i ~/phoenix-host.key root@89.167.125.29 \
  'docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdns_control retrieve phoenix-host.net'
# Then check logs for:
#   "AXFR-in zone: 'phoenix-host.net', primary: '100.76.182.198', zone committed with serial ..."

# 4. Verify zone is current on ns2:
ssh -i ~/phoenix-host.key root@89.167.125.29 \
  'docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdnsutil list-all-zones'
```

---

## Firewall Rules Summary (ns1)

| Port | Proto | Source | Purpose |
|------|-------|--------|---------|
| 22 | TCP | `160.242.115.95` (admin) + rate limit | SSH |
| 53 | UDP+TCP | `0.0.0.0/0` | DNS authoritative |
| 80 | TCP | `0.0.0.0/0` | NetBird ACME HTTP challenge |
| 443 | TCP | `0.0.0.0/0` | NetBird HTTPS (management + dashboard) |
| 3478 | UDP+TCP | `0.0.0.0/0` | NetBird STUN/TURN relay |
| 51820 | UDP | `0.0.0.0/0` | WireGuard data plane |
| 8081 | TCP | `127.0.0.1` + `100.76.92.172` (ns2 NetBird, DNAT'd from wt0) | PowerDNS API |
| 8082 | TCP | `wt0` (NetBird) | pdns-admin UI (DNAT'd from wt0) |

## Firewall Rules Summary (ns2)

| Port | Proto | Source | Purpose |
|------|-------|--------|---------|
| 22 | TCP | `160.242.115.95` (admin) + rate limit | SSH |
| 53 | UDP+TCP | `0.0.0.0/0` | DNS secondary |
| 51820 | UDP | `0.0.0.0/0` | WireGuard data plane |
| 8081 | TCP | `wt0` (any NetBird peer, DNAT'd to `127.0.0.1:8081`) | PowerDNS API |

---

## Troubleshooting

### pdns-admin not loading in browser

1. Check the container is healthy: `docker compose -f /opt/powerdns/docker-compose.yml ps`
2. Check it binds to `127.0.0.1:8082`: ports column should show `127.0.0.1:8082->80/tcp`
3. Check route_localnet: `sysctl net.ipv4.conf.all.route_localnet` → must be `1`
4. Check nftables DNAT: `nft list table ip nat` → look for `wt0 tcp dport 8082 dnat to 127.0.0.1:8082`
5. Test from another NetBird peer: `curl -v http://100.76.182.198:8082/`

### DNS not resolving

```bash
# On ns1 or ns2:
dig @23.88.111.142 phoenix-host.net A    # query ns1 directly
dig @89.167.125.29 phoenix-host.net A    # query ns2 directly
# Check container logs:
docker compose -f /opt/powerdns/docker-compose.yml logs pdns
```

### Zone not on ns2 / AXFR not working

```bash
# Check autoprimary is registered on ns2:
docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdnsutil list-autoprimaries

# Trigger manual NOTIFY from ns1:
docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdns_control notify phoenix-host.net

# Watch ns2 logs for AXFR:
docker compose -f /opt/powerdns/docker-compose.yml logs --tail=20 pdns

# Verify zone exists on ns2:
docker compose -f /opt/powerdns/docker-compose.yml exec -T pdns pdnsutil list-all-zones
```

### NetBird peers not connected

```bash
netbird status   # on each peer
# Look for: Management: Connected, Signal: Connected
# Check peer list for 2/2 Connected
```

### Full re-provision from scratch

If a server is rebuilt from snapshot, the NetBird peer token will be stale. The peer role
generates a one-time setup key via API and re-enrolls only if the peer is not already enrolled.
Force re-enrollment by removing the NetBird state:

```bash
ssh -i ~/phoenix-host.key root@<server_ip> 'netbird down; rm -f /etc/netbird/config.json'
ansible-playbook netbird.yml
```
