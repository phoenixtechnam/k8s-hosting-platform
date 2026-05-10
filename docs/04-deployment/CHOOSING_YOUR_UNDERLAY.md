# Choosing Your Underlay

The platform supports three underlay shapes for cluster-internal network
traffic: **public-only**, **private VLAN** (Hetzner Cloud / AWS VPC /
generic L2 private network), and **mesh overlay** (NetBird / Tailscale /
WireGuard direct). This document walks through which to pick, the
tradeoffs, configuration, and what you can and cannot mix.

For the firewall mechanics + nft set design that all three modes share,
see [CLUSTER_NETWORK.md](CLUSTER_NETWORK.md). For migration between
modes, see [CLUSTER_NETWORK_MIGRATION.md](CLUSTER_NETWORK_MIGRATION.md).

## TL;DR — pick one

| You're running… | Pick |
|---|---|
| Hetzner Cloud, single region, you control the network | **Private VLAN** |
| AWS / GCP / Azure, single region | **Private VLAN** (the cloud's native VPC counts) |
| Mixed providers (e.g., Hetzner servers + a Linode worker) | **Mesh overlay** |
| Bare-metal / on-prem with a switching fabric you control | **Private VLAN** |
| Geo-distributed nodes (multiple regions in one cluster) | **Mesh overlay**, but consider [multi-cluster](#multi-region-and-multi-cluster) instead |
| Operators want to support tenants on home / NAT'd boxes | **Mesh overlay** OR (better) the [private-worker tunnel feature](PRIVATE_WORKER.md) — that's not a node, it's a service tunnel |
| Public-IP cloud servers, no special networking needed | **Public-only** (default; simplest) |
| Tiny cluster (1-3 nodes), staging, dev | **Public-only** |

If you're not sure which provider/topology you'll have long-term,
**start public-only** — it's the simplest, the platform's bootstrap
defaults to it, and you can migrate to a VLAN or mesh later (with some
operator effort, see [Migration paths](#migration-paths)).

## The fundamental constraint: one underlay per cluster

Kubernetes assigns one `Node.status.InternalIP` per node. Every
component that does cluster-internal routing — kube-proxy DNAT,
EndpointSlices, Calico tunnel endpoints, kubelet/apiserver streaming,
the firewall reconciler's `cluster_peers_v4` — uses **that single IP**
to identify the node. There is no "primary IP" vs "fallback IP" concept.

This means **every node in a cluster must have its `InternalIP` on the
same underlay**, and every other node must be able to reach that
`InternalIP`. You cannot have some nodes on a VLAN and other nodes on
a mesh in the same cluster — not without committing to operationally
fragile route-stitching (NetBird advertised routes, per-node Calico
overrides, MTU pinning to the lowest common denominator).

If you have nodes that genuinely cannot share an underlay (e.g.,
servers in a Hetzner Frankfurt VLAN + a worker in someone's home),
you have **two clusters**, not one cluster spanning two networks.
Run them separately and federate via [tenant migration](#multi-region-and-multi-cluster) or
the [private-worker tunnel](PRIVATE_WORKER.md).

## The four layers

Every underlay choice configures four layers consistently. Bootstrap
handles all four when you pass the right flags:

| Layer | Purpose | Bootstrap-flag-driven by |
|---|---|---|
| **1. k3s `--node-ip`** | Pins `Node.status.InternalIP` to the underlay IP. Determines how kubelet, kube-proxy, EndpointSlices identify this node. | `--cluster-network-cidr` (CIDR mode) OR auto-detection of `wt0`/`tailscale0` |
| **2. Calico `nodeAddressAutodetectionV4`** | Selects the source IP for VXLAN/WG tunnel headers. Currently set to `kubernetes:NodeInternalIP` — inherits from layer 1, so always correct. | Automatic; cluster-wide config |
| **3. Firewall** (nft, the always-on set mode) | Gates control-plane ports + tenant ports. `cluster_peers_v4` tracks `Node.status.InternalIP` (layer 1). `trusted_ranges_v4` covers the underlay's own CIDR for VXLAN/WG handshakes between peers. | `--cluster-network-cidr` and `--allow-source` |
| **4. MTU** | Calico pod-network MTU = underlay MTU − 110 (Calico WG 60 + VXLAN 50). Mismatch causes silent fragmentation drops on cross-node pod traffic. | Auto-detected from underlay interface; override via `--calico-mtu` |

If any one of those is wrong, you'll hit subtle failures (Service VIPs
unreachable, fragmentation, firewall drops). The bootstrap flow is
designed to keep them aligned automatically given a single underlay
choice. Mixing underlays is what breaks the alignment.

## Option A: Public-only (no overlay)

Every node has a public IP on its NIC; that's the InternalIP; cluster
traffic flows over the public Internet between nodes. The firewall is
the only thing keeping the control plane safe.

### Topology

```
   ┌──────────────┐                         ┌──────────────┐
   │  server-1    │   public Internet      │  server-2    │
   │  46.x.y.z    │ ◀──── encrypted ─────▶ │  167.x.y.z   │
   │  eth0        │   via Calico WG (51821)│  eth0        │
   └──────────────┘                         └──────────────┘
```

### Bootstrap

```bash
# First server (no --cluster-network-cidr → public mode)
./bootstrap.sh --join-as server \
    --domain phoenix-host.net \
    --acme-email ops@... \
    --allow-source <operator-IP>/32

# Subsequent servers / workers — same shape
./bootstrap.sh --join-as worker \
    --server <existing-server-public-IP> \
    --token K10...
```

Bootstrap auto-detects `Node.status.InternalIP = public-NIC-IP`,
configures Calico autodetect to inherit it, sets MTU to 1390 (1500
underlay − 110). `cluster_peers_v4` tracks the four nodes' public IPs;
control-plane ports are gated to those four sources only.

### When to pick this

- **Default for staging / dev / small public clusters.** Lowest setup
  complexity, no extra infrastructure to manage.
- **Vendor-neutral.** Works on any provider that gives nodes a public IP.
- **Highest performance.** No tunnel encapsulation overhead beyond
  Calico WG (which all three options share). 1500-byte MTU underlay,
  1390-byte pod MTU.

### Caveats

- **Every node needs a public IP** (or at least a routable-from-other-nodes
  IP). Cloud nodes without a public IP need a different mode.
- **Operator security relies entirely on the firewall reconciler.**
  Don't disable it; don't manually flush cluster_peers_v4. The
  always-on set mode is what keeps `:6443` and `:10250` from being
  open to the world.
- **Cannot natively support private nodes** (NAT'd home boxes, cloud
  servers without public IPs). If you need this later, you'll
  migrate to mesh or run a second cluster.
- **Inter-node bandwidth costs.** Cloud providers typically charge for
  inter-AZ / inter-region public-IP traffic. If you're on the same
  provider with a free private network, **option B** is cheaper at
  scale.

## Option B: Private VLAN (Hetzner Cloud / AWS VPC / generic)

All nodes share a layer-2 private network. The InternalIP is the VLAN
IP. Public IPs become optional per node (typically only on 1-2 ingress
nodes). The cluster's traffic stays on private RFC1918 addresses.

### Topology (Hetzner Cloud example)

```
                    Hetzner private network 10.0.0.0/16
   ┌──────────────────────────┴──────────────────────────┐
   │                                                     │
   ▼                                                     ▼
  ┌──────────────┐                         ┌──────────────┐
  │  server-1    │                         │  server-2    │
  │  ens10:      │ ◀──── L2 forwarding ──▶ │  ens10:      │
  │  10.0.1.5    │   no NAT, no overlay    │  10.0.1.6    │
  │  Calico WG   │   over the VLAN         │  Calico WG   │
  │  on ens10    │                         │  on ens10    │
  ├──────────────┤                         ├──────────────┤
  │  eth0:       │                         │  eth0:       │
  │  46.x.y.z    │ ← public, optional      │  (no public) │
  │  (ingress    │   only on a few nodes   │  no public   │
  │   only)      │                         │  IP needed   │
  └──────────────┘                         └──────────────┘
```

### Bootstrap

Bring the VLAN up first (Hetzner Cloud: attach the network + cloud-init
brings up `ens10`; AWS: attach ENI in the VPC; bare-metal: configure
the switch). Verify the node has an IP in your chosen CIDR before
running bootstrap.

```bash
# First server
./bootstrap.sh --join-as server \
    --cluster-network-cidr 10.0.0.0/16 \
    --domain phoenix-host.net \
    --acme-email ops@... \
    --allow-source 10.0.0.0/16    # implicit; the CIDR also gets added

# Subsequent servers + workers
./bootstrap.sh --join-as server \
    --cluster-network-cidr 10.0.0.0/16 \
    --server 10.0.1.5 \
    --token K10...

./bootstrap.sh --join-as worker \
    --cluster-network-cidr 10.0.0.0/16 \
    --server 10.0.1.5 \
    --token K10...
```

`--cluster-network-cidr` triggers:
- k3s `--node-ip = <ens10 IP inside CIDR>`
- Calico `nodeAddressAutodetectionV4.cidrs: ["10.0.0.0/16"]`
- nft `cluster_peers_v4` populated with VLAN IPs from `Node.status.InternalIP`
- nft `trusted_ranges_v4` includes `10.0.0.0/16`
- Calico MTU auto-detected from `ens10`'s MTU minus 110 (typically 1450 → 1340 for Hetzner)

### When to pick this

- **Production single-region clusters where you control the cloud network.**
- **Cost-sensitive deployments.** Inter-node traffic is free on most
  cloud providers' private networks.
- **High-throughput requirements.** Hetzner private network sustains
  ~9 Gbit/s between servers; AWS VPC similar within an AZ. Better than
  any overlay can achieve.
- **You want optional public-IP-free nodes.** A worker that holds tenant
  workloads but never serves external traffic doesn't need a public IP
  in this mode (route outbound through a NAT gateway or a public-IP
  ingress node).
- **Compliance.** Cluster traffic stays on RFC1918 IPs, never crosses
  the public Internet. Calico WG is still on top, so it's also encrypted.

### Caveats

- **Vendor lock-in.** Hetzner private network ≠ AWS VPC ≠ Azure VNet.
  Migrating to a different provider means re-bootstrapping the cluster.
  At the platform layer this is the same migration cost as any other
  provider switch (you'd be moving servers regardless), but the network
  layer doesn't transfer.
- **Single-region only.** Most cloud private networks don't extend
  across regions. If you need multi-region, see [Multi-region](#multi-region-and-multi-cluster) below.
- **Your switching fabric becomes load-bearing.** A misconfigured VLAN
  / vSwitch / VPC route table can isolate the cluster. The firewall
  doesn't help here — the failure is at L2/L3 below it.
- **VLAN MTU defaults vary.** Hetzner: 1450. AWS VPC: 9001 (jumbo) or
  1500. The platform's MTU auto-detect picks the right value, but if
  your VLAN MTU isn't what you expected, the result is silent
  fragmentation. Check `ip link show ens10` after attach.

## Option C: Mesh overlay (NetBird / Tailscale / WireGuard-direct)

A userspace mesh agent on every node creates a `wt0` (NetBird) /
`tailscale0` interface. Nodes have stable mesh IPs in a shared
private CIDR (NetBird default: 100.64.0.0/10). The mesh handles NAT
traversal, holepunching, and provides bidirectional reachability
even for nodes behind NAT.

### Topology

```
                 NetBird mesh: 100.64.0.0/10
   ┌────────────────────────┴────────────────────────┐
   │                                                 │
   ▼                                                 ▼
  ┌──────────────┐                         ┌──────────────┐
  │  server-1    │                         │  worker-3    │
  │  wt0:        │  ◀── WG tunnel ───────▶ │  wt0:        │
  │  100.64.1.5  │  (NetBird handles       │  100.64.1.7  │
  │              │   NAT-traversal)        │              │
  │  eth0:       │                         │  (no public  │
  │  46.x.y.z    │                         │   IP — home  │
  │  (operator   │                         │   NAT'd box) │
  │   access)    │                         │              │
  └──────────────┘                         └──────────────┘
```

Calico WG runs on top of the mesh — pod traffic is double-encrypted
(once by Calico WG, once by the mesh). Acceptable in practice; minor
CPU cost.

### Bootstrap

The mesh agent must be running BEFORE bootstrap. Bootstrap auto-
detects `wt0` / `tailscale0` and pins everything to the mesh IP.

```bash
# Sysadmin step (BEFORE bootstrap):
netbird up --management-url https://vpn.platform.net --setup-key <KEY>
ip -br addr show wt0    # confirm 100.64.x.y bound

# Then bootstrap:
./bootstrap.sh --join-as server \
    --domain phoenix-host.net \
    --acme-email ops@... \
    --allow-source 100.64.0.0/10
    # bootstrap auto-detects wt0 → sets --node-ip=100.64.x.y
    # Calico autodetect inherits, MTU auto = wt0_mtu - 110

# Subsequent server / worker (including NAT'd home boxes!)
./bootstrap.sh --join-as worker \
    --server 100.64.1.5 \
    --token K10...
```

### When to pick this

- **Geo-distributed cluster.** Servers in multiple regions/providers,
  workers anywhere. Mesh handles routing transparently.
- **Need to support private (NAT'd) workers.** A home box, a corporate
  VM behind a firewall, an edge IoT host — the mesh agent dials out
  TCP/UDP to the mesh management server, no inbound ports needed on
  the box itself.
- **Vendor-neutral.** NetBird is OSS; no provider lock-in. Migrating
  providers is just "spin up new servers, install NetBird, attach to
  same mesh, drain old".
- **Operator access without a jumphost.** Operator's workstation joins
  the same mesh; `kubectl` reaches every cluster apiserver via mesh
  IP, no SSH-tunnel-to-jumphost required.

### Caveats

- **Throughput cap.** Mesh tunnels are typically ~1 Gbit/s peer-to-peer
  (single-WG-tunnel limit) and can drop to ~100 Mbit/s when relay-mode
  is forced (NAT traversal failed). Far below VLAN throughput.
- **Latency tax.** Direct WG (good NAT): +5-15 ms. Relayed (bad NAT):
  +30-100 ms. Affects cross-node pod traffic and apiserver→kubelet
  probes. **etcd is sensitive to this** — keep voting members
  off-mesh or all-on-mesh, never mixed (latency-asymmetric quorums
  cause leader churn).
- **MTU is smaller.** NetBird wt0 MTU: 1420. Calico MTU: 1310. ~7%
  payload tax compared to a clean VLAN.
- **Double encryption.** Pod traffic = Calico WG inside mesh WG. Real
  CPU cost on encryption-heavy workloads, but small in practice
  (modern hardware does ~10-30 Gbit AES-NI per core).
- **Management-server dependency.** NetBird's management server is on
  the critical path for new node enrolment + key rotation. If it's
  down, existing nodes stay connected, but new joins fail. Self-host
  it for production, don't rely on a free SaaS tier.
- **Don't put cloud-private-network-eligible nodes on mesh.** If you
  have 4 servers in a Hetzner VLAN and you put them on NetBird mesh
  anyway, you're paying the mesh latency tax for traffic that could
  have flowed at L2 speed. Pick VLAN.

## Mixing rules

This is what people get wrong. Rules in order:

### Rule 1: One underlay per cluster

Every node's `Node.status.InternalIP` must be on the same network. Pick
one of A/B/C and stick with it for the whole cluster.

### Rule 2: A node can have additional NICs that aren't the InternalIP

A node bootstrapped on a VLAN (`InternalIP = 10.0.1.5`) can also run
NetBird (`wt0 = 100.64.1.5`) for operator access. The mesh interface
is invisible to the cluster — kube-proxy, Calico, the firewall, all
ignore it. It's just there for `ssh` from the operator's laptop, or
for monitoring scrape from outside the VLAN. Same for a public-IP
node that also has a NetBird agent.

This is the **right way to use mesh on a VLAN cluster**: as an
out-of-band operator-access channel, not as the cluster underlay.

### Rule 3: A new node CAN'T join unless it shares the cluster's underlay

If existing servers' `InternalIP` is `10.0.1.x` (Hetzner VLAN), a new
worker not in that VLAN cannot reach the existing servers via their
InternalIP. It joins, registers with the apiserver, but its
`kubectl get` from inside fails because Service-VIP DNAT routes to
`10.0.1.x` which the new node can't reach.

### Rule 4: Adding a node to the wrong-underlay cluster is a non-trivial fix

If you discover a private-only worker should join your public-only
cluster (or any other mismatch), the options are:
1. Re-bootstrap the cluster on the right underlay (downtime; tenant
   migration via [migration tool](#migration-paths))
2. Add the new node to the existing underlay (if possible — e.g.,
   attach Hetzner private network to the new node, then bootstrap)
3. Don't add the node; use [private-worker tunnel](PRIVATE_WORKER.md)
   for the use case instead

There is no "make this one node use a different underlay than the
others" workaround that's worth maintaining.

### Quick reference: what works

| Cluster underlay → | All-public | All-VLAN | All-mesh |
|---|---|---|---|
| **Add a public-IP node (with that IP routable from cluster)** | ✓ | ✗ (can't reach VLAN IPs) | ✗ (can't reach mesh IPs without mesh agent) |
| **Add a VLAN-only node (no public IP, no mesh)** | ✗ (can't reach public servers) | ✓ | ✗ |
| **Add a mesh-only node** | ✗ (Service-VIP DNATs to public, mesh node can't reach) | ✗ (can't reach VLAN IPs) | ✓ |
| **Add a node on multiple networks** (e.g., VLAN + public + mesh) | ✓ if public matches cluster | ✓ if VLAN matches cluster | ✓ if mesh matches cluster |

The pattern is simple: **a node's InternalIP must be on the same
network as every other node's InternalIP**.

## Multi-region and multi-cluster

A common ask: "I want servers in EU and workers in US in one cluster."
**Don't.** Run two clusters and federate at the tenant layer.

Reasons:
- etcd doesn't tolerate cross-region latency for voting members
- One Calico/firewall config per cluster — cross-region tuning
  conflicts (MTU, keepalives, timeouts)
- Failure modes multiply (one cluster surviving a region outage is
  better than one stretched cluster being half-broken)
- Tenant migration between regions is a deliberate operator action,
  not an emergent property of the topology

The platform supports per-region independence via the **simplified
multi-region model**:

- Each region is a fully independent cluster running the same code
- Operator picks which region a new tenant lands in
- Cross-region migration uses the existing tenant-bundle export+restore
  pipeline — no cluster-mesh required
- Cross-region DR uses S3-level cross-region replication of backup buckets

See the future `MULTI_REGION.md` doc when written; for now the design
is captured in `project_private_node_join_test_2026_05_09` memory note
and conversation context.

## Migration paths

### Public-only → Private VLAN

This is destructive: existing servers' InternalIPs change.
1. Stand up a new VLAN cluster alongside the old one
2. Migrate tenants one at a time using the bundle export+restore flow
3. Repoint DNS for each tenant after their migration
4. Decommission the old cluster

There is no in-place migration that preserves all running tenants
without downtime. The cluster's `Node.status.InternalIP` is what
EndpointSlices use, and that field can't be changed without
re-creating the Node — which means re-bootstrapping.

### Public-only → Mesh

Same shape: re-bootstrap, migrate tenants. Mesh-uniform cluster
becomes the new home; old public cluster is decommissioned.

### Adding mesh ON TOP of an existing cluster (operator access only)

This works in-place and is non-disruptive:
1. Install NetBird/Tailscale on every node (no bootstrap re-run needed)
2. Each node's `wt0` comes up; cluster's `InternalIP` is unchanged
3. Operator's workstation joins the mesh; can now `kubectl` via mesh IPs

This **does not** turn the cluster into a mesh-mode cluster — it adds
mesh as an out-of-band access path while the cluster's underlay stays
public-only or VLAN.

### Calico autodetect retroactive update

If a cluster was bootstrapped pre-2026-05-09 (when the autodetect
was changed from `skipInterface` to `kubernetes:NodeInternalIP`),
patch the live `Installation` CR:

```bash
kubectl patch installation default --type=json -p '[
  {"op":"replace",
   "path":"/spec/calicoNetwork/nodeAddressAutodetectionV4",
   "value":{"kubernetes":"NodeInternalIP"}}
]'
```

calico-node DS rolls cleanly (~3 min, maxUnavailable 1). No-op for
public-IP clusters where InternalIP already equals the public NIC IP;
correctness fix for clusters with mesh-private nodes.

## Worksheet

When you're about to bootstrap a new cluster, answer these in order:

1. **Will every node have a routable IP on the same network?**
   - If yes → continue
   - If no → you have multiple clusters, not one. Stop and design
     accordingly.

2. **Is that network public Internet, a cloud private network, or a
   userspace mesh?**
   - Public Internet → Option A (public-only)
   - Cloud private network / VLAN → Option B
   - Userspace mesh (NetBird/Tailscale) → Option C

3. **Do any nodes need to join from behind NAT (no inbound public
   reachability)?**
   - If yes → Option C is required for those nodes; the cluster must
     be all-mesh, OR those workloads should use the
     [private-worker tunnel](PRIVATE_WORKER.md) and not be cluster
     nodes at all
   - If no → Options A/B are both viable

4. **What's the throughput requirement for cross-node pod traffic?**
   - > 1 Gbit/s sustained → Option B (VLAN) strongly preferred
   - < 1 Gbit/s peaks → any option works
   - Storage replication (Longhorn) at scale → Option B almost certainly

5. **Do you need geo-distribution?**
   - If yes → run multiple clusters, one per region. Don't stretch a
     single cluster across regions even with mesh.
   - If no → all three options are single-region by design

6. **Vendor lock-in tolerance?**
   - High → Option A or C (provider-neutral)
   - Low → Option B is fine; you're already on that provider

## Related docs

- [CLUSTER_NETWORK.md](CLUSTER_NETWORK.md) — firewall + nft set design,
  CRDs, mode mechanics
- [CLUSTER_NETWORK_MIGRATION.md](CLUSTER_NETWORK_MIGRATION.md) — moving
  an existing cluster from one mode to another
- [PRIVATE_WORKER.md](PRIVATE_WORKER.md) — when you want a tenant
  service exposed through the platform without making the host a node
- `K3S_DEPLOYMENT_GUIDE.md` — bootstrap walk-through
- `STAGING_DEPLOYMENT.md` — current staging cluster's choices (today:
  public-only with NetBird as out-of-band operator access — Rule 2)
