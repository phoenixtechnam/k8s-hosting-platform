# Private-network bootstrap (`--cluster-network-cidr`)

> **Audience:** operators provisioning a multi-node k3s cluster on
> public-IP-only VPS (Hetzner / Vultr / OVH / etc.) or any topology
> where the nodes are not on a single L2 segment.

## Why

Without a private underlay, every cross-node K8s flow — etcd peer
(`tcp/2379-2380`), Calico Typha (`tcp/5473`), kubelet (`tcp/10250`),
Calico VXLAN (`udp/4789`) — would have to traverse the public
internet. VXLAN especially has no authentication; a malicious peer
could inject pod-network packets directly. We close those ports on
the public interface and only allow them from a private CIDR.

## How it works

`--cluster-network-cidr <cidr>` tells `bootstrap.sh`:

1. **Pick the host's IP from that CIDR** as the kubelet `--node-ip`,
   apiserver `--advertise-address`, and the IP that etcd announces to
   peers.
2. **Generate firewall rules** that allow `udp/4789`, `tcp/5473`,
   `tcp/2379`, `tcp/2380`, `tcp/10250` only from sources inside that
   CIDR. Public-source packets fall through to `policy drop`.
3. **Pin Calico's VXLAN tunnel endpoint** to the private interface via
   `Installation.spec.calicoNetwork.nodeAddressAutodetectionV4.cidrs`.

The public interface keeps `tcp/22, 80, 443, 6443` (operator access +
tenant Ingress). NetBird/WireGuard ports stay public (public-key
authed).

The CIDR choice is committed at first-server bootstrap. Adding a
second server with a different CIDR (or no CIDR) is refused by a
pre-flight check. Switching the underlay later requires a full
cluster rebuild.

## Examples

### NetBird mesh (recommended)

NetBird is the supported overlay for this project. Default CGNAT
range is `100.64.0.0/10`. Bootstrap can bring NetBird up itself:

```bash
# First server:
./bootstrap.sh --join-as server \
  --domain phoenix-host.net --acme-email ops@phoenix-host.net \
  --netbird-management-url https://vpn.phoenix-host.net \
  --netbird-setup-key <UUID>

# Second + third servers (note: --server is the FIRST server's wt0
# IP, NOT its public IP):
./bootstrap.sh --join-as server \
  --server 100.64.1.5 --token K10abc...:server:def... \
  --domain phoenix-host.net --acme-email ops@phoenix-host.net \
  --netbird-management-url https://vpn.phoenix-host.net \
  --netbird-setup-key <UUID>

# Worker:
./bootstrap.sh --join-as worker \
  --server 100.64.1.5 --token K10abc...:server:def... \
  --netbird-management-url https://vpn.phoenix-host.net \
  --netbird-setup-key <UUID>
```

`--cluster-network-cidr` defaults to `100.64.0.0/10` when both
NetBird flags are passed; override with `--cluster-network-cidr
<other>` if you've reconfigured NetBird's CGNAT range.

### Tailscale

Operator brings Tailscale up first:

```bash
# On every node, before bootstrap:
tailscale up --auth-key tskey-auth-...
```

Then:

```bash
./bootstrap.sh --join-as server \
  --domain phoenix-host.net --acme-email ops@phoenix-host.net \
  --cluster-network-cidr 100.64.0.0/10
```

Tailscale uses the same `100.64.0.0/10` range by default. If you've
configured a custom tailnet, use that CIDR instead.

### Hetzner Cloud private network / generic VLAN / ZeroTier

Operator attaches the private interface (`eth1` or whatever) before
bootstrap. The interface needs an IP in a stable CIDR:

```bash
./bootstrap.sh --join-as server \
  --domain phoenix-host.net --acme-email ops@phoenix-host.net \
  --cluster-network-cidr 10.0.0.0/16
```

### Single-server (no HA), public underlay

Skip `--cluster-network-cidr`. Cluster-internal ports stay closed
to the public; you get a single-server install with no path to add
peers later. **Going to HA from this state requires a full rebuild.**

```bash
./bootstrap.sh --join-as server \
  --domain phoenix-host.net --acme-email ops@phoenix-host.net
```

## Pre-flight checks

When joining (`--server` is set), bootstrap validates that the
local CIDR matches the existing cluster's:

```
--server 100.64.1.5 is not inside --cluster-network-cidr 10.0.0.0/16.
  When the existing cluster is private-network-pinned, --server must
  be the control-plane's IP within that CIDR (e.g. its NetBird wt0
  IP), not its public IP.
```

This catches "operator forgot the flag on server-2" — without it the
new server would join etcd announcing its public IP, and quorum could
break under partition.

## Recovery — peer reachability dropped

If the underlay (NetBird mgmt server, VLAN, etc.) goes down and pod-
to-pod traffic stalls, the documented escape hatch is to temporarily
allow cross-public-IP for the affected ports on each peer:

```bash
nft insert rule inet filter input ip saddr <peer-public-ip> udp dport 4789 accept
nft insert rule inet filter input ip saddr <peer-public-ip> tcp dport 5473 accept
nft insert rule inet filter input ip saddr <peer-public-ip> tcp dport 2379 accept
nft insert rule inet filter input ip saddr <peer-public-ip> tcp dport 2380 accept
nft insert rule inet filter input ip saddr <peer-public-ip> tcp dport 10250 accept
```

Remove these rules (`nft delete rule …`) once the underlay is back.

There is intentionally **no `--keep-public-cluster-ports` CLI flag**
— it would encourage operators to leave VXLAN exposed.

## Caveats

### CGNAT collisions

`100.64.0.0/10` (RFC 6598) is the default for both NetBird and
Tailscale, AND is sometimes used by VPS providers' native private
networks. If you're running NetBird on a Hetzner Cloud VPS that also
has a Hetzner private network in `100.x.x.x`, expect routing
conflicts. Either reconfigure NetBird's CGNAT range or use the
Hetzner private CIDR instead.

### Single Calico Installation CR

Calico's `nodeAddressAutodetectionV4.cidrs` is cluster-wide. All
nodes must be on the same private CIDR. You cannot mix NetBird and
Tailscale in one cluster.

### VPN flap during install

If NetBird/Tailscale flaps while k3s is starting, kubelet may bind
to the wrong IP — permanent skew, requires re-bootstrap. The
NetBird convenience helper waits 60 s for `wt0` to acquire an IP
before invoking k3s; if it flaps after that, you'll see kubelet log
errors and need to redo the affected node.

### `--cluster-network-cidr` is one-way

Pinning the underlay at first-server bootstrap is a permanent
commitment. The `--node-ip` cannot be changed without uninstalling
k3s + clearing `/var/lib/rancher/k3s/`. Plan accordingly.

## See also

- `scripts/bootstrap.sh --help` — flag reference + worked examples
- `docs/02-operations/HA_MIGRATION_RUNBOOK.md` — HA growth path (1 → 3 → 5 servers)
- `docs/02-operations/MULTI_NODE_RUNBOOK.md` — operator runbooks for node lifecycle
