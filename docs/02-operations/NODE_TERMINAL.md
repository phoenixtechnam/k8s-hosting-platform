# Admin Node Terminal — Operator Runbook

Privileged root shell on any cluster node, opened from the admin
panel. `super_admin` only, audited, ephemeral. See
[ADR-041](../07-reference/ADR-041-node-terminal.md) for the design.

## Enabling the feature

The feature is gated by `platform-config` ConfigMap key
`node-terminal-enabled`. Default by environment:

| Overlay      | Default | Reason                                       |
|--------------|---------|----------------------------------------------|
| dev          | `true`  | Integration harness needs it on.             |
| staging      | `true`  | Operators have a break-glass tool on day 1.  |
| production   | `false` | Opt-in — flip when stickiness is in place.   |

Flip on staging/production via the System Settings UI OR:

```bash
kubectl -n platform patch configmap platform-config \
  --type merge -p '{"data":{"node-terminal-enabled":"true"}}'

# Roll platform-api so the env var takes effect (~60s)
kubectl -n platform rollout restart deployment/platform-api
```

`bootstrap.sh` writes `node-terminal-enabled` into `platform-config`
on first run, picking the default for the requested `--env`. Re-run
bootstrap or `kubectl patch` to change it later.

## Using it

1. Sign in as a `super_admin`.
2. Navigate to `Nodes & Storage → Cluster Nodes`.
3. Click the red **Terminal** button on any Ready node card. Modal opens.
4. If your last credential check was ≥30 min ago, you'll see a
   re-authentication prompt (password and/or passkey, based on what
   your account has). Verify; modal proceeds to the shell.
5. You're now `root` in the node's host namespaces. `whoami` returns
   `root`; `hostname` returns the node's hostname; the filesystem you
   see is the node's `/`, not the container's.
6. Close the modal (X button OR Escape OR browser tab close) → the
   privileged Pod is deleted within 10s.

## Lifecycle guarantees

The privileged Pod is destroyed by the FIRST of:

| Trigger                                | Latency                       |
|----------------------------------------|-------------------------------|
| Operator closes the modal (HTTP DELETE)| ~5s                           |
| WebSocket drop (network / browser kill)| ~5s (server-side finalize)    |
| Shell `exit` from inside the terminal  | ~5s (stdout EOF → cleanup)    |
| Idle 15 minutes (no I/O on the WS)     | Within the next 60s scheduler |
| `activeDeadlineSeconds` 3600 (1 hour)  | k8s evicts; hard cap          |
| Orphan sweeper (stale-safety 5 min)    | Within the next 60s scheduler |

Operator can force-close another super-admin's session via:

```bash
# List active sessions
curl -sk -H "Authorization: Bearer $TOKEN" \
  https://admin.<apex>/api/v1/admin/node-terminal/sessions | jq .

# DELETE — the audit row records WHO closed (you) AND
# whose session it was (changes.sessionOwnerId).
curl -sk -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://admin.<apex>/api/v1/admin/nodes/<node>/terminal/sessions/<id>"
```

## Auditing

Every action lands in `audit_logs` with `resource_type='node_terminal'`.

```sql
SELECT
  action_type,
  http_status,
  ip_address,
  actor_id,
  changes->>'nodeName'        AS node,
  changes->>'durationMs'      AS duration_ms,
  changes->>'reason'          AS reason,
  changes->>'sessionOwnerId'  AS owner,
  created_at
FROM audit_logs
WHERE resource_type = 'node_terminal'
ORDER BY created_at DESC
LIMIT 50;
```

What is captured: who, when, which node, session id, duration,
close reason (`client_close` / `idle` / `deadline` / `server_close`
/ `shell_exited` / `error`), source IP, whether a force-close by a
different super-admin happened.

What is NOT captured: keystrokes, command output. Session recording
was operator-rejected by design — the audit row proves a session
happened; reconstructing what was typed during it requires
correlating with cluster-wide logs.

## HA-3 considerations

The session registry lives in-memory per platform-api replica. When
platform-api is scaled beyond one replica, two layers of stickiness
are required so the WebSocket upgrade lands on the replica that
created the session:

1. **Traefik sticky cookie** on the IngressRoute service entry
   (`platform_panel_replica`, set automatically by Traefik). Pins
   the browser to one admin-panel pod.
2. **`Service.sessionAffinity: ClientIP`** on `platform-api`. Pins
   each admin-panel pod's onward traffic to one platform-api pod.

Both are baked into `k8s/base/backend-deployment.yaml` and
`backend/src/modules/system-settings/ingress-reconciler.ts`. The
ConfigMap flip is sufficient; no per-cluster operator action is
required at HA-3 scale.

