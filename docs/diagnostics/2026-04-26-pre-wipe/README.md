# PRE-wipe baseline — 2026-04-26

Captured immediately before the planned bulk-wipe + clean re-bootstrap experiment.

## Cluster snapshot
- 4 nodes: staging (control-plane), staging2 (control-plane), staging3 (control-plane), worker
- k3s v1.33.10+k3s1 on Debian 13 (kernel 6.12.x)
- Calico via Tigera operator: VXLAN-only encap, MTU 1450 (effective 1230 over NetBird wt0 1280)
- NetBird mesh on 100.64.0.0/10 = the trust boundary for both the K8s API and pod underlay
- ingress-nginx DaemonSet, hostNetwork=true, on all 4 nodes

## Smoke test result: PASS=10 FAIL=37

| Test | Result | Interpretation |
|---|---|---|
| 1 — external IP × hostname matrix | FAIL on every IP × every hostname | DNS round-robin masks the issue from end users; per-IP probing reveals the failure |
| 2 — ingress→pod cross-node | 2/8 PASS | **Only same-node combinations work** |
| 3 — pod→pod cross-node | 2/2 PASS | **Control: pod-network sources are fine cross-node** |
| 4 — hostNetwork→pod cross-node (canary) | 2/8 PASS | **Confirms host-source is the failing path** |
| 5 — Longhorn replica health | 2/3 (stalwart-mail volume `degraded`) | Pre-existing; tracking separately |
| 6 — Felix log scrape | 1/4 (3 nodes have MTU/XDP warning loops) | `Failed to set tunnel device MTU error=invalid argument` every 10s |

## Diagnosis going in
- Routes, FDB, ARP, vxlan tunnel local IPs all verified correct on every node.
- Failure path: `hostNetwork=true source pod (e.g. ingress-nginx)` → `vxlan.calico` → cross-node target pod = TIMEOUT.
- Working path: `pod-network source pod (e.g. platform-api)` → `vxlan.calico` → cross-node target pod = OK.
- The cluster is functional only by statistical luck (ingress-nginx happens to have nginx pods on the same nodes as admin-panel replicas, and nginx retries one upstream).

## Hypothesis under test
Cumulative drift from in-place Calico restarts during the bootstrap-debugging session has put Felix into a partial-reconcile state (witness: the recurring `Failed to set tunnel device MTU` warning). A clean re-bootstrap from scratch will eliminate the drift and host→pod cross-node will work.

## Next step
Bulk-wipe all 4 nodes simultaneously, fresh bootstrap, re-run smoke, A/B compare.

## Files
- `smoke.log` — full smoke test output (every PASS/FAIL line)
- `nodes.txt` — `kubectl get nodes -o wide`
- `pods.txt` — `kubectl get pods -A -o wide`
- `installation.yaml` — Tigera Installation CR
- `felix.yaml` — FelixConfiguration default
- `calico-node-logs.txt` — last 100 lines per calico-node pod (4 pods)
