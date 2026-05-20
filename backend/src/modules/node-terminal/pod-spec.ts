import type * as k8s from '@kubernetes/client-node';

// Label keys are exported so the orphan-sweeper and CI guard can pin
// to the same strings without import-of-magic-string surprises.
export const TERMINAL_POD_LABEL = 'platform.phoenix-host.net/node-terminal';
export const TERMINAL_SESSION_LABEL = 'platform.phoenix-host.net/session-id';
export const TERMINAL_TARGET_NODE_LABEL = 'platform.phoenix-host.net/target-node';

// Namespace + naming. Pods land in the same namespace as platform-api
// so the SA's existing pod-management RBAC suffices.
export const TERMINAL_POD_NAMESPACE = 'platform';
export const TERMINAL_POD_NAME_PREFIX = 'node-terminal-';

// Default image — overridable via NODE_TERMINAL_IMAGE env. The image
// ONLY needs to provide /usr/bin/nsenter and a sleeping process for
// `kubectl exec` to hook into. See images/node-terminal/Dockerfile.
export const DEFAULT_TERMINAL_IMAGE = 'ghcr.io/phoenixtechnam/hosting-platform/node-terminal:latest';

// 1 hour. Hard backstop: even if every other lifecycle guarantee fails
// (platform-api crashes mid-session, WS gets stuck, orphan-sweeper is
// silenced) the k8s control plane evicts the Pod at this deadline.
export const TERMINAL_POD_ACTIVE_DEADLINE_SECONDS = 3600;

export interface BuildTerminalPodSpecInput {
  /** Target k3s node (the Pod is pinned via nodeName). */
  readonly nodeName: string;
  /** Session UUID. Used in pod name + label and to surface in audit logs. */
  readonly sessionId: string;
  /**
   * platform-api Deployment as ownerReference, so the Pod cascades
   * away if platform-api is uninstalled. Optional — when omitted, the
   * orphan sweeper is the only cleanup path (still safe).
   */
  readonly ownerReference?: k8s.V1OwnerReference;
  /** Container image (SHA-pinned in production). */
  readonly image?: string;
}

/**
 * Build the privileged-Pod manifest. Pure function so we can
 * snapshot-test the whole shape without any k8s client setup.
 *
 * Security choices, in priority order:
 *   1. activeDeadlineSeconds — k8s-level kill switch independent of
 *      anything the app does. The single most load-bearing safety
 *      mechanism.
 *   2. ownerReferences — platform-api Deployment is the owner; when
 *      the platform-api itself is uninstalled, every live terminal
 *      Pod cascade-deletes.
 *   3. Specific labels — orphan sweeper + admin observability tools
 *      can list `platform.phoenix-host.net/node-terminal=true` and
 *      verify there are no surprises.
 *   4. automountServiceAccountToken=false — the inside-the-shell user
 *      should not have an SA token; the shell needs root on the host,
 *      not on the cluster API. nsenter into host PID 1 doesn't need it.
 *   5. No initContainers, no volumes (except the implicit emptyDir
 *      tmpfs from /proc). Minimum surface area.
 *
 * NOTE: we DO NOT set `runAsNonRoot:true` or any UID restriction —
 * nsenter into host PID 1 requires CAP_SYS_ADMIN, granted via the
 * privileged securityContext. A CI guard rejects PRs that flip this.
 */
