/**
 * webmail-feature-css periodic reconciler.
 *
 * Mirrors `startWebmailRouterReconciler`'s pattern. Runs every 5
 * minutes (`unref()`'d timer) to recover from drift between the
 * `platform_settings` flags and the in-cluster ConfigMap +
 * Deployment annotations:
 *
 *   - Manual `kubectl edit configmap webmail-feature-overrides`
 *   - Flux re-apply of an old static manifest (the file in
 *     `k8s/base/mail/webmail-feature-overrides-cm.yaml` is the
 *     "stub" — its data keys are empty strings and Flux is told
 *     not to reconcile them via the standard skip annotation).
 *   - A new operator-flipped flag that hasn't reached the next
 *     scheduler tick yet — the PATCH route also triggers an
 *     immediate reconcile via the task-center handler.
 *
 * Idempotent: when `platform_settings` matches the ConfigMap content
 * and the Deployments are already annotated with the same hash, the
 * pass is a no-op.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import {
  reconcileWebmailFeatureCss,
  type FeatureCssClients,
} from './reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface WebmailFeatureCssSchedulerHandle {
  readonly stop: () => void;
}

export interface WebmailFeatureCssSchedulerClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
}

export function startWebmailFeatureCssReconciler(
  db: Database,
  clients: WebmailFeatureCssSchedulerClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): WebmailFeatureCssSchedulerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const featureClients: FeatureCssClients = {
        core: clients.core,
        apps: clients.apps,
      };
      await reconcileWebmailFeatureCss(db, featureClients, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'webmail-feature-css-scheduler: tick threw',
      );
    }
  };

  // Fire immediately so cold-start convergence shares the same code
  // path as the periodic tick.
  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs }, 'webmail-feature-css-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}
