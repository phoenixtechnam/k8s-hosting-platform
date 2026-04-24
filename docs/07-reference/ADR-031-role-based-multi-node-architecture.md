# ADR-031: Role-based Multi-Node Architecture — Server/Worker Split with Opt-in HA

**Status:** Accepted · 2026-04-24
**Relates to:** ADR-028 (backup architecture — constrains HA recovery story),
ADR-029 (secrets + DR), ADR-027 (oauth2-proxy scope)
**Follow-ups:** Longhorn StorageClass tiers (M2), role-specific ingress
routing (M3), admin Nodes page UI (M4), client provisioning worker-selector
(M5), tenant migration tooling (M6), HA opt-in workflow (M7), 3-server
control plane (M8), multi-node runbooks (M9), CNPG replication prep (M10),
optional provider-abstracted Load Balancer (M11).

---

## Context

Through 2026-04-24 the platform ran single-node: one staging server at
89.167.3.56 hosting the full stack (k3s control plane, platform-api,
admin/client panels, Postgres, Redis, Stalwart, ingress-nginx, Longhorn,
every tenant workload). That topology has a floor and a ceiling:

- **Floor.** Initial clients ship on a 1-server footprint that costs
  €10–20/mo. Adding capacity for a second client shouldn't require
  two more servers.
- **Ceiling.** A single server is a single-point-of-failure for every
  tenant AND for every system component. There is no graceful path
  from "one VPS" → "HA cluster that survives a node loss" without
  re-architecting workload placement and storage replication.

Two previous ADRs had touched HA tangentially (ADR-028 set up Longhorn +
DR backups; ADR-029 established the operator-recipient secret model so a
cold restore is possible across clusters), but neither specified how a
fleet of nodes would partition responsibility between "runs the platform"
and "runs the tenant."

The 2026-04-24 planning discussion worked through the shape of that
partition. The outcome was a staged roadmap (M1–M11) described in this
ADR as the target architecture, with M1 (node taxonomy) already shipped
on the same day this decision was accepted.

---

## Decisions

### 1. Role-based node taxonomy, two roles

Every node carries one of two platform roles, stamped as the k8s label
`platform.phoenix-host.net/node-role`:

| Role     | Runs                                                     | Default count        |
|----------|----------------------------------------------------------|----------------------|
| `server` | k3s control plane (etcd) + all system workloads          | 1, 3, 5, or 7 (quorum) |
| `worker` | Tenant workloads only; local nginx for ingress routing   | N (0..many)          |

**Rationale.** Separating system state from tenant state at the node
level lets us:

- Scale tenant capacity horizontally without touching control plane.
- Harden the control plane (taint out tenant workloads, tighter
  egress policy, separate LinkedIn-style monitoring).
- Apply different storage tiers per role (M2) — system gets
  replicated storage, default tenant PVCs stay local.

**Trade-off.** An extra role distinction to maintain in the scheduler
config, the admin UI, and the backup/DR runbooks. Mitigated by treating
`server` as the quorum boundary: everything that's not a server is a
worker, no third role.

**Rejected alternative: per-workload taints.** Instead of role labels,
we could taint individual nodes with `platform/runs-postgres=true` etc.
That's too granular — every new system service would need a migration
to paint taints; operators would hand-place workloads one at a time.
The role abstraction collapses the decision to "which pool does this
node belong to."

### 2. `canHostClientWorkloads` opt-in on servers

A server node can additionally register itself as tenant-capable by
setting `platform.phoenix-host.net/host-client-workloads=true`. This is
the "small cluster economy" escape hatch — a single-server install
works today exactly because the staging node was manually relabeled
with `host-client-workloads=true` on 2026-04-24.

When a server opts OUT of tenant workloads
(`host-client-workloads=false`, the default), the node gets the taint
`platform.phoenix-host.net/server-only=true:NoSchedule`. Every system
Deployment gets a matching toleration; tenant workloads don't, so they
can't land. Workers never carry this taint.

**Rationale.** The tension is: an HA setup with 3 servers wants to keep
control-plane and tenant pools separate (clean operations, blast
radius); a 1-server setup wants one node to serve everything (cost).
The opt-in flag preserves both in the same config surface.

### 3. System workloads are pinned to `server` nodes via nodeAffinity

Every Deployment / StatefulSet in the `platform`, `platform-system`,
and `mail` namespaces carries a `requiredDuringSchedulingIgnoredDuring
Execution` nodeAffinity for `node-role=server` plus a toleration for
the `server-only` taint. Shipped via the
`k8s/components/system-node-affinity/` Kustomize component + a
`pin_system_components_to_servers()` helper in bootstrap that patches
Helm-installed Deployments post-install.

**The critical apply-order rule:** a node MUST already carry the
`server` label before the component lands. Otherwise the scheduler
evicts every system pod, the API becomes unreachable, and the admin UI
you'd use to fix it is also gone. The scheduler has no hysteresis —
once a pod loses its node, there is no "keep running for now" grace.

