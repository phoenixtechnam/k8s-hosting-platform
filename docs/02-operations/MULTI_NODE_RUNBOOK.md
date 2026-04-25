# Multi-Node Runbook (M8 + M9)

Field manual for growing a running cluster from 1 → 3 → 5 servers and
adding worker nodes. Pairs with ADR-031 (architecture) and
`NODE_ROLE_TAXONOMY.md` (label/taint schema).

## Glossary

- **Server**: k3s control plane node. Runs etcd, platform-api,
  admin/client-panel, Postgres, Stalwart. Carries the
  `platform.phoenix-host.net/node-role=server` label.
- **Worker**: tenant workload node. Runs the per-client pods,
  ingress-nginx DaemonSet, Longhorn replica.
- **Quorum**: etcd requires a majority of servers to accept writes.
  3 servers tolerate 1 failure; 5 servers tolerate 2. Never run an
  even count — it can't form a quorum on partition.

## Growing the cluster

### Add a 2nd server (1 → 2 servers; DEGRADED HA, not fully HA)

Two servers don't form a real HA setup (can't tolerate loss — etcd
refuses writes when either is down). Use this step only as a
stepping-stone toward 3 servers, typically on the same provisioning
day.

```bash
# On the existing 1st server — grab the join token:
ssh root@<server-1> cat /var/lib/rancher/k3s/server/node-token
# → K1234...

# Provision a new VPS, DNS, firewall rules.

# Run bootstrap against the new host:
./scripts/bootstrap.sh \
  --remote <server-2-ip> --ssh-key ~/hosting-platform.key \
  --role server \
  --domain phoenix-host.net \
  --env staging \
  --server <server-1-ip> \
  --token <K1234...>
```

The new server joins the etcd cluster. You can verify with:

```bash
ssh root@<server-1> kubectl get nodes -L platform.phoenix-host.net/node-role
```

New server appears with the `server` label applied automatically by
`apply_node_labels_and_taints`. `canHostClientWorkloads` defaults to
`false` — the server is production-safe by default.

### Add a 3rd server (2 → 3; FULL HA)

Same flow. Once done, the cluster has real HA:

- etcd tolerates the loss of any 1 server.
- The admin panel's "Cluster Nodes" page shows 3 servers with the
  last-seen badge.
- The M11 Load Balancer HA gate (`enforceHaGate`) now unlocks —
  operators can enable an LB if desired.
- The M10 CNPG activation runbook becomes applicable.

### Add a worker

Workers don't join etcd; they just take tenant workloads.

```bash
./scripts/bootstrap.sh \
  --remote <worker-ip> --ssh-key ~/hosting-platform.key \
  --role worker \
  --server <any-server-ip> \
  --token <K-token>
```

After the script completes, from the control plane:

```bash
ssh root@<server-1> kubectl label node <worker-hostname> \
  platform.phoenix-host.net/node-role=worker --overwrite
ssh root@<server-1> kubectl label node <worker-hostname> \
  platform.phoenix-host.net/host-client-workloads=true --overwrite
```

Workers default to `host-client-workloads=true` via the bootstrap
message; this explicit label is only needed if you want a specific
value. The node-sync reconciler (M1) picks up the labels within 60s
and the node appears in the admin UI.

## Common tasks

### Drain a node for maintenance

```bash
kubectl drain <nodename> --ignore-daemonsets --delete-emptydir-data
```

The drain:
- Evicts tenant pods; the scheduler rebinds them on other eligible
  nodes (workers with spare capacity, or a server if
  `host-client-workloads=true`).
- Ignores DaemonSets (ingress-nginx, longhorn-manager).
- Waits for graceful shutdown.

Once maintenance is done:

```bash
kubectl uncordon <nodename>
```

### Remove a node permanently

1. `kubectl drain` as above (wait for tenants to reschedule).
2. `kubectl delete node <nodename>` — removes from the cluster.
3. `ssh root@<node> /usr/local/bin/k3s-uninstall.sh` — if it was a
   server — or `k3s-agent-uninstall.sh` for workers.
