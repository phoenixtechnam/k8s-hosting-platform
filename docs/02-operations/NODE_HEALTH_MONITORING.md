# Node Health Monitoring

Operator-facing observability layer for k3s node health. Closes the
three monitoring gaps surfaced by the **2026-05-08 worker incident**:

> Calico Felix crash-looped for 10 days writing core dumps into the
> calico-node container's writable layer (28 GB → DiskPressure on
> the worker → kubelet evicted Longhorn pods → worker silently lost
> `driver.longhorn.io` registration → tenant PVCs that needed a worker
> replica failed to bind). Nothing in the platform alerted.

## What it covers

The 5-minute reconciler (`backend/src/modules/node-health/`) tracks
three signal classes per node:

| Signal | Source | Severity trigger |
|---|---|---|
| Pressure (`DiskPressure` / `MemoryPressure` / `PIDPressure`) | `kubectl get node` conditions | Any pressure → **critical** |
| CSINode drivers vs cluster baseline (mode of cluster) | `storage.k8s.io/v1/CSINode` | Missing baseline driver → **critical** |
| Pod evictions in last hour | `events.k8s.io reason=Evicted` | ≥3/hr → **warning**, ≥10/hr → **critical** |
| Disk usage % (Phase 2) | kubelet `/stats/summary` (not yet wired) | ≥75% → warning, ≥90% → critical |

Plus `not Ready` → critical.

## How notifications fire

- Severity transition (any direction) → 1 notification per admin /
  super_admin user.
- Sustained warning or critical → 1 re-notification every 24 h.
- Recovery to normal → 1 notification.

Notifications carry `resourceType=node_health` and `resourceId=<node-name>`
so the admin panel's bell icon can deep-link.

## Operator surfaces

- **Monitoring → Node Health tab** (`/admin/monitoring`): full per-node
  table — severity, ready, pressures, CSI driver count, evictions/h,
  disk %, observed-at. "Reconcile now" button forces a tick (skips the
  5-min wait).
- **Nodes & Storage → Cluster Nodes tab**: per-node card header now
  carries a compact severity badge when severity != normal. Hover the
  badge for the full pressure / CSI / eviction summary.

## Bootstrap-side disk caps

`scripts/bootstrap.sh:configure_node_logging_caps()` writes three
guards that prevent *future* unbounded log/dump growth:

1. `kernel.core_pattern = |/bin/false` (`/etc/sysctl.d/99-platform-no-core-dumps.conf`).
   Drops core dumps on the floor — exactly the bleed that caused the
   28 GB calico-node growth on 2026-05-08. Override per-host by
   removing the file and setting `core_pattern` manually if you need
   real cores for a debug session.
2. `* hard core 0` (`/etc/security/limits.d/99-platform-no-cores.conf`).
   Belt-and-suspenders pairing with the sysctl above.
3. `SystemMaxUse=2G` (`/etc/systemd/journald.conf.d/99-platform-cap.conf`).
   Caps systemd-journald disk use to 2 GB (default is auto-detected
   ≤ 4 GB on Debian — too much for the 38 GB Hetzner CX21).
4. `/etc/logrotate.d/calico` — daily rotate of `/var/log/calico/*.log`
   so a stuck calico-node pod can't grow its host-mounted log volume
   unbounded.

Existing nodes (bootstrapped before 2026-05-08) need a manual one-shot:

```bash
ansible -i hosts all -m shell -a "$(scripts/bootstrap.sh --emit-node-logging-caps)"
# OR (single host)
ssh root@<node> bash <(scripts/bootstrap.sh --emit-node-logging-caps)
```

(`--emit-node-logging-caps` is a follow-up CLI flag — until then,
copy the four file blocks from `configure_node_logging_caps()`.)

## Severity precedence

```
not Ready                                  → critical
disk/memory/pid pressure                   → critical
missing baseline CSI driver                → critical
evictions/h ≥ EVICTION_CRITICAL_THRESHOLD  → critical (default 10)
diskUsedPct  ≥ DISK_USED_PCT_CRITICAL      → critical (default 90)
evictions/h ≥ EVICTION_WARNING_THRESHOLD   → warning  (default 3)
diskUsedPct  ≥ DISK_USED_PCT_WARNING       → warning  (default 75)
                                            → normal
```

Constants in `backend/src/modules/node-health/service.ts`. Override
via env vars in a follow-up if cluster shapes diverge.

## API

- `GET /api/v1/admin/node-health/summary` (super_admin / admin) —
  last persisted snapshot from the reconciler, sorted critical →
  warning → normal then by name.
- `POST /api/v1/admin/node-health/reconcile` (super_admin / admin) —
  run a tick now. Useful after operator-initiated remediation; the
  Monitoring page calls this on the "Reconcile now" button.

## Smoke check

