# Cluster Network — Three-Mode Firewall

`scripts/bootstrap.sh` configures the host nftables ruleset based on the
underlay topology of the cluster. There are three modes; bootstrap picks
one automatically based on what's available at install time.

## TL;DR — what gets opened on the public internet

In **every** mode, only these ports face `0.0.0.0/0` (and `::/0`):

| Port | Reason |
|---|---|
| `22/tcp` | SSH |
| `80/tcp`, `443/tcp` | Tenant HTTP(S) |
| `25, 110, 143, 465, 587, 993, 995, 4190 / tcp` | Stalwart mail |
| `51820/udp` | NetBird WireGuard (public-key auth) |
| `51821/udp` | Calico WireGuard (public-key auth) |
| `29899/udp` | NetBird direct connection |
| `icmp`, `icmpv6` | diagnostics |

Cluster-internal control-plane ports — `6443` (kube-API), `8443`
(ingress-nginx admission), `10250` (kubelet), `5473` (Calico Typha),
`2379-2380` (etcd peers), and CIDR-trusted `4789` (Calico VXLAN) — are
**scoped** to peers via one of the three modes below.

## Sysadmin responsibility (before bootstrap)

`bootstrap.sh` does NOT install or enrol VPN/mesh **clients** (NetBird,
Tailscale, etc.) — that's a sysadmin step performed beforehand. It DOES
install kernel `wireguard-tools` since Calico's pod-traffic encryption
relies on the WireGuard userland.

The bootstrap **auto-detects** a mesh underlay at firewall-config time:

- If `wt0` (NetBird) or `tailscale0` has an IPv4 in `100.64.0.0/10`, the
  firewall enters **cidr mode** with `--cluster-network-cidr=100.64.0.0/10`
  by default — **no flag required**.
- The IPv6 sibling is derived from the interface's announced route prefix
  (Tailscale's `/48`, NetBird's ULA range), again no flag required.
- For non-mesh underlays (Hetzner Cloud VLAN, AWS VPC, raw WireGuard,
  ZeroTier, etc.), pass `--cluster-network-cidr <CIDR>` explicitly —
  bootstrap can't auto-detect arbitrary interface names.

If the mesh isn't up when bootstrap runs and no CIDR is passed, the
firewall enters **set mode** instead and a peer-firewall-reconciler
DaemonSet maintains the allowlist from kube-API. Adding a new node in
that mode requires one `peer-firewall-add <new-IP>` call on an existing
peer (see below).

## Mode selection

```
operator passes --cluster-network-cidr ──────┐
                                             │
sysadmin brought up wt0 / tailscale0 ────► auto-detect mesh ─┐
(BEFORE running bootstrap)                   │               │
                                             │               │
HA install (--join-as server|worker) ────────┴──┬────────────┴──► CIDR mode
                                                 │
                                                 ▼
                                            Set mode (Persona C)

single-server install with no peers ──► single mode (no cluster ports open)
```

Set mode + dual-stack + Calico WG behaviour are described below.

## CIDR mode (Personas A & B)

Triggered when `CLUSTER_NETWORK_CIDR` is set explicitly OR a NetBird
(`wt0`) / Tailscale (`tailscale0`) interface is detected at bootstrap
time (default CIDR auto-fills to `100.64.0.0/10`).

Rendered nft rule:

```
ip saddr ${CLUSTER_NETWORK_CIDR} ip protocol tcp accept
ip saddr ${CLUSTER_NETWORK_CIDR} ip protocol udp accept
```

`--node-ip`, `--advertise-address`, and node InternalIP are pinned
to the CIDR-private IP automatically. Cross-node webhook traffic uses
the private IP as source; the firewall accepts it.

### IPv6 — `--cluster-network-cidr-v6`

Auto-detected from the mesh interface's announced route prefix. Set
explicitly with `--cluster-network-cidr-v6 fd7a:115c:a1e0::/48` if your
mesh announces a wider range than the per-host /64. When unset, IPv6
control-plane traffic falls through to default-drop (safe).

### Persona-A example: NetBird mesh

Bootstrap does NOT install or enrol NetBird / Tailscale / any VPN
tooling — that's a sysadmin responsibility, performed BEFORE running
this script. Once the mesh is up, bootstrap auto-detects it.

```bash
# Sysadmin (BEFORE bootstrap):
apt-get install -y netbird   # or curl -fsSL https://pkgs.netbird.io/install.sh | sh
netbird up --management-url https://vpn.example.com --setup-key <UUID>

# Then run bootstrap — auto-detect picks wt0 → 100.64.0.0/10:
./scripts/bootstrap.sh --join-as server \
  --domain example.com --acme-email ops@example.com
```

### Persona-B example: Hetzner Cloud VLAN / AWS VPC / generic private network

```bash
./scripts/bootstrap.sh --join-as server \
  --domain example.com --acme-email ops@example.com \
  --cluster-network-cidr 10.0.0.0/16 \
  --cluster-network-cidr-v6 fd00:10::/48
```

