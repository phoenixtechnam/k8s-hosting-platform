/**
 * Periodic stale-bouncer pruner.
 *
 * Background: the maxlerebourg Traefik bouncer plugin doesn't send a
 * stable bouncer name. CrowdSec auto-creates a new entry
 * `traefik@<pod-ip>` for each unique source IP, and every Traefik pod
 * restart leaves the old entry in CrowdSec's SQLite forever — by
 * design, CrowdSec doesn't auto-prune. Without periodic cleanup,
 * `cscli bouncers list` accumulates dozens of zombies and the
 * Banned-IPs status panel shows confusing "8 online / 31 total".
 *
 * This scheduler runs `cscli bouncers prune -d 24h --force` every 24h
 * (offset by a small initial delay so a cluster of fresh pod starts
 * don't all prune at the same wall clock). Operators can also trigger
 * a prune on-demand via POST /admin/security/crowdsec/bouncers/prune
 * — the manual button on the Banned IPs tab.
 *
 * The 24h threshold is safely above the bouncer's `updateInterval-
 * Seconds: 60s` configured in middlewares-crowdsec.yaml — no live
 * bouncer ever stays >60s between pulls except during a LAPI outage,
 * which is itself an operator-visible alarm.
 */

import type { Logger } from 'pino';
import { pruneStaleBouncers } from './crowdsec.js';

const BOUNCER_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const BOUNCER_PRUNE_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5min warm-up
const BOUNCER_PRUNE_OLDER_THAN_SECONDS = 24 * 60 * 60; // 24h

export interface BouncerPruneSchedulerHandle {
  readonly stop: () => void;
}

export function startCrowdsecBouncerPruneScheduler(
  kubeconfigPath: string | undefined,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = BOUNCER_PRUNE_INTERVAL_MS,
): BouncerPruneSchedulerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const result = await pruneStaleBouncers(kubeconfigPath, BOUNCER_PRUNE_OLDER_THAN_SECONDS);
      if (result.pruned > 0) {
        log.info({ pruned: result.pruned }, 'crowdsec-bouncer-prune: pruned stale bouncers');
      } else {
        log.info({}, 'crowdsec-bouncer-prune: no stale bouncers to prune');
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'crowdsec-bouncer-prune: tick failed (will retry next interval)',
      );
    }
  };

  // Initial delay so cold-start convergence doesn't immediately prune
  // bouncers that haven't pulled because the cluster is still warming up.
  const initial = setTimeout(tick, BOUNCER_PRUNE_INITIAL_DELAY_MS);
  initial.unref();

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs, olderThanSeconds: BOUNCER_PRUNE_OLDER_THAN_SECONDS }, 'crowdsec-bouncer-prune-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
    },
  };
}
