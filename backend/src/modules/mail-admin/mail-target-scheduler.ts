/**
 * Self-healing reconciler for the mail-target Secret.
 *
 * Periodically calls `syncMailResticSecretFromAssignment` so the
 * `stalwart-snapshot-restic-repo` Secret stays consistent with the
 * `system_mail` snapshot-class assignment row. This catches drift
 * from the inline-sync path failing (transient k8s 5xx, platform-api
 * restart mid-PUT, manual `kubectl edit secret`, etc.).
 *
 * Pattern mirrors `webmail-router/scheduler.ts`: fires once via
 * `setImmediate` for fast cold-start convergence, then on a 5-min
 * interval. All errors logged, never thrown — the assignment row
 * (not the Secret) is authoritative.
 */

import type { Database } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { syncMailResticSecretFromAssignment } from './mail-target-sync.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

export interface MailTargetSchedulerOptions {
  readonly kubeconfigPath: string | undefined;
  readonly encryptionKey: string;
}

export interface MailTargetSchedulerHandle {
  readonly stop: () => void;
}

export function startMailTargetReconciler(
  db: Database,
  log: FastifyBaseLogger,
  opts: MailTargetSchedulerOptions,
): MailTargetSchedulerHandle {
  let stopped = false;

  const tick = async (reason: 'boot' | 'interval') => {
    if (stopped) return;
    try {
      const r = await syncMailResticSecretFromAssignment(db, opts.encryptionKey, {
        kubeconfigPath: opts.kubeconfigPath,
      });
      if (r.action !== 'noop') {
        log.info({ reason, action: r.action, targetId: r.targetId }, 'mail-target-reconciler: synced');
      }
    } catch (err) {
      log.warn({ err, reason }, 'mail-target-reconciler: sync failed — will retry next tick');
    }
  };

  setImmediate(() => { void tick('boot'); });

  const timer = setInterval(() => { void tick('interval'); }, RECONCILE_INTERVAL_MS);
  // Don't keep the process alive on shutdown — graceful close via
  // onClose hook is the authoritative stop signal.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
