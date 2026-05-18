import { describe, it, expect } from 'vitest';
import {
  buildTerminalPodSpec,
  NSENTER_BASH_ARGV,
  TERMINAL_POD_LABEL,
  TERMINAL_POD_NAMESPACE,
  TERMINAL_POD_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_TERMINAL_IMAGE,
} from './pod-spec.js';

const VALID_NODE = 'staging-control-1';
const VALID_SESSION = '11111111-2222-3333-4444-555555555555';

describe('buildTerminalPodSpec', () => {
  it('names the pod after the session UUID prefix', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    expect(pod.metadata?.name).toBe('node-terminal-11111111');
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

  it('uses imagePullPolicy IfNotPresent + caps resources', () => {
    const pod = buildTerminalPodSpec({ nodeName: VALID_NODE, sessionId: VALID_SESSION });
    const c = pod.spec?.containers?.[0];
    expect(c?.imagePullPolicy).toBe('IfNotPresent');
    expect(c?.resources?.limits).toEqual({ cpu: '500m', memory: '256Mi' });
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

describe('NSENTER_BASH_ARGV', () => {
  it('enters all 5 host namespaces (m,u,i,n,p) — required for full root shell', () => {
    expect(NSENTER_BASH_ARGV.slice(0, 8)).toEqual(['/usr/bin/nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p']);
  });

  it('execs /bin/bash -l so the shell sources /etc/profile + ~/.bashrc', () => {
    const tail = NSENTER_BASH_ARGV.slice(-3);
    expect(tail).toEqual(['--', '/bin/bash', '-l']);
  });
});
