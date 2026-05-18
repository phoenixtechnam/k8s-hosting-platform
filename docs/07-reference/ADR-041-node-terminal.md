# ADR-041: Admin Web-Terminal — Privileged Root Shell on Cluster Nodes

**Status:** Accepted (2026-05-18)
**Author:** Sebastian Buchweitz

## Context

Operators occasionally need a root shell on a specific k3s node — to
inspect kubelet logs, run `nft list ruleset`, check a stuck mount, or
recover from a state that platform automation can't reach. The
historical options were:

1. SSH into the node. Requires SSH keys distributed to every joined
   host, an open port 22 (the cluster-firewall mode `cidr` scopes 22
   to the mesh; `set`/`single` modes are stricter), and bypasses the
   platform audit log entirely.
2. `kubectl debug node/<name>` from an operator workstation. Requires
   a working kubeconfig + cluster network access from the laptop +
   knowing the right `nsenter` invocation. Not auditable.
3. Maintain a separate bastion host. Operationally heavy; another
   piece of infrastructure to patch.

None of these scale with the operating model: a super-admin who's
already logged into the admin panel, sees something broken, and wants
to investigate without context-switching to a terminal.

## Decision

Add a "Terminal" button to every Ready node card in
`/nodes-and-storage`. Clicking it opens a modal with an `xterm.js`-
rendered shell. The backend spawns a one-shot privileged Pod on the
target node and `kubectl exec`s `nsenter -t 1 -m -u -i -n -p --` into
PID 1 host namespaces. Modal close → privileged Pod deleted within
10s. Every keystroke connection lifecycle is logged to `audit_logs`.

### Mechanism (load-bearing)

The privileged-Pod spec
([`backend/src/modules/node-terminal/pod-spec.ts`](../../backend/src/modules/node-terminal/pod-spec.ts)):

```yaml
spec:
  nodeName: <target>          # scheduler bypass — works on tainted control-plane
  hostPID: true               # see host PID 1
  hostNetwork: false          # nsenter -n swaps netns anyway
  restartPolicy: Never
  activeDeadlineSeconds: 3600 # k8s-level kill switch independent of app
  tolerations: [operator: Exists]
  automountServiceAccountToken: false
  containers:
    - name: shell
      image: ghcr.io/.../node-terminal:<sha>
      command: [/bin/sh, -c, "sleep 3600"]
      securityContext:
        privileged: true       # CAP_SYS_ADMIN — required for nsenter
        runAsUser: 0
      resources:
        limits:  { cpu: 100m, memory: 64Mi }
```

The container's PID 1 is `sleep`. Platform-api `kubectl exec`s into the
container with:

```
/usr/bin/nsenter -t 1 -m -u -i -n -p --
  /bin/sh -c '[ -x /bin/bash ] && exec /bin/bash -l ; exec /bin/sh -l'
```

The shell runs in the **host's** namespaces. Inside the shell:
`whoami` → `root`; `hostname` → the node's hostname;
`cat /proc/1/comm` → `k3s` / `kubelet` / `systemd` (NOT `sleep`).

### Authorization (defence in depth)

1. **Role gate:** `super_admin` ONLY. Defended by `authenticate +
   requirePanel('admin') + requireRole('super_admin')` on every route.
   The WS handler re-checks role + panel after the JWT verify in case
   a future hook reorder skips the gate.
2. **Step-up freshness:** `users.last_credential_check_at` must be
   within the last 30 minutes. Every successful credential challenge
   (password login, passkey verify, OIDC login, step-up endpoints)
   bumps the timestamp. OIDC-only users with no local credential get
   `STEP_UP_UNAVAILABLE 409`.
3. **WS token:** every session ships with a 256-bit
   ([`randomBytes(32)`](../../backend/src/modules/node-terminal/service.ts))
   single-use token bound to the sessionId. 60s TTL — burned on first
   consume OR expiry. Constant-time compared. Token is redacted from
   Pino access logs.
4. **Host allowlist:** `publicWssOrigin` constructs the wsUrl from the
   Host header, validated against `CORS_ORIGINS + PLATFORM_PUBLIC_HOSTS`.
   No X-Forwarded-Host spoofing.

### Lifecycle (no orphans)

A terminal Pod's death is triggered by, in priority order:

1. **Modal close → DELETE → service.terminateSession** (normal path).
2. **WS drop → server-side finalize** (close/error/stderr-end/stdout-end).
3. **Idle 15min** — `session-registry.findIdle` + scheduler tick.
4. **`activeDeadlineSeconds: 3600`** — k8s evicts. Hard cap.
5. **Orphan sweeper** — 60s scheduler tick lists pods labelled
   `platform.phoenix-host.net/node-terminal=true` whose `sessionId`
   label isn't in the in-memory registry AND were created >5min ago.

