# ADR-037 — Asymmetric QoS Resource Model (Burstable CPU, Guaranteed Memory)

**Status:** Accepted · 2026-05-12
**Supersedes / related:** ADR-025 (Workload Catalog), ADR-026 (Application Catalog), ADR-033 (Client Lifecycle Hooks), ADR-036 (Custom Deployments)

## Context

The platform shipped with **Guaranteed QoS** for every tenant container: `requests == limits` on both CPU and memory, with the per-tenant ResourceQuota enforcing `limits.cpu` and `limits.memory` at the customer plan ceiling.

That model produced two real failures:

1. **Multi-component deployments rejected at admission.** A 2-CPU plan deploying Nextcloud (web + db + cache + cron) tried to allocate 4× the user-assigned 1 CPU (the value was duplicated verbatim across every component, not summed against the plan). ResourceQuota correctly rejected at the 4th pod — but the rejection message and the user mental model were both broken: the user "assigned 1 CPU" and got "out of CPU".
2. **No headroom for natural bursts.** Even when sizing was correct, the Guaranteed QoS hard-caps every container at its own number. An idle `db` component couldn't lend headroom to a busy `web` component. The platform sold guarantees nobody asked for.

Two changes were needed:

- **Per-component allocation** — the user's deployment-level `cpuRequest` / `memoryRequest` must be split across components, not duplicated. Manifest authors should be able to declare weights so the split matches the app's real workload shape.
- **A model that allows bursting** — at least for CPU, where bursting is safe.

## Decision

### Per-component allocation (allocator module)

A pure-function allocator (`backend/src/modules/deployments/resource-allocator.ts`) splits the deployment-level budget across components:

