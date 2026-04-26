# Cluster Network Smoke + Failover Suite

The platform ships two operator scripts that exercise the cluster's network and recovery behavior end-to-end. They are the regression detector for the kinds of failures that don't show up in unit tests but do show up in production: cross-node connectivity, ingress fan-out, replica health, induced-failure recovery.

**Where:**
- `scripts/smoke-test-cluster-network.sh` — 6 tests, ~5-10 min, non-destructive.
- `scripts/failover-test.sh` — 5 induced-failure drills, ~30+ min, **destructive** (drains nodes, restarts k3s).
- `Makefile` — convenience targets (`make smoke`, `make failover`, `make verdict`, `make diagnose`).

Both scripts are idempotent and clean up after themselves.

## Quick start

```bash
# Smoke (needs KUBECONFIG to a cluster admin context)
KUBECONFIG=/tmp/k8s-staging/kubeconfig make smoke

# One-line PASS/FAIL summary (good for CI dashboards)
KUBECONFIG=... make verdict     # → "PASS=36 FAIL=9"

# Test 1 only — no kubeconfig needed (probes public DNS hostnames)
make smoke-public

# Forensic dump (creates docs/diagnostics/<utc-stamp>/ with nodes/pods/Felix logs + smoke.log)
KUBECONFIG=... make diagnose

# Induced-failure drills (DESTRUCTIVE — schedule a maintenance window)
KUBECONFIG=... make failover
```

## The 6 smoke tests

| # | Test | What it catches |
|---|------|-----------------|
| 1 | External IP × hostname matrix | DNS round-robin masks per-IP failures; this probes each external IP individually with 5 attempts × p50/max timing |
| 2 | ingress→pod cross-node matrix | The exact failure mode of [project_calico_netpol_ipblock_fix.md](../../home/.../memory/project_calico_netpol_ipblock_fix.md) — cross-node host→pod was broken by a NetworkPolicy ipBlock pointing at the wrong CIDR. Test 2 is the regression canary. |
| 3 | pod→pod cross-node | Control: should keep passing even when 2/4 fail. If both fail together, the Calico data plane is broken. |
| 4 | hostNetwork→pod cross-node | Direct probe of the host-source-via-vxlan-tunnel-IP class of bug. Spawns a hostNetwork=true pod on each node, curls pod-network targets cross-node. |
| 5 | Longhorn replica health | Catches the "node up but Longhorn replicas degraded/unattached" silent failure mode |
| 6 | Calico Felix log scrape | Greps the last 200 log lines per `calico-node` for `Failed to set tunnel device MTU`, `XDP`, `fatal`, `panic`. Catches Felix in a partial-reconcile loop. |

Pass criteria: every cell of every matrix succeeds. A FAIL on any single cell = the suite fails.

## The 5 failover drills

Each drill: wait steady → induce failure → re-run smoke → assert SLO recovery → restore → wait steady.

| # | Drill | Induced failure | Recovery SLO |
|---|-------|-----------------|--------------|
| D1 | cordon | Each node, in turn | Smoke clean while cordoned |
| D2 | drain | Each node, gracefully evict pods | External IPs on other nodes still serve <2s |
| D3 | kubelet kill | `systemctl stop k3s` on one node | Cluster declares NotReady within 60s, traffic reroutes |
| D4 | ingress pod kill | Delete one ingress-nginx pod | DaemonSet recreates within 5s, no extended outage |
| D5 | rolling deploy | Patch admin-panel Deployment annotation | Zero downtime (≤1 fail in 30s of polling) |

The drills are sequential and stateful — D3 leaves the node briefly NotReady, drills wait for full recovery before the next.

## When to run

- **After every cluster bootstrap** — `bootstrap.sh` does this automatically (advisory) on the first server. Pass `--require-smoke-pass` to make it fatal in CI.
- **Before any infra-touching change** — get a PRE baseline log so you can A/B compare after.
- **After Calico or k3s upgrades** — the Felix MTU and policy-chain code paths are the most fragile.
- **During incident response** — `make diagnose` packages a forensic snapshot in seconds.

## Common FAIL diagnoses

| Symptom | Likely cause | Reference |
|---------|--------------|-----------|
| Test 4 (hostNetwork→pod cross-node) all-FAIL | NetworkPolicy `ipBlock` references the wrong CIDR (underlay instead of pod CIDR) | [verdict](../../docs/diagnostics/2026-04-26-post-fix/verdict.md), [k8s/base/network-policies.yaml](../../k8s/base/network-policies.yaml) |
| Test 1 mostly-OK but with 5.5s spikes | Cross-node host→pod broken; nginx upstream-retry hides total failure | Same as Test 4 |
| Test 3 FAIL but Test 4 PASS | Calico VXLAN data plane is broken (rare) | tcpdump on `vxlan.calico` of source + dest |
| Test 5 (Longhorn) FAIL with "degraded" | Replica out of sync after a node restart | `kubectl get volumes.longhorn.io -n longhorn-system` |
| Test 6 (Felix logs) recurring FAIL | Felix is in a partial-reconcile loop (often: MTU mismatch with the underlay) | `kubectl logs -n calico-system -l k8s-app=calico-node` |
| Every test except Test 6 FAIL | Cluster API not reachable from `kubectl` | Check kubeconfig + NetBird mesh state |

## Forensic record

Successful + failed runs should be committed to `docs/diagnostics/<utc-stamp>/` for future A/B comparison. Use:

```bash
KUBECONFIG=... make diagnose
git add docs/diagnostics/<the new dir>/
git commit -m "diagnostics: <short reason for capture>"
```

The 2026-04-26 `pre-wipe`/`post-wipe`/`post-fix` triplet is the canonical example — it captured a clean re-bootstrap A/B that ruled out cumulative drift before chasing the real root cause.