`scripts/smoke-test.sh` (admin path) hits `/admin/node-health/summary`
and asserts `overallSeverity != 'critical'`. Fails the smoke run if
the reconciler reports any node in critical state.

## UI-actionable recovery procedures

Every node row with severity != normal gets a **Recover…** button on
the Monitoring → Node Health tab. The modal lists action options
(suggested-first based on the detected condition) and requires:

- Operator types the node name to confirm
- Operator types a reason ≥ 3 chars (audit-logged)
- Click "Run action"

All actions are super_admin/admin only, audit-logged, and
**idempotent** (running twice on a recovered node returns
`{ recovered: 0 }` with no error).

### Action catalogue

| Action | API | When to use | Risk |
|---|---|---|---|
| **Clean stale pod records on this node** | `POST /admin/node-health/recovery/clean-stale-pods` | Pile of `Failed` / `Evicted` / `ContainerStatusUnknown` pods on the node — typically post-DiskPressure cleanup. | Zero — pods are already dead K8s records. |
| **Restart Longhorn CSI plugin on this node** | `POST /admin/node-health/recovery/restart-csi-plugin` | `csiDriversMissing` includes `driver.longhorn.io`. Deletes the longhorn-csi-plugin pod; DaemonSet replaces; re-registers driver. | Low — ~30s CSI outage on this node. |
| **Recycle a specific system pod** | `POST /admin/node-health/recovery/recycle-pod` | A single pod has runaway storage growth (the 2026-05-08 calico-node 28GB core-dump case). Operator picks namespace + pod name. | Low — controller reschedules in seconds. |

### Allow-list

Recovery actions accept these namespaces only:

```
calico-system  longhorn-system  ingress-nginx  kube-system
cnpg-system    cert-manager     flux-system    platform-system
tigera-operator
```

Tenant namespaces (`client-*`) and CNPG instance pods (label
`cnpg.io/instance`) are **always** refused regardless of any other
condition. Use the per-client / CNPG-failover flows for those.

### Audit log

Every action inserts an `audit_logs` row with:

- `action_type`: e.g. `node_health.recycle_pod` (or `.noop` for
  idempotent no-ops)
- `resource_type`: `node_health_recovery`
- `resource_id`: the node name
- `actor_id`: the admin's user id
- `changes` (jsonb): `{ reason, namespace?, podName?, deleted?: [...] }`

Filter the Monitoring → Audit Log tab by `resource_type=node_health_recovery`
to see every recovery run.

## Manual fix: backfill node logging caps on existing nodes

The bootstrap-side `configure_node_logging_caps()` runs on every
fresh `bootstrap.sh` install. **Existing** nodes (bootstrapped before
2026-05-08) need a one-shot SSH remediation:

```bash
# On each control-plane + worker node:
ssh -i ~/hosting-platform.key root@<node> 'bash -s' <<'EOF'
set -e
mkdir -p /etc/sysctl.d /etc/security/limits.d /etc/systemd/journald.conf.d /etc/logrotate.d
cat > /etc/sysctl.d/99-platform-no-core-dumps.conf <<'INNER'
kernel.core_pattern = |/bin/false
INNER
sysctl --system >/dev/null
cat > /etc/security/limits.d/99-platform-no-cores.conf <<'INNER'
* soft core 0
* hard core 0
root soft core 0
root hard core 0
INNER
cat > /etc/systemd/journald.conf.d/99-platform-cap.conf <<'INNER'
[Journal]
SystemMaxUse=2G
SystemKeepFree=4G
SystemMaxFileSize=128M
RuntimeMaxUse=200M
INNER
systemctl restart systemd-journald.service || true
cat > /etc/logrotate.d/calico <<'INNER'
/var/log/calico/*.log /var/log/calico/*/*.log {
  daily
  rotate 5
  size 50M
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su root root
}
INNER
echo "  caps applied; core_pattern=$(sysctl -n kernel.core_pattern); journald=$(journalctl --disk-usage 2>&1 | head -1)"
EOF
```

Run this once per node. Idempotent — safe to re-run.

The 2026-05-08 staging cluster (staging1/2/3 + worker) had this run
inline during the incident response and is already covered.

## Verification (post-deploy)

After this feature deploys to staging, validate end-to-end by:

1. Navigate to **Monitoring → Node Health**. Confirm all nodes show
   `severity=Healthy`.
2. Click **Reconcile now** to force-tick. `lastTickAt` updates.
3. (Optional drill) On a non-production worker, fill `/var/lib/`
   manually to >88% via `dd if=/dev/zero of=/tmp/big bs=1M count=...`
   and wait one tick. Confirm:
   - Worker row shows severity=critical with `disk` pressure.
   - "Recover…" button opens the modal with **Clean stale pod records**
     suggested.
   - Notification appears in the bell icon for admin role.
4. Remove the test fill (`rm /tmp/big`); next tick clears severity
   and emits a "Node X recovered to normal" notification.
