import * as k8s from '@kubernetes/client-node';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { createKubeConfig } from '../container-console/service.js';
import * as sessionStore from './session-store.js';
import {
  sweepOrphanPods,
  terminateSession,
  NODE_TERMINAL_IDLE_MS,
  type ServiceCtx,
} from './service.js';

/**
 * 60-second tick that does three things — all DB-backed so any
 * platform-api replica can sweep any session cluster-wide:
 *  1. Terminate sessions whose `last_activity_at` is older than the
 *     idle timeout (15min default).
 *  2. Terminate sessions whose `expires_at` has elapsed (1h cap,
 *     belt-and-braces with k8s activeDeadlineSeconds).
 *  3. Reap labelled Pods that no longer have a DB row AND are
 *     >5min old (covers platform-api-crashed-mid-create).
 *
 * All operations are best-effort. Failures are logged via Fastify's
 * logger — they don't crash the tick.
 */
export function startNodeTerminalScheduler(app: FastifyInstance, intervalMs: number = 60_000): () => void {
  let stopped = false;

  const fakeRequest = {
    method: 'INTERNAL',
    url: '/scheduler/idle-sweep',
    ip: '127.0.0.1',
    log: app.log,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const ctx: ServiceCtx = buildCtx(app);
    // 1) Idle sweep — DB-backed so ANY replica can reap sessions it
    //    didn't create. The in-memory map is gone from this hot path.
    try {
      const stale = await sessionStore.findIdle(app.db, NODE_TERMINAL_IDLE_MS);
      for (const session of stale) {
        await terminateSession(ctx, session.id, 'idle', fakeRequest).catch((err) => {
          app.log.warn({ err, sessionId: session.id }, 'node-terminal idle terminate failed');
        });
      }
    } catch (err) {
      app.log.warn({ err }, 'node-terminal idle sweep failed');
    }
    // 2) Hard-cap sweep — sessions past expires_at, regardless of
    //    activity. Pod's activeDeadlineSeconds usually fires first,
    //    but this is the fallback.
    try {
      const expired = await sessionStore.findExpired(app.db);
      for (const session of expired) {
        await terminateSession(ctx, session.id, 'deadline', fakeRequest).catch((err) => {
          app.log.warn({ err, sessionId: session.id }, 'node-terminal expired terminate failed');
        });
      }
    } catch (err) {
      app.log.warn({ err }, 'node-terminal expired sweep failed');
    }
    // 3) Orphan pod sweep (DB-aware — see service.ts).
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
