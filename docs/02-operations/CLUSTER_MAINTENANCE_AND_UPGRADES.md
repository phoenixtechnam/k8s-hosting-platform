# Cluster Maintenance & Upgrades Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** DevOps engineers, platform operators, system administrators

---

## Overview

This specification defines procedures for maintaining and upgrading the Kubernetes (k3s) cluster, including:
- **k3s version upgrades** (e.g., 1.28 → 1.29)
- **Control plane node OS upgrades** (e.g., Debian 13 → Debian 14)
- **Worker node upgrades** (rolling updates with zero downtime)
- **Security patching** (kernel, packages)
- **Planned maintenance** (graceful procedures with customer notification)
- **Backup & restore** (cluster state protection)
- **High availability considerations** (single-node vs. HA clusters)

> **Note:** All `ssh admin@<node>` commands in this document are executed via the **NetBird WireGuard mesh** (ADR-013). SSH port 22 is not exposed on the public internet. Ensure your NetBird agent is connected before performing maintenance. See `SECURITY_ARCHITECTURE.md` for mesh architecture details.

> **Scaling the cluster:** For step-by-step procedures to add nodes and transition from single-node to full HA (Stages 0→1→2→3→4), see `HA_MIGRATION_RUNBOOK.md` in this directory.

### Key Principles

1. **Customer impact first** — Minimize downtime and disruption
2. **Backup everything** — Always snapshot before major changes
3. **Test in staging** — Never test in production
4. **Rollback capability** — Always have a way back
5. **Transparency** — Communicate with customers before/after
6. **Documentation** — Document all changes for future reference

### Downtime Targets

| Scenario | Single-Node CP | HA Control Plane |
|----------|---|---|
| k3s patch upgrade (1.28.1 → 1.28.2) | 5-10 min | <1 min (rolling) |
| k3s minor upgrade (1.28 → 1.29) | 10-20 min | <5 min (rolling) |
| Control plane OS upgrade | 30-60 min | 30-60 min per node (rolling) |
| Worker node OS upgrade | Variable | <5 min per node (rolling) |
| Security patch | 10-30 min | <10 min per node |
| Emergency downtime | N/A | < 5 min automatic failover |

---

## Architecture Context

### Initial Deployment (MVP)

```
┌─────────────────────────────────────────────┐
│ CONTROL PLANE NODE                          │
│  Hostname: k3s-cp-001                       │
│  OS: Debian 13                              │
│  Kubernetes: k3s v1.28.x                    │
│  Resources: 2vCPU / 4Gi RAM                 │
│  Persistent: /var/lib/rancher/k3s/ (etcd)  │
│  Public IP: 1.2.3.4 (Ingress/DNS)          │
├─────────────────────────────────────────────┤
│ k3s components:                             │
│  - API Server                               │
│  - Scheduler                                │
│  - Controller Manager                       │
│  - kubelet                                  │
│  - kube-proxy                               │
│  - containerd (runtime)                     │
│  - etcd (data store) ← CRITICAL            │
│  - Flannel (CNI)                            │
│  - Traefik (k3s default, DISABLED — replaced by NGINX Ingress Controller) │
└─────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────┐
│ WORKER NODE(S)                              │
│  Hostname: k3s-worker-001, k3s-worker-002  │
│  OS: Debian 13                              │
│  Kubernetes: k3s v1.28.x (auto-updated)    │
│  Resources: 4vCPU / 8Gi RAM (each)         │
│  Persistent: /var/lib/rancher/k3s/         │
├─────────────────────────────────────────────┤
│ k3s components:                             │
│  - kubelet                                  │
│  - kube-proxy                               │
│  - containerd (runtime)                     │
│  - Flannel (CNI)                            │
└─────────────────────────────────────────────┘
```

### High Availability Deployment (Phase 2+)

```
┌──────────────────────────────────────┐
│ CONTROL PLANE NODE 1 (Leader)        │
│ k3s-cp-001 | Debian 13               │
├──────────────────────────────────────┤
│ etcd: leader                         │
│ API Server: Primary                  │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ CONTROL PLANE NODE 2                 │
│ k3s-cp-002 | Debian 13               │
├──────────────────────────────────────┤
│ etcd: member (synced)                │
│ API Server: Secondary (warm backup)  │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ CONTROL PLANE NODE 3                 │
│ k3s-cp-003 | Debian 13               │
├──────────────────────────────────────┤
│ etcd: member (synced)                │
│ API Server: Secondary (warm backup)  │
└──────────────────────────────────────┘

        ↓ (Load Balancer)

┌──────────────────────────────────────┐
│ WORKER NODES (N+1 or more)           │
└──────────────────────────────────────┘
```

---

## Pre-Upgrade Checklist

Before ANY upgrade, verify:

```
☐ All pods are running (kubectl get pods -A)
☐ All nodes are Ready (kubectl get nodes)
☐ Ingress controller healthy (kubectl get ing -A)
☐ All PVCs mounted (kubectl get pvc -A)
☐ DNS resolving (nslookup example.com)
☐ Database connectivity working
☐ Backup current state (see Backup Procedures below)
☐ Customer traffic baseline captured (for post-upgrade verification)
☐ Staging cluster available for testing (if major version)
☐ Rollback plan documented
☐ Communication sent to customers (if downtime expected)
☐ On-call team notified
☐ Maintenance window scheduled (low-traffic time)
```

---

## Part 1: k3s Cluster Version Upgrades

### Overview

k3s releases new versions regularly:
- **Patch releases** (1.28.0 → 1.28.1) — Bug fixes, security patches, 1-2 weeks
- **Minor releases** (1.28 → 1.29) — New features, breaking changes, 3-4 months
- **Major releases** (1.x → 2.x) — Large changes, rare, years apart

**Upgrade path:** Always upgrade sequentially (1.28 → 1.28.1 → 1.29, not 1.28 → 1.29 directly).

### Upgrade Decision Matrix

