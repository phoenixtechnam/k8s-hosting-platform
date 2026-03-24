# High Availability Migration Runbook

**Document Version:** 1.0  
**Last Updated:** 2026-03-06  
**Status:** DRAFT — Ready for implementation  
**Audience:** DevOps engineers, platform operators, system administrators

---

## Overview

This runbook provides step-by-step procedures for scaling the platform from a single-node deployment to full high availability. Each stage is independent — you can stop at any stage and remain at that level indefinitely.

**Key principle:** Every stage transition has **zero customer downtime** when performed correctly. All stages are additive (no rebuilds, no data migration).

> **Note:** All `ssh admin@<node>` commands are executed via the **NetBird WireGuard mesh** (ADR-013). SSH is not exposed on the public internet.

### Stage Summary

| Stage | Topology | Monthly Cost | Capacity | Survives |
|-------|----------|-------------|----------|----------|
| **0** | 1 node (CP+Worker) | ~EUR15 | 0-20 Starter clients | Nothing (rebuild from backup) |
| **1** | CP + 1 Worker | ~EUR30 | 20-50 Starter | CP failure (traffic continues serving) |
| **2** | CP + 2 Workers | ~EUR45 | 50-100 Starter + Business | Single worker failure (Longhorn replica + pod reschedule) |
| **3** | 3 CP + 2 Workers | ~EUR75 | 100-200+ | Any single node failure |
| **4** | Stage 3 + DB HA | ~EUR75 | 100-200+ | Any single node + database pod failure |

---

## Stage 0: Single Node (Starting Point)

**Topology:** 1 node running k3s server + agent combined.

```
┌──────────────────────────────────────┐
│  Node 1: CP + Worker                 │
│  Hetzner CPX31 (4vCPU / 8GB / 160GB)│
│                                      │
│  k3s server + agent (combined)       │
│  etcd (embedded, single-member)      │
│  All platform services               │
│  All customer pods                   │
│  Longhorn storage (replication: 1)   │
│  NGINX Ingress Controller (DaemonSet)│
│  NetBird agent                       │
└──────────────────────────────────────┘
```

**Installation:**

```bash
# Install k3s (single node, server+agent combined)
curl -sfL https://get.k3s.io | sh -s - server \
  --disable traefik \
  --tls-san <public-ip> \
  --tls-san <netbird-mesh-ip>

# Verify
kubectl get nodes
# NAME    STATUS   ROLES                  AGE   VERSION
# node1   Ready    control-plane,master   1m    v1.29.x+k3s1
```

**Backup strategy (critical at this stage):**
- Daily etcd snapshot: `k3s etcd-snapshot save --name daily-$(date +%Y%m%d)`
- Daily Longhorn volume snapshots (all PVCs)
- Daily offsite backup via SSHFS mount over NetBird mesh (mount → write → unmount)
- **RTO:** 30-60 minutes (provision new VPS, restore from backup)
- **RPO:** Up to 24 hours (last backup)

**Note:** DNS (PowerDNS) and admin VPN (NetBird) run on separate VPS infrastructure (ns1: Falkenstein, ns2: Helsinki), external to this cluster. They are not affected by cluster node failures. See `SECURITY_ARCHITECTURE.md` for the dual-VPS topology.

---

## Stage 0 to 1: Add Dedicated Worker Node

