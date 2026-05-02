/**
 * Phase 5 API surface for lifecycle hooks.
 *
 *   GET  /api/v1/admin/lifecycle/transitions
 *        - Lists recent transitions across all clients with their hook_runs.
 *        - Used by the (future) Settings → Lifecycle Hooks panel.
 *
 *   GET  /api/v1/admin/clients/:id/lifecycle/transitions
 *        - Per-client view; same row shape filtered by client_id.
 *
 *   POST /api/v1/admin/lifecycle/hook-runs/:runId/retry
 *        - Operator-triggered immediate retry. Sets next_attempt_at=now()
 *          so the scheduler's next tick picks it up; this endpoint does
 *          NOT run the hook inline (avoids tying up a request thread on
 *          a slow provider).
 */
import type { FastifyInstance } from 'fastify';
import { eq, desc, inArray } from 'drizzle-orm';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  clientLifecycleTransitions,
  clientLifecycleHookRuns,
} from '../../db/schema.js';

type HookRunRow = typeof clientLifecycleHookRuns.$inferSelect;

async function fetchHookRunsForTransitions(
  db: FastifyInstance['db'],
  transitionIds: readonly string[],
): Promise<Record<string, HookRunRow[]>> {
  if (transitionIds.length === 0) return {};
  const rows = await db.select().from(clientLifecycleHookRuns)
    .where(inArray(clientLifecycleHookRuns.transitionId, transitionIds as string[]));
  const grouped: Record<string, HookRunRow[]> = {};
  for (const r of rows) {
    grouped[r.transitionId] = grouped[r.transitionId] ?? [];
    grouped[r.transitionId].push(r);
  }
  return grouped;
}

export async function clientLifecycleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /admin/lifecycle/transitions?clientId=...&limit=...
  app.get('/admin/lifecycle/transitions', {
    schema: {
      tags: ['ClientLifecycle'],
      summary: 'List recent lifecycle transitions',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          clientId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
  }, async (request) => {
    const { clientId, limit } = request.query as { clientId?: string; limit?: number };
    const cap = Math.min(limit ?? 50, 200);
    const transitions = clientId
      ? await app.db.select().from(clientLifecycleTransitions)
        .where(eq(clientLifecycleTransitions.clientId, clientId))
        .orderBy(desc(clientLifecycleTransitions.startedAt))
        .limit(cap)
      : await app.db.select().from(clientLifecycleTransitions)
        .orderBy(desc(clientLifecycleTransitions.startedAt))
        .limit(cap);
    const hookRuns = await fetchHookRunsForTransitions(app.db, transitions.map((t) => t.id));
    return success({ transitions, hookRuns });
  });

  // GET /admin/clients/:id/lifecycle/transitions
  app.get('/admin/clients/:id/lifecycle/transitions', {
    schema: {
      tags: ['ClientLifecycle'],
      summary: 'Transitions for a single client',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const transitions = await app.db.select().from(clientLifecycleTransitions)
      .where(eq(clientLifecycleTransitions.clientId, id))
      .orderBy(desc(clientLifecycleTransitions.startedAt))
      .limit(50);
    const hookRuns = await fetchHookRunsForTransitions(app.db, transitions.map((t) => t.id));
    return success({ transitions, hookRuns });
  });

  // POST /admin/lifecycle/hook-runs/:runId/retry
  app.post('/admin/lifecycle/hook-runs/:runId/retry', {
    schema: {
      tags: ['ClientLifecycle'],
      summary: 'Mark a failed hook_run for immediate retry',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } },
    },
  }, async (request) => {
    const { runId } = request.params as { runId: string };
    const [row] = await app.db.select().from(clientLifecycleHookRuns)
      .where(eq(clientLifecycleHookRuns.id, runId))
      .limit(1);
    if (!row) {
      throw new ApiError('NOT_FOUND', `hook_run ${runId} not found`, 404);
    }
    if (row.state !== 'failed') {
      throw new ApiError('CONFLICT',
        `hook_run is in state '${row.state}' — only 'failed' rows can be retried`,
        409);
    }
    // Operator override: if attempts >= maxAttempts, bump max so the
    // next tick is allowed to try one more time.
    const patch: { nextAttemptAt: Date; maxAttempts?: number } = { nextAttemptAt: new Date() };
    if (row.attempts >= row.maxAttempts) {
      patch.maxAttempts = row.attempts + 1;
    }
    await app.db.update(clientLifecycleHookRuns)
      .set(patch)
      .where(eq(clientLifecycleHookRuns.id, runId));
    return success({ retryQueuedAt: new Date().toISOString() });
  });
}