export function buildTerminalPodSpec(input: BuildTerminalPodSpecInput): k8s.V1Pod {
  const image = input.image ?? DEFAULT_TERMINAL_IMAGE;
  // Security finding H3: avoid pod-name collisions in the 8-char
  // UUID prefix space (~4B combinations) by using the FULL UUID.
  // Total length: 14 ("node-terminal-") + 36 = 50 chars, well under
  // the DNS-1123 label cap of 63.
  const podName = `${TERMINAL_POD_NAME_PREFIX}${input.sessionId}`;

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: TERMINAL_POD_NAMESPACE,
      labels: {
        [TERMINAL_POD_LABEL]: 'true',
        [TERMINAL_SESSION_LABEL]: input.sessionId,
        [TERMINAL_TARGET_NODE_LABEL]: input.nodeName,
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'node-terminal',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
      annotations: {
        'platform.phoenix-host.net/created-at': new Date().toISOString(),
      },
      ...(input.ownerReference
        ? { ownerReferences: [input.ownerReference] }
        : {}),
    },
    spec: {
      // Pin to the specific node. The scheduler bypasses normal placement
      // rules when nodeName is set — works on tainted control-plane
      // nodes thanks to the `Exists` tolerations below.
      nodeName: input.nodeName,
      // hostPID lets the container see PID 1 on the host so nsenter
      // can attach to its namespaces. Required for the feature.
      hostPID: true,
      // hostNetwork NOT set — nsenter -n drops us into the host network
      // namespace anyway. Keeping the Pod outside hostNetwork avoids
      // surprising the operator about Pod IP assignment / DNS / etc.
      hostNetwork: false,
      restartPolicy: 'Never',
      // K8s-level kill switch independent of platform-api. See
      // TERMINAL_POD_ACTIVE_DEADLINE_SECONDS above.
      activeDeadlineSeconds: TERMINAL_POD_ACTIVE_DEADLINE_SECONDS,
      // Tolerate ALL taints — operators commonly taint control-plane
      // nodes (NoSchedule). Without this the Pod would Pending on the
      // very nodes that often need the most debugging.
      tolerations: [{ operator: 'Exists' }],
      // priorityClassName left unset on purpose — using
      // system-cluster-critical would preempt tenant Pods, which is
      // not what an interactive debug session should do.
      terminationGracePeriodSeconds: 5,
      // We don't need a SA token inside the shell — every action
      // happens in the HOST namespaces via nsenter, not against the
      // k8s API.
      automountServiceAccountToken: false,
      containers: [
        {
          name: 'shell',
          image,
          imagePullPolicy: 'IfNotPresent',
          // Pause-style sleep. platform-api kubectl-exec's nsenter
          // separately. terminationGracePeriodSeconds: 5 keeps shutdown
          // tight if the session ends.
          command: ['/bin/sh', '-c', 'sleep 3600'],
          securityContext: {
            // The whole reason the feature works. CAP_SYS_ADMIN
            // (granted via privileged: true) is required for nsenter
            // -t 1 -m -u -i -n -p -- ... to enter the host's
            // namespaces. CI guard rejects PRs that flip this.
            privileged: true,
            runAsUser: 0,
            allowPrivilegeEscalation: true,
          },
          // Tight resource caps. The pod's container process is
          // just `sleep 3600` — the actual bash shell runs in the
          // host's PID namespace via `kubectl exec nsenter`, so the
          // accounting for shell processes lives outside this cgroup
          // (host kernel cgroups). Minimal limits suffice and keep
          // the terminal Pod from eating the platform quota.
          resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: { cpu: '100m', memory: '64Mi' },
          },
        },
      ],
    },
  };
}

/**
 * The argv vector platform-api passes to `kubectl exec`. Exported so
 * the exec call-site and tests stay in sync.
 *
 * Tries `/bin/bash -l` first (full creature comforts: PS1, history,
 * tab-completion); falls back to `/bin/sh -l` for Alpine-based hosts
 * (k3s itself, busybox images, embedded distros) that don't ship bash.
 * The `exec` keeps the shell as PID 1 inside the nsenter pid-ns so
 * exit propagates cleanly.
 */
/**
 * Build the argv vector platform-api passes to `kubectl exec` for a
 * given sessionId. Per-session because we use the sessionId as the
 * tmux session name — same sessionId across reconnects = SAME shell
 * process with history + scrollback + any in-flight commands intact.
 *
 * Lifecycle:
 *   • First exec for a sessionId → tmux creates session 'nt-<uuid>'
 *     and spawns bash inside it.
 *   • Subsequent exec (reload, Reconnect button, network blip) →
 *     tmux attaches to the existing session. Shell state preserved.
 *   • Pod deletion → tmux server dies with the Pod → session gone.
 *
 * Falls back to plain bash with `history -a; history -n` on every
 * prompt when tmux isn't installed on the host (rare on Tier-1
 * distros; covers Alpine k3s images where tmux is not default).
 * That fallback only preserves bash HISTORY across reconnects, not
 * scrollback or running processes.
 */