If the affined replica is rolled (deploy, restart, crash) mid-session,
the WS drops. The modal surfaces a banner + **Reconnect** button which
opens a fresh session (new sessionId, new audit row).

## Disabling in an incident

Set the ConfigMap to `false` and roll platform-api. Any active
sessions die immediately because the routes unregister on next
restart. Manual cleanup of any in-flight privileged Pods:

```bash
kubectl -n platform delete pod \
  -l platform.phoenix-host.net/node-terminal=true \
  --grace-period=5
```

## Troubleshooting

| Symptom                                              | Diagnosis                                                       |
|------------------------------------------------------|-----------------------------------------------------------------|
| "STEP_UP_REQUIRED" 403                               | Last credential check >30 min ago. Re-auth in the modal.       |
| "STEP_UP_UNAVAILABLE" 409                            | Your account is OIDC-only. Enroll a passkey to gain step-up.   |
| "PLATFORM_HOST_UNALLOWED" 500                        | `platform-public-hosts` ConfigMap doesn't list your admin host.|
| "NODE_NOT_READY" 409                                 | The target node's Ready condition isn't True.                  |
| WS opens but closes with code 4404 (REPLICA_MISMATCH) | HA-3 stickiness broken — see "HA replica mismatch" below.     |
| WS opens but closes with code 4404 (SESSION_NOT_FOUND)| Session expired, terminated, or platform-api rolled mid-session.|
| Pod takes >30s to come up                            | Image pull on a cold node. Re-open after ~10s — IfNotPresent.  |
| `cat /proc/1/comm` returns `sleep`                   | Pod not entering host namespaces. CI guard would catch this.   |

## HA replica mismatch (`REPLICA_MISMATCH` 4404)

When platform-api is scaled beyond a single replica, the in-memory
session registry on replica-X is unreachable from replica-Y. The WS
upgrade must land on the same replica that handled the POST. The
fix relies on two layers of stickiness baked into the base manifests:

| Layer                                          | Pins                              |
|------------------------------------------------|-----------------------------------|
| Traefik IngressRoute `services[].sticky.cookie`| browser → one admin-panel pod     |
| `Service.sessionAffinity: ClientIP` (3h TTL)   | admin-panel pod → one platform-api|

If you see `[error] Session lives on platform-api replica 'X' but
this WebSocket landed on 'Y'`, one or both layers isn't in effect.
Verify with:

```bash
# 1. Confirm Service sessionAffinity is applied.
kubectl -n platform get svc platform-api -o jsonpath='{.spec.sessionAffinity}'
# Expect: ClientIP

# 2. Confirm Traefik panel sticky cookie is in the IngressRoute.
kubectl -n platform get ingressroute platform-ingress -o yaml \
  | grep -A5 'services:' | grep -A4 'sticky:'
# Expect: cookie name, secure, httpOnly fields

# 3. List the platform-api pods — if there are multiple, both should
#    be reachable from any admin-panel pod's perspective, but only
#    one should serve any given user/session.
kubectl -n platform get pods -l app=platform-api -o wide
```

If `sessionAffinity` is empty, the manifest hasn't been reconciled
yet — wait for Flux or force the apply:

```bash
kubectl -n platform patch svc platform-api -p \
  '{"spec":{"sessionAffinity":"ClientIP","sessionAffinityConfig":{"clientIP":{"timeoutSeconds":10800}}}}'
```

If the IngressRoute is missing `sticky.cookie`, the
`backend/src/modules/system-settings/ingress-reconciler.ts` writes
that block on every platform-api startup — roll the deployment to
trigger it:

```bash
kubectl -n platform rollout restart deployment/platform-api
```

**Short-term mitigation**: scale platform-api to 1 replica until
both layers are confirmed working. Clicking Reconnect on the dock
pill (or just clicking the Terminal button again) spawns a fresh
session that lands on the current replica.

## Verification

Integration harness (DinD or staging):

```bash
export ADMIN_TOKEN=$(curl -sk -X POST https://admin.<apex>/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@<apex>","password":"<...>"}' \
  | jq -r '.data.token')

# DinD only — set KUBECTL so the harness's psql shells reach the DB:
export KUBECTL='docker exec hosting-platform-k3s-server-1 kubectl'

ADMIN_PASSWORD='<...>' \
API_BASE=https://admin.<apex> \
NAMESPACE=platform \
CURL_INSECURE=1 \
  bash scripts/integration-node-terminal.sh --bump-freshness
```

Expected: **All 21 assertions passed.**

## CI guards

`scripts/ci-node-terminal-check.sh` (Infrastructure CI) enforces 12
invariants on every PR — privileged:true, hostPID:true,
activeDeadlineSeconds, super_admin-only routes, WS handler
panel+role+step-claim checks, log redaction, wsToken TTL, full-UUID
pod name. Any of these regressing fails the build.