| Release Type | Urgency | Downtime | Testing | Rollback Risk |
|---|---|---|---|---|
| **Patch** (1.28.0 → 1.28.1) | Medium (if security fix) | Low (5-10 min) | Staging + 1h smoke | Low |
| **Minor** (1.28 → 1.29) | Low (can defer 1-2 months) | Medium (10-30 min) | Staging + full test | Medium |
| **Major** (1.x → 2.x) | Very low (plan well ahead) | High (plan for >1h) | Extensive staging | High |

### Single-Node Control Plane Upgrade (MVP)

**Downtime:** 10-30 minutes (unavoidable)

**Process:**

```bash
# Step 1: Backup etcd before upgrade (CRITICAL)
sudo k3s etcd-snapshot save --name pre-upgrade-$(date +%Y%m%d-%H%M%S)
# Expected output: 
# + mkdir -p /var/lib/rancher/k3s/server/db/snapshots
# + /opt/k3s/bin/etcd-snapshot save --name pre-upgrade-20250301-140000
# Verify: ls -la /var/lib/rancher/k3s/server/db/snapshots/

# Step 2: Copy backup to external storage (disaster recovery)
sudo scp /var/lib/rancher/k3s/server/db/snapshots/pre-upgrade-*.tar.gz \
  backup-admin@backup.external.com:/backups/k3s/

# Step 3: Stop all client workloads (graceful shutdown)
# Option A: Via kubectl (preferred, allows graceful shutdown)
kubectl scale deploy -n hosting shared-web-pool --replicas=0
kubectl scale deploy -n hosting shared-db --replicas=0
kubectl scale deploy -n hosting shared-redis --replicas=0
# Allow 1-2 minutes for pods to terminate gracefully
sleep 120

# Option B: If needed, force-delete pods (only if graceful fails)
kubectl delete pods --all-namespaces --grace-period=0 --force

# Step 4: Upgrade k3s
# k3s uses systemd, upgrade via package manager or installer script
sudo curl -sfL https://get.k3s.io | sh -
# This auto-detects installed version and upgrades

# Verify upgrade completed
sudo systemctl status k3s
sudo k3s -v
# Expected: k3s version v1.29.x

# Step 5: Wait for API server to become healthy
# The control plane node will restart k3s automatically
# Wait for API server to be ready
kubectl wait --for=condition=Ready pod \
  -l component=kube-apiserver \
  -n kube-system \
  --timeout=300s

# Step 6: Verify cluster health
kubectl get nodes
# Expected: STATUS = Ready, ROLES = control-plane

kubectl get pods -A
# Expected: All pods Running or Completed

# Step 7: Bring workloads back online
kubectl scale deploy -n hosting shared-web-pool --replicas=3
kubectl scale deploy -n hosting shared-db --replicas=1
kubectl scale deploy -n hosting shared-redis --replicas=1

# Step 8: Verify workloads running
kubectl get pods -n hosting
# Expected: All pods Running

# Step 9: Run smoke tests
curl http://localhost/healthz
# Expected: 200 OK

# Step 10: Communicate to customers
# "Cluster maintenance completed. All services restored."
```

**Rollback if Upgrade Fails:**

```bash
# If API server doesn't come up after 5 minutes:

# Step 1: Restore from snapshot
sudo k3s server --cluster-reset-restore-path=/var/lib/rancher/k3s/server/db/snapshots/pre-upgrade-TIMESTAMP.tar.gz

# Step 2: Restart k3s
sudo systemctl restart k3s

# Step 3: Verify old version restored
sudo k3s -v
# Expected: k3s version v1.28.x

# Step 4: Check cluster health
kubectl get nodes
kubectl get pods -A

# Step 5: Notify team and investigate failure
# Document what went wrong for future upgrades
```

### High Availability Control Plane Upgrade

**Downtime:** <1 minute (rolling upgrade, automatic failover)

**Process:**

```bash
# Upgrade HA control plane by rolling through each node

# Step 1: Backup all etcd members (on one node)
k3s etcd-snapshot save --name pre-ha-upgrade-$(date +%Y%m%d-%H%M%S)
# Verify on other nodes they have same snapshot (synced)

# Step 2: Cordon and drain Node 2 (non-leader)
kubectl cordon k3s-cp-002
kubectl drain k3s-cp-002 --ignore-daemonsets --delete-emptydir-data

# Step 3: Upgrade Node 2
ssh admin@k3s-cp-002
sudo curl -sfL https://get.k3s.io | sh -
# API remains available (Node 1 and 3 still serving)

# Step 4: Uncordon Node 2
kubectl uncordon k3s-cp-002

# Step 5: Verify Node 2 is Ready and synced
kubectl get nodes k3s-cp-002
# Expected: STATUS = Ready

# Step 6: Wait for etcd quorum to stabilize (30-60 seconds)
sleep 60

# Step 7: Repeat for Node 3
kubectl cordon k3s-cp-003
kubectl drain k3s-cp-003 --ignore-daemonsets --delete-emptydir-data
ssh admin@k3s-cp-003 && sudo curl -sfL https://get.k3s.io | sh -
kubectl uncordon k3s-cp-003
sleep 60

# Step 8: Finally, upgrade leader (Node 1)
# This is last because failover already happened
kubectl cordon k3s-cp-001
kubectl drain k3s-cp-001 --ignore-daemonsets --delete-emptydir-data
ssh admin@k3s-cp-001 && sudo curl -sfL https://get.k3s.io | sh -
kubectl uncordon k3s-cp-001
sleep 60

# Step 9: Verify all nodes Ready and etcd healthy
kubectl get nodes
etcdctl member list  # or: k3s etcd-snapshot save (tests etcd health)

# Step 10: Verify cluster fully operational
kubectl get pods -A
# Expected: All pods Running or Completed
```

---

## Part 2: Control Plane Node OS Upgrade

### When to Upgrade

