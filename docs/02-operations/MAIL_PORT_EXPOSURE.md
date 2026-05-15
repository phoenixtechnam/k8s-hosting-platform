# Mail Port Exposure — Operator Runbook

**Scope:** how the Stalwart mail-server's external mail ports (25, 465, 587, 143, 993, 4190) are bound on Kubernetes nodes, how an operator flips between the two supported modes, and how to recover from the small set of stuck states that can occur during the flip.

**Audience:** platform operators on call. Assumes `kubectl` access to the cluster and admin-panel access for `/admin/mail/port-exposure`.

**Last updated:** 2026-05-14, Phase 7 streamline. Supersedes the older "haproxy DaemonSet always-on with nodeSelector toggle" model documented in [STALWART_DEPLOYMENT.md](./STALWART_DEPLOYMENT.md).

---

## The two modes

| Mode | What binds the mail port | Who claims `hostPort` | haproxy DaemonSet |
| --- | --- | --- | --- |
| `thisNodeOnly` (default) | Stalwart pod, via `hostPort` | platform-api (field-manager) | **absent** |
| `allServerNodes` | haproxy pod on every server-role node, forwards to `stalwart-mail.mail.svc:<port>` with PROXY Protocol v2 | nobody — field unset | **present** as a DaemonSet |

`thisNodeOnly` is the simplest setup — single point of ingress on whatever node Stalwart happens to run on. DNS A records for `mail.example.com` must resolve to that single node's IP, and traffic enters only there. Source IP is preserved automatically (no proxy in the path).

`allServerNodes` is what you want if the mail subsystem must survive single-node loss without DNS changes. haproxy on every server-role node binds the mail ports and forwards to Stalwart through the in-cluster Service. DNS round-robins all server IPs; any reachable node accepts mail. haproxy injects PROXY Protocol v2 so Stalwart still sees real client IPs in its access log and rate-limiter. Cost: an extra ~1 ms of haproxy latency per connection, and one more failure surface (the DaemonSet).

---

## How the flip works mechanically

Switching modes is a two-step operation in the platform-api (`backend/src/modules/mail-admin/port-exposure.ts:updateMailPortExposure`). The order is mode-specific — it matters because both Stalwart and haproxy compete for the same node-local ports, and overlapping their bindings on any node causes a CrashLoopBackOff.

### `thisNodeOnly` → `allServerNodes`

1. **Remove `hostPort` from the Stalwart Deployment** (SSA-apply with `fieldManager=platform-api.port-exposure`, `force=true`). The Deployment rolls; we **wait for the rollout to complete** (`waitForStalwartRollout` in `rollout-wait.ts`, 90 s budget) so the old Stalwart pod is fully gone before any haproxy pod tries to bind the same ports on the same node.
2. **Create the haproxy DaemonSet** (`apps.createNamespacedDaemonSet`, idempotent — `409 Conflict` is treated as success).
3. **Persist `mailPortExposureMode='allServerNodes'`** in `system_settings`.

### `allServerNodes` → `thisNodeOnly`

1. **Delete the haproxy DaemonSet** with `propagationPolicy=Foreground`, then poll for absence (`waitForHaproxyDaemonSetGone`, 60 s budget). Foreground GC blocks the delete-call until child pods are gone; the poll is belt-and-suspenders to detect a client-side cancel.
2. **Re-add `hostPort` to the Stalwart Deployment** (same SSA-apply, with `hostPort=containerPort` on each mail port). Wait for the rollout to complete.
3. **Persist `mailPortExposureMode='thisNodeOnly'`** in `system_settings`.

### Why SSA, not strategic-merge

The static Stalwart manifest (`k8s/base/stalwart-mail/stalwart/deployment.yaml`) declares mail-port `containerPort`/`name`/`protocol` only — it has **no `hostPort` field**. platform-api claims `hostPort` dynamically via Server-Side Apply with `fieldManager=platform-api.port-exposure`. Flux's `kustomize.toolkit.fluxcd.io/ssa: merge` annotation makes Flux's reconciler skip fields owned by another Apply-manager, so it never reverts our claim.

Three other patch strategies were tried first and rejected (commit history `feat/stalwart-rocksdb-ha`):

