// Top-bar Task Tracker — retention cron.
//
// Runs every 6 hours:
//   1. Reaps orphaned `running`/`queued` rows older than 24h (the surface
//      forgot to call finish — almost certainly because the process
//      crashed mid-op). Marks them `failed` with a clear reason so the
//      operator can re-run if needed.
//   2. Deletes terminal rows older than 7 days. Bounded growth.
//
// This is the safety net for the "missed helper call" risk flagged in
// the plan. The chip's user will see at most a 24h delay before a
// stuck-looking task either resolves or shows an explicit "no progress
// in over 24 hours" failure.

import * as service from './service.js';
import type { Database } from '../../db/index.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function startTaskRetention(db: Database): NodeJS.Timeout {
  // Run once at startup so a crash-recovery scenario gets cleaned up
  // promptly instead of waiting 6h for the first tick.
  void runOnce(db);
  const timer = setInterval(() => {
    void runOnce(db);
  }, RETENTION_INTERVAL_MS);
  // Keep this from holding the event loop open if the process is
  // shutting down — the onClose hook will clearInterval anyway, but
  // unref() is the belt-and-braces.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function runOnce(db: Database): Promise<void> {
  try {
    const result = await service.runRetention(db);
    if (result.deletedTerminal > 0 || result.reapedOrphans > 0) {
      console.log(
        `[task-retention] deleted ${result.deletedTerminal} terminal · reaped ${result.reapedOrphans} orphans`,
      );
    }
  } catch (err) {
    // Never throw — the cron must keep running.
    console.warn('[task-retention] cycle failed:', err instanceof Error ? err.message : String(err));
  }
}