| Trigger | Urgency | Downtime | Example |
|---|---|---|---|
| **Security patch** (kernel, OpenSSL, etc.) | HIGH | Plan ASAP | CVE-2024-XXXXX in glibc |
| **EOL approaching** (6 months to EOL) | MEDIUM | Plan in next release | Debian 13 (Trixie) EOL: ~2028 |
| **EOL reached** (support ends) | CRITICAL | Plan immediately | Debian 12 (Bookworm) EOL: June 2026 |
| **New stable release** | LOW | Can defer 6+ months | Debian 14 expected ~2027 |

### Debian Version Lifecycle

```
Debian 12 (Bookworm):
  Released: June 2023
  LTS EOL: June 2026
  Status: Previous stable — do not use for new nodes

Debian 13 (Trixie):
  Released: 2025
  LTS EOL: ~2028 (estimated)
  Status: CURRENT STABLE — use for all new nodes

Debian 14:
  Released: projected ~2027
  
Maintenance window: Upgrade during 6-month window before EOL
```

### Option A: In-Place OS Upgrade (High Risk, Some Downtime)

**Downtime:** 30-60 minutes

**Risk:** Medium — kernel/container runtime changes can break k3s

**Process:**

```bash
# Step 1: Backup cluster state (CRITICAL)
sudo k3s etcd-snapshot save --name pre-os-upgrade-$(date +%Y%m%d-%H%M%S)
sudo scp /var/lib/rancher/k3s/server/db/snapshots/pre-os-upgrade-*.tar.gz \
  backup-admin@backup.external.com:/backups/k3s/

# Step 2: Drain workloads from all other nodes
# (ensure nothing running on CP node that can't restart)
for worker in k3s-worker-001 k3s-worker-002; do
  kubectl cordon $worker
  kubectl drain $worker --ignore-daemonsets --delete-emptydir-data
done

# Step 3: Update system packages
ssh admin@k3s-cp-001
sudo apt update
sudo apt full-upgrade -y
# This may include kernel updates, systemd, containerd, etc.

# Step 4: Reboot
sudo reboot

# Step 5: Wait for node to come back online
# (wait 2-3 minutes for boot)
sleep 180

# Step 6: Verify k3s still running
sudo systemctl status k3s
sudo k3s -v

# Step 7: Verify cluster health
kubectl get nodes
# Expected: k3s-cp-001 = Ready

kubectl get pods -A
# Expected: All pods Running

# Step 8: Uncordon worker nodes
for worker in k3s-worker-001 k3s-worker-002; do
  kubectl uncordon $worker
done

# Step 9: Reschedule workloads back to workers
# Pods will auto-reschedule as node capacity available
```

**If Upgrade Fails:**

```bash
# If k3s doesn't start after reboot:

# Option 1: SSH to node and check logs
ssh admin@k3s-cp-001
sudo journalctl -u k3s -n 100
# Common issues: kernel incompatibility, containerd version mismatch

# Option 2: Rollback via etcd restore (requires HA)
# On healthy node:
kubectl exec -it -n kube-system etcd-k3s-cp-002 -- sh
etcdctl snapshot restore /var/lib/rancher/k3s/server/db/snapshots/pre-os-upgrade-TIMESTAMP.tar.gz
# This is complex, requires multi-node HA to work

# Option 3: Rebuild node from scratch (single-node CP only)
# Use infrastructure code (Terraform) to rebuild VM
# Restore cluster from etcd snapshot to new node
```

### Option B: Node Replacement (Lower Risk, More Effort)

**Downtime:** 0-30 minutes (depends on setup)

**Risk:** Low — old node completely replaced, no OS upgrade issues

**Process:**

```bash
# For SINGLE-NODE control plane:
# This requires downtime, but is safer

# Step 1: Backup everything
sudo k3s etcd-snapshot save --name pre-node-replacement-$(date +%Y%m%d-%H%M%S)
sudo scp /var/lib/rancher/k3s/server/db/snapshots/pre-node-replacement-*.tar.gz \
  backup-admin@backup.external.com:/backups/k3s/

# Step 2: Copy all k3s data directories
sudo tar -czf /tmp/k3s-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  /var/lib/rancher/k3s/server/
# Store backup externally

# Step 3: Create new node with fresh Debian 14
# Using Terraform/IaC or manual VPS creation
# New node: k3s-cp-001-new
# IP: 1.2.3.5 (temporary, will switch later)

# Step 4: Install k3s on new node with restore
ssh admin@k3s-cp-001-new
sudo mkdir -p /var/lib/rancher/k3s/server/db/snapshots/
# Copy snapshot to new node
sudo scp backup-admin@backup.external.com:/backups/k3s/pre-node-replacement-TIMESTAMP.tar.gz \
  /var/lib/rancher/k3s/server/db/snapshots/

# Install k3s with etcd restore flag
sudo curl -sfL https://get.k3s.io | \
  INSTALL_K3S_SKIP_START=true sh -
# Copy old token for join (if HA setup)
sudo cp /var/lib/rancher/k3s/server/node-token \
  /var/lib/rancher/k3s/server/node-token.backup

# Restore from snapshot
sudo k3s server --cluster-reset-restore-path=/var/lib/rancher/k3s/server/db/snapshots/pre-node-replacement-TIMESTAMP.tar.gz

# Step 5: Start k3s
sudo systemctl start k3s
sudo systemctl status k3s

# Step 6: Verify cluster restored
sudo k3s -v
sudo kubectl get nodes
sudo kubectl get pods -A

# Step 7: Update DNS/Ingress IP
# The DNS Ingress Controller auto-updates ingress.platform.com A record set.
# If DNS Ingress Controller is not yet deployed, manually update PowerDNS:
# Update ingress.platform.com A record to new worker IP (1.2.3.5)

# Option: Keep old IP by:
# - Assigning new IP 1.2.3.5 to new node
# - Assigning old IP 1.2.3.4 to new node (if VPS provider allows)
# - Or: Update DNS to new IP

# Step 8: Verify connectivity
curl http://1.2.3.5/healthz
# Expected: 200 OK

# Step 9: Shutdown old node
ssh admin@k3s-cp-001
sudo shutdown -h now

# Step 10: Rename new node to old name
# On new node:
sudo hostnamectl set-hostname k3s-cp-001
# Update /etc/hosts and DNS if needed

# Step 11: Verify final state
kubectl get nodes
# Expected: k3s-cp-001 = Ready (on new IP)
```

