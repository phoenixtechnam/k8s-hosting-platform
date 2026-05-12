# Resource Model — Operator Runbook

**Authoritative reference:** [ADR-037](../07-reference/ADR-037-burstable-cpu-resource-model.md)

The platform uses an **asymmetric QoS model**: CPU is burstable, memory is guaranteed. This document explains what that means operationally, and how to handle the most common scenarios.

## The model in one paragraph

A customer plan of "2 CPU, 4 GiB memory" means:

- **CPU**: The customer is **guaranteed up to 2 CPU baseline** across all their deployments combined. When neighbour customers on the same node are idle, individual pods may **burst beyond their per-pod baseline**, but the customer cannot reserve more than 2 CPU at admission. Under CPU contention, the kernel arbitrates fairly via cgroup CPU shares proportional to each pod's `requests.cpu`.
- **Memory**: The customer **always has access to up to 4 GiB of memory**. There is no bursting. Pods are sized at their requested value and cannot exceed it without being OOMKilled.

## How a deployment's "1 CPU" is split across components

Multi-component applications (Nextcloud, Jitsi, Rocket.Chat, …) deploy several pods. The user assigns a single number (e.g. "1 CPU") which is the **total budget for the whole stack**. The allocator splits it across components by manifest-declared weights:

```jsonc
// Nextcloud manifest (hosting-platform-application-catalog)
"components": [
  { "name": "web",   "resourceShare": { "weight": 50, "minCpu": "100m", "minMemory": "256Mi" } },
  { "name": "db",    "resourceShare": { "weight": 35, "minCpu": "100m", "minMemory": "256Mi" } },
  { "name": "cache", "resourceShare": { "weight": 10, "minCpu": "20m",  "minMemory": "64Mi"  } },
  { "name": "cron",  "resourceShare": { "weight": 5,  "minCpu": "10m",  "minMemory": "32Mi"  } }
]
```

For "1 CPU" → web gets 450m, db gets 330m, cache gets 130m, cron gets 90m (minimums first, remainder by weight). Sum equals exactly the budget.

When no `resourceShare` is declared on a multi-component app, an even split with default floors (50m / 64Mi) is used. This is defence-in-depth: the bug that motivated [ADR-037](../07-reference/ADR-037-burstable-cpu-resource-model.md) cannot recur even on un-updated manifests.

## Operator scenarios

### "Customer says their CPU is throttled"

1. Check the customer's plan: `clients.cpu_limit` (or `plan.cpuLimit` if no override).
2. Check the namespace's current usage:
   ```bash
   kubectl -n client-<short> describe resourcequota | grep -A2 "requests.cpu"
   ```
   If `used == hard`, the customer has reserved their full plan — pods can still **burst** but cannot reserve any new ones (creating a new Deployment would 400 with `RESOURCE_LIMIT_EXCEEDED`).
3. Check per-pod actual CPU usage:
   ```bash
   kubectl -n client-<short> top pod
   ```
   If pods show CPU usage **above their `requests.cpu`**, they're successfully bursting — no problem. If they show usage **at exactly `requests.cpu` repeatedly under load**, they're being cgroup-throttled by neighbours on the node.
4. If neighbour contention is the cause, options are:
   - Pin the noisy neighbour to a dedicated node (set `clients.worker_node_name`).
   - Raise the customer's plan CPU.
   - Add a new node and rebalance.

### "Customer says their memory keeps OOMing"

Memory has no burst path — if the application uses more than its allocated `limits.memory`, the kernel OOMKills it.

1. Check the namespace's ResourceQuota:
   ```bash
   kubectl -n client-<short> describe resourcequota | grep -A2 "limits.memory"
   ```
2. Check the affected deployment's per-component memory:
   ```bash
   kubectl -n client-<short> get pod -o jsonpath='{.items[*].spec.containers[*].resources}' | jq
   ```
3. If a single component's `limits.memory` is too low for its actual working set, the operator (or customer) needs to **raise the deployment-level `memory_request`** in the UI. The allocator will redistribute the new total across components by their declared weights.
4. If the deployment-level total already equals the customer plan, the customer must **upgrade their plan**.

### "Deployment refuses to start with INSUFFICIENT_RESOURCE_BUDGET"

This is the allocator's structured failure when `sum(per-component minimums) > deployment budget`. The API returns:

```json
{
  "error": "INSUFFICIENT_RESOURCE_BUDGET",
  "data": {
    "required": { "cpu": "500m", "memory": "512Mi" },
    "assigned": { "cpu": "250m", "memory": "256Mi" },
    "perComponentMinimums": [
      { "name": "web", "cpu": "100m", "memory": "256Mi" },
      { "name": "db", "cpu": "100m", "memory": "256Mi" },
      ...
    ]
  }
}
```

**Fix**: tell the customer (or operator) to raise the deployment's CPU or memory above the `required` value. The UI surfaces a "raise to X" quick-fix button.

### "I want to deploy a new client but the quota math doesn't add up"

The two-tier quota is unchanged:

- **`<ns>-quota`** (scoped to PriorityClass=`tenant-default`): counts tenant pods only.
  - `requests.cpu` = plan CPU
  - `requests.memory` = plan memory (in GiB)
  - `limits.memory` = plan memory (in GiB)
  - **No `limits.cpu`** — that's what allows CPU bursting.
- **`<ns>-storage-quota`** (unscoped): counts PVCs.
  - `requests.storage` = plan storage (in GiB)

The `platform-tenant-overhead` PriorityClass (file-manager, etc.) is exempt from the scoped quota.

### "How do I migrate an existing tenant to the new model?"

Each Deployment update reapplies the new spec on next `deployCatalogEntry` call. Touching a deployment via the UI ("Adjust resources" or "Redeploy") will pick up the new shape automatically.

For a one-shot fleet migration, the Phase-5 plan was deferred — for staging test clients, we don't bother. For production, when this rolls out, do it in batches off-peak; each Deployment update causes one rolling restart (Recreate strategy → ~10-30s of downtime per pod).

## Monitoring metrics to watch

- `container_cpu_usage_seconds_total` vs `requests.cpu` per pod → throttling indicator.
- `container_memory_working_set_bytes` vs `limits.memory` per pod → OOM risk.
- ResourceQuota `requests.cpu used / hard` per namespace → headroom for new deploys.
- Pod evictions with reason `MemoryPressure` → node memory oversold (should never happen under this model — investigate).

## Edge cases

- **Custom deployments (ADR-036)** can explicitly pin `cpuLimit` in their compose/simple spec. When set, that tenant opts out of bursting for that container — it gets a hard CPU cap. `memoryLimit` is clamped to `memoryRequest` if smaller to preserve the Guaranteed shape.
- **Job-type components** (one-shot install jobs like `wp-install`) are excluded from the budget. They declare their own hard-pinned `resources` in the manifest.
- **Single-component deployments** (PHP runtime, Node.js standalone, MariaDB standalone, etc.) receive the full deployment budget — no allocator activity. Their behaviour is byte-identical to pre-ADR-037 except they no longer have `limits.cpu`.
