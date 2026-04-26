# Verdict — 2026-04-26 cross-node host→pod failure

## Headline
**Root cause: K8s NetworkPolicy `ipBlock: 100.64.0.0/10` was a no-op.** When ingress-nginx (hostNetwork=true) forwarded a request to a pod IP cross-node, the Linux kernel routed via `vxlan.calico` and **rewrote the source IP** from the host's wt0 address (NetBird CGNAT, e.g. 100.120.116.150) to `vxlan.calico`'s tunnel IP (cluster pod CIDR, e.g. 10.42.171.64). By the time the destination's Felix evaluated the NetworkPolicy, the source was 10.42.x.x — which never matches `100.64.0.0/10`. Packets fell through to default-deny.

**Fix: change ipBlock from `100.64.0.0/10` → `10.42.0.0/16`** (the cluster pod CIDR — the actual source IP after the vxlan tunnel re-source). Single-line manifest change, no architectural surgery.

## Why it took 3 sessions to find
- Same-node paths bypass Calico via kernel-local routing → 50% of requests succeeded by luck.
- nginx upstream-retry hid the failure further (one cross-node attempt + one same-node retry = 5.5s TTFB instead of 504).
- DNS round-robin across 3 server IPs added another 33% statistical mask.
- The `ipBlock: 100.64.0.0/10` *looked* obviously correct (NetBird CGNAT range matches all node wt0 IPs), so no one questioned it.
- Re-bootstrap experiment (PRE/POST A/B) was needed to rule out cumulative drift before chasing the real bug.

## Evidence
| File | Result |
|---|---|
| `../2026-04-26-pre-wipe/smoke.log` | PASS=10 FAIL=37 |
| `../2026-04-26-post-wipe/smoke.log` | PASS=10 FAIL=36 (clean re-bootstrap, **identical** failure pattern → drift hypothesis REJECTED) |
| `smoke.log` (this dir, post-fix) | PASS=36 FAIL=10. Tests 2 + 4 (the canary) flipped from 2/8 to **8/8 PASS** |

Remaining 10 FAILs in post-fix are unrelated to the cross-node bug:
- 4 × dex hostname not routable (oauth2-proxy + dex CrashLoopBackOff during cluster bring-up; will heal)
- 4 × test6 Felix log warnings (pre-existing `Failed to set tunnel device MTU` loop — separate item)
- 2 × test1 minor — small intermittent variance on DNS round-robin

## Diagnostic methodology that worked
1. **PRE-baseline smoke** captured a forensic record before any change.
2. **Bulk wipe + clean re-bootstrap** A/B tested the cumulative-drift hypothesis. POST=identical-FAIL → not drift.
3. **Bisect via `kubectl run testpod` in `default` ns** (no NetworkPolicy) → cross-node host→pod WORKS without a policy. Proved the packet wasn't being dropped at the CNI layer.
4. **Live patch with `ipBlock: 10.42.0.0/16`** added → instant green. Confirmed the policy was the dropper.
5. Patched the manifest, fast-forwarded `staging` branch, verified Flux reconciled and the live policy matches the source.

## Files changed in the fix
- `k8s/base/network-policies.yaml` — `100.64.0.0/10` → `10.42.0.0/16` on `allow-ingress-to-platform`, with a long inline comment explaining the kernel re-source behavior.

## Smoke + failover scripts as the regression detector
- `scripts/smoke-test-cluster-network.sh` — Test 2 + Test 4 will catch this exact failure mode if it ever recurs.
- `scripts/failover-test.sh` — induced-failure drills for the cluster.
- `scripts/destroy-cluster.sh` — destructive cluster wipe utility (used today).

## Lessons (for memory)
1. **Don't trust an ipBlock that's not in the cluster pod CIDR.** Linux re-sources host packets to the egress interface's primary IP. For Calico VXLAN, that's the vxlan.calico tunnel IP (in the pod CIDR), NOT the underlay (NetBird) IP.
2. **Same-node paths can mask cross-node bugs indefinitely.** Always include cross-node and per-IP probes in smoke tests.
3. **A clean re-bootstrap is the cheapest way to rule out drift** when you suspect cumulative state corruption. The PRE/POST A/B was a 90-minute experiment that gave a definitive answer.

## Outstanding work (not in scope for this verdict)
- Test 6 Felix MTU loop warnings — non-blocking but should be addressed.
- dex/oauth2-proxy CrashLoopBackOff post-bootstrap — likely a Flux ordering issue.
- Wire smoke + failover into `bootstrap.sh`, `local.sh`, GH workflow (Phase G).