- **JSON-Patch `op: replace`** — Operation=Update, which is not constrained by SSA ownership. Flux reverts the change within one reconcile.
- **Strategic-merge with `$patch: replace` directive** — apiserver accepts the patch but silently no-ops the directive on nested merge-key lists (`containers[].ports`).
- **Strategic-merge with per-port `$retainKeys`** — apiserver emits `Warning: unknown field` and treats the patch as a no-op.

If you find yourself wanting to "just patch hostPort" with kubectl, don't — use the API. The API path encodes the rollout-wait + idempotency + ownership semantics that ad-hoc kubectl patches skip.

---

## Triggering a flip

### Via the admin panel (preferred)

1. Open **Settings → Email → Port Exposure**.
2. Select the target mode in the radio list.
3. Click **Apply**, then confirm in the dialog.
4. Watch the haproxy DS status row at the bottom of the card — it goes to `0/n pods ready` during the rollout, then stabilises at `n/n` (allServerNodes) or disappears entirely (thisNodeOnly).

The card auto-invalidates the placement + health queries on success, so the **Mail server: OK** banner at the top of the page refreshes within a couple of seconds without waiting out the 30 s staleTime.

Expected operator-visible interruption: ~30 s per flip. Stalwart's pod restarts (small RocksDB warm-up) and any in-flight mail connections drop. Server retries (SMTP RFC 5321 §4.5.4.1) will reconnect within minutes.

### Via the API

```bash
TOKEN=...  # JWT for an admin user
PANEL=https://admin.platform.example.com

# Read current state
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$PANEL/api/v1/admin/mail/port-exposure" | jq .

# Flip to allServerNodes
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"allServerNodes"}' \
  "$PANEL/api/v1/admin/mail/port-exposure"
```

The PATCH returns 204 only after both the rollout-wait and DaemonSet-create complete. If your client times out, the flip is still in progress on the server — query GET again to see the actual settled state.

---

## Validating after a flip

A clean flip leaves these visible:

```bash
# 1. system_settings row matches
kubectl -n platform-api exec -it deploy/platform-api -- \
  psql -t -c "select mail_port_exposure_mode from system_settings;"
# →  thisNodeOnly  OR  allServerNodes

# 2. Stalwart pod has (or doesn't have) hostPort claims
kubectl -n mail get deploy stalwart-mail \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="stalwart")].ports[*]}' | jq .
# allServerNodes: containerPort only, no hostPort key
# thisNodeOnly:   each entry has hostPort==containerPort

# 3. haproxy DaemonSet presence + readiness
kubectl -n mail get ds stalwart-haproxy
# thisNodeOnly: NotFound is correct
# allServerNodes: DESIRED == READY (one per server-role node)

# 4. External smoke from outside the cluster
swaks --to postmaster@mail.example.com --from probe@probes.example \
      --server <any-server-node-ip> --port 25 --tls --quit-after EHLO
```

The integration harness covers all of this automatically:

```bash
scripts/integration-stalwart-mail-ha.sh --mode-flip
```

— flips in both directions, asserts hostPort presence, asserts DS state, runs SMTP smoke after each transition.

---

## Stuck states and recovery

### A. PATCH returns `MAIL_DEPLOYMENT_SCALED_TO_ZERO` (409)

**Meaning:** another mail-admin operation is in progress that has scaled the Stalwart Deployment to 0 replicas — almost always the archive-downtime path (`archive.ts`) or a DR scale-down. The rollout-wait refuses to flip in this state because `updatedReplicas==replicas` is trivially satisfied (0==0) and the safety check would pass while Stalwart isn't actually running.

