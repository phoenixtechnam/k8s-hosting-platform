import * as k8s from '@kubernetes/client-node';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { createKubeConfig } from '../container-console/service.js';
import { findIdle } from './session-registry.js';
import {
  sweepOrphanPods,
  terminateSession,
  NODE_TERMINAL_IDLE_MS,
  type ServiceCtx,
} from './service.js';

/**
 * 60-second tick that does TWO things:
 *  1. Terminate sessions whose `lastActivityAt` is older than the
 *     idle timeout. Idle = 15min default.
 *  2. Reap labelled Pods that no longer have a registry entry AND
 *     are >5min old (covers platform-api-crashed-mid-create).
 *
 * Both operations are best-effort. Failures are logged via Fastify's
 * logger — they don't crash the tick.
 */
export function startNodeTerminalScheduler(app: FastifyInstance, intervalMs: number = 60_000): () => void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const ctx: ServiceCtx = buildCtx(app);
    // 1) Idle sweep
    try {
      const stale = findIdle(NODE_TERMINAL_IDLE_MS);
      for (const session of stale) {
        // Forge a minimal request shape for the audit writer — the
        // scheduler isn't tied to any specific request. We construct
        // a no-op fastify request that the audit module tolerates.
        const fakeRequest = {
          method: 'INTERNAL',
          url: '/scheduler/idle-sweep',
          ip: '127.0.0.1',
          log: app.log,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        await terminateSession(ctx, session.id, 'idle', fakeRequest).catch((err) => {
          app.log.warn({ err, sessionId: session.id }, 'node-terminal idle terminate failed');
        });
      }
    } catch (err) {
      app.log.warn({ err }, 'node-terminal idle sweep failed');
    }
    // 2) Orphan pod sweep
    try {
      await sweepOrphanPods(ctx);
    } catch (err) {
      app.log.warn({ err }, 'node-terminal orphan sweep failed');
    }
  };

  const handle = setInterval(() => { void tick(); }, intervalMs);
  return () => { stopped = true; clearInterval(handle); };
}

function buildCtx(app: FastifyInstance): ServiceCtx {
  const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
  const kc = createKubeConfig(kubeconfigPath);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  return {
    db: app.db,
    kubeConfig: kc,
    k8sCoreApi: coreApi,
    replicaHost: (app.config as Record<string, unknown>).PLATFORM_API_REPLICA_HOST as string
      ?? os.hostname(),
  };
}
