import { Writable } from 'node:stream';
import { Exec, KubeConfig } from '@kubernetes/client-node';

/**
 * Shared `kubectl exec` helper for in-cluster commands. Centralised so
 * deployments/db-manager, postgres-restore, and any other module that
 * needs to shell into a pod uses the same Exec wiring + stream-flush
 * sequencing (the status callback can fire before stdout is fully
 * drained, hence the dual-finish pattern).
 *
 * Usage:
 *   const r = await execInPod(kubeconfigPath, ns, pod, 'postgres',
 *     ['psql', '-tAc', 'SELECT 1']);
 *   r.stdout, r.stderr, r.exitCode
 */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kc = new KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromDefault();
  return kc;
}

export async function execInPod(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  command: readonly string[],
): Promise<ExecResult> {
  const kc = loadKubeConfig(kubeconfigPath);
  const exec = new Exec(kc);
  let stdout = '';
  let stderr = '';
  const stdoutStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) { stdout += chunk.toString(); cb(); },
  });
  const stderrStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) { stderr += chunk.toString(); cb(); },
  });

  let statusError: Error | null = null;
  let exitCode = 0;
  await new Promise<void>((resolve, reject) => {
    let statusDone = false; let stdoutDone = false; let stderrDone = false;
    const tryResolve = (): void => {
      if (statusDone && stdoutDone && stderrDone) {
        if (statusError) reject(statusError); else resolve();
      }
    };
    stdoutStream.on('finish', () => { stdoutDone = true; tryResolve(); });
    stderrStream.on('finish', () => { stderrDone = true; tryResolve(); });

    exec.exec(
      namespace, podName, containerName,
      command as string[],
      stdoutStream, stderrStream, null, false,
      (status) => {
        const s = status as Record<string, unknown> | undefined;
        if (!s || s.status === 'Success' || s.status === undefined) {
          exitCode = 0;
        } else {
          // Failure — extract the exit code from causes if present
          exitCode = 1;
          const details = s.details as { causes?: Array<{ reason?: string; message?: string }> } | undefined;
          const exitCodeCause = details?.causes?.find((c) => c.reason === 'ExitCode');
          if (exitCodeCause?.message) {
            const parsed = parseInt(exitCodeCause.message, 10);
            if (Number.isFinite(parsed)) exitCode = parsed;
          }
        }
        stdoutStream.end();
        stderrStream.end();
        statusDone = true;
        tryResolve();
      },
    ).catch((err: Error) => {
      // The status callback never fires in this path — end both streams
      // ourselves so `tryResolve` can complete (otherwise the Promise
      // hangs forever). End() flushes any pending writes and triggers
      // the 'finish' event, which sets stdoutDone/stderrDone.
      statusError = err;
      stdoutStream.end();
      stderrStream.end();
      statusDone = true;
      tryResolve();
    });
  });
  return { stdout, stderr, exitCode };
}