This is documented in `docs/07-reference/NODE_ROLE_TAXONOMY.md` as a
two-phase rollout and is enforced operationally: the staging upgrade
on 2026-04-24 relabeled the node BEFORE the C5 commit that wired in
the component was pushed. Bootstrap puts the labels on BEFORE the
platform manifests apply, so a fresh cluster is automatic.

**Rejected alternative: `preferredDuringSchedulingIgnoredDuring
Execution`.** Softer affinity would avoid the deadlock but wouldn't
enforce the separation — a misconfigured worker could still host
Postgres. The deadlock risk is manageable with good docs + a CI
guardrail (`scripts/ci-system-affinity-check.sh`); the alternative's
silent failure mode is worse.

### 4. Workers serve tenants they actually host (ingress topology)

Each worker runs an `ingress-nginx` DaemonSet pod. Workers advertise
only the tenants whose pods are scheduled on them via DNS. When a
tenant pod moves workers (M6 migration flow, or scheduler rescheduling
after node failure), the tenant's A record in PowerDNS is updated to
point to the new worker's public IP.

This is **opt-out DNS-RR**, not a load balancer in front of every
tenant. Rationale:

- Zero per-tenant cost. Adding a tenant doesn't require buying a
  Hetzner LB.
- Vendor-neutral by default. Our ingress path doesn't depend on
  Hetzner LB / AWS ELB / MetalLB; any VPS with a public IP works.
- Local traffic. Tenant → nginx on the same worker → tenant pod, all
  within the node. Cross-worker traffic happens only for
  cross-tenant requests, which are rare.

Systems workloads stay reachable via platform-wide DNS-RR against all
servers, because every server runs nginx and terminates TLS for
`*.phoenix-host.net`.

**Rejected alternative: one LB in front of every node for every tenant.**
Cost (€5.50/mo × N tenants × cloud factor) dominates for the first 50
tenants; the DNS-RR model scales there without buying anything. LB
becomes interesting only when the SPOF cost of "worker N dies and 10
tenants go dark until DNS TTL expires" becomes unacceptable — that's
the M11 decision.

### 5. Worker failure = client offline until operator-triggered restore

When a worker dies, the tenants it hosted go offline. The ADR-028
backup chain makes them *recoverable* — the operator runs a restore
workflow (M6) that spins up the tenant on another worker from the
latest Longhorn snapshot + S3 off-site backup. Data loss is bounded by
the backup cadence (currently 24h for tenant PVCs; see ADR-028 §3.2).

**Rationale.** Automatic failover for tenants would require continuous
replication of every tenant PVC, which is:

- Expensive (3x storage cost for Longhorn replicaCount=3).
- Complex (replication controller, split-brain handling, per-tenant
  health checks).
- Under-used (most hosted sites are worth less than the extra
  infrastructure cost — the owner accepts a few hours downtime).

Clients who need HA can opt in per-tenant (M7). That splits the
trade-off along the axis the tenant actually cares about instead of
forcing it on the platform.

### 6. Client provisioning picks a worker, admin can override

On "new client" the UI (M5) shows the available workers ranked by free
resources and picks the highest-ranked one by default. An admin can
override at creation time or migrate later (M6).

**Rationale.** Operators want visibility and veto, not an invisible
scheduler decision. Automatic placement with override handles the
common case (default pick is almost always correct) while preserving
control for the tricky one (pinning a large tenant to a specific
worker).

### 7. Postgres replication is prepared, not activated

CloudNative-PG (CNPG) operator gets installed passively in M10 — the
operator CRDs land, but no Cluster CR is applied. Postgres stays as a
single StatefulSet backed by Longhorn `longhorn-system-ha`
(replicaCount=3) on servers.

**Rationale.** Active-passive Postgres replication (CNPG's Cluster
resource) needs at least two server nodes AND manual failover review
for every primary change. At the 1-server stage it's overhead without
benefit; at the 3-server stage it's worth turning on. Pre-installing
the operator lets us flip the switch without a migration — just apply
a Cluster CR pointing at the existing Postgres data directory. See
`docs/09-runbooks/CNPG_ACTIVATION_RUNBOOK.md` (to be written in M10).

### 8. Load balancer is opt-in, provider-abstracted, gated on 3+ servers

The Hetzner Load Balancer (or AWS ELB, MetalLB, Null stub for dev) is
opt-in via the admin UI. It activates only when the cluster is in a
full 3+ server HA state. Until then, DNS-RR against the control plane
servers covers the system ingress, and per-worker DNS covers tenants.

**Rationale.** A single-server install with Hetzner LB in front costs
more and gains nothing (the LB forwards to one backend that might
die). In 3-server HA the LB abstracts node failure for system traffic
(admin panel, platform-api), which is worth the €5.50/mo. Keeping it
opt-in + provider-abstracted means:

- Dev / staging can stay LB-less.
- Migration to a different cloud doesn't lock us into Hetzner.
- Self-hosted MetalLB (K8s-native LB using BGP or L2 announcement) is
  a drop-in alternative for on-prem deployments.