4. Release the VPS.

The node-sync reconciler drops the stale `cluster_nodes` row on the
next tick (it upserts from `kubectl get nodes`; anything missing
there is eventually cleaned up).

### Handle an unhealthy server

If etcd on a server misbehaves:

```bash
kubectl logs -n kube-system -l app=k3s --tail=200
journalctl -u k3s -n 200 --no-pager   # on the affected host
```

When an etcd quorum is at risk (2 of 3 servers healthy):
1. Don't drain the healthy one.
2. Investigate logs on the unhealthy host.
3. If unrecoverable: remove the unhealthy member from etcd first:

```bash
# On a healthy server:
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cert=/var/lib/rancher/k3s/server/tls/etcd/server-client.crt \
  --key=/var/lib/rancher/k3s/server/tls/etcd/server-client.key \
  --cacert=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
  member list

ETCDCTL_API=3 etcdctl member remove <unhealthy-member-id>
```

Then `kubectl delete node <unhealthy-nodename>` from the k8s side,
replace the VPS, and re-run `bootstrap.sh --join-as server --server …
--token …` to join a fresh etcd member.

## Monitoring

### Essential dashboards

Enable at bootstrap (`--with-monitoring`) or via Flux:

- **Node health**: `kubectl get nodes -o wide` + Prometheus
  `kube_node_status_condition`. Alert when Ready=False for >5 min.
- **etcd health**: `etcd_server_has_leader` per endpoint. Alert when
  any server reports 0 for >1 min (leader lost).
- **Server count**: `cluster_nodes` table `COUNT(*) WHERE role='server'
  AND last_seen_at > NOW() - INTERVAL '5 min'`. Should be 1, 3, or 5.
  Alert on even numbers (operator error — odd quorum required).
- **Tenant pod placement**: `count by (node) (kube_pod_info{namespace=~"client-.*"})`.
  Alert when a single node hosts >70% of tenants (bad distribution).

### Log aggregation

- platform-api: `kubectl logs -n platform deploy/platform-api`
  (or via Loki if `--with-monitoring` was set).
- Node-sync reconciler: grep `[node-sync]` in the platform-api logs —
  60s cadence, last_seen lag.
- Ingress-nginx: per-node access logs (each DaemonSet pod has its
  own).

### Node sync staleness

The admin-panel Cluster Nodes page surfaces `last_seen_at` as a
coloured badge:

- **green** < 5 min (healthy)
- **amber** 5–30 min (stale — investigate but not urgent)
- **red**   > 30 min (dead — likely removed or offline)

## Known gotchas

- **Longhorn replica rebalance on new worker**: replicas don't
  migrate automatically. On adding a worker, run
  `kubectl patch settings replica-auto-balance -n longhorn-system
  --type=json -p='[{"op":"replace","path":"/value","value":"best-effort"}]'`
  or use the Longhorn UI to rebalance manually. Watch disk I/O — the
  replica copy saturates network for the duration.
- **cert-manager + ACME challenges**: when ingress-nginx runs on
  every node (DaemonSet) and DNS points at worker-N, ACME's
  http-01 challenge must hit THAT worker. The `externalTrafficPolicy:
  Local` on the ingress-nginx Service preserves the client IP
  (needed for rate limits) AND means each worker serves only the
  hosts for which its node has a backend pod. Don't switch to
  `Cluster` without re-checking the ACME flow.
- **Flux reconciles on every server**: since Flux runs on the
  control plane, each server tries to reconcile. With 3 servers
  there can be 3 simultaneous applies on the same cluster.
  Kustomize-server-side-apply makes this idempotent, but Flux events
  get spammy. Acceptable.
- **Joining a server without `--cluster-init` fails with "etcd not
  available"**: the first server bootstrapped with sqlite can't
  upgrade to etcd without a full rebuild. Check
  `/var/lib/rancher/k3s/server/db/state.db` — if that file exists
  and `/var/lib/rancher/k3s/server/db/etcd/` does NOT, you're on
  sqlite. Rebootstrap per DISASTER_RECOVERY.md before growing.
