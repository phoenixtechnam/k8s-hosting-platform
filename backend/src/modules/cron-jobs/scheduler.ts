import { eq, and, sql } from 'drizzle-orm';
import { cronJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/**
 * Given a cron schedule string and the last run time, compute the next time
 * the job should fire. This is a simplified approach for MVP:
 *
 * - `* /N` minute fields produce an N-minute interval from last run
 * - All other patterns default to a 1-minute minimum interval from last run
 *
 * For production, replace with a proper cron parsing library (e.g. cron-parser).
 */
export function getNextRunTime(schedule: string, lastRunAt: Date | null): Date {
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return new Date(0);

  const [min] = parts;
  const base = lastRunAt ?? new Date(0);

  // If minute field is */N, interval is N minutes
  if (min.startsWith('*/')) {
    const interval = parseInt(min.slice(2), 10) || 1;
    return new Date(base.getTime() + interval * 60_000);
  }

  // Default: minimum 1-minute interval from last run
  return new Date(base.getTime() + 60_000);
}

export function startWebcronScheduler(db: Database): NodeJS.Timeout {
  console.log('[webcron-scheduler] Starting...');

  const pollInterval = setInterval(async () => {
    try {
      const now = new Date();
      const jobs = await db
        .select()
        .from(cronJobs)
        .where(
          and(
            eq(cronJobs.type, 'webcron'),
            eq(cronJobs.enabled, 1),
          ),
        );

      for (const job of jobs) {
        const nextRun = getNextRunTime(job.schedule, job.lastRunAt);
        if (nextRun > now) continue;
        if (job.lastRunStatus === 'running') continue;

        // Atomic conditional update — only mark running if not already running (prevents TOCTOU race)
        const [updated] = await db.update(cronJobs)
          .set({ lastRunStatus: 'running' })
          .where(and(eq(cronJobs.id, job.id), sql`${cronJobs.lastRunStatus} != 'running'`))
          .returning({ id: cronJobs.id });
        if (!updated) continue; // Another tick already claimed this job

        // Execute asynchronously
        executeWebcron(db, job).catch(err => {
          console.error(`[webcron-scheduler] Error executing ${job.name}:`, err);
        });
      }
    } catch (err) {
      console.error('[webcron-scheduler] Poll error:', err);
    }
  }, 30_000); // Poll every 30 seconds

  return pollInterval;
}

async function executeWebcron(db: Database, job: typeof cronJobs.$inferSelect): Promise<void> {
  const startTime = Date.now();
  let status: 'success' | 'failed' = 'success';
  let responseCode: number | null = null;
  let output: string | null = null;

  try {
    const res = await fetch(job.url!, {
      method: (job.httpMethod as string) ?? 'GET',
      signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'K8s-Hosting-Webcron/1.0' },
    });
    responseCode = res.status;
    output = (await res.text()).slice(0, 2000);
    status = res.ok ? 'success' : 'failed';
  } catch (err) {
    status = 'failed';
    output = err instanceof Error ? err.message : 'Request failed';
  }

  const durationMs = Date.now() - startTime;

  await db.update(cronJobs).set({
    lastRunAt: new Date(),
    lastRunStatus: status,
    lastRunDurationMs: durationMs,
    lastRunResponseCode: responseCode,
    lastRunOutput: output?.slice(0, 2000) ?? null,
  }).where(eq(cronJobs.id, job.id));
}