**Rejected alternative: always-on Hetzner LB.** Vendor lock-in +
bills from day 1 + doesn't solve tenant-level SPOF. The LB helps
only system traffic at the 3+ server scale.

---

## Stage progression (M1–M11)

| Phase | What | Shipped | Ref |
|-------|------|---------|-----|
| M1 | Node role taxonomy (labels/taints/DB/bootstrap/nodeAffinity) | ✅ 2026-04-24 | `NODE_ROLE_TAXONOMY.md` |
| M2 | Longhorn StorageClass tiers (system-ha, tenant-local, tenant-ha, mail-local, mail-ha) | — | TBD |
| M3 | Role-specific ingress routing (workers own their tenants) | — | TBD |
| M4 | Admin-panel Nodes page (on top of M1 API hooks) | — | TBD |
| M5 | Client provisioning worker-selector | — | TBD |
| M6 | Tenant migration between workers | — | TBD |
| M7 | Per-tenant HA opt-in (tenant-local → tenant-ha SC migration) | — | TBD |
| M8 | Grow to 3-server control plane (quorum ready) | — | TBD |
| M9 | Multi-node runbooks + monitoring | — | TBD |
| M10 | CNPG operator passive install + runbooks | — | TBD |
| M11 | Optional provider-abstracted Load Balancer (opt-in at 3+ servers) | — | TBD |

The sequence is not strictly linear. M2 + M4 can parallelize after M1;
M3 gates M5/M6; M7 depends on M2's tenant-ha SC; M8 gates M10 activation.

---

## Consequences

### Good

- Tenant capacity scales horizontally by adding workers; no control
  plane change needed for the 51st tenant.
- Control plane hardening is a clean exercise: tighter NetworkPolicy,
  Pod Security Standard `restricted` only on `platform`/`mail` ns,
  doesn't collide with tenant flexibility needs.
- System state (Postgres, Redis, platform-api) has a clear migration
  path to HA via M8 + M10 without re-architecting schedulers.
- Dev overlay is unaffected — single-node DinD k3s never needs the
  nodeAffinity component (it's explicitly excluded).

### Bad

- The apply-order rule is a sharp edge. Operators who skim docs will
  eventually merge the affinity component before relabeling and brick
  their cluster. CI guardrail catches the forgot-to-add-to-component
  direction but can't catch the apply-order direction — that's a
  runbook discipline problem.
- Worker failure recovery is operator-triggered. A 2am incident
  requires someone to be up. Escalation path: M7 HA opt-in for the
  tenants who care, stay DNS-RR for the rest.
- `canHostClientWorkloads` is a surprise-prone flag for the 1-server
  case. Default `false` on servers is the HA-correct choice but
  breaks a fresh 1-server install unless operator flips it — the
  bootstrap's auto-resolution to `true` when there's only one node
  (future M5.x UX polish) would close this gap.

### Neutral

- Existing tenants unaffected by M1. The reconciler populates
  `cluster_nodes` on first tick; the label is authoritative; the
  seeded `staging=server` row from migration 0046 gets corrected to
  match the actual labels.
- Documentation cost is real but front-loaded. `NODE_ROLE_TAXONOMY.md`
  + this ADR + the M9 runbooks should be sufficient; no ongoing doc
  burden beyond "update the allowlist when adding a new system
  workload."

---

## Deferred / out of scope

- Cross-cluster HA (multi-datacenter failover). Out of scope forever
  for this budget tier — customers who need it will use a different
  product.
- Automatic Longhorn replica rebalancing on worker join / departure.
  Longhorn has settings for this; we'll lean on them as-configured
  (replicaAutoBalance=best-effort) and surface manual rebalance in
  the admin UI if M9 monitoring shows it's needed.
- Tenant-level CDN / edge caching. Orthogonal.
- Multi-tenant network isolation beyond NetworkPolicy (e.g. Cilium,
  Istio). Our NetworkPolicy coverage is sufficient at this scale;
  service mesh complexity isn't.
- Actual Postgres replication activation (M10 installs the operator
  only; the Cluster CR + primary/replica topology is a future ADR
  when we have the 3-server footprint to support it).

---

## Open questions

- **Dex in production.** Currently dev + staging ship Dex for OIDC.
  Production was supposed to skip it per memory but the role
  taxonomy doesn't touch this — stays as-is. If production ever
  adopts Dex, the inline dex patch in the staging overlay becomes
  a template to copy into production.
- **Two workers on the same physical host.** Our worker model
  assumes distinct hosts. Nothing stops two k3s agents on the same
  VPS, but nodeAffinity + DNS-RR would treat them as separate
  workers regardless. Probably fine; adds a test case to M9.
- **Rolling a worker back to a server.** The admin API refuses
  server→worker demotion if system pods are still scheduled (requires
  `force=true`). Worker→server promotion has no equivalent safety —
  the pool just grows. If a worker's canHostClientWorkloads flip
  evicts tenants, that's logged but not refused. Future M7 work may
  tighten this.
