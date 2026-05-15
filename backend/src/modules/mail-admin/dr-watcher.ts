/**
 * Mail DR watcher — monitors active node health and triggers auto-failover.
 *
 * Runs every DEFAULT_TICK_MS. Each tick:
 *   1. Reads mailAutoFailoverEnabled from system_settings — exits immediately if false.
 *   2. Checks whether the active node's k8s Node object has Ready=True.
 *   3. If node is NotReady:
 *      - Transitions drState: healthy → degraded (records degradedSince).
 *      - If degraded for >= failoverThresholdSeconds: triggers restore-based
 *        auto-failover to secondary/tertiary node.
 *   4. If node recovers while in degraded state: resets drState → healthy.
 *
 * For node-loss DR the source PVC is inaccessible, so we use
 * `triggerRestoreBasedFailover` (empty PVC + allow-restore annotation) rather
 * than the full rsync migration pipeline.
 *
 * Follows the exact pattern of backup-health/scheduler.ts.
 */

import { eq } from 'drizzle-orm';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { triggerRestoreBasedFailover } from './migration.js';

const SETTINGS_ID = 'system';

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;
type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;
type BatchV1Api = import('@kubernetes/client-node').BatchV1Api;

export interface DrWatcherDeps {
  readonly db: Database;
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  /**
   * Batch client — required since Phase 1 streamline (2026-05-15)
   * because the restore-based failover polls the snapshot CronJob's
   * `status.lastSuccessfulTime` to wait for fresh snapshots before
   * scaling Stalwart down.
   */
  readonly batch: BatchV1Api;
  readonly kubeconfigPath?: string;
  readonly tickMs?: number;
  readonly logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

/** Default tick: 30s — fast enough to detect node loss within a minute. */
export const DR_WATCHER_TICK_MS = 30_000;

/**
 * Start the DR watcher. Returns a stop function compatible with
 * `app.addHook('onClose', () => stop())`.
 */
export function startDrWatcher(deps: DrWatcherDeps): () => void {
  const tickMs = deps.tickMs ?? DR_WATCHER_TICK_MS;

  // Run one tick immediately on start to catch a degraded state that
  // persisted across a platform-api restart.
  void runDrWatcherTick(deps);

  const timer = setInterval(() => void runDrWatcherTick(deps), tickMs);
  return () => clearInterval(timer);
}

/**
 * One tick of the DR watcher. Exported for unit-testability.
 */
export async function runDrWatcherTick(deps: DrWatcherDeps): Promise<void> {
  const { db, core, apps, batch, kubeconfigPath } = deps;
  const log = deps.logger ?? {
    warn: (...args: unknown[]) => console.warn('[dr-watcher]', ...args),
    info: (...args: unknown[]) => console.info('[dr-watcher]', ...args),
  };

  try {
    const [settings] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
    if (!settings) return;
    if (!settings.mailAutoFailoverEnabled) return;
    if (!settings.mailActiveNode) return;

    // Only act in stable states — if already failing-over or failed-over,
    // leave the state machine alone.
    const drState = settings.mailDrState ?? 'healthy';
    if (drState !== 'healthy' && drState !== 'degraded') return;

    const nodeReady = await isNodeReady(core, settings.mailActiveNode);

    if (!nodeReady) {
      const thresholdSec = settings.mailFailoverThresholdSeconds ?? 300;

      if (drState === 'healthy') {
        // First detection — transition to degraded and record the time.
        await db.update(systemSettings)
          .set({ mailDrState: 'degraded', mailLastFailoverAt: new Date() })
          .where(eq(systemSettings.id, SETTINGS_ID));
        log.warn(
          `Active mail node ${settings.mailActiveNode} is NotReady — entering degraded state (threshold ${thresholdSec}s)`,
        );
        return;
      }

      // Already degraded — check how long.
      const degradedSince = settings.mailLastFailoverAt
        ? (Date.now() - settings.mailLastFailoverAt.getTime()) / 1000
        : thresholdSec + 1; // treat unknown as exceeded

      if (degradedSince < thresholdSec) {
        log.info(
          `Node ${settings.mailActiveNode} still degraded — ${Math.round(degradedSince)}s / ${thresholdSec}s threshold`,
        );
        return;
      }

      // Threshold exceeded — pick failover target.
      const targetNode = settings.mailSecondaryNode ?? settings.mailTertiaryNode ?? null;
      if (!targetNode) {
        log.warn('No secondary/tertiary node configured — cannot auto-failover. Set placement policy.');
        return;
      }

      log.warn(
        `Node ${settings.mailActiveNode} degraded for ${Math.round(degradedSince)}s >= threshold ${thresholdSec}s — ` +
        `triggering auto-failover to ${targetNode}`,
      );

      await db.update(systemSettings)
        .set({ mailDrState: 'failing-over' })
        .where(eq(systemSettings.id, SETTINGS_ID));

      try {
        await triggerRestoreBasedFailover(targetNode, { db, core, apps, batch, kubeconfigPath });
        log.warn(`Auto-failover to ${targetNode} complete — state set to failed-over`);
      } catch (err) {
        log.warn('Auto-failover failed — resetting to degraded for next tick retry:', err);
        await db.update(systemSettings)
          .set({ mailDrState: 'degraded' })
          .where(eq(systemSettings.id, SETTINGS_ID))
          .catch(() => { /* best-effort */ });
      }
    } else if (drState === 'degraded') {
      // Node recovered from degraded state before threshold — reset to healthy.
      await db.update(systemSettings)
        .set({ mailDrState: 'healthy' })
        .where(eq(systemSettings.id, SETTINGS_ID));
      log.info(`Active mail node ${settings.mailActiveNode} recovered — drState reset to healthy`);
    }
  } catch (err) {
    // Never let a tick crash the interval — log and wait for next cycle.
    const log2 = deps.logger ?? { warn: console.warn, info: console.info };
    log2.warn('DR watcher tick error:', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function isNodeReady(core: CoreV1Api, nodeName: string): Promise<boolean> {
  try {
    const node = await core.readNode({ name: nodeName }) as {
      status?: { conditions?: Array<{ type: string; status: string }> };
    };
    const conditions = node.status?.conditions ?? [];
    const readyCond = conditions.find((c) => c.type === 'Ready');
    return readyCond?.status === 'True';
  } catch {
    // Node not found or API unreachable — treat as not ready.
    return false;
  }
}