### For HA Control Plane (3 nodes)

Same as k3s version upgrade — use rolling upgrade approach:

```bash
# Upgrade each control plane node one at a time
# While others remain healthy and serving traffic

for node in k3s-cp-002 k3s-cp-003 k3s-cp-001; do
  kubectl cordon $node
  kubectl drain $node --ignore-daemonsets --delete-emptydir-data
  
  # Upgrade OS on this node
  ssh admin@$node
  sudo apt update && sudo apt full-upgrade -y
  sudo reboot
  
  # Wait for node to come back
  sleep 180
  
  kubectl uncordon $node
  kubectl wait --for=condition=Ready node/$node --timeout=300s
  
  # Small delay before next node
  sleep 60
done
```

---

## Part 3: Worker Node Upgrades

### Single Worker Node Upgrade

**Downtime:** <5 minutes per node (pods reschedule)

**Process:**

```bash
# Step 1: Cordon node (prevent new pods from scheduling)
kubectl cordon k3s-worker-001

# Step 2: Drain node (evict running pods to other nodes)
kubectl drain k3s-worker-001 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=120

# Expected: 
#   - node/k3s-worker-001 cordoned
#   - All pods moved to k3s-worker-002, k3s-worker-003
#   - DaemonSets (monitoring, logging) remain on node

# Step 3: SSH to node and upgrade
ssh admin@k3s-worker-001
sudo apt update
sudo apt full-upgrade -y
# May include kernel, containerd, etc.

# Step 4: Reboot
sudo reboot

# Step 5: Wait for node to rejoin cluster
# (2-3 minutes)
sleep 180

# Step 6: Verify node is Ready
kubectl get nodes k3s-worker-001
# Expected: STATUS = Ready

# Step 7: Uncordon node
kubectl uncordon k3s-worker-001

# Step 8: Monitor pod rescheduling
# Pods will reschedule to this node if it has capacity
kubectl get pods -A --field-selector spec.nodeName=k3s-worker-001
```

### Rolling Worker Node Upgrade (N+1 Strategy)

**Downtime:** 0 (automatic rescheduling)

**Requirement:** N+1 or more nodes (if N=2 nodes, need 3 total)

**Process:**

```bash
# Step 1: Verify capacity (all pods can fit on N-1 nodes)
kubectl top nodes
# Calculate: Sum of all pod requests should fit on (N-1) nodes

# Step 2: Upgrade nodes one at a time
for worker in k3s-worker-001 k3s-worker-002; do
  echo "Upgrading $worker..."
  
  kubectl cordon $worker
  kubectl drain $worker \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=120
  
  # Wait for pods to move
  sleep 30
  
  ssh admin@$worker
  sudo apt update
  sudo apt full-upgrade -y
  sudo reboot
  
  sleep 180
  
  kubectl uncordon $worker
  kubectl wait --for=condition=Ready node/$worker --timeout=300s
  
  # Verify all pods running
  kubectl get pods -A | grep -c Running
  
  # Small delay before next node
  sleep 60
done

# Step 3: Verify all nodes upgraded and healthy
kubectl get nodes
# Expected: All = Ready
```

---

## Part 4: Security Patching Strategy

### Critical vs. Non-Critical Patches

| Type | Example | Urgency | Timeline |
|---|---|---|---|
| **Critical** | Linux kernel CVE, OpenSSL RCE | IMMEDIATE | Within 24 hours |
| **High** | Container runtime vulnerability | ASAP | Within 7 days |
| **Medium** | Application package update | Plan | Within 30 days |
| **Low** | Minor library update | Batch with others | Within 90 days |

### Weekly Security Patch Cycle

```
Monday 2 AM UTC:
├─ Check security advisories (Debian, Kubernetes, Docker)
├─ Test patches in staging cluster
└─ Schedule production updates

Wednesday 2 AM UTC (Low-traffic window):
├─ Non-critical patches applied (worker nodes rolling)
├─ Monitor for issues
└─ Document in change log

Friday 2 AM UTC (If critical patches exist):
├─ Critical patches applied (control plane + workers)
├─ Customer notification (if downtime expected)
└─ Full cluster health verification
```

### Automated Patch Application (Optional)

For non-critical patches, use unattended-upgrades:

```bash
# On each node:
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# Configure to auto-reboot (optional, risky)
# Edit /etc/apt/apt.conf.d/50unattended-upgrades
# Unattended-Upgrade::Automatic-Reboot "true";
# Unattended-Upgrade::Automatic-Reboot-Time "02:30";

# Schedule for low-traffic time (2:30 AM UTC)
```

---

## Part 5: Backup & Restore Procedures

### Full Cluster Backup

**What gets backed up:**
- etcd state (all Kubernetes objects)
- PersistentVolumes (Longhorn snapshots)
- Secrets (encrypted in Sealed Secrets)
- Application data (via Velero)

**Backup frequency:** Daily at 2 AM UTC

### Backup Script

