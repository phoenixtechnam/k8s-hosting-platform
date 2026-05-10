# Cluster Network Migration — pre-Phase-1 → always-on set mode

This page documents the upgrade path from the legacy three-mode firewall
(`cidr` / `set` / `single`) to the always-on set mode that ships in
[the `feat/firewall-set-mode-always` series](../07-reference/ARCHITECTURE_DECISION_RECORDS.md).

## TL;DR

For a cluster bootstrapped before Phase 1, the simplest migration is
**re-run `bootstrap.sh` on every existing node**. The script is
idempotent for everything except the firewall layer; the firewall is
re-rendered on each invocation (`flush ruleset` + atomic apply). The
six-set declaration in the new `bootstrap.sh` adds two new sets
(`trusted_ranges_v{4,6}`) and keeps the existing two
(`cluster_peers_v{4,6}`), so the host firewall layout converges to the
new shape on first re-run.

## What changed

| Before (cidr/set/single)                          | After (always-on set)                        |
| ------------------------------------------------- | -------------------------------------------- |
| `--cluster-network-cidr <CIDR>` selects firewall mode | `--cluster-network-cidr` only pins k3s `--node-ip` |
| Mode resolution at install time                   | No mode — set is always rendered             |
| `cluster_peers_v{4,6}` only                       | `cluster_peers_v{4,6}` + `trusted_ranges_v{4,6}` |
| Manual SSH + `peer-firewall-add` on every peer    | `Settings → Cluster Networking → Pre-Enroll Node` |
| Operator workstation IP not in nft                | `--allow-source <IP>` at bootstrap OR `Settings → Cluster Networking → Add Trusted Range` |

## Migration plan

### Option A — wipe + rebootstrap (recommended for staging)

The cheap option, given there is no production cluster yet.

1. `kubectl drain` and decommission every node (data loss is fine for
   the staging cluster).
2. Re-run `bootstrap.sh --join-as server --domain ... --acme-email ...`
   on the new first server, with the new flags:
   ```
   bootstrap.sh --join-as server \
     --domain phoenix-host.net --acme-email ops@... \
     --allow-source 198.51.100.7    # operator workstation
   ```
3. Re-run on each subsequent server / worker as before, joining via
   `--server <existing-peer-IP> --token <T>`.
4. Re-create any pre-Phase-1 trusted ranges via Settings → Cluster
   Networking → Add Trusted Range.

### Option B — in-place migration (requires production-grade care)

For a future production cluster that's already on the legacy script.

1. Pick a window where short kube-API blips on each node are
   acceptable (~30s per re-run).
2. On each node IN ORDER (servers first, workers after), re-run
   `bootstrap.sh` with the same flags it was originally invoked with,
   plus any new `--allow-source` entries you want seeded.
3. The `flush ruleset` + atomic apply briefly drops in-flight
   connections; existing TCP connections survive thanks to
   `ct state established,related accept` reaching the new ruleset.
4. After all nodes are upgraded, verify:
   - `kubectl get nodes` — all Ready
   - `kubectl get clustertrustedranges` — empty (no CRs yet; legacy
     CIDR is just an nft set member from `--cluster-network-cidr`'s
     allow-source mirror)
   - `nft list set inet filter trusted_ranges_v4` on each node —
     contains the bootstrap-time allow-source entries
   - `nft list set inet filter cluster_peers_v4` on each node —
     contains every other Node's InternalIP (reconciler converged)
5. Promote bootstrap-time entries you want to persist into
   ClusterTrustedRange CRs via the admin panel. The CRs survive
   re-bootstraps; raw nft set members do not.

## Reconciler upgrade

The firewall-reconciler image is bumped as part of the same
release. On a node that's been re-bootstrapped, the new reconciler:
1. Probes for the four required sets at startup. If any is missing,
   logs a clear ERROR pointing back at re-running `bootstrap.sh`,
   then `idleForever`. No crashloop.
2. Watches Nodes + ClusterTrustedRange + ClusterPendingPeer.
3. Converges all four sets every 30s (or sooner on informer events).

If you upgrade the reconciler image WITHOUT re-bootstrapping the host,
the reconciler enters its idle state and logs a single ERROR. The
firewall continues to work (the host nft rules are static; only the
sets need reconciler help to stay current). New cluster joins won't
auto-update `cluster_peers` until the host is re-bootstrapped, at
which point the reconciler resumes normal operation.

## Cluster network migration: no automation

We deliberately do NOT auto-import legacy `CLUSTER_NETWORK_CIDR`
values as ClusterTrustedRange CRs on first reconcile, for two
reasons:

1. The bootstrap-time allow-source seed already covers the same
   semantic (the legacy CIDR was added to `trusted_ranges_v{4,6}` via
   the new `--cluster-network-cidr` mirror in `parse_args`). There's
   no missing trust.
2. The CR has audit fields (`addedBy`, conditions) that an automated
   import couldn't fill in correctly — `addedBy=migration` is
   misleading. The operator promoting nft set members to CRs
   intentionally is the right boundary.

## Smoke check

After migration, run:
```
make smoke
```
This exercises external-IP routing, cross-node ingress, hostNetwork→pod,
Longhorn replica health, and Felix log scrape. Failures indicate the
firewall isn't accepting cluster-internal traffic the way it should —
the most common cause is a node that wasn't re-bootstrapped, leaving
the legacy `flush ruleset` with no `trusted_ranges_v{4,6}` declaration.

## Rollback

If the new firewall layout breaks something on staging, the rollback
is the same as the migration in reverse: check out the pre-Phase-1
commit of `bootstrap.sh`, re-run on every node, accept the brief
downtime. The CRs from the new admin UI become orphans (they exist
on the kube-API but the legacy reconciler doesn't watch them), so
delete them after the rollback to keep the cluster state clean:
```
kubectl delete clustertrustedranges --all
kubectl delete clusterpendingpeers --all
```

The CRDs themselves can be deleted if you want to revert Phase 2:
```
kubectl delete crd clustertrustedranges.networking.platform.phoenix-host.net
kubectl delete crd clusterpendingpeers.networking.platform.phoenix-host.net
```

## See also

- [CLUSTER_NETWORK.md](./CLUSTER_NETWORK.md) — the architecture page
  describing the always-on set mode (post-migration)
- [CLUSTER_NETWORK_SMOKE.md](./CLUSTER_NETWORK_SMOKE.md) — the
  cluster-level network smoke test
- [docs/07-reference/ADR-NNN-firewall-always-on-set-mode.md](../07-reference/ARCHITECTURE_DECISION_RECORDS.md) —
  the design ADR (TBD)
