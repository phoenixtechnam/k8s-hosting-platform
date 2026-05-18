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
export const NSENTER_BASH_ARGV: readonly string[] = [
  '/usr/bin/nsenter',
  '-t', '1',
  '-m', // mount namespace
  '-u', // UTS namespace
  '-i', // IPC namespace
  '-n', // network namespace
  '-p', // PID namespace
  '--',
  '/bin/sh',
  '-c',
  // Try bash, fall back to sh. `exec` replaces the shell entirely
  // when the target exists; the `command -v` check avoids the
  // "exec: not found → exit 127" failure mode that swallows the
  // fallback when /bin/bash is missing (k3s, busybox, embedded).
  '{ [ -x /bin/bash ] && exec /bin/bash -l; } ; exec /bin/sh -l',
];
