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