### Audit

Every action goes to `audit_logs` with `resource_type='node_terminal'`:

| action_type                              | When                                       |
|------------------------------------------|--------------------------------------------|
| `node_terminal.session.create.attempt`   | BEFORE Pod creation (proves user-intent)   |
| `node_terminal.session.create.success`   | After Pod Ready + session registered       |
| `node_terminal.session.create.failed`    | Step-up required, node not ready, k8s err  |
| `node_terminal.session.ws.attached`      | WS upgrade consumes the wsToken             |
| `node_terminal.session.ws.rejected`      | Token invalid, owner mismatch              |
| `node_terminal.session.closed`           | Pod deleted; carries reason + durationMs   |

Audit rows carry the **acting user** (`actor_id`) AND the **session
owner** (`changes.sessionOwnerId`) separately, so a super-admin
force-closing another super-admin's session is traceable.

### HA-3 stickiness

The in-memory session registry lives per-replica. End-to-end pinning:

```
browser → (Traefik IngressRoute sticky cookie) → admin-panel-pod-X
       → (Service sessionAffinity ClientIP)    → platform-api-pod-Y
```

- `platform_panel_replica` cookie set by Traefik on the panel routes
  pins the browser to one admin-panel pod for ~30 days.
- `platform-api` Service's `sessionAffinity: ClientIP` (3h timeout)
  pins each admin-panel pod's onward traffic to one platform-api pod.

Without this chain, scaling either tier beyond 1 replica would
silently break WS upgrades (the upgrade lands on a replica that
doesn't have the in-memory session, returning 4404).

## Consequences

### Positive

- Operators get root on any node from inside the admin panel with
  audit trail.
- No SSH key rotation on every join — the only auth boundary is the
  k8s API server + kubelet.
- 30-min freshness window means a fresh login → immediate terminal
  with no extra prompt; a 2h-old session → step-up prompt.
- All cleanup paths converge: modal close, server idle, k8s
  activeDeadlineSeconds, orphan sweeper.

### Negative

- A super-admin token = root on every node. This is by design (we
  trust super-admins), but the audit log + 30-min step-up shrink the
  blast radius of a stolen token.
- HA-3 stickiness uses cookie + ClientIP affinity at two hops; a
  rolling restart of the affined replica drops the session (user
  clicks "Reconnect" to spawn a fresh one).
- Container ephemeral image pull adds ~3-5s to first-modal-open on a
  given node before the image is cached. Pre-pull DaemonSet deferred.

### Rejected alternatives

- **SSH bastion**: keeps SSH config sprawl on every node; bypasses
  audit.
- **WireGuard mesh + SSH-via-mesh**: still requires SSH ports and
  key management; doesn't give pod-level isolation.
- **Long-lived DaemonSet agent**: would mean a permanently privileged
  Pod on every node, even when idle. The ephemeral Pod model has
  attack surface only while sessions are open.
- **Session recording (asciicast)**: operator declined. Audit log
  has actor/node/start/end/durationMs but NOT keystrokes/output.

## Implementation map

| Concern             | Path                                                                                 |
|---------------------|--------------------------------------------------------------------------------------|
| Pod spec builder    | `backend/src/modules/node-terminal/pod-spec.ts`                                       |
| Session registry    | `backend/src/modules/node-terminal/session-registry.ts`                               |
| Service             | `backend/src/modules/node-terminal/service.ts`                                        |
| HTTP + WS routes    | `backend/src/modules/node-terminal/routes.ts`                                         |
| Orphan sweeper      | `backend/src/modules/node-terminal/scheduler.ts`                                      |
| Audit writer        | `backend/src/modules/node-terminal/audit.ts`                                          |
| Step-up primitive   | `backend/src/modules/auth/step-up-{service,routes}.ts` + migration 0009               |
| API contracts       | `packages/api-contracts/src/{node-terminal,step-up}.ts`                               |
| Container image     | `images/node-terminal/Dockerfile`                                                     |
| Frontend hook       | `frontend/admin-panel/src/hooks/use-node-terminal.ts`                                 |
| Frontend modal      | `frontend/admin-panel/src/components/NodeTerminalModal.tsx`                           |
| Terminal button     | `frontend/admin-panel/src/pages/ClusterNodes.tsx`                                     |
| Integration harness | `scripts/integration-node-terminal.sh` (21 assertions)                                |
| CI guard            | `scripts/ci-node-terminal-check.sh` (12 invariants)                                   |
| HA stickiness       | `Service.sessionAffinity: ClientIP` + Traefik `services[].sticky.cookie`              |

## Operator runbook

See [docs/02-operations/NODE_TERMINAL.md](../02-operations/NODE_TERMINAL.md).