```bash
#!/bin/bash
# /usr/local/bin/backup-k3s-cluster.sh

BACKUP_DIR="/mnt/backups/k3s"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_NAME="cluster-backup-${TIMESTAMP}"

echo "[$(date)] Starting cluster backup: $SNAPSHOT_NAME"

# 1. Snapshot etcd
echo "[$(date)] Snapshotting etcd..."
sudo k3s etcd-snapshot save --name $SNAPSHOT_NAME
if [ $? -ne 0 ]; then
  echo "ERROR: etcd snapshot failed"
  exit 1
fi

# 2. Verify snapshot created
SNAPSHOT_FILE="/var/lib/rancher/k3s/server/db/snapshots/${SNAPSHOT_NAME}.tar.gz"
if [ ! -f $SNAPSHOT_FILE ]; then
  echo "ERROR: Snapshot file not found: $SNAPSHOT_FILE"
  exit 1
fi

# 3. Copy to backup storage
echo "[$(date)] Copying snapshot to backup storage..."
mkdir -p $BACKUP_DIR
cp $SNAPSHOT_FILE $BACKUP_DIR/
chmod 600 $BACKUP_DIR/${SNAPSHOT_NAME}.tar.gz

# 4. Upload to external backup server (daily)
echo "[$(date)] Uploading to external backup..."
scp $BACKUP_DIR/${SNAPSHOT_NAME}.tar.gz \
  backup-admin@backup.external.com:/backups/k3s/

# 5. Cleanup old snapshots (keep 7 days locally)
echo "[$(date)] Cleaning up old snapshots..."
find /var/lib/rancher/k3s/server/db/snapshots/ -name "*.tar.gz" -mtime +7 -delete
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete

# 6. Verify backup succeeded
echo "[$(date)] Backup completed successfully"
ls -lh $BACKUP_DIR/${SNAPSHOT_NAME}.tar.gz
```

### CronJob for Automated Backup

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cluster-backup
  namespace: kube-system
spec:
  schedule: "0 2 * * *"  # 2 AM UTC daily
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cluster-backup
          containers:
          - name: backup
            image: alpine:latest
            command:
            - sh
            - -c
            - |
              #!/bin/sh
              TIMESTAMP=$(date +%Y%m%d-%H%M%S)
              SNAPSHOT_NAME="cluster-backup-${TIMESTAMP}"
              k3s etcd-snapshot save --name $SNAPSHOT_NAME
              # Upload to external server
              scp /var/lib/rancher/k3s/server/db/snapshots/${SNAPSHOT_NAME}.tar.gz \
                backup@backup.external.com:/backups/k3s/
          restartPolicy: OnFailure
```

### Restore from Backup

**Scenario:** Complete cluster failure, need to restore from backup

```bash
# Step 1: Deploy new cluster with same k3s version
# Option A: New VM with k3s installed
curl -sfL https://get.k3s.io | sh -

# Option B: Already have cluster, just restore state
# On the new/recovered node:

# Step 2: Retrieve backup from external storage
scp backup@backup.external.com:/backups/k3s/cluster-backup-TIMESTAMP.tar.gz \
  /var/lib/rancher/k3s/server/db/snapshots/

# Step 3: Stop k3s (if running)
sudo systemctl stop k3s

# Step 4: Restore from snapshot
sudo k3s server --cluster-reset-restore-path=/var/lib/rancher/k3s/server/db/snapshots/cluster-backup-TIMESTAMP.tar.gz

# Step 5: Start k3s
sudo systemctl start k3s

# Step 6: Verify restoration
sudo k3s -v
sudo kubectl get nodes
sudo kubectl get pods -A
sudo kubectl get pvc -A

# Step 7: Check data integrity (sample check)
sudo kubectl exec -it pod/some-pod -n default -- bash
ls -la /var/www/html
# Verify files are present

# Step 8: Verify DNS/Ingress (if IP changed)
# Update DNS records or ingress config if needed
```

### Restore Specific Namespace/Pod

```bash
# If only one application is broken, restore just that namespace

# Step 1: Use Velero to restore specific namespace
velero restore create --from-backup cluster-backup-20250301-140000 \
  --include-namespaces=client-001

# Step 2: Monitor restoration
velero restore logs --restore-name=client-001-restore

# Step 3: Verify restored resources
kubectl get pods -n client-001
kubectl get pvc -n client-001
```

---

## Part 6: Upgrade Testing Strategy

### Pre-Production Testing (Staging Cluster)

**Setup:** Keep a separate k3s cluster for testing (same size as production, or scaled down)

```bash
# Step 1: Clone production cluster config
rsync -av prod-config/ staging-config/

# Step 2: Deploy staging cluster with current version
./deploy-k3s.sh --environment staging --version 1.28.x

# Step 3: Restore production data to staging
# (From most recent backup)
scp backup@backup.external.com:/backups/k3s/cluster-backup-latest.tar.gz \
  /var/lib/rancher/k3s/server/db/snapshots/
k3s server --cluster-reset-restore-path=/var/lib/rancher/k3s/server/db/snapshots/cluster-backup-latest.tar.gz
kubectl get nodes
kubectl get pods -A

# Step 4: Perform upgrade on staging
# Test the exact upgrade procedure you'll use on production

# Step 5: Run smoke tests
./test-cluster-health.sh
# Verify: DNS works, ingress routing works, apps responding, DB queries work

# Step 6: Load test (optional, for major versions)
ab -n 10000 -c 100 http://staging-ingress.local/
# Compare to production baseline

# Step 7: Document any issues found
# Adjust upgrade procedure if needed

# Step 8: Obtain approval to proceed with production upgrade
```

### Smoke Test Script

```bash
#!/bin/bash
# test-cluster-health.sh

echo "Cluster Health Tests"
echo "===================="

# Test 1: API Server
echo -n "API Server: "
kubectl get nodes > /dev/null && echo "✓ PASS" || echo "✗ FAIL"

# Test 2: DNS
echo -n "DNS: "
nslookup kubernetes.default > /dev/null && echo "✓ PASS" || echo "✗ FAIL"

# Test 3: Ingress
echo -n "Ingress: "
curl -H "Host: example.com" http://localhost/healthz > /dev/null && echo "✓ PASS" || echo "✗ FAIL"

# Test 4: Database
echo -n "Database: "
kubectl exec -it mysql-pod -- mysql -u root -p"$DB_PASS" -e "SELECT 1" > /dev/null && echo "✓ PASS" || echo "✗ FAIL"

# Test 5: All pods running
echo -n "All pods running: "
PENDING=$(kubectl get pods -A --field-selector=status.phase=Pending | wc -l)
FAILED=$(kubectl get pods -A --field-selector=status.phase=Failed | wc -l)
if [ $PENDING -eq 0 ] && [ $FAILED -eq 0 ]; then
  echo "✓ PASS"