**Trigger indicators:**
- Node resource usage consistently >70% (CPU or memory)
- First paying customer (need to isolate CP from workload risk)
- Desire to reduce blast radius (CP failure shouldn't affect customer data)

**Duration:** 45-60 minutes  
**Customer downtime:** Zero (pods drain gracefully and reschedule)

### Pre-flight Checklist

```
[ ] New VPS provisioned (Hetzner CPX31: 4vCPU/8GB or larger)
[ ] Debian 13 installed, base OS hardened (SSH keys, firewall, fail2ban)
[ ] NetBird agent installed and joined to mesh
[ ] Node can reach CP node on port 6443 (verify via NetBird mesh)
[ ] etcd snapshot taken on CP node (rollback point)
[ ] Maintenance window communicated to customers (optional at this stage)
```

### Procedure

**Step 1: Take a backup (5 min)**

```bash
# On CP node (Node 1)
ssh admin@<node1-netbird-ip>

# etcd snapshot
sudo k3s etcd-snapshot save --name pre-stage1-$(date +%Y%m%d-%H%M)

# Verify snapshot
sudo k3s etcd-snapshot ls
```

**Step 2: Get join token from CP (1 min)**

```bash
# On CP node
sudo cat /var/lib/rancher/k3s/server/node-token
# Save this token — needed for worker to join
```

**Step 3: Install k3s agent on new worker (5 min)**

```bash
# On new Worker node (Node 2)
ssh admin@<node2-netbird-ip>

# Install k3s agent (worker only, no server components)
curl -sfL https://get.k3s.io | K3S_URL=https://<node1-netbird-ip>:6443 \
  K3S_TOKEN=<node-token> \
  INSTALL_K3S_EXEC="agent" sh -

# Verify node joined
kubectl get nodes
# NAME    STATUS   ROLES                  AGE   VERSION
# node1   Ready    control-plane,master   30d   v1.29.x+k3s1
# node2   Ready    <none>                 1m    v1.29.x+k3s1
```

**Step 4: Label the worker node (1 min)**

```bash
kubectl label node node2 node-role.kubernetes.io/worker=worker
kubectl label node node2 kubernetes.io/role=worker
```

**Step 5: Taint CP node to prevent workload scheduling (1 min)**

```bash
# Prevent customer/platform workloads from scheduling on CP
kubectl taint nodes node1 node-role.kubernetes.io/control-plane:NoSchedule
```

**Step 6: Remove CP node IP from DNS ingress records BEFORE draining (2 min)**

Remove the CP node's IP from the `ingress.platform.com` A record set **before** draining. Draining first would send traffic to a node that is mid-drain and shedding connections. DNS removal first ensures no new connections arrive on node1 while it drains.

```bash
# If DNS Ingress Controller is deployed, it will detect the drain cordon automatically
# and remove the IP when the NGINX Ingress pod on node1 becomes Terminating.
# To be safe, manually remove it first via PowerDNS API:

curl -s -X PATCH -H "X-API-Key: $PDNS_API_KEY" \
  http://ns1.platform.com:8081/api/v1/servers/localhost/zones/platform.com. \
  -d '{
    "rrsets": [{
      "name": "ingress.platform.com.",
      "type": "A",
      "ttl": 60,
      "changetype": "REPLACE",
      "records": [{"content": "<node2-public-ip>", "disabled": false}]
    }]
  }'

# Verify the CP IP is no longer returned
dig ingress.platform.com +short
# Should return ONLY node2-public-ip

# Wait one TTL (60s) for DNS caches to expire before draining
sleep 60
```

**Step 7: Drain workloads from CP to worker (5-10 min)**

```bash
# Gracefully move all pods from Node 1 to Node 2
kubectl drain node1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=120

# Watch pods migrate
kubectl get pods -A -o wide --watch
# Wait until all non-system pods are Running on node2
```

**Step 9: Verify Longhorn storage (5 min)**

```bash
# Verify Longhorn sees the new node
kubectl -n longhorn-system get nodes.longhorn.io

# Verify all PVCs are accessible from the new node
kubectl get pvc -A
# All should show STATUS: Bound

# Longhorn will automatically schedule volume replicas on the new node
# But replication factor is still 1 (only one copy)
# We'll increase this in Stage 2
```

**Step 10: Verify all services (5 min)**

```bash
# All pods running on worker
kubectl get pods -A -o wide | grep node2

# Ingress controller responding
curl -k https://<public-ip>/healthz

# Test a customer site
curl -I https://customer-domain.com

# Test Management API
curl https://api.platform.com/api/v1/health

# Test email
# Send a test email, verify IMAP access

# Verify NetBird mesh
netbird status
# Both nodes should show as connected peers
```

**Step 11: Update firewall on CP node (2 min)**

```bash
# CP no longer serves customer traffic — close customer-facing ports
# Keep only: WireGuard (51820/UDP), K8s API via mesh (6443 on wt0)

ssh admin@<node1-netbird-ip>

# Remove customer-facing ports from CP firewall
sudo iptables -D INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -D INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -D INPUT -p tcp --dport 25 -j ACCEPT
sudo iptables -D INPUT -p tcp --dport 587 -j ACCEPT
sudo iptables -D INPUT -p tcp --dport 993 -j ACCEPT
sudo iptables -D INPUT -p tcp --dport 2222 -j ACCEPT

# Save iptables rules
sudo iptables-save > /etc/iptables/rules.v4
```

**Step 12: Update DNS ingress records (2 min)**

```bash
# The DNS Ingress Controller should auto-detect the new worker node and update
# the ingress.platform.com A record set to point at the Worker node (Node 2).
# Verify:
dig ingress.platform.com +short
# Should return: <node2-public-ip>

# If DNS Ingress Controller is not yet deployed, manually update PowerDNS:
# curl -X PATCH -H "X-API-Key: $API_KEY" \
#   http://ns1.platform.com:8081/api/v1/servers/localhost/zones/platform.com. \
#   -d '{"rrsets": [{"name": "ingress.platform.com.", "type": "A", "ttl": 60, "changetype": "REPLACE", "records": [{"content": "<node2-public-ip>", "disabled": false}]}]}'

# All customer domains using CNAME → ingress.platform.com will follow automatically.
# Apex domains with direct A records need updating too.
```

**Step 13: Optionally downsize CP node (5 min)**

The CP node now only runs k3s server (etcd, API server, scheduler, controller-manager). It needs far less resources:

```
Before: CPX31 (4vCPU / 8GB)  ~EUR15/month
After:  CPX21 (3vCPU / 4GB)  ~EUR8/month  (sufficient for CP-only)
```

Hetzner allows in-place resize (requires reboot). Schedule during low-traffic window.

### Post-Stage-1 Verification

```
[ ] kubectl get nodes — both nodes Ready
[ ] All customer sites accessible
[ ] Management API responsive
[ ] Email sending/receiving works
[ ] SFTP accessible
[ ] Longhorn volumes healthy
[ ] Prometheus scraping both nodes
[ ] NetBird mesh shows both nodes connected
[ ] etcd snapshot taken (new baseline)
[ ] Monitoring alerts not firing
```

### Rollback (if needed)

```bash
# Remove taint from CP node
kubectl taint nodes node1 node-role.kubernetes.io/control-plane:NoSchedule-

# Drain worker, move pods back to CP
kubectl drain node2 --ignore-daemonsets --delete-emptydir-data

# Remove worker from cluster
kubectl delete node node2

# On worker node: uninstall k3s agent
ssh admin@<node2-netbird-ip>
sudo /usr/local/bin/k3s-agent-uninstall.sh
```

---

## Stage 1 to 2: Add Second Worker (Storage Redundancy)

**Trigger indicators:**
- Single worker at >70% resource usage
- Need storage redundancy (Longhorn replication factor 2)
- Running Business/Premium clients that need guaranteed uptime

**Duration:** 30-45 minutes  
**Customer downtime:** Zero

### Pre-flight Checklist

```
[ ] New VPS provisioned (Hetzner CPX31 or larger, matching Node 2 specs)
[ ] Debian 13 installed, base OS hardened
[ ] NetBird agent installed and joined to mesh
[ ] Node can reach CP on port 6443 via mesh
[ ] etcd snapshot taken
```

### Procedure

**Step 1: Take backup (2 min)**

```bash
ssh admin@<node1-netbird-ip>
sudo k3s etcd-snapshot save --name pre-stage2-$(date +%Y%m%d-%H%M)
```

**Step 2: Join new worker to cluster (5 min)**

```bash
# On new Worker node (Node 3)
ssh admin@<node3-netbird-ip>

curl -sfL https://get.k3s.io | K3S_URL=https://<node1-netbird-ip>:6443 \
  K3S_TOKEN=<node-token> \
  INSTALL_K3S_EXEC="agent" sh -

# Label the node
kubectl label node node3 node-role.kubernetes.io/worker=worker
kubectl label node node3 kubernetes.io/role=worker
```

**Step 3: Increase Longhorn replication factor (5 min)**

```bash
# Update default Longhorn StorageClass to replication factor 2
kubectl patch storageclass longhorn -p '{"parameters":{"numberOfReplicas":"2"}}'

# For existing volumes, update replication via Longhorn UI or API
# Longhorn UI: Settings > General > Default Replica Count = 2
# Or via kubectl:
kubectl -n longhorn-system edit settings.longhorn.io default-replica-count
# Set value to "2"

# Longhorn will begin replicating existing volumes to the new node
# This happens in the background — no downtime
# Monitor progress:
kubectl -n longhorn-system get volumes.longhorn.io -o wide
```

**Step 4: Verify NGINX Ingress DaemonSet on both workers (2 min)**

```bash
# NGINX Ingress runs as a DaemonSet — it auto-schedules on every worker node.
# No manual scaling needed. Verify one pod on each worker:
kubectl -n ingress-nginx get pods -o wide
# ingress-nginx-controller-xxx   Running   node2
# ingress-nginx-controller-yyy   Running   node3

# Verify DNS Ingress Controller updated the A record set:
dig ingress.platform.com +short
# Expected: <node2-ip> and <node3-ip>
```

**Step 5: Add pod anti-affinity for critical services (5 min)**

Ensure critical platform services don't all land on the same worker:

```bash
# Patch deployments to spread across nodes
# MariaDB, PostgreSQL, Redis, Management API, NGINX Ingress

# Example: Management API anti-affinity
kubectl -n platform patch deployment management-api --type=json -p='[
  {"op": "add", "path": "/spec/template/spec/affinity", "value": {
    "podAntiAffinity": {
      "preferredDuringSchedulingIgnoredDuringExecution": [{
        "weight": 100,
        "podAffinityTerm": {
          "labelSelector": {
            "matchExpressions": [{
              "key": "app",
              "operator": "In",
              "values": ["management-api"]
            }]
          },
          "topologyKey": "kubernetes.io/hostname"
        }
      }]
    }
  }}
]'
```

**Step 6: Add Pod Disruption Budgets (3 min)**

```yaml
# pdb-platform-services.yaml
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ingress-nginx-pdb
  namespace: ingress-nginx
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: management-api-pdb
  namespace: platform
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: management-api
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: mariadb-pdb
  namespace: platform
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: mariadb
```

```bash
kubectl apply -f pdb-platform-services.yaml
```

**Step 7: Rebalance workloads (5 min)**

```bash
# Restart deployments to spread pods across both workers
kubectl -n platform rollout restart deployment/management-api
kubectl -n monitoring rollout restart deployment/grafana
kubectl -n monitoring rollout restart statefulset/prometheus

# Wait for rollout
kubectl -n platform rollout status deployment/management-api
```

**Step 8: Verify DNS ingress records (5 min)**

With two workers serving traffic via DaemonSet, the DNS Ingress Controller should
automatically update the `ingress.platform.com` A record set to include both worker IPs:

```bash
# Verify DNS records include both worker IPs
dig ingress.platform.com +short
# Expected:
# <node2-public-ip>
# <node3-public-ip>

# If DNS Ingress Controller is not yet deployed, manually update PowerDNS:
# curl -X PATCH -H "X-API-Key: $API_KEY" \
#   http://ns1.platform.com:8081/api/v1/servers/localhost/zones/platform.com. \
#   -d '{"rrsets": [{"name": "ingress.platform.com.", "type": "A", "ttl": 60, "changetype": "REPLACE", "records": [{"content": "<node2-public-ip>", "disabled": false}, {"content": "<node3-public-ip>", "disabled": false}]}]}'

# All customer CNAMEs → ingress.platform.com follow automatically.
```

**Step 9: Verify (5 min)**

```bash
# All nodes ready
kubectl get nodes
# node1   Ready   control-plane   ...
# node2   Ready   worker          ...
# node3   Ready   worker          ...

# Longhorn replication status
kubectl -n longhorn-system get volumes.longhorn.io
# All volumes should show 2 replicas (may take time to sync)

# Ingress on both workers
kubectl -n ingress-nginx get pods -o wide

# Customer sites reachable via both worker IPs
curl -I --resolve panel.platform.com:443:<node2-ip> https://panel.platform.com
curl -I --resolve panel.platform.com:443:<node3-ip> https://panel.platform.com
```

### What Stage 2 Gives You

**Worker failure test:**
```
1. Worker Node 2 dies
2. Kubernetes detects node NotReady (40 seconds default)
3. Pods rescheduled to Node 3 (~30-60 seconds)
4. Longhorn serves data from replica on Node 3
5. Customer downtime: 60-90 seconds (pod rescheduling time)
6. Data loss: ZERO (Longhorn replicated)
```

### Rollback

```bash
# Ingress runs as DaemonSet — it auto-removes when worker node is removed.
# No manual ingress scaling needed.

# Reduce Longhorn replication to 1 (wait for decommission)
kubectl -n longhorn-system edit settings.longhorn.io default-replica-count
# Set value to "1"

# Remove PDBs
kubectl delete pdb -n ingress-nginx ingress-nginx-pdb
kubectl delete pdb -n platform management-api-pdb mariadb-pdb

# Drain and remove Node 3
kubectl drain node3 --ignore-daemonsets --delete-emptydir-data
kubectl delete node node3
ssh admin@<node3-netbird-ip>
sudo /usr/local/bin/k3s-agent-uninstall.sh
```

---

## Stage 2 to 3: HA Control Plane (3-Node etcd)

**Trigger indicators:**
- CP downtime is unacceptable (even for kubectl/deployments)
- Running >100 clients
- Compliance requires documented HA
- Need to perform CP maintenance without cluster management downtime

**Duration:** 60-90 minutes  
**Customer downtime:** Zero  
**Cluster management downtime:** Brief (seconds during etcd migration to multi-member)

### Pre-flight Checklist

```
[ ] 2 new VPS provisioned (Hetzner CPX21: 3vCPU/4GB each — CP-only, no workloads)
[ ] Debian 13 installed, base OS hardened on both
[ ] NetBird agent installed and joined to mesh on both
[ ] Both can reach existing CP on port 6443 via mesh
[ ] etcd snapshot taken (critical!)
[ ] Maintenance window communicated (brief kubectl unavailability possible)
```

### Important: k3s Embedded etcd HA

k3s supports embedded etcd HA natively. The first server is initialized with `--cluster-init`, and additional servers join with `--server`. **However**, if the original single server was NOT started with `--cluster-init`, you need to migrate.

**If you started Stage 0 with `--cluster-init`:** Proceed directly to Step 2.  
**If you started Stage 0 without `--cluster-init`:** You must migrate first (Step 1).

### Procedure

**Step 1: Migrate to embedded etcd cluster mode (if needed) (10 min)**

```bash
# On CP node (Node 1)
ssh admin@<node1-netbird-ip>

# Take snapshot first
sudo k3s etcd-snapshot save --name pre-ha-migration-$(date +%Y%m%d-%H%M)

# Stop k3s
sudo systemctl stop k3s

# Restart with --cluster-init (converts single-node etcd to cluster-capable)
# Edit /etc/systemd/system/k3s.service or k3s config
sudo nano /etc/rancher/k3s/config.yaml
```

```yaml
# /etc/rancher/k3s/config.yaml
cluster-init: true
disable:
  - traefik
tls-san:
  - <public-ip>
  - <netbird-mesh-ip>
```

```bash
sudo systemctl daemon-reload
sudo systemctl start k3s

# Verify single-member etcd cluster
sudo k3s etcd-snapshot ls
kubectl get nodes  # Should still work
```

**Step 2: Join second CP node (10 min)**

```bash
# Get token from Node 1
ssh admin@<node1-netbird-ip>
sudo cat /var/lib/rancher/k3s/server/node-token

# On Node 4 (new CP)
ssh admin@<node4-netbird-ip>

# Create config
sudo mkdir -p /etc/rancher/k3s
sudo cat > /etc/rancher/k3s/config.yaml <<'EOF'
server: https://<node1-netbird-ip>:6443
token: <node-token>
disable:
  - traefik
tls-san:
  - <public-ip>
  - <netbird-mesh-ip>
EOF

# Install k3s server (joins existing cluster)
curl -sfL https://get.k3s.io | sh -s - server

# Verify 2-member cluster
kubectl get nodes
# node1   Ready   control-plane,master   ...
# node2   Ready   worker                 ...
# node3   Ready   worker                 ...
# node4   Ready   control-plane,master   ...
```

**Step 3: Join third CP node (10 min)**

```bash
# On Node 5 (third CP)
ssh admin@<node5-netbird-ip>

# Same config as Node 4 (points to Node 1)
sudo mkdir -p /etc/rancher/k3s
sudo cat > /etc/rancher/k3s/config.yaml <<'EOF'
server: https://<node1-netbird-ip>:6443
token: <node-token>
disable:
  - traefik
tls-san:
  - <public-ip>
  - <netbird-mesh-ip>
EOF

curl -sfL https://get.k3s.io | sh -s - server

# Verify 3-member etcd cluster
kubectl get nodes
# node1   Ready   control-plane,master   ...
# node2   Ready   worker                 ...
# node3   Ready   worker                 ...
# node4   Ready   control-plane,master   ...
# node5   Ready   control-plane,master   ...
```

**Step 4: Verify etcd health (5 min)**

```bash
# On any CP node
sudo k3s etcd-snapshot ls

# Check etcd member list
sudo ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
  --cert=/var/lib/rancher/k3s/server/tls/etcd/client.crt \
  --key=/var/lib/rancher/k3s/server/tls/etcd/client.key \
  member list -w table

# Expected: 3 members, all started
# +------------------+---------+-------+----------------------------+
# |        ID        | STATUS  | NAME  |        PEER ADDRS          |
# +------------------+---------+-------+----------------------------+
# | xxxx             | started | node1 | https://node1-ip:2380      |
# | yyyy             | started | node4 | https://node4-ip:2380      |
# | zzzz             | started | node5 | https://node5-ip:2380      |
# +------------------+---------+-------+----------------------------+

# Check etcd cluster health
sudo ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
  --cert=/var/lib/rancher/k3s/server/tls/etcd/client.crt \
  --key=/var/lib/rancher/k3s/server/tls/etcd/client.key \
  endpoint health --cluster -w table
# All should show "healthy"
```

**Step 5: Taint all CP nodes (2 min)**

```bash
# Ensure no workloads schedule on CP nodes
kubectl taint nodes node1 node-role.kubernetes.io/control-plane:NoSchedule
kubectl taint nodes node4 node-role.kubernetes.io/control-plane:NoSchedule
kubectl taint nodes node5 node-role.kubernetes.io/control-plane:NoSchedule
```

**Step 6: Configure load balancing for K8s API (10 min)**

With 3 CP nodes, kubectl should be able to reach any of them. Options:

```bash
# Option A: Round-robin DNS (simple)
# Point kubeconfig server URL to a DNS name that resolves to all 3 CP IPs
k8s-api.internal.platform.com  IN A  <node1-netbird-ip>
k8s-api.internal.platform.com  IN A  <node4-netbird-ip>
k8s-api.internal.platform.com  IN A  <node5-netbird-ip>

# Update kubeconfig on admin workstations:
# server: https://k8s-api.internal.platform.com:6443

# Option B: NetBird DNS (built-in)
# NetBird supports DNS for mesh peers
# Configure k8s-api.mesh to resolve to all 3 CP nodes

# Option C: HAProxy on admin workstation (local load balancer)
# For maximum reliability — local proxy distributes across all 3 CPs
```

**Step 7: Update firewall on new CP nodes (5 min)**

```bash
# Same rules as Node 1 — CP-only, no customer-facing ports
# Only allow: WireGuard (51820/UDP), mesh SSH (22 on wt0), mesh K8s API (6443 on wt0)
# Plus etcd peer communication between CP nodes (2379/2380)

for node in node4 node5; do
  ssh admin@<${node}-netbird-ip> <<'FIREWALL'
  sudo iptables -A INPUT -p udp --dport 51820 -j ACCEPT
  sudo iptables -A INPUT -i wt0 -p tcp --dport 22 -j ACCEPT
  sudo iptables -A INPUT -i wt0 -p tcp --dport 6443 -j ACCEPT
  sudo iptables -A INPUT -s <cp-subnet> -p tcp --dport 2379 -j ACCEPT
  sudo iptables -A INPUT -s <cp-subnet> -p tcp --dport 2380 -j ACCEPT
  sudo iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  sudo iptables -A INPUT -i lo -j ACCEPT
  sudo iptables -P INPUT DROP
  sudo iptables-save > /etc/iptables/rules.v4
FIREWALL
done
```

**Step 8: Install NetBird and verify mesh (5 min)**

```bash
# Verify all 5 nodes are in the NetBird mesh
netbird status
# Should show 5 peers: node1, node2, node3, node4, node5

# Verify SSH to all CP nodes via mesh
for ip in <node1-mesh-ip> <node4-mesh-ip> <node5-mesh-ip>; do
  ssh admin@$ip "hostname && kubectl get nodes --no-headers | wc -l"
done
# Each should return hostname and "5" (all nodes visible)
```

**Step 9: Test CP failover (10 min)**

```bash
# Simulate CP node failure — stop k3s on Node 1
ssh admin@<node1-netbird-ip>
sudo systemctl stop k3s

# From admin workstation (pointing kubectl at Node 4 or 5):
kubectl get nodes
# node1 should show NotReady
# All other nodes should be Ready
# kubectl commands should still work (etcd quorum: 2 of 3)

# Verify customer traffic unaffected
curl -I https://customer-domain.com
# Should work — workers are independent of CP for serving existing traffic

# Restart Node 1
ssh admin@<node1-netbird-ip>
sudo systemctl start k3s

# Wait for node to rejoin
kubectl get nodes
# All 5 nodes Ready
```

### What Stage 3 Gives You

**CP failure test:**
```
1. CP Node 1 dies
2. etcd quorum maintained (2 of 3 members alive)
3. K8s API available via Node 4 or Node 5
4. kubectl commands work normally
5. Pod scheduling continues on workers
6. Customer traffic: ZERO impact
7. Cluster management: ZERO downtime
```

**Quorum rules:**
- 3 CP nodes: can lose 1 (quorum = 2)
- If 2 CP nodes fail: etcd loses quorum, cluster becomes read-only (existing pods keep running but no new scheduling)

### Rollback

```bash
# Remove CP nodes (reverse order)
ssh admin@<node5-netbird-ip>
sudo /usr/local/bin/k3s-uninstall.sh

ssh admin@<node4-netbird-ip>
sudo /usr/local/bin/k3s-uninstall.sh

# Remove from cluster
kubectl delete node node5
kubectl delete node node4

# Untaint Node 1 if reverting to single CP + workers
kubectl taint nodes node1 node-role.kubernetes.io/control-plane:NoSchedule-
```

---

## Stage 3 to 4: Database High Availability

**Trigger indicators:**
- Database downtime is unacceptable
- Running >100 clients
- Business/Premium clients with SLA commitments
- Desire to perform database maintenance without downtime

**Duration:** 30-60 minutes per database  
**Customer downtime:** Zero (operators handle failover)  
**Requires:** Stage 2+ (at least 2 workers for anti-affinity)

### 4a: MariaDB HA (Percona Operator)

**Current:** Single MariaDB pod on one worker.  
**Target:** Primary + 1 replica with automatic failover.

**Step 1: Install Percona XtraDB Cluster Operator**

```bash
# Add Percona Helm repo
helm repo add percona https://percona.github.io/percona-helm-charts/
helm repo update

# Install operator
helm install percona-xtradb-cluster-operator percona/pxc-operator \
  --namespace platform \
  --set watchAllNamespaces=true
```

**Step 2: Create MariaDB cluster resource**

```yaml
# mariadb-ha.yaml
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBCluster
metadata:
  name: mariadb-cluster
  namespace: platform
spec:
  pxc:
    size: 2  # Primary + 1 replica
    resources:
      requests:
        memory: 512Mi
        cpu: 500m
      limits:
        memory: 1Gi
        cpu: "1"
    volumeSpec:
      persistentVolumeClaim:
        storageClassName: longhorn
        resources:
          requests:
            storage: 20Gi
    affinity:
      antiAffinityTopologyKey: "kubernetes.io/hostname"
  haproxy:
    enabled: true
    size: 2
    affinity:
      antiAffinityTopologyKey: "kubernetes.io/hostname"
```

```bash
kubectl apply -f mariadb-ha.yaml
```

**Step 3: Migrate data from standalone to cluster**

```bash
# Export from standalone MariaDB
kubectl -n platform exec mariadb-standalone -- \
  mysqldump --all-databases --single-transaction > all-databases.sql

# Import into new cluster (via HAProxy service)
kubectl -n platform exec -i mariadb-cluster-haproxy-0 -- \
  mysql < all-databases.sql

# Update Management API database connection string to point at HAProxy service:
#   mariadb-cluster-haproxy.platform.svc.cluster.local:3306
```

**Step 4: Verify failover**

```bash
# Check cluster status
kubectl -n platform exec mariadb-cluster-pxc-0 -- \
  mysql -e "SHOW STATUS LIKE 'wsrep_cluster_size';"
# Should show 2

# Simulate failure: delete primary pod
kubectl -n platform delete pod mariadb-cluster-pxc-0

# HAProxy routes to replica automatically
# Verify app still works:
curl https://api.platform.com/api/v1/health

# Wait for pod to be recreated
kubectl -n platform get pods -w
# mariadb-cluster-pxc-0 should come back and rejoin cluster
```

### 4b: PostgreSQL HA (CloudNativePG)

**Current:** Single PostgreSQL pod.  
**Target:** Primary + 1 replica with automatic failover.

**Step 1: Install CloudNativePG Operator**

```bash
kubectl apply -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.22/releases/cnpg-1.22.0.yaml
```

**Step 2: Create PostgreSQL cluster**

```yaml
# postgresql-ha.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgresql-cluster
  namespace: platform
spec:
  instances: 2  # Primary + 1 replica
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "256MB"
  storage:
    storageClass: longhorn
    size: 20Gi
  affinity:
    topologyKey: kubernetes.io/hostname
  bootstrap:
    recovery:
      source: postgresql-standalone  # Migrate from existing
  monitoring:
    enablePodMonitor: true
```

```bash
kubectl apply -f postgresql-ha.yaml
```

**Step 3: Verify**

```bash
# Check cluster status
kubectl -n platform get cluster postgresql-cluster
# Should show: Cluster in healthy state, 2 instances

kubectl -n platform cnpg status postgresql-cluster
# Shows primary and replica, replication lag

# Failover test: delete primary
kubectl -n platform delete pod postgresql-cluster-1
# CloudNativePG promotes replica, creates new replica
# App reconnects automatically via service endpoint
```

### 4c: Redis HA (Sentinel)

**Current:** Single Redis pod.  
**Target:** 1 primary + 2 replicas + 3 Sentinel instances.

```yaml
# redis-ha.yaml (using Bitnami Helm chart)
# helm install redis-ha bitnami/redis --namespace platform -f redis-ha-values.yaml

# redis-ha-values.yaml
architecture: replication
replica:
  replicaCount: 2
sentinel:
  enabled: true
  quorum: 2
master:
  persistence:
    storageClass: longhorn
    size: 2Gi
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: redis
          topologyKey: kubernetes.io/hostname
```

```bash
helm install redis-ha bitnami/redis \
  --namespace platform \
  -f redis-ha-values.yaml

# Update app connection to use Sentinel-aware client:
# Connection: redis-ha-sentinel.platform.svc.cluster.local:26379
# Sentinel master name: mymaster
```

### Post-Stage-4 Verification

```
[ ] MariaDB cluster: 2 members, wsrep_cluster_size = 2
[ ] PostgreSQL cluster: healthy, 2 instances, replication lag < 1s
[ ] Redis Sentinel: 1 primary + 2 replicas, Sentinel quorum = 2
[ ] All customer sites working (test CRUD operations)
[ ] Management API health check passing
[ ] Failover tested for each database (delete primary pod, verify automatic recovery)
[ ] Connection strings updated in all application configs
[ ] Monitoring dashboards showing cluster metrics
[ ] Backup jobs updated to work with clustered databases
```

---

## Storage Expansion: Hetzner Volume as Longhorn Disk

**When to use this:** Longhorn storage utilisation reaches the warning threshold (>70%) but the node has sufficient CPU and RAM — you need more disk, not more compute. Attaching a Hetzner volume to an existing node is cheaper and faster than provisioning a full new worker node.

**Approach:** Attach a Hetzner block volume to an existing worker node, mount it at a stable path, and register it as an additional disk in Longhorn. Longhorn then schedules new volume replicas onto that disk. No Kubernetes objects change — Longhorn handles everything transparently.

**Why not the Hetzner CSI driver?** The `hcloud-csi` driver would replace Longhorn as the StorageClass backend, breaking replication, snapshots, and multi-cloud portability. Longhorn using a Hetzner volume as a raw disk preserves all of those capabilities. See ADR-014 for the no-hoster-lock-in principle.

**Cost:** €0.04/GB/month on Hetzner. A 200 GB volume costs ~€8/month — significantly cheaper than a new node (~€15/month) when compute capacity is not the bottleneck.

**Duration:** 15–20 minutes  
**Customer downtime:** Zero

---

### Pre-flight Checklist

```
[ ] Longhorn storage utilisation >70% confirmed (Grafana → Longhorn dashboard)
[ ] Target node identified (the worker with the most available CPU headroom)
[ ] hcloud CLI installed and authenticated on admin workstation
[ ] Node accessible via NetBird mesh
[ ] etcd snapshot taken (standard precaution)
```

### Procedure

**Step 1: Create and attach the Hetzner volume (3 min)**

```bash
# On admin workstation (hcloud CLI)

# List current nodes to get the exact server name
hcloud server list

# Create a volume and attach it to the target worker node in one command
# --format ext4 formats it immediately; --automount mounts it at /mnt/HC_Volume_<id>
hcloud volume create \
  --size 200 \
  --name longhorn-data-<node-name>-01 \
  --server <node-name> \
  --format ext4 \
  --automount

# Note the volume ID from the output — you'll need it for the stable device path
hcloud volume list
# VOLUME ID   NAME                         SIZE    SERVER       LOCATION
# 12345678    longhorn-data-worker-01      200 GB  worker-01    fsn1
```

**Step 2: Set up a stable mount point on the node (5 min)**

Hetzner volumes appear as `/dev/disk/by-id/scsi-0HC_Volume_<id>`. Always use the `by-id` path in `/etc/fstab` — device names like `/dev/sdb` can change across reboots.

```bash
ssh admin@<worker-node-netbird-ip>

# Confirm the device is visible
ls -la /dev/disk/by-id/ | grep HC_Volume
# scsi-0HC_Volume_12345678 -> ../../sdb

# Hetzner --automount may have already mounted it at /mnt/HC_Volume_12345678
# We want a more descriptive, stable path for Longhorn:
sudo mkdir -p /mnt/longhorn-data-01

# If already mounted by automount, unmount it first
sudo umount /mnt/HC_Volume_12345678 2>/dev/null || true

# Add stable entry to /etc/fstab
# discard  — enables TRIM (important for performance on Hetzner SSDs)
# nofail   — node boots even if volume is temporarily detached
echo '/dev/disk/by-id/scsi-0HC_Volume_12345678 /mnt/longhorn-data-01 ext4 discard,nofail,defaults 0 0' \
  | sudo tee -a /etc/fstab

# Mount it
sudo mount -a

# Verify
df -h /mnt/longhorn-data-01
# Filesystem      Size  Used Avail Use%  Mounted on
# /dev/sdb        197G   28K  187G   1%  /mnt/longhorn-data-01
```

**Step 3: Register the disk in Longhorn (5 min)**

Longhorn does not auto-discover new mount points. You must register the path explicitly — either via the Longhorn UI or `kubectl`.

**Option A — Longhorn UI (easier):**

1. Open Longhorn UI: `https://longhorn.platform.com` (or port-forward: `kubectl -n longhorn-system port-forward svc/longhorn-frontend 8080:80`)
2. Navigate to **Node** → click the target node name
3. Click **Edit** → **Add Disk**
4. Set:
   - **Path:** `/mnt/longhorn-data-01`
   - **Storage Reserved:** `20Gi` (leave headroom for Longhorn metadata and OS writes)
   - **Scheduling:** Enabled
5. Click **Save**

**Option B — kubectl patch:**

```bash
# Get the current node spec
kubectl -n longhorn-system get nodes.longhorn.io <node-name> -o yaml > longhorn-node.yaml

# Edit the disks section to add the new disk:
# spec:
#   disks:
#     default-disk-<existing-hash>:   ← existing disk entry (leave untouched)
#       path: /var/lib/longhorn
#       allowScheduling: true
#       storageReserved: 10737418240
#     longhorn-data-01:               ← new entry
#       path: /mnt/longhorn-data-01
#       allowScheduling: true
#       storageReserved: 21474836480  # 20Gi in bytes

kubectl -n longhorn-system edit nodes.longhorn.io <node-name>
# Add the new disk entry under spec.disks and save
```

**Step 4: Verify Longhorn sees the new disk (2 min)**

```bash
# Via kubectl
kubectl -n longhorn-system get nodes.longhorn.io <node-name> -o jsonpath='{.spec.disks}'

# Verify the disk shows as schedulable
kubectl -n longhorn-system get nodes.longhorn.io
# NAME        READY   ALLOWSCHEDULING   SCHEDULABLE   AGE
# worker-01   True    True              True          30d
# The node should still show SCHEDULABLE: True

# In Longhorn UI: Node view should show the new disk with its capacity
# and "Scheduling: Enabled" status
```

**Step 5: Rebalance existing volumes onto the new disk (optional)**

New volumes will automatically schedule replicas onto the new disk. Existing volumes keep their current replicas — they are not automatically moved. To rebalance:

```bash
# Option A: Increase and then restore replica count to trigger rebalancing
# This forces Longhorn to schedule a new replica (on the new disk), then remove the old one.
# Do this per-volume or set globally:

# Set replica count to 3 temporarily (triggers new replica on new disk)
kubectl -n longhorn-system patch settings.longhorn.io default-replica-count \
  -p '{"value":"3"}' --type=merge

# Wait for all volumes to reach 3 replicas (monitor in Longhorn UI)
kubectl -n longhorn-system get volumes.longhorn.io -o wide
# Repeat: ROBUSTNESS column should show Healthy for all volumes

# Set back to 2
kubectl -n longhorn-system patch settings.longhorn.io default-replica-count \
  -p '{"value":"2"}' --type=merge

# Option B: Longhorn UI — select individual volumes → Update Replicas
# Useful if you only want to rebalance specific high-priority volumes
```

**Step 6: Verify (2 min)**

```bash
# Longhorn storage available should have increased
kubectl -n longhorn-system get nodes.longhorn.io <node-name> \
  -o jsonpath='{.status.diskStatus}' | python3 -m json.tool
# storageAvailable should reflect the new disk capacity

# All existing PVCs still bound
kubectl get pvc -A | grep -v Bound
# Should return empty (all PVCs remain Bound throughout)

# Customer sites still responding
curl -I https://<a-customer-domain>
```

---

### Expanding an Existing Hetzner Volume

If you need more space on an already-attached volume, Hetzner allows online resize (no detach required).

```bash
# On admin workstation
# Resize from 200GB to 400GB
hcloud volume resize <volume-id> --size 400

# On the node — resize the filesystem to fill the new space (online, no unmount needed)
ssh admin@<worker-node-netbird-ip>
sudo resize2fs /dev/disk/by-id/scsi-0HC_Volume_<id>

# Verify new size
df -h /mnt/longhorn-data-01
# Should show ~394G available

# Longhorn detects the increased disk capacity automatically within ~60 seconds
# No Longhorn configuration changes needed
```

---

### Detaching a Hetzner Volume (Decommission)

Before detaching, Longhorn must evacuate all replicas off the disk.

```bash
# Step 1: Disable scheduling on the disk (stops new replicas landing on it)
# Longhorn UI: Node → Edit → set disk Scheduling to Disabled
# Or:
kubectl -n longhorn-system edit nodes.longhorn.io <node-name>
# Set spec.disks.longhorn-data-01.allowScheduling: false

# Step 2: Evict all replicas off the disk
# Longhorn UI: Node → Disk → Evict
# Or trigger via volume replica count increase (same as Step 5 above)

# Step 3: Confirm zero replicas remain on the disk
kubectl -n longhorn-system get replicas.longhorn.io -o wide | grep longhorn-data-01
# Should return empty

# Step 4: Remove the disk from Longhorn node spec
kubectl -n longhorn-system edit nodes.longhorn.io <node-name>
# Delete the longhorn-data-01 entry from spec.disks

# Step 5: Unmount and remove from fstab on the node
ssh admin@<worker-node-netbird-ip>
sudo umount /mnt/longhorn-data-01
sudo sed -i '/longhorn-data-01/d' /etc/fstab

# Step 6: Detach volume in Hetzner
hcloud volume detach <volume-id>

# Optional: delete volume permanently (data is gone)
hcloud volume delete <volume-id>
```

---

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Disk shows `SCHEDULABLE: False` in Longhorn | Longhorn reserved space exceeds free space | Reduce `storageReserved` for the disk in Longhorn UI |
| Volume stays degraded after adding disk | Longhorn waiting for rebuild scheduling | Wait 5–10 min; check Longhorn UI for rebuild progress |
| `resize2fs` fails with "device busy" | Filesystem is mounted | `resize2fs` works on mounted ext4 — retry; if failing, check for I/O errors first |
| `/etc/fstab` entry causes boot failure | Wrong device path | Use `nofail` in fstab options (already specified above); boot will succeed even if volume missing |
| Hetzner volume not visible on node | Volume attached to wrong server, or multipathd needed | Verify `hcloud volume list` shows correct server; run `sudo udevadm trigger` on node |

---

## Adding a Cross-Hoster Node

The platform is explicitly designed for cross-hoster worker nodes (ADR-014). Because ingress uses DNS round-robin across worker public IPs — not Floating IPs or MetalLB — a worker on OVH, Strato, Netcup, or any other provider is functionally identical to one on Hetzner. It just needs a public IP and UDP 51820 open.

**What makes this work:**
- **NetBird WireGuard mesh** is the private network between nodes. There is no requirement for L2 adjacency, VPC peering, or hoster-specific private networking.
- **Flannel VXLAN** overlay traffic (pod-to-pod across nodes) travels inside the WireGuard tunnel — not over the public internet directly.
- **k3s join** uses the CP's NetBird mesh IP, not its public IP, so the join works from any network that can reach the mesh.
- **DNS Ingress Controller** automatically adds the new worker's public IP to `ingress.platform.com` — customer traffic starts flowing to it immediately.

---

### Port Requirements

#### On the new node — public firewall

| Port | Protocol | Direction | Required | Purpose |
|------|----------|-----------|----------|---------|
| `51820` | UDP | Inbound + Outbound | **Yes — mandatory** | NetBird WireGuard mesh transport. Without this the node cannot join the mesh and cannot reach the CP. |
| `80` | TCP | Inbound | Yes (worker nodes) | HTTP — customer traffic via NGINX Ingress DaemonSet |
| `443` | TCP | Inbound | Yes (worker nodes) | HTTPS — customer traffic via NGINX Ingress DaemonSet |
| `25` | TCP | Inbound | If mail runs on this node | SMTP |
| `587` | TCP | Inbound | If mail runs on this node | SMTP submission |
| `993` | TCP | Inbound | If mail runs on this node | IMAPS |
| `2222` | TCP | Inbound | If SFTP runs on this node | SFTP gateway |

#### On the new node — explicitly closed on public firewall

| Port | Protocol | Notes |
|------|----------|-------|
| `22` | TCP | SSH — closed on public; reachable only via WireGuard (`wt0`) |
| `6443` | TCP | Kubernetes API — workers don't serve this, and it must not be publicly exposed |
| `10250` | TCP | kubelet — reachable only via WireGuard; never public |

#### Between nodes — via WireGuard tunnel (`wt0`), not public interface

All of the following flow inside the encrypted WireGuard tunnel. They do not need separate firewall rules on the public interface because WireGuard encapsulates them. They do need to be allowed on the `wt0` interface (which is typically `ACCEPT` by default for the loopback-like mesh interface).

| Port | Protocol | Purpose |
|------|----------|---------|
| `8472` | UDP | Flannel VXLAN — pod-to-pod overlay networking across nodes |
| `10250` | TCP | kubelet API — used by CP for `kubectl exec`, `kubectl logs`, metrics |
| `6443` | TCP | Kubernetes API server — worker → CP direction for node registration |

> **Why VXLAN travels inside WireGuard:** Flannel encapsulates pod traffic in UDP/VXLAN packets. These are then further encapsulated inside the WireGuard tunnel when traversing between nodes on different networks. Nodes on different hosters do not share an L2 network, so VXLAN cannot rely on multicast discovery — k3s configures Flannel in unicast mode, which works correctly over the WireGuard routed network.

#### On the existing nodes — no changes needed

The existing nodes already have UDP 51820 open. NetBird's TURN/relay servers (running on ns1/ns2) handle NAT traversal between nodes on different providers automatically. No additional firewall rules are needed on existing nodes to accept a new cross-hoster peer.

---

### Pre-flight Checklist (Cross-Hoster)

```
[ ] VPS provisioned at target provider with a public IPv4 address
[ ] Debian 13 installed, SSH keys configured, fail2ban running
[ ] Firewall configured: 51820/UDP open; 80/443 open; 22/6443/10250 closed on public
[ ] NetBird agent installed (see Step 1 below)
[ ] Node joined NetBird mesh and can ping CP node via mesh IP
[ ] Node can reach CP port 6443 via mesh: curl -k https://<cp-mesh-ip>:6443 (should return 401, not timeout)
[ ] etcd snapshot taken on CP (standard precaution before any cluster change)
```

---

### Procedure

**Step 1: Install and join NetBird on the new node (5 min)**

```bash
ssh admin@<new-node-public-ip>

# Install NetBird
curl -fsSL https://pkgs.netbird.io/install.sh | sh

# Join the mesh using a setup key generated from the NetBird dashboard
# Setup keys are pre-authenticated — they bypass OIDC and are stored offline
netbird up --setup-key <SETUP_KEY> --management-url https://netbird.platform.com

# Verify: node appears in mesh and can reach CP
netbird status
# Expected: Peers: [node1 Connected, node2 Connected, ...]

# Test connectivity to CP via mesh
ping <cp-node-netbird-ip>

# Test K8s API reachability via mesh
curl -k https://<cp-node-netbird-ip>:6443
# Expected: HTTP 401 (Unauthorized) — means the API server is reachable
```

**Step 2: Configure firewall on the new node (3 min)**

```bash
# Allow customer-facing ports and WireGuard publicly
sudo iptables -A INPUT -p udp --dport 51820 -j ACCEPT   # WireGuard — MUST be first
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT       # HTTP
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT      # HTTPS
sudo iptables -A INPUT -p tcp --dport 2222 -j ACCEPT     # SFTP (if applicable)
sudo iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
sudo iptables -A INPUT -i lo -j ACCEPT

# Allow management ports via WireGuard interface only
sudo iptables -A INPUT -i wt0 -p tcp --dport 22 -j ACCEPT    # SSH via mesh
sudo iptables -A INPUT -i wt0 -p tcp --dport 10250 -j ACCEPT # kubelet via mesh

# Drop SSH and K8s API from public internet
sudo iptables -A INPUT -p tcp --dport 22 -j DROP
sudo iptables -A INPUT -p tcp --dport 6443 -j DROP
sudo iptables -A INPUT -p tcp --dport 10250 -j DROP

# Default drop
sudo iptables -P INPUT DROP

# Persist
sudo apt-get install -y iptables-persistent
sudo iptables-save > /etc/iptables/rules.v4
```

> **Note:** You do not need explicit rules for `UDP 8472` (Flannel VXLAN) or `TCP 6443` (k3s join direction from this node outward) on the public interface. VXLAN travels inside WireGuard, and outbound connections are allowed by the `ESTABLISHED,RELATED` rule.

**Step 3: Join the k3s cluster (3 min)**

```bash
# Get the node join token from CP (if you don't have it stored)
ssh admin@<cp-node-netbird-ip>
sudo cat /var/lib/rancher/k3s/server/node-token

# On the new node — use the CP's NetBird mesh IP as K3S_URL, not its public IP
ssh admin@<new-node-public-ip>

curl -sfL https://get.k3s.io | \
  K3S_URL=https://<cp-node-netbird-ip>:6443 \
  K3S_TOKEN=<node-token> \
  INSTALL_K3S_EXEC="agent" sh -

# Verify the node joined
kubectl get nodes
# NAME          STATUS   ROLES                  AGE   VERSION
# node1         Ready    control-plane,master   30d   v1.29.x+k3s1
# node2         Ready    worker                 10d   v1.29.x+k3s1
# new-node      Ready    <none>                 30s   v1.29.x+k3s1  ← new
```

**Step 4: Label the new node (1 min)**

```bash
kubectl label node <new-node-name> node-role.kubernetes.io/worker=worker
kubectl label node <new-node-name> kubernetes.io/role=worker

# Optional: label with provider for affinity/anti-affinity rules
kubectl label node <new-node-name> topology.platform.io/provider=ovh
kubectl label node <new-node-name> topology.platform.io/region=strasbourg
```

**Step 5: Verify NGINX Ingress DaemonSet scheduled on new node (2 min)**

```bash
# The DaemonSet automatically schedules a pod on the new worker
kubectl -n ingress-nginx get pods -o wide
# ingress-nginx-controller-xxx   Running   node2
# ingress-nginx-controller-yyy   Running   new-node   ← new pod

# Verify the DNS Ingress Controller picked up the new node's public IP
dig ingress.platform.com +short
# Should now include <new-node-public-ip>

# Test that the new node can serve customer traffic directly
curl -I --resolve panel.platform.com:443:<new-node-public-ip> https://panel.platform.com
# Expected: HTTP/2 200
```

**Step 6: Verify pod-to-pod networking (Flannel overlay) (2 min)**

```bash
# Schedule a test pod on the new node and verify it can reach a pod on an existing node
kubectl run nettest --image=busybox --overrides='{"spec":{"nodeName":"<new-node-name>"}}' \
  --restart=Never -- sleep 300

# Get IP of a pod running on an existing node (e.g., management-api)
kubectl -n platform get pods -o wide | grep management-api
# management-api-xxx   10.42.1.15   node2

# From the test pod, ping across nodes
kubectl exec nettest -- ping -c 3 10.42.1.15
# Expected: 3 packets transmitted, 3 received

# Clean up
kubectl delete pod nettest
```

---

### Provider-Specific Notes

#### OVH / Strato / Netcup

No special configuration beyond the standard checklist. These providers use standard public IPv4 and do not impose restrictions on UDP 51820.

Netcup in particular applies strict default firewall rules via their customer control panel (ECP) — ensure UDP 51820 is explicitly allowed in the ECP firewall **before** installing NetBird, or the mesh join will time out silently.

#### Hetzner (adding a second Hetzner node from a different location)

If both nodes are on Hetzner, you can optionally use Hetzner's private network feature for inter-node traffic instead of WireGuard. However, private networks are location-specific (Falkenstein private network ≠ Helsinki private network). **Do not use Hetzner private networks for cross-location cluster networking** — use the NetBird mesh for all cases. This keeps the setup consistent and avoids a mixed routing model.

#### Providers with IPv6-only public IPs

If the provider only gives a public IPv6 address (no IPv4), the NGINX Ingress DaemonSet can still serve customer traffic over IPv6 — but all existing customer DNS records must also have AAAA records. The DNS Ingress Controller must be extended to handle IPv6 A record sets. This is a documented gap — see `IPV4_IPV6_REQUIREMENTS.md` if available, otherwise raise as a task before adding an IPv6-only node.

---

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `netbird up` hangs / no peers connect | UDP 51820 blocked on public firewall | Verify firewall at provider control panel level (not just iptables) — some providers have a separate cloud firewall |
| `curl https://<cp-mesh-ip>:6443` times out | NetBird not connected yet, or TURN relay needed | Run `netbird status` — if peer shows `Disconnected`, wait for TURN relay negotiation (can take 30–60s on first connect) |
| k3s agent install fails with `connection refused` | Using public IP instead of mesh IP in K3S_URL | Ensure `K3S_URL` uses the CP's NetBird mesh IP (`100.x.x.x`), not its public IP |
| Node joins but shows `NotReady` | Flannel VXLAN can't route between nodes | Check that `wt0` interface allows all traffic: `iptables -I INPUT -i wt0 -j ACCEPT` |
| Pods on new node can't reach pods on other nodes | Flannel not routing cross-node | Run `kubectl exec nettest -- ping <pod-on-other-node-ip>`; if failing, check `ip route` on new node — the `10.42.0.0/16` pod CIDR route should be via `wt0` |
| NGINX Ingress pod on new node returns 502 | Backend pod not reachable cross-node | Same Flannel issue — fix pod overlay routing first |
| DNS Ingress Controller doesn't add new node IP | Node missing `node-role.kubernetes.io/worker` label | Add the label: `kubectl label node <name> node-role.kubernetes.io/worker=worker` |
| Netcup node can't join mesh | ECP firewall blocking UDP 51820 | Log into Netcup ECP → Firewall → allow UDP 51820 inbound |

---

## Post-HA: Ongoing Operations

### etcd Backup Schedule

With HA control plane, etcd backups become more important (3 members to coordinate):

```bash
# Daily etcd snapshot (runs on each CP node via CronJob or systemd timer)
# k3s automatically snapshots etcd — configure retention:
# /etc/rancher/k3s/config.yaml
etcd-snapshot-schedule-cron: "0 2 * * *"  # Daily at 2 AM
etcd-snapshot-retention: 14               # Keep 14 snapshots
etcd-snapshot-dir: /var/lib/rancher/k3s/server/db/snapshots
```

### Node Maintenance (Rolling)

With HA, you can maintain any node without downtime:

```bash
# Maintain CP node (1 of 3):
kubectl drain <cp-node> --ignore-daemonsets
# Perform maintenance (OS upgrade, kernel patch, etc.)
kubectl uncordon <cp-node>

# Maintain Worker node (1 of 2):
kubectl drain <worker-node> --ignore-daemonsets --delete-emptydir-data
# Pods reschedule to other worker
# Perform maintenance
kubectl uncordon <worker-node>
```

### Capacity Monitoring

Watch these metrics to know when to add more workers:

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Worker CPU avg | >60% sustained | >80% sustained | Add worker (Runbook 4) |
| Worker memory avg | >70% sustained | >85% sustained | Add worker |
| Longhorn storage used | >70% | >85% | Attach Hetzner volume to existing node (see Storage Expansion section) or add worker node |
| Pod count per worker | >80 | >110 (k8s default max) | Add worker |
| etcd DB size | >4GB | >8GB | Defragment or evaluate cluster split |

---

## Related Documents

- **INFRASTRUCTURE_PLAN.md** — HA Upgrade Path table (Section 5.1)
- **INFRASTRUCTURE_SIZING.md** — Node sizing and cost optimization
- **CLUSTER_MAINTENANCE_AND_UPGRADES.md** — Rolling upgrades and patching
- **CLUSTER_MAINTENANCE_AND_UPGRADES.md Runbook 4** — Adding a new worker node
- **BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md** — Backup strategy per stage
- **DEPENDENCIES_AND_RISKS.md** — Risk assessment per stage
- **MONITORING_OBSERVABILITY.md** — Capacity monitoring and alerts
- **ARCHITECTURE_DECISION_RECORDS.md** — ADR-013 (NetBird mesh for admin access), ADR-014 (DNS-based ingress routing, cross-hoster design)
- **MULTI_CLOUD_STRATEGY.md** — Multi-provider and geographic distribution options
- **SECURITY_ARCHITECTURE.md** — Full firewall rule reference per node role
