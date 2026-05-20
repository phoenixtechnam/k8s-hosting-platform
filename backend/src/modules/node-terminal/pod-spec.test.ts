import { describe, it, expect } from 'vitest';
import {
  buildTerminalPodSpec,
  buildNsenterArgv,
  NSENTER_BASH_ARGV,
  TERMINAL_POD_LABEL,
  TERMINAL_POD_NAMESPACE,
  TERMINAL_POD_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_TERMINAL_IMAGE,
} from './pod-spec.js';

const VALID_NODE = 'staging-control-1';
const VALID_SESSION = '11111111-2222-3333-4444-555555555555';

describe('buildTerminalPodSpec', () => {
  it('names the pod after the FULL session UUID (no collision via 8-char prefix)', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.metadata?.name).toBe(`node-terminal-${VALID_SESSION}`);
    // DNS-1123 label cap is 63 chars
    expect(pod.metadata!.name!.length).toBeLessThanOrEqual(63);
  });

  it('lands in the platform namespace', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.metadata?.namespace).toBe(TERMINAL_POD_NAMESPACE);
    expect(TERMINAL_POD_NAMESPACE).toBe('platform');
  });

  it('labels the pod for orphan-sweeper + observability', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.metadata?.labels?.[TERMINAL_POD_LABEL]).toBe('true');
    expect(pod.metadata?.labels?.['platform.phoenix-host.net/session-id']).toBe(VALID_SESSION);
    expect(pod.metadata?.labels?.['platform.phoenix-host.net/target-node']).toBe(VALID_NODE);
  });

  it('pins to the target node via spec.nodeName', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.nodeName).toBe(VALID_NODE);
  });

  it('uses hostPID:true so nsenter can attach to host PID 1', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.hostPID).toBe(true);
  });

  it('does NOT enable hostNetwork (nsenter -n handles netns swap)', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.hostNetwork).toBe(false);
  });

  it('runs the shell container as privileged root with allowPrivilegeEscalation', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    const c = pod.spec?.containers?.[0];
    expect(c?.securityContext?.privileged).toBe(true);
    expect(c?.securityContext?.runAsUser).toBe(0);
    expect(c?.securityContext?.allowPrivilegeEscalation).toBe(true);
  });

  it('NEVER sets runAsNonRoot=true (would break nsenter — CI guard checks this)', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    const c = pod.spec?.containers?.[0];
    expect(c?.securityContext?.runAsNonRoot).toBeUndefined();
  });

  it('sets activeDeadlineSeconds = 3600 (1h hard backstop)', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.activeDeadlineSeconds).toBe(3600);
    expect(TERMINAL_POD_ACTIVE_DEADLINE_SECONDS).toBe(3600);
  });

  it('tolerates ALL taints so control-plane nodes are reachable', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.tolerations).toEqual([{ operator: 'Exists' }]);
  });

  it('disables SA-token automount (shell does not need k8s API access)', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
  });

  it('uses Never restart policy + 5s grace', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.restartPolicy).toBe('Never');
    expect(pod.spec?.terminationGracePeriodSeconds).toBe(5);
  });

  it('uses imagePullPolicy IfNotPresent + tight resource caps', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    const c = pod.spec?.containers?.[0];
    expect(c?.imagePullPolicy).toBe('IfNotPresent');
    expect(c?.resources?.limits).toEqual({ cpu: '100m', memory: '64Mi' });
  });

  it('uses the default image when none is provided', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.containers?.[0].image).toBe(DEFAULT_TERMINAL_IMAGE);
  });

  it('honours a custom image override', () => {
    const pod = buildTerminalPodSpec({
      nodeName: VALID_NODE,
      sessionId: VALID_SESSION,
      image: 'ghcr.io/example/custom-terminal:abc123',
    });
    expect(pod.spec?.containers?.[0].image).toBe('ghcr.io/example/custom-terminal:abc123');
  });

  it('attaches an ownerReference when supplied', () => {
    const pod = buildTerminalPodSpec({
      nodeName: VALID_NODE,
      sessionId: VALID_SESSION,
      ownerReference: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'platform-api',
        uid: 'parent-uid',
        controller: true,
      },
    });
    expect(pod.metadata?.ownerReferences?.[0].name).toBe('platform-api');
  });

  it('runs `sleep` as the container PID 1 — nsenter is exec\'d separately by platform-api', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.spec?.containers?.[0].command).toEqual(['/bin/sh', '-c', 'sleep 3600']);
  });
});