**Recovery:** wait for the concurrent operation to complete (visible in the admin panel's Mail Archive card or the Mail DR card), then retry the flip.

### B. PATCH returns `MAIL_DEPLOYMENT_ROLLOUT_TIMEOUT` (504)

**Meaning:** Stalwart's Deployment didn't reach `readyReplicas==replicas && unavailableReplicas==0` within 90 s. Usually means the new pod can't schedule (PVC stuck attaching to another node, no node has enough disk, an initContainer is looping).

**Diagnose:**

```bash
kubectl -n mail get pods -l app=stalwart-mail
kubectl -n mail describe pod <pod-name>
kubectl -n mail logs <pod-name> -c restore-state --previous
```

**Recovery:** fix the underlying schedulability problem, then re-issue the same PATCH — the operation is idempotent.

### C. PATCH returns `MAIL_HAPROXY_DS_DELETE_TIMEOUT` (504, only on `allServerNodes→thisNodeOnly`)

**Meaning:** haproxy DaemonSet's child pods didn't terminate within 60 s. Almost always one specific node is unhealthy (kubelet not responding) and Foreground GC is stuck waiting for that node's pod.

**Diagnose:**

```bash
kubectl -n mail get pods -l app=stalwart-haproxy
kubectl get nodes
```

**Recovery (in order of escalation):**

1. If exactly one node is the problem and you can recover its kubelet, do that. Retry the PATCH.
2. If the node is dead, drain the dead haproxy pod manually:
   ```bash
   kubectl -n mail delete pod stalwart-haproxy-<id> --force --grace-period=0
   ```
   Retry the PATCH.
3. If even step 2 doesn't work, force-delete the DaemonSet and let platform-api re-create it on the next mode flip:
   ```bash
   kubectl -n mail delete ds stalwart-haproxy
   ```
   Then **flip to `allServerNodes` then back to `thisNodeOnly`** to re-establish state consistency (don't try to manually `kubectl patch` hostPort back onto Stalwart — see "Why SSA, not strategic-merge" above).

### D. `hostPort` field is stuck unclaimed (very rare)

**Symptoms:** mode says `thisNodeOnly` in the DB but external mail connections fail; `kubectl get deploy stalwart-mail -o yaml | grep hostPort` shows the field absent.

**Cause:** a previous flip was interrupted between the SSA-apply and the DB write. Or, more rarely, a manual `kubectl edit` removed the field outside platform-api's field-manager.

**Recovery:** flip the mode twice via the API — `thisNodeOnly` → `allServerNodes` → `thisNodeOnly`. The first flip re-establishes platform-api as the field-manager-of-record. The second flip applies hostPort. Both flips persist their state, so a crash in the middle just leaves you in `allServerNodes` (still functional).

### E. Both Stalwart and haproxy try to bind hostPort simultaneously (you should not see this)

**Symptoms:** haproxy pod on the same node as Stalwart is in `CrashLoopBackOff` with `bind: address already in use` in logs.

**Cause:** rollout-wait was bypassed somehow — typically because a previous version of this code path didn't have it. **This should not happen on the current code.** If you see it on the current code, it's a regression and the integration harness should have caught it; file an issue.

**Recovery (workaround):** delete the haproxy DaemonSet, wait 30 s for Stalwart to settle, recreate via mode flip:

```bash
kubectl -n mail delete ds stalwart-haproxy
# wait until kubectl -n mail get pods -l app=stalwart-mail shows ready
# then via admin panel: flip thisNodeOnly → allServerNodes
```

---

## What this code does NOT cover

- **Per-node mode** — you cannot have haproxy on some nodes and Stalwart hostPort on others. The mode is cluster-wide.
- **Custom mail ports** — the port list (25, 465, 587, 143, 993, 4190) is canonical in `MAIL_HOST_PORTS` (port-exposure.ts) and in the haproxy ConfigMap. Adding new mail ports requires editing both.
- **TLS termination on haproxy** — haproxy is L4 passthrough (no TLS in haproxy). Stalwart owns ACME certs and TLS handshakes. This is intentional: keeps cert lifecycle centralised.
- **Cross-cluster failover** — out of scope. Use the DR card + manual migration for in-cluster failover; cross-cluster failover would need an external load balancer in front of all clusters' node IPs.

---

## Related

- [STALWART_DEPLOYMENT.md](./STALWART_DEPLOYMENT.md) — top-level mail subsystem overview.
- [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md) — DR card, auto-failover thresholds, and the migration path.
- `backend/src/modules/mail-admin/port-exposure.ts` — the canonical implementation.
- `backend/src/modules/mail-admin/rollout-wait.ts` — the shared rollout-wait helper used here and by `migration.ts`.
- `scripts/integration-stalwart-mail-ha.sh --mode-flip` — the integration test that exercises everything above.
