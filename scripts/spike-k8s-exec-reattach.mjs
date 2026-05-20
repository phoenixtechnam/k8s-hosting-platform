#!/usr/bin/env node
/**
 * P0 spike for ADR-041 follow-up: verify k8s exec re-attach semantics.
 *
 * The DB-backed session refactor rests on the assumption that a SECOND
 * `Exec.exec()` call into a TTY container (while a first exec stream is
 * still active) succeeds with its own independent PTY — letting any
 * platform-api replica re-attach to a long-lived terminal Pod.
 *
 * This script tests that assumption against the local DinD cluster.
 *
 * Steps:
 *   1. Create a privileged Pod (hostPID + privileged, mimicking
 *      pod-spec.ts) running `sleep 3600`.
 *   2. Wait for Running.
 *   3. Open exec stream A: nsenter→bash, send `echo HELLO_FROM_A_$$`.
 *      Keep it open for the duration.
 *   4. While A is still open, open exec stream B against the SAME
 *      Pod/container. Send `echo HELLO_FROM_B_$$`.
 *   5. Observe what each stream receives — independent PTYs (expected)
 *      or one steals from the other.
 *   6. Cleanup: delete Pod.
 *
 * Run inside the DinD container so kubectl + k8s client SDK both talk
 * to the local cluster:
 *   docker exec -i hosting-platform-k3s-server-1 sh -c \
 *     'cd /tmp && node spike-k8s-exec-reattach.mjs'
 *
 * Or on the workspace host with KUBECONFIG pointing at the dind cluster.
 */
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';

const NS = 'default';
const POD = `spike-exec-reattach-${Date.now()}`;
const IMAGE = process.env.IMAGE
  ?? 'ghcr.io/phoenixtechnam/hosting-platform/node-terminal:latest';

const kc = new k8s.KubeConfig();
if (process.env.KUBECONFIG_PATH) kc.loadFromFile(process.env.KUBECONFIG_PATH);
else if (process.env.IN_CLUSTER === '1') kc.loadFromCluster();
else kc.loadFromDefault();
const core = kc.makeApiClient(k8s.CoreV1Api);
const exec = new k8s.Exec(kc);

const log = (...a) => console.log('[spike]', ...a);

async function createPod() {
  const body = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: POD,
      labels: { 'platform.phoenix-host.net/spike': 'exec-reattach' },
    },
    spec: {
      hostPID: true,
      restartPolicy: 'Never',
      activeDeadlineSeconds: 600,
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      containers: [{
        name: 'shell',
        image: IMAGE,
        imagePullPolicy: 'IfNotPresent',
        command: ['/bin/sh', '-c', 'sleep 600'],
        securityContext: { privileged: true, runAsUser: 0 },
        resources: {
          requests: { cpu: '10m', memory: '32Mi' },
          limits: { cpu: '100m', memory: '64Mi' },
        },
      }],
    },
  };
  log('creating pod', POD);
  await core.createNamespacedPod({ namespace: NS, body });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const p = await core.readNamespacedPod({ namespace: NS, name: POD });
    if (p?.status?.phase === 'Running') { log('pod Running'); return; }
    if (['Failed', 'Succeeded'].includes(p?.status?.phase ?? '')) {
      throw new Error(`pod entered ${p.status.phase} before Running`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('pod did not reach Running in 60s');
}

async function deletePod() {
  log('deleting pod', POD);
  await core.deleteNamespacedPod({ namespace: NS, name: POD, gracePeriodSeconds: 0 })
    .catch((e) => log('delete failed (ignored):', e?.message ?? e));
}

/** Open an exec stream and return { ws, write, output: Promise<string> } */
async function openExec(label) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let buffer = '';
  stdout.on('data', (c) => { buffer += c.toString(); });
  stderr.on('data', (c) => { buffer += `[stderr]${c.toString()}`; });
  log(`[${label}] opening exec…`);
  const argv = [
    '/usr/bin/nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
    '/bin/sh', '-c', 'export TERM=xterm-256color; exec /bin/sh -l',
  ];
  const ws = await exec.exec(NS, POD, 'shell', argv, stdout, stderr, stdin, true);
  log(`[${label}] exec stream opened`);
  return {
    ws,
    write: (data) => stdin.write(data),
    snapshot: () => buffer,
  };
}

(async () => {
  try {
    await createPod();
    log('---');
    log('TEST 1: open A, wait for prompt');
    const A = await openExec('A');
    await new Promise(r => setTimeout(r, 1500));
    A.write('echo HELLO_FROM_A_PID_$$\n');
    await new Promise(r => setTimeout(r, 1500));
    log('A snapshot after first echo:');
    console.log(A.snapshot());

    log('---');
    log('TEST 2: open B against the SAME Pod/container while A still alive');
    const B = await openExec('B');
    await new Promise(r => setTimeout(r, 1500));
    B.write('echo HELLO_FROM_B_PID_$$\n');
    await new Promise(r => setTimeout(r, 1500));
    log('B snapshot after first echo:');
    console.log(B.snapshot());

    log('---');
    log('TEST 3: write to both streams concurrently, check isolation');
    A.write('echo A_AFTER_B_$$\n');
    B.write('echo B_AFTER_A_$$\n');
    await new Promise(r => setTimeout(r, 1500));
    log('A snapshot:');
    console.log(A.snapshot());
    log('B snapshot:');
    console.log(B.snapshot());

    log('---');
    log('TEST 4: close A, verify B still works');
    try { A.ws.close?.(); } catch {}
    await new Promise(r => setTimeout(r, 500));
    B.write('echo B_AFTER_A_CLOSED_$$\n');
    await new Promise(r => setTimeout(r, 1500));
    log('B snapshot after A closed:');
    console.log(B.snapshot());

    log('---');
    log('VERDICT inputs above — see EOF for summary');
  } catch (e) {
    log('SPIKE FAILED:', e?.stack ?? e);
    process.exitCode = 1;
  } finally {
    await deletePod();
  }
})();