describe('NSENTER_BASH_ARGV (deprecated; kept for fallback callers)', () => {
  it('enters all 5 host namespaces (m,u,i,n,p) — required for full root shell', () => {
    expect(NSENTER_BASH_ARGV.slice(0, 8)).toEqual(['/usr/bin/nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p']);
  });

  it('falls back from bash to sh so alpine-based hosts work', () => {
    const argv = NSENTER_BASH_ARGV;
    expect(argv).toContain('--');
    const idx = argv.indexOf('--');
    expect(argv[idx + 1]).toBe('/bin/sh');
    expect(argv[idx + 2]).toBe('-c');
    expect(argv[idx + 3]).toMatch(/\[ -x \/bin\/bash \].*exec \/bin\/bash.*exec \/bin\/sh/);
  });
});

describe('buildNsenterArgv (per-session, tmux-in-Pod)', () => {
  const VALID = '11111111-2222-3333-4444-555555555555';

  it('runs /bin/sh inside the Pod (not nsenter directly) so it can find tmux', () => {
    const argv = buildNsenterArgv(VALID);
    // The outer command runs inside the Pod's alpine container; that's
    // where tmux is bundled. tmux's pane process is the nsenter command.
    expect(argv[0]).toBe('/bin/sh');
    expect(argv[1]).toBe('-c');
  });

  it('uses tmux new-session -A to attach-or-create the per-session tmux', () => {
    const argv = buildNsenterArgv(VALID);
    const cmd = argv[argv.length - 1] as string;
    // -A = "attach if exists, else create" — load-bearing for reconnects
    // landing in the SAME tmux pane = SAME nsenter'd host shell.
    expect(cmd).toMatch(/tmux new-session -A -s 'nt-11111111-2222-3333-4444-555555555555'/);
  });

  it("tmux pane invokes nsenter into PID 1's host namespaces (m,u,i,n,p)", () => {
    const argv = buildNsenterArgv(VALID);
    const cmd = argv[argv.length - 1] as string;
    // Same 5-namespace enter as the legacy direct path.
    expect(cmd).toMatch(/nsenter -t 1 -m -u -i -n -p --/);
  });

  it('inside the host shell, sets HISTFILE scoped to this sessionId', () => {
    const argv = buildNsenterArgv(VALID);
    const cmd = argv[argv.length - 1] as string;
    expect(cmd).toMatch(/HISTFILE=\/tmp\/\.bash_history-11111111-2222-3333-4444-555555555555/);
  });

  it('prefers bash and flushes history on every prompt', () => {
    const argv = buildNsenterArgv(VALID);
    const cmd = argv[argv.length - 1] as string;
    // The inner shell command is single-quoted INSIDE the outer
    // sh -c, so its own single quotes are escaped as '\''. Match
    // the semantic content (PROMPT_COMMAND + history -a) without
    // pinning the exact escape sequence.
    expect(cmd).toMatch(/PROMPT_COMMAND=.*history -a/);
    expect(cmd).toMatch(/exec \/bin\/bash -l/);
  });

  it('exports TERM=xterm-256color for the host shell', () => {
    const argv = buildNsenterArgv(VALID);
    const cmd = argv[argv.length - 1] as string;
    expect(cmd).toMatch(/TERM=xterm-256color/);
  });

  it('falls back to direct nsenter when tmux missing from the Pod image', () => {
    const argv = buildNsenterArgv(VALID);
    const cmd = argv[argv.length - 1] as string;
    expect(cmd).toMatch(/if command -v tmux/);
    // Both branches MUST end with an nsenter invocation. The tmux
    // branch nsenter is inside `tmux new-session ... nsenter ...`;
    // the fallback nsenter is at top level after `fi;`. Count
    // occurrences: two distinct nsenter calls.
    const nsenterCount = (cmd.match(/\/usr\/bin\/nsenter/g) ?? []).length;
    expect(nsenterCount).toBeGreaterThanOrEqual(2);
  });

  it('rejects sessionId values containing shell metacharacters', () => {
    expect(() => buildNsenterArgv("'; rm -rf /; '")).toThrow(/invalid sessionId/);
    expect(() => buildNsenterArgv('../../etc/passwd')).toThrow(/invalid sessionId/);
    expect(() => buildNsenterArgv('$(id)')).toThrow(/invalid sessionId/);
  });

  it('embeds the full UUID in the tmux session name (no prefix collision)', () => {
    const argv = buildNsenterArgv(VALID);
    const cmd = argv[argv.length - 1] as string;
    expect(cmd).toContain(VALID);
  });
});
