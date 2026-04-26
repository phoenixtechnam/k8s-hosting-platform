# Platform HA Mode (`Apply HA`)

Single-button operation that takes the platform from "any-node-failure causes outage" to "any single server can fail without outage". Reverse direction (`Revert to Local`) restores the simpler resource profile.

## What `Apply HA` actually does (M14)

| Component | Local tier | HA tier | Reversible? |
|---|---|---|---|
| Longhorn volumes (postgres + stalwart) | 1 replica | 3 replicas, spread across nodes | ✓ (extra replicas deleted) |
| Postgres CNPG `Cluster` `spec.instances` | 1 | 3 (sync replication) | ✓ (replicas removed; primary keeps data) |
| `admin-panel`, `client-panel`, `platform-api`, `oauth2-proxy`, `dex` Deployments | 2 replicas | 3 replicas + `topologySpreadConstraints` (one per node) | ✓ (replica count) |

What `Apply HA` does NOT do:
- Per-tenant client workloads (separate per-client storage tier)
- Stalwart-mail StatefulSet — stays at `replicas=1`. Failover handled by Longhorn HA volume rebind to a new node (~30-60s recovery time)
- Redis was removed in M14 — replaced by per-pod in-memory LRU. No HA concern.
- ingress-nginx — already a DaemonSet (one pod per node)
- etcd — already 3-server quorum from bootstrap

## Pre-conditions

Apply HA requires:
- ≥3 Ready server nodes (the `recommendedTier` calculation enforces this)
- `cm/platform-operator-recipient` exists (used by backup CronJobs)
- CNPG operator running (`kubectl get deploy -n cnpg-system cnpg-controller-manager`)

The recommendation banner only shows when `recommendedTier=ha && systemTier=local && !pinnedByAdmin`. The Apply HA button is disabled when the cluster doesn't meet the threshold.

## Flow

```
┌─────────────────┐
│ Operator clicks │
│  "Apply HA"     │
└────────┬────────┘
         │
         ▼ confirmation modal lists every change
         │
         ▼ super_admin → PATCH /api/v1/admin/platform-storage-policy
         │
         ▼ backend applyPolicy() runs three patch loops:
         │   1. Longhorn volumes (1→3 replicas per CR)
         │   2. Stateless Deployments (replicas + topologySpread)
         │   3. CNPG Cluster (instances 1→3)
         │
         ▼ each loop is independent; partial failure is reported
         │   not aborted (so 1 LH + 0 deploys + 1 CNPG patched
         │   shows up clearly in the result)
         │
         ▼ audit_logs row written with before/after + per-resource patch
         │
         ▼ UI receives ApplyPlatformStoragePolicyResponse:
             { policy, patches[], deployments[], cnpgClusters[] }
```

## Reverse (`Revert to Local`)

Same three loops in reverse:
- Longhorn volumes 3→1 replica (extra copies deleted)
- Stateless Deployments 3→2 replicas (topologySpread retained — harmless at 2)
- CNPG Cluster instances 3→1 (replicas removed; primary keeps all data)

Reverting does NOT lose data anywhere. CNPG drops the standby pods cleanly; Longhorn deletes extra replicas after rebuilding-down.

## Failure modes

| Scenario | Apply HA result | Recovery |
|---|---|---|
| `cluster.postgres` not yet reconciled (Flux still applying) | `cnpgClusters[0].error="cluster CR not found (Flux still reconciling?)"` | Wait + retry |
| Operator clicks Apply HA on a 2-server cluster | Frontend disables the button (`recommendedTier !== 'ha'`) | Wait until 3rd server joins |
| Longhorn patch fails (e.g. volume currently detaching) | `patches[i].error="..."`, other components still patched | Re-click Apply HA after Longhorn settles |
| CNPG instance scale-up fails (insufficient resources) | `cnpgClusters[0].error="..."`, primary unaffected | Operator must address resource issue |
| `kubectl patch deploy admin-panel` fails (RBAC) | `deployments[i].error="forbidden"` | Check ServiceAccount permissions |

## Replica field ownership

Stateless Deployments (admin-panel, client-panel, platform-api,
oauth2-proxy, dex) intentionally have NO `replicas:` field in
their base manifests. The field is owned by the platform-storage-
policy reconciler — Apply HA / Apply Local writes it via the
`/scale` subresource and Flux's SSA leaves it untouched (because
the manifest doesn't claim it).

Consequence for fresh installs: every Deployment starts at K8s
default = 1 replica. The HA recommendation banner appears once
the cluster has ≥3 ready servers. Operator clicks Apply HA → 3
replicas. Or clicks Apply Local explicitly → 2 replicas. Never
auto-applied.

## Smoke tests covering this

- **Test 8** — every stateless Deployment has ≥3 ready replicas across ≥2 nodes (when tier=ha)
- **Test 9** — CNPG Cluster reports `readyInstances === spec.instances`

Run via `make smoke` after any Apply HA / Revert to Local action.

## Why not also do stalwart-mail / redis / k3s

- **stalwart-mail**: clustering across pods isn't validated for our deployment. Active-active over RWX risks mailbox state corruption. Single-replica + Longhorn HA volume + automatic pod reschedule gives ~30-60s mail downtime on node failure — acceptable for a small platform; revisit when stalwart >0.10 cluster mode is mature.
- **redis**: removed in M14. The previous use was a per-pod TTL cache; `lru-cache` in-memory replaces it. No HA concern.
- **k3s control plane**: already 3-server etcd quorum from bootstrap. No further action.

## Audit trail

Every Apply HA / Revert to Local writes an `audit_logs` row with:
- `action_type=update`
- `resource_type=platform_storage_policy`
- `actor_id` = the user who clicked
- `changes` = full before/after snapshot including per-resource patch results

Query: `SELECT actor_id, changes, created_at FROM audit_logs WHERE resource_type='platform_storage_policy' ORDER BY created_at DESC LIMIT 5;`