- Components with hard-pinned `resources` (one-shot Jobs, etc.) are **excluded from the shared budget** — they keep their declared values.
- Job-type components are excluded entirely (they declare their own tiny footprints).
- **Single-component deployments** receive the full budget — no allocation needed, preserves legacy behaviour byte-for-byte.
- **Multi-component deployments** split by manifest-declared `resourceShare.weight`, with `minCpu` / `minMemory` floors per component. When weights are not declared, even split with default 50m / 64Mi floors.
- **Minimum-first algorithm**: every component is guaranteed its minimum, then the remainder is distributed by weight. This is stable under floor enforcement (a tiny component being floored up to its minimum doesn't overshoot the total). Rounding remainder goes to the highest-weight component (deterministic tiebreak by name).
- When `sum(minimums) > budget`, throws `INSUFFICIENT_RESOURCE_BUDGET` with structured per-component minimums so the UI can render an actionable "raise to X" quick-fix.

### Asymmetric QoS — Burstable CPU, Guaranteed Memory

| Resource | Per-container spec | ResourceQuota enforced on | Why |
|----------|--------------------|----------------------------|-----|
| **CPU** | `requests.cpu = allocated`, **no `limits.cpu`** | `requests.cpu ≤ plan` | CPU is compressible. cgroup `cpu.shares` proportionally throttles under contention. No process dies. Free bursting when neighbours idle. |
| **Memory** | `requests.memory == limits.memory = allocated` | `requests.memory ≤ plan` AND `limits.memory ≤ plan` | Memory is incompressible. OOMKill is non-graceful. Kubelet eviction can cross namespaces. Pods stay Guaranteed for memory. |

The decision is intentionally **mixed**. The user originally proposed "pure requests, no limits at all", which is the GKE/Autopilot baseline for CPU but unsafe for memory (kernel OOM + cross-tenant kubelet eviction). The asymmetric model captures the burst benefit where it's safe and keeps the safety guarantee where it's required.

### Overselling policy

This is the explicit operator-facing trade-off:

- **CPU is oversold.** A node with 16 cores can host clients whose summed `cpuLimit`s exceed 16. This matches Hetzner shared-CPU plans, AWS T-class burstable, GKE Autopilot baseline. Documented to operators as "shared CPU model — burstable up to plan when neighbour customers are idle, fairly throttled under contention".
- **Memory is NOT oversold.** Sum of plan memory limits across a node must not exceed node capacity, because memory is uncompressible. Memory eviction is the only "fairness" lever and it crosses namespace boundaries — a memory-greedy tenant could evict another tenant's Guaranteed pod.

Future work: a `plan.cpuMode = 'burstable' | 'reserved'` column for a paid tier that guarantees CPU. Out of scope for this ADR.

## Alternatives considered

| Option | Verdict | Why |
|--------|---------|-----|
| Stick with Guaranteed (status quo) | Reject | Doesn't fix the Nextcloud admission rejection; kills bursting. |
| Pure requests-only for both CPU and memory | Reject | Unsafe for memory. OOMKill and cross-tenant kubelet eviction risk. Single bug in any tenant container could leak node memory until another tenant gets evicted. |
| **Asymmetric: CPU soft, memory hard (chosen)** | Accept | Captures burst benefit safely; well-trodden pattern. |
| Per-namespace cgroup ceilings | Defer | Kubelet `NodeQOSLevels` is alpha; complexity not justified in Phase 1. |
| Split N components evenly (no weights) | Reject as default | Wrong defaults — cache deserves 5%, not 33%. Used as fallback only when manifest declares no weights. |
| Apply user's CPU to "main" component, fixed defaults for sidecars | Reject | "Main" is ambiguous for symmetric stacks (Jitsi: prosody/jicofo/jvb). Hides cluster cost when sidecars are sized hard. |
| Expose per-component CPU sliders in the UI | Defer | Phoenix-Tech operator confirmed: tenant should see one number. Per-component overrides may ship as a Phase-5 advanced option. |

## Implementation

### Phase 1 (this ADR's scope)

1. `resource-allocator.ts` + 15 unit tests covering single-component, multi-component, weighted, even-fallback, minimum floors, INSUFFICIENT_BUDGET, Job exclusion, hard-pinned exclusion, partial-declaration defence-in-depth, format normalisation.
2. `k8s-deployer.ts` lines 464–540 — compute allocations before the per-component loop; rewrite the container `resources` block to:
   ```ts
   resources: {
     requests: { cpu: allocated.cpu, memory: allocated.memory },
     limits:   { memory: allocated.memory },
   }
   ```
3. Same shape applied to `init-dirs` container, `password-reset` init container, file-manager pod (tenant ns but quota-exempt), and custom-deployments path (ADR-036).
4. `applyResourceQuota` (`backend/src/modules/k8s-provisioner/service.ts:251`) — enforces `requests.cpu`, `requests.memory`, `limits.memory` at the plan ceiling; drops `limits.cpu`. PriorityClass scope selector preserved.
5. `INSUFFICIENT_RESOURCE_BUDGET` → 400 `ApiError` translation at both `createDeployment` and `updateDeploymentResources` call sites in `deployments/service.ts`.
6. Catalog sync validator `validateResourceShares()` — enforces all-or-nothing per manifest, weight ∈ [1,1000], `sum(minCpu) ≤ recommended.cpu`, same for memory.
7. `packages/api-contracts/src/catalog.ts:componentSchema` — adds `resourceShare: { weight, minCpu?, minMemory? }`.

### Phase 2 (follow-up PRs)

- Coordinated PR to `hosting-platform-application-catalog` adding `resourceShare` to Nextcloud, Jitsi, Rocket.Chat, Discourse, Mastodon, etc. using upstream Helm chart ratios.
- `GET /deployments/:id/resource-breakdown` endpoint returning `{ total, components: [{ name, cpu, memory, weight }], warnings }`.
- UI: live breakdown table under the CPU/memory slider; relabel "CPU" → "CPU baseline (burstable)" and "Memory" → "Memory (guaranteed)".
- `INSUFFICIENT_RESOURCE_BUDGET` error UX: render per-component minimums + quick-fix button.
- Real-k3s integration test `scripts/integration-burstable-qos.sh` proving burst-and-cap on a real cluster.

### Phase 5 (deferred)

- `componentOverrides` on `deployments.configuration` for power users.
- `plan.cpuMode` reserved tier.

## Risks & Mitigations

- **Risk**: Existing tenants currently have summed per-component `limits.cpu` exceeding their plan (the old bug). The new `requests.cpu` quota rejects the reapply.
  - Mitigation: pre-flight check during fleet rollout; operator-driven rebalance before flipping each namespace.
- **Risk**: Every Deployment in the fleet rolls when reapplied (Recreate strategy → ~10-30s downtime per Deployment).
  - Mitigation: batched fleet rollout in off-peak windows; explicit operator banner before applying.
- **Risk**: Wrong ratios in a catalog manifest under-provision a component.
  - Mitigation: per-component `minCpu`/`minMemory` floors. Manifest authors derive ratios from upstream Helm charts. Integration test runs each app through E2E.
- **Risk**: Noisy CPU-bursting tenant degrades quiet-tenant's perceived latency.
  - Mitigation: cgroup CPU shares give proportional fair sharing under contention. Operators can isolate noisy tenants to dedicated nodes via `worker_node_name` pinning. Future `plan.cpuMode = 'reserved'` for paid guarantees.
- **Risk**: Memory eviction on node pressure can still kill a Burstable pod (kubelet evicts Burstable-over-request first). Tenants declaring `requests.memory == limits.memory` are Guaranteed and protected.
  - Mitigation: already protected by our policy — every tenant container is Guaranteed for memory.
- **Risk**: Custom-deployment containers (ADR-036) may pin their own CPU limit through `cpuLimit` in the spec.
  - Mitigation: honoured — tenants who explicitly want a CPU ceiling opt out of bursting. `memoryLimit` is clamped to `memoryRequest` if smaller, to preserve the Guaranteed shape.

## Success Criteria

- [x] Multi-component Deployments deploy without "Quota exceeded — CPU limit" rejections when the sum of declared `requests.cpu` is under the plan cap.
- [x] Allocator unit tests cover even-split, weighted, minimum floors, INSUFFICIENT_BUDGET, Job exclusion.
- [x] Backend unit tests assert the new container shape: `requests.cpu`, `requests.memory`, `limits.memory`, no `limits.cpu`.
- [x] `applyResourceQuota` unit test asserts the new `hard` keys.
- [x] No `limits.cpu` on tenant containers (init-dirs, password-reset, file-manager, catalog deployer, custom deployer).
- [ ] (Phase 2) Real-cluster integration test proves a single component bursts beyond its `requests.cpu` when sibling components are idle.
- [ ] (Phase 2) UI labels reflect the model ("baseline" vs "cap").
- [ ] (Phase 2) Catalog repo PR adds `resourceShare` to multi-component manifests.