If you want Calico WireGuard scoped to your VLAN as well (default is
public, since that's the only safe choice on mesh underlays):

```bash
./scripts/bootstrap.sh --join-as server ... \
  --cluster-network-cidr 10.0.0.0/16 \
  --calico-wg-public false
```

## Set mode (Persona C — no private network)

Triggered when an HA install runs without `--cluster-network-cidr` and
no mesh interface is present. Rendered rule:

```
ip  saddr @cluster_peers_v4 tcp dport { 6443, 8443, 10250, 5473, 2379-2380 } accept
ip6 saddr @cluster_peers_v6 tcp dport { 6443, 8443, 10250, 5473, 2379-2380 } accept
```

`cluster_peers_v{4,6}` are nft sets. Their members are reconciled by
the **peer-firewall-reconciler DaemonSet** (`platform-system` namespace)
which watches kube-API `Node` objects and reflects every node's
`InternalIP` into the local set on every host.

### Pre-authorising a new peer

A brand-new node hasn't registered with kube-API yet — so the
reconciler doesn't know about it, and the existing peers' nft sets
don't list its IP. The new node would not be able to reach `:6443` to
join.

To bridge the gap, **on any existing peer**, run:

```bash
/usr/local/bin/peer-firewall-add <new-node-IP>
```

That's it. The reconciler propagates the change to all other peers
within ~30 seconds once the new node has joined kube-API. Symmetrically:

```bash
/usr/local/bin/peer-firewall-remove <ip>   # one-off purge for a node that won't reappear
```

The helpers are written by `bootstrap.sh` to every node in set mode.

### When set mode is the right choice

- Multi-cloud HA without a private network or VPN.
- Air-gapped / lab clusters where running a mesh is overkill.
- You want zero operator-side networking config beyond the bootstrap
  flag.

If you'd rather have one CIDR to manage instead of a dynamic peer set,
bring up NetBird or Tailscale before running bootstrap — auto-detect
will switch to CIDR mode.

## Single mode

Triggered when `--join-as` is not passed (or when there's clearly only
one node and no mesh). No cluster-internal ports are opened — single-
server installs don't need them.

To upgrade from single to HA later: re-run bootstrap on each new node
with `--join-as server|worker --cluster-network-cidr <CIDR>` (or with a
mesh up first, for auto-detect).

## Operator kubectl from outside the cluster

`:6443` is now scoped in CIDR and Set modes. To reach kube-API from
your laptop:

- **Persona A**: enrol your laptop in NetBird / Tailscale; kubectl
  works against the wt0 IP.
- **Persona B**: connect to your VLAN / VPC; kubectl works against
  the private IP.
- **Persona C**: SSH-tunnel to a node and use the local kubeconfig:
  ```bash
  ssh -L 6443:127.0.0.1:6443 root@<node>
  KUBECONFIG=~/.kube/staging kubectl ...
  ```
  (or run `peer-firewall-add` for your laptop's public IP — but this
  punches a hole in the design and is not recommended for sustained
  use.)

## Calico WireGuard (UDP/51821) policy

Default: public. Reasoning:

1. Public-key authentication makes the surface effectively zero — WG
   silently drops packets that don't authenticate.
2. Calico advertises its WG endpoint as the underlay (eth0) IP, not
   the mesh-interface IP. Scoping the firewall to the mesh CIDR would
   block legitimate handshakes between peers.

Override with `--calico-wg-public=false` only on Persona B (real
private VLAN / VPC where Calico's underlay can ride the same network).
Never override on a NetBird/Tailscale mesh — the same MTU/path issues
that pushed us off Calico-on-NetBird re-emerge for handshakes.

## CI guardrail

`scripts/ci-firewall-check.sh` (wired into Infrastructure CI) fails
the build if:

- A new `tcp dport <port> accept` line lands in `bootstrap.sh` outside
  the documented public-surface allowlist.
- An `ip saddr` rule is added without a parallel `ip6 saddr` sibling
  (or an explicit `# v4-only:` marker).

This forces every future webhook port to flow through one of the three
scoped modes, not back into the always-open block.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| New node can't join cluster (`:6443` connection refused) | Set mode + new IP not in any peer's `cluster_peers_v4` | Run `peer-firewall-add <new-IP>` on an existing peer |
| Tenant cert issuance hangs at "PresentError" / 5+ min latency | Cross-node admission webhook traffic blocked | Confirm node `InternalIP` matches the trusted CIDR (`kubectl get node -o wide`); for legacy clusters bootstrapped without `--cluster-network-cidr`, see "Carryover" note below |
| `kubectl get nodes` from operator laptop times out | `:6443` scoped to mesh; laptop not on mesh | Enrol laptop in mesh, or SSH-tunnel + use local kubeconfig |
| Reconciler DaemonSet pods crashloop | `cluster_peers` set absent (cluster is in CIDR mode) | DaemonSet should detect and idle; if it doesn't, file a bug |

### Carryover for clusters bootstrapped pre-2026-04-29

Clusters bootstrapped before this change with **no** `--cluster-network-cidr`
have node InternalIPs = public. After applying CIDR mode (e.g. by
auto-detecting wt0), cross-node webhook traffic still uses public
source IPs and gets blocked. Workaround: insert a static peer-IP
allowlist alongside the CIDR rule until the cluster is re-imaged with
the new bootstrap (which pins `--node-ip` to the private IP):

```bash
nft insert rule inet filter input position 0 \
  ip saddr { <peer1>, <peer2>, ... } \
  tcp dport { 6443, 8443, 10250, 5473, 2379-2380 } accept \
  comment "carryover-peers"
```

New clusters bootstrapped with the new code don't need this workaround.