else
  echo "✗ FAIL (Pending: $PENDING, Failed: $FAILED)"
fi

# Test 6: Persistent Volumes
echo -n "Persistent Volumes: "
kubectl get pvc -A | grep -c Bound > /dev/null && echo "✓ PASS" || echo "✗ FAIL"

echo "===================="
```

### Post-Upgrade Verification Checklist

After ANY upgrade, verify:

```
☐ All nodes Ready (kubectl get nodes)
☐ All pods Running (kubectl get pods -A)
☐ No pending pods (kubectl get pods -A | grep Pending)
☐ No failed pods (kubectl get pods -A | grep Failed)
☐ All PVCs Bound (kubectl get pvc -A)
☐ Ingress responsive (curl http://ingress/healthz)
☐ DNS resolving (nslookup example.com)
☐ Database healthy (kubectl logs pod/mysql | tail)
☐ Redis responding (kubectl exec pod/redis -- ping)
☐ Email working (test client email send)
☐ Customer sites loading (curl -H "Host: customer.com" http://ingress/)
☐ Monitoring metrics flowing (check Prometheus targets)
☐ Logs being collected (check Loki)
☐ Backups created (verify etcd snapshot)
☐ Performance baseline (compare CPU/memory to pre-upgrade)
```

---

## Part 7: Failure Scenarios & Recovery

### Scenario 1: k3s Fails to Start After Upgrade

**Symptoms:** `sudo systemctl status k3s` shows failed, API unavailable

**Recovery:**

```bash
# Check error logs
sudo journalctl -u k3s -n 50 -e
# Common issues:
#  - Incompatible kernel
#  - Incompatible containerd version
#  - etcd corruption

# Try automatic recovery
sudo systemctl restart k3s
sleep 30
sudo systemctl status k3s

# If still failed, restore from snapshot
sudo k3s server --cluster-reset-restore-path=/var/lib/rancher/k3s/server/db/snapshots/pre-upgrade-TIMESTAMP.tar.gz

# If etcd corrupted (last resort)
sudo rm -rf /var/lib/rancher/k3s/server/db/*
k3s server --cluster-reset-restore-path=/var/lib/rancher/k3s/server/db/snapshots/pre-upgrade-TIMESTAMP.tar.gz
```

### Scenario 2: Pod Rescheduling Hangs After Node Drain

**Symptoms:** Pods stuck in Terminating state >5 minutes, node not draining

**Recovery:**

```bash
# Force pod eviction
kubectl delete pod POD_NAME -n NAMESPACE --grace-period=0 --force

# Skip this pod and continue draining
kubectl drain NODE --ignore-daemonsets --delete-emptydir-data \
  --skip-wait-for-delete-timeout=true

# Or: Uncordon node and investigate
kubectl uncordon NODE
kubectl describe pod POD_NAME -n NAMESPACE
# Check for pod disruption budgets, finalizers, etc.
```

### Scenario 3: etcd Corruption After Upgrade

**Symptoms:** `kubectl get pods` hangs, API slow/unresponsive

**Recovery:**

```bash
# Verify etcd health
sudo k3s etcd-snapshot save --name test-$(date +%s)
# If this hangs or fails, etcd is corrupted

# Stop k3s
sudo systemctl stop k3s

# Backup corrupted etcd
sudo mv /var/lib/rancher/k3s/server/db /var/lib/rancher/k3s/server/db.corrupted

# Restore from known good snapshot
sudo mkdir -p /var/lib/rancher/k3s/server/db
sudo k3s server --cluster-reset-restore-path=/var/lib/rancher/k3s/server/db/snapshots/pre-upgrade-TIMESTAMP.tar.gz

# Start k3s
sudo systemctl start k3s

# Verify health
sleep 30
kubectl get nodes
```

### Scenario 4: API Server OOMKilled During Upgrade

**Symptoms:** API server pod killed, cluster unresponsive

**Recovery (Single-Node):**

```bash
# Wait for kubelet to restart API server
sleep 60
kubectl get pods -n kube-system

# If API server not restarting:
sudo systemctl restart k3s
# k3s will auto-restart API server

# Verify
kubectl get nodes
```

**Recovery (HA Cluster):**

```bash
# API server should failover to other control plane node
# Verify other nodes have API server running
kubectl get pods -n kube-system -o wide | grep apiserver

# If all API servers down, restore from etcd
```

---

## Part 8: Tools & Commands Reference

### Essential Commands

```bash
# k3s version and information
sudo k3s -v
sudo k3s check-config

# Service management
sudo systemctl status k3s
sudo systemctl restart k3s
sudo systemctl enable k3s

# etcd operations
sudo k3s etcd-snapshot save --name backup-name
sudo k3s etcd-snapshot list
sudo k3s etcd-snapshot restore --name snapshot-name
sudo k3s etcd-snapshot delete --name snapshot-name

# Node management
kubectl get nodes
kubectl describe node NODE_NAME
kubectl cordon NODE_NAME
kubectl uncordon NODE_NAME
kubectl drain NODE_NAME --ignore-daemonsets --delete-emptydir-data
kubectl delete node NODE_NAME  # Only after node offline

# Pod management
kubectl get pods -A
kubectl describe pod POD_NAME -n NAMESPACE
kubectl logs pod POD_NAME -n NAMESPACE
kubectl delete pod POD_NAME -n NAMESPACE --grace-period=0 --force

# Cluster health
kubectl get cs  # Component status
kubectl api-resources  # Verify API groups loaded
kubectl version  # Client and server versions

# etcd health (HA only)
kubectl exec -it -n kube-system etcd-POD_NAME -- sh
$ etcdctl member list
$ etcdctl endpoint health
```

### k3s Configuration Files

```
Location: /etc/rancher/k3s/
├── k3s.yaml              (kubeconfig)
├── k3s.env               (environment variables)
└── registries.yaml       (container registry config)

Service file: /etc/systemd/system/k3s.service

Data directory: /var/lib/rancher/k3s/
├── server/               (control plane data)
│   ├── db/               (etcd data)
│   │   └── snapshots/    (etcd backups)
│   ├── manifests/        (static pods)
│   └── node-token        (join token for workers)
├── agent/                (worker data)
│   └── kubelet/          (pod data)
└── logs/                 (k3s logs)
```

---

## Part 9: Operational Runbooks

### Runbook 1: Monthly k3s Patch Update

**Duration:** 1-2 hours

**Downtime:** 10-20 minutes

```
1. [T-1 day] Announce maintenance window to customers
   - Email, dashboard notification
   - Scheduled for Tuesday 2 AM UTC (low traffic)

2. [T-24h] Create backup
   - sudo k3s etcd-snapshot save --name pre-patch-$(date +%Y%m%d)
   - scp to backup server
   - Verify backup integrity

3. [T-1h] Final health check
   - kubectl get nodes (all Ready?)
   - kubectl get pods -A (all Running?)
   - kubectl top nodes (resource usage ok?)

4. [T-0h] Notify on-call team
   - "Maintenance starting now, expect 10-min downtime"

5. [T+0m] Scale down workloads (graceful shutdown)
   - kubectl scale deploy -n hosting --all --replicas=0
   - Wait 60s for graceful termination

6. [T+2m] Upgrade k3s
   - sudo curl -sfL https://get.k3s.io | sh -
   - sudo systemctl restart k3s (if not auto-restarted)

7. [T+5m] Wait for recovery
   - Watch: sudo systemctl status k3s
   - Expected: Active (running)

8. [T+8m] Verify cluster health
   - kubectl get nodes
   - kubectl get pods -n kube-system (all Running?)

9. [T+10m] Scale up workloads
   - kubectl scale deploy -n hosting shared-web-pool --replicas=3
   - kubectl scale deploy -n hosting shared-db --replicas=1
   - kubectl scale deploy -n hosting shared-redis --replicas=1

10. [T+15m] Smoke tests
    - curl http://localhost/healthz (expect 200)
    - kubectl logs pod/mysql (check for errors)
    - kubectl get all -n hosting (all Running?)

11. [T+20m] Communication
    - "Maintenance completed successfully"
    - Post summary to ops channel

12. [T+24h] Post-mortem (if issues)
    - Document what went wrong
    - Adjust procedure if needed
```

### Runbook 2: OS Security Patch (Worker Node)

**Duration:** 30 minutes per node

**Downtime:** <5 minutes per node

```
1. [T-1d] Announce window (if critical CVE)
   - "Security patch required, minimal downtime"

2. [T-24h] Staging test
   - Apply patch to staging node
   - Verify k3s still works

3. [T-1h] Final check
   - kubectl get nodes (all Ready?)
   - kubectl top nodes (utilization ok?)

4. [T-0h] For each worker node:

   a) Cordon
      kubectl cordon k3s-worker-001

   b) Drain
      kubectl drain k3s-worker-001 --ignore-daemonsets --delete-emptydir-data
      (wait 60s for pods to evict)

   c) SSH and upgrade
      ssh admin@k3s-worker-001
      sudo apt update && sudo apt full-upgrade -y

   d) Reboot
      sudo reboot
      (wait 3 minutes for node to boot)

   e) Uncordon
      kubectl uncordon k3s-worker-001

   f) Verify
      kubectl wait --for=condition=Ready node/k3s-worker-001 --timeout=300s
      (wait for pods to reschedule)

   g) Next node (wait 2 minutes before starting next)

5. [T+5m per node] Verify all nodes Ready
   kubectl get nodes
   All = Ready? ✓

6. [T+30m] Post-patch verification
   - curl http://localhost/healthz
   - kubectl get pods -A (all Running?)
   - Check monitoring (CPU/memory baseline ok?)

7. [T+end] Documentation
   - Log patch details
   - Note any issues encountered
```

### Runbook 3: Emergency Cluster Restore

**Duration:** 30 minutes - 2 hours (depends on cluster size)

**Downtime:** Complete until restoration

```
1. [T-0m] Declare incident
   - Notify team: "Cluster failure, initiating restore"
   - All hands on deck

2. [T+1m] Assess situation
   - Is cluster still running? (kubectl get nodes)
   - Can API server respond? (curl -k https://localhost:6443/api/v1/nodes)
   - Is it unrecoverable? (multiple failed nodes, etcd broken)

3. [T+5m] Retrieve backups
   - ssh backup@backup.external.com
   - ls /backups/k3s/
   - Identify most recent backup: cluster-backup-20250301-140000.tar.gz
   - scp to target node

4. [T+10m] Prepare new infrastructure
   - Provision new VMs (or use existing recovered nodes)
   - Install fresh Debian
   - Install k3s (INSTALL_K3S_SKIP_START=true)

5. [T+15m] Restore cluster state
   - scp backup-file to node
   - Stop k3s: sudo systemctl stop k3s
   - Restore: sudo k3s server --cluster-reset-restore-path=/path/to/backup.tar.gz
   - Start k3s: sudo systemctl start k3s

6. [T+20m] Verify restoration
   - kubectl get nodes
   - kubectl get pods -a
   - kubectl get pvc -a
   - Spot-check customer data

7. [T+25m] Update DNS/Ingress IPs (if changed)
   - Update A records for ingress IP
   - Update PowerDNS if IP changed
   - Or: Assign old IP to new node via IaC

8. [T+30m] Final health checks
   - curl http://ingress/healthz
   - Customer site checks
   - Database connectivity
   - Email system

9. [T+45m] Customer communication
   - "Cluster restored, all services online"
   - "Possible data loss up to [backup timestamp]"
   - "Next steps: verify your data"

10. [T+2h] Post-mortem
    - What caused the failure?
    - How to prevent?
    - What could we have done better?
    - Improve runbook
```

---

### Runbook 4: Adding a New Worker Node

**Duration:** 30-45 minutes  
**Downtime:** None (additive operation)

```
1. [T-0] Provision new server
   - Provision VM with same specs as existing workers (e.g., Hetzner CPX31: 4vCPU/8GB)
   - Install Debian 13 (matching existing nodes)
   - Apply base OS hardening (SSH keys, firewall, fail2ban)
   - Ensure node can reach control plane on port 6443

2. [T+5m] Install k3s agent
   - Get join token from control plane:
     sudo cat /var/lib/rancher/k3s/server/node-token
   - Install k3s agent on new node:
     curl -sfL https://get.k3s.io | K3S_URL=https://<control-plane-ip>:6443 \
       K3S_TOKEN=<node-token> \
       INSTALL_K3S_EXEC="agent --disable traefik" sh -
   - Verify node joins: kubectl get nodes

3. [T+10m] Label and taint the node (if needed)
   - kubectl label node <new-node> node-role.kubernetes.io/worker=worker
   - kubectl label node <new-node> workload-type=general  # or 'dedicated' for Business/Premium
   - Optional: kubectl taint node <new-node> dedicated=premium:NoSchedule

4. [T+15m] Verify Longhorn storage
   - kubectl -n longhorn-system get nodes
   - Confirm new node appears and is schedulable for storage
   - If replication factor needs increasing: update Longhorn settings

5. [T+20m] Verify workload scheduling
   - Check that pods can be scheduled to new node:
     kubectl get pods -A -o wide | grep <new-node>
   - Optionally rebalance workloads:
     kubectl rollout restart deployment/<shared-web-pod> -n platform

6. [T+25m] Update monitoring
   - Verify Prometheus discovers new node (node-exporter auto-deploys via DaemonSet)
   - Confirm Grafana dashboards show new node
   - Verify Fluent Bit DaemonSet runs on new node

7. [T+30m] Update documentation
   - Update INFRASTRUCTURE_SIZING.md with new node count
   - Update admin panel node inventory
   - Log in cluster change history

8. [T+35m] Scale workloads as needed
   - Verify NGINX Ingress DaemonSet pod is running on new node:
     kubectl -n ingress-nginx get pods -o wide
   - Verify DNS Ingress Controller added new node IP to ingress.platform.com:
     dig ingress.platform.com +short
   - Verify client pods are scheduling on new node as expected
   - Update Longhorn replication factor if going from 1→2+ nodes
```

**Post-addition checks:**
- `kubectl get nodes` — all nodes Ready
- `kubectl top nodes` — resource usage distributed
- Customer sites load-tested across nodes
- Alertmanager firing rules validated for new node

---

## Part 10: Admin Panel Features

### Features for Cluster Maintenance

**Location:** Admin Panel → Infrastructure → Cluster Management

| Feature | Description |
|---------|-------------|
| **Cluster health dashboard** | k3s version, node status, etcd health, resource usage |
| **Node management** | List nodes, view details (kernel, packages), reboot, drain, cordoned status |
| **k3s version check** | Current version, latest available version, security advisories |
| **Upgrade scheduler** | Schedule k3s upgrade for specific date/time, with customer notifications |
| **Backup status** | Last backup timestamp, backup size, offsite write status |
| **Backup & restore** | Manual backup trigger, restore from snapshot, restore to point-in-time |
| **Upgrade history** | Timeline of all upgrades/patches applied, downtime logged |
| **Patch management** | Available OS patches, manually apply, or schedule auto-apply |
| **Node upgrade workflow** | Start drain → upgrade → uncordon (guided steps) |
| **etcd monitoring** | Health status, snapshot list, replication status (HA) |
| **Maintenance window scheduler** | Set preferred maintenance windows (don't upgrade during these) |
| **Automated alerts** | Notify admins of failed backups, critical patches, node issues |

---

## Implementation Checklist

### Documentation Phase

- [ ] Create detailed runbooks for each scenario
- [ ] Document k3s version roadmap (what versions to support, EOL dates)
- [ ] Create backup retention policy documentation
- [ ] Document disaster recovery procedures

### Automation Phase

- [ ] Implement automated backup script (CronJob)
- [ ] Create upgrade testing in staging cluster
- [ ] Build k3s upgrade automation (scripted procedure)
- [ ] Create health check scripts (pre/post-upgrade verification)

### Admin Panel Phase

- [ ] Build cluster health dashboard
- [ ] Implement upgrade scheduler
- [ ] Build backup management UI
- [ ] Create upgrade history view
- [ ] Implement maintenance window scheduling

### Testing Phase

- [ ] Test k3s patch upgrade (staging)
- [ ] Test k3s minor upgrade (staging)
- [ ] Test OS upgrade on single node
- [ ] Test worker node rolling upgrade
- [ ] Test full cluster restore from backup
- [ ] Test etcd snapshot recovery

### Production Readiness

- [ ] Verify backup restoration works (monthly test)
- [ ] Perform first production k3s upgrade
- [ ] Document lessons learned
- [ ] Update runbooks based on experience
- [ ] Train ops team on procedures

---

## Related Documents

- [`../05-advanced/DISASTER_RECOVERY.md`](../05-advanced/DISASTER_RECOVERY.md) — High availability and disaster recovery
- [`./BACKUP_STRATEGY.md`](./BACKUP_STRATEGY.md) — Customer data backup procedures
- [`../02-operations/INFRASTRUCTURE_SIZING.md`](../02-operations/INFRASTRUCTURE_SIZING.md) — Cluster sizing and node allocation
- [`../01-core/PLATFORM_ARCHITECTURE.md`](../01-core/PLATFORM_ARCHITECTURE.md) — k3s architecture decisions

---

**Status:** Ready for implementation  
**Estimated Development Time:** 2-3 weeks (scripts, automation, testing)  
**Priority:** CRITICAL — Essential for production operations  
**Complexity:** High — Involves cluster state management and downtime procedures

