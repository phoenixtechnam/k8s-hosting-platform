/**
 * Shared `cscli` exec helper — used by the CrowdSec decisions
 * (crowdsec.ts) AND allowlist (crowdsec-allowlists.ts) modules.
 *
 * Race-safe WebSocket close: timer + Promise can resolve in either
 * order, so we use a shared `done` flag and a holder pattern that
 * closes the connection in the .then() if the timer already fired.
 */

import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';

const CROWDSEC_NAMESPACE = 'crowdsec';
const CROWDSEC_CONTAINER = 'crowdsec';
const CSCLI_EXEC_TIMEOUT_MS = 15_000;

export async function findCrowdsecPodName(kc: k8s.KubeConfig): Promise<string> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const pods = await (core as unknown as {
    listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
      items: { metadata?: { name?: string }; status?: { phase?: string } }[];
    }>;
  }).listNamespacedPod({
    namespace: CROWDSEC_NAMESPACE,
    labelSelector: 'app.kubernetes.io/name=crowdsec',
  });
  const running = (pods.items ?? []).find((p) => p.status?.phase === 'Running' && p.metadata?.name);
  if (!running?.metadata?.name) {
    throw new Error(`No Running pod found for app.kubernetes.io/name=crowdsec in ${CROWDSEC_NAMESPACE}`);
  }
  return running.metadata.name;
}

export async function cscliExec(
  kc: k8s.KubeConfig,
  podName: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const exec = new k8s.Exec(kc);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  let done = false;
  let timer: NodeJS.Timeout | null = null;
  const wsHolder: { conn: { close?: () => void } | null } = { conn: null };
  let deferredResolve!: (v: { stdout: string; stderr: string }) => void;
  let deferredReject!: (e: Error) => void;
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });

  const finish = (err: Error | null, value?: { stdout: string; stderr: string }) => {
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    try { wsHolder.conn?.close?.(); } catch { /* swallow */ }
    if (err) deferredReject(err); else deferredResolve(value as { stdout: string; stderr: string });
  };

  timer = setTimeout(() => {
    finish(new Error(`cscli exec timed out after ${CSCLI_EXEC_TIMEOUT_MS}ms`));
  }, CSCLI_EXEC_TIMEOUT_MS);

  exec.exec(
    CROWDSEC_NAMESPACE,
    podName,
    CROWDSEC_CONTAINER,
    ['cscli', ...args],
    stdout,
    stderr,
    null,
    false,
    (status) => {
      const so = Buffer.concat(stdoutChunks).toString('utf-8');
      const se = Buffer.concat(stderrChunks).toString('utf-8');
      if (status.status === 'Success') {
        finish(null, { stdout: so, stderr: se });
      } else {
        finish(new Error(`cscli ${args.join(' ')} failed: ${status.message ?? status.status} stderr=${se}`));
      }
    },
  ).then((conn) => {
    const handle = conn as unknown as { close?: () => void };
    if (done) {
      try { handle.close?.(); } catch { /* swallow */ }
      return;
    }
    wsHolder.conn = handle;
  }).catch((err) => {
    finish(err instanceof Error ? err : new Error(String(err)));
  });

  return result;
}