export function buildNsenterArgv(sessionId: string): readonly string[] {
  // The sessionId is interpolated into a sh -c command, so we MUST
  // reject anything that could escape the single-quoted tmux name and
  // run arbitrary shell. UUIDs from the route layer are safe; this
  // belt-and-braces check stops a future caller from passing
  // unsanitised input. Allowed: alphanumerics, dash, underscore.
  // Tmux itself permits more (e.g. `.`) but we don't need them.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
    throw new Error(`buildNsenterArgv: invalid sessionId shape: ${sessionId}`);
  }
  const tmuxName = `nt-${sessionId}`;
  // Architecture: tmux runs INSIDE the Pod's alpine container
  // (where it's bundled). Each tmux pane spawns the actual host
  // shell via nsenter. Tmux preserves the pane's process across
  // detach/reattach cycles — so reconnecting hits the SAME nsenter'd
  // shell with history, scrollback, and any running commands intact.
  //
  // Why tmux-in-Pod (not on host): tmux on the host would require
  // tmux + dynamic libs installed there. Production hosts get this
  // via bootstrap.sh (apt/dnf install tmux), but DinD/stripped k3s
  // images don't have a package manager. Putting tmux INSIDE the
  // alpine Pod (which we control) sidesteps the host-dep issue
  // entirely — every cluster gets continuity for free.
  //
  // The pane's shell is the nsenter command. When the user types
  // commands, they hit the HOST's PID 1 namespaces — same root
  // shell behaviour as before, just managed by tmux.
  //
  // Fallback: if tmux ever goes missing from the Pod image (build
  // regression), fall back to plain nsenter+bash. No continuity in
  // that path; CI guard catches the omission.
  const nsenterShellCmd =
    // Inside the host's namespaces — prefer bash for history, fall
    // back to sh. PROMPT_COMMAND keeps an on-disk history file in
    // sync per session so even if tmux somehow loses the pane, the
    // history file survives.
    'export TERM=xterm-256color; '
    + `export HISTFILE=/tmp/.bash_history-${sessionId}; `
    + 'if [ -x /bin/bash ]; then '
    +   "export PROMPT_COMMAND='history -a'; "
    +   'exec /bin/bash -l; '
    + 'fi; '
    + 'exec /bin/sh -l';

  const tmuxLauncher =
    'if command -v tmux >/dev/null 2>&1; then '
    +   `exec tmux new-session -A -s '${tmuxName}' `
    +     `/usr/bin/nsenter -t 1 -m -u -i -n -p -- /bin/sh -c '${nsenterShellCmd.replace(/'/g, `'\\''`)}'; `
    + 'fi; '
    // tmux missing in the Pod image (shouldn't happen — CI guard
    // catches it). Fall back to direct nsenter; no continuity.
    + `exec /usr/bin/nsenter -t 1 -m -u -i -n -p -- /bin/sh -c '${nsenterShellCmd.replace(/'/g, `'\\''`)}'`;

  return [
    // Run as /bin/sh INSIDE the Pod (alpine) so we can locate tmux
    // and orchestrate the tmux+nsenter pipeline. The host shell
    // proper still runs in PID 1's namespaces via tmux's pane process.
    '/bin/sh',
    '-c',
    tmuxLauncher,
  ];
}

/**
 * Backwards-compatibility alias for code that doesn't yet pass a
 * sessionId. Tests + spike scripts use this. Production attachExec
 * always uses buildNsenterArgv with the real sessionId so tmux
 * persistence kicks in.
 *
 * @deprecated Use buildNsenterArgv(sessionId) for per-session tmux.
 */
export const NSENTER_BASH_ARGV: readonly string[] = [
  '/usr/bin/nsenter',
  '-t', '1',
  '-m', '-u', '-i', '-n', '-p',
  '--',
  '/bin/sh',
  '-c',
  'export TERM=xterm-256color; { [ -x /bin/bash ] && exec /bin/bash -l; } ; exec /bin/sh -l',
];
