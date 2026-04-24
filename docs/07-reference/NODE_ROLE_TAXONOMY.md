# Node-role Taxonomy (M1)

Platform-managed role + config annotations on top of k8s node labels.
M1 of the multi-node + HA track (ADR-031 pending).

## Label + taint schema

| Key                                                   | Applied to         | Values            | Purpose                                                                 |
|-------------------------------------------------------|--------------------|-------------------|-------------------------------------------------------------------------|
| `platform.phoenix-host.net/node-role`                 | Node label         | `server` / `worker` | Which pool the node belongs to. System workloads pin to `server`.       |
| `platform.phoenix-host.net/host-client-workloads`     | Node label         | `true` / `false`    | Whether the node accepts tenant pods. Default: `false` for servers, `true` for workers. |
| `platform.phoenix-host.net/server-only`               | Node taint (NoSchedule) | `true`          | Applied when a server sets `host-client-workloads=false`. Repels tenant pods; system pods tolerate it. |

Unlabeled nodes (legacy, or ones that bootstrapped before M1) are
treated as `worker` with `canHostClientWorkloads=true` — matches
migration 0046 defaults and preserves pre-M1 scheduling behavior.

## Backend mirror

Table `cluster_nodes` (migration 0046) keeps a platform-owned copy of
the inventory. Columns you'd see in the admin API (`GET /api/v1/admin/nodes`):

- `name` — k8s node name (primary key)
- `role`, `can_host_client_workloads` — authoritative state; the PATCH
  endpoint writes the label on k8s first, then reflects back via the
  reconciler.
- `public_ip`, `kubelet_version`, `k3s_version`, `cpu_millicores`,
  `memory_bytes`, `storage_bytes`, `status_conditions`, `labels`,
  `taints` — observed values from the last reconciler tick.
- `notes` — free text surfaced in the admin UI (M4), for operator
  annotations that don't belong on a k8s label.
- `joined_at`, `last_seen_at` — lifecycle tracking. Stale
  `last_seen_at` → node probably offline.

The reconciler (`backend/src/modules/nodes/scheduler.ts`) ticks every
60s with a 10s initial delay, matching the in-process pattern used
elsewhere in the backend (storage-lifecycle, imapsync, dkim, etc.)
over a CronJob. Sharing the same k8s client + RBAC + DB pool as the
API keeps overhead minimal.

## Bootstrap flags

```
./scripts/bootstrap.sh \
  --role server \
  --host-client-workloads false      # default for servers
```

```
./scripts/bootstrap.sh --remote <worker-ip> --ssh-key <key> \
  --role worker \
  --server <control-plane-ip> --token <k3s-join-token>
  # worker defaults: host-client-workloads=true (no taint)
```

`apply_node_labels_and_taints` runs after k3s is up and before
platform manifests apply. Worker mode is a log-only step — the script
writes no local kubeconfig on workers; the matching `kubectl label`
commands must run on the control plane afterwards. Most workers don't
need that because the unlabeled default matches the intent.

`pin_system_components_to_servers` runs after all Helm installs on a
server bootstrap. It strategic-merge patches flux-system, cert-manager,
and sealed-secrets Deployments with nodeSelector + toleration, and
applies toleration-only to ingress-nginx + longhorn DaemonSets so they
still land on server-only-tainted nodes.

## Apply order (CRITICAL)

The `system-node-affinity` Kustomize component (included by staging +
production overlays) requires the target node to carry
`platform.phoenix-host.net/node-role=server` BEFORE Flux reconciles.
If it doesn't, every system pod enters Pending, Flux can't reach the
platform-api, and the admin UI becomes unreachable.

For a fresh cluster, `bootstrap.sh` applies the label in
`apply_node_labels_and_taints` before any platform manifest lands, so
the order is automatic. For an existing cluster being upgraded into
M1 (e.g. staging on 2026-04-24), the relabel MUST happen manually
before the new overlay ships:

```bash
ssh root@<control-plane> \
  kubectl label node <node-name> platform.phoenix-host.net/node-role=server --overwrite
ssh root@<control-plane> \
  kubectl label node <node-name> platform.phoenix-host.net/host-client-workloads=true --overwrite
ssh root@<control-plane> \
  kubectl get nodes -L platform.phoenix-host.net/node-role,platform.phoenix-host.net/host-client-workloads
```

Only after the verification command shows `server / true` should the
commit that adds `components: - ../../components/system-node-affinity`
to the overlay be merged.

## CI guardrail

`scripts/ci-system-affinity-check.sh` runs in the Infrastructure CI
job on every PR. It kustomize-builds staging + production and asserts
every entry on its allowlist renders with the `role=server`
nodeAffinity. Adding a new system Deployment / StatefulSet to the base
manifests without also adding it to the
`k8s/components/system-node-affinity/kustomization.yaml` list (or to
an overlay-inline patch for overlay-only workloads like dex) fails CI.

Allowlist lives at the top of `ci-system-affinity-check.sh`. Keep it
in sync with the component. Dev overlay is intentionally skipped (the
DinD single-node dev stack deliberately has no labelled node).

## Admin API

- `GET /api/v1/admin/nodes` — list all nodes + their last-observed
  state. Envelope: `{ data: ClusterNodeResponse[] }`.
- `GET /api/v1/admin/nodes/:name` — single node.
- `PATCH /api/v1/admin/nodes/:name` — update `role` /
  `canHostClientWorkloads` / `notes`. Writes the k8s label first
  (authoritative), DB is refreshed on the next reconciler tick.
  **Server→worker demotion is refused** (`409 NODE_DEMOTION_BLOCKED`)
  when the node still hosts any system pod. Pass `force: true` in the
  body to override — typically after a manual `kubectl drain`.

All routes are admin-only (`super_admin` / `admin`). Client-panel
tokens have no visibility into cluster topology.

## What's still out of M1

- Admin-panel Nodes page UI (M4)
- Client provisioning worker-selector (M5)
- Longhorn storage class tiers (M2)
- Tenant migration tools (M6)
- HA opt-in for tenant workloads (M7)
- 3-server control plane (M8)
- CNPG Postgres replication prep (M10)
- Provider-abstracted Load Balancer (M11, opt-in only at 3+ servers)

See task tracker or the original planner plan for the full sequence.
