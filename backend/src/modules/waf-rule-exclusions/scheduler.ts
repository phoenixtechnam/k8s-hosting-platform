/**
 * waf-rule-exclusions periodic reconciler.
 *
 * Mirrors `startWebmailFeatureCssReconciler`'s pattern. Runs every 5
 * minutes (`unref()`'d timer) to recover from drift between the DB and
 * the in-cluster ConfigMap + Deployment annotation:
 *  - Manual `kubectl edit configmap modsec-crs-exclusions-dynamic`
 *  - Flux re-apply of the empty seed ConfigMap
 *  - A new operator action that hasn't triggered the inline reconcile
 *    (e.g. multiple PATCHes in quick succession where one tick happens
 *    to land mid-transaction)
 *
 * The routes.ts handlers ALSO trigger an inline reconcile after every
 * mutation so the operator sees the change reflect within seconds.
 */

import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { reconcileWafExclusions, type WafExclusionClients } from './reconciler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface WafExclusionSchedulerHandle {
  readonly stop: () => void;
}

export function startWafExclusionReconciler(
  db: Db,
  clients: WafExclusionClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): WafExclusionSchedulerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await reconcileWafExclusions(db, clients, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'waf-rule-exclusions-scheduler: tick threw',
      );
    }
  };

  // Fire immediately so cold-start convergence shares the same code
  // path as the periodic tick.
  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs }, 'waf-rule-exclusions-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}
