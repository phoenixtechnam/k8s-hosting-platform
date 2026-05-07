// Top-bar Task Tracker routes.
//
// GET  /api/v1/me/tasks              snapshot of in-flight + recent terminal
// GET  /api/v1/me/tasks/stream       SSE — server-sent events of pg_notify deltas
// POST /api/v1/me/tasks/clear        clear all completed for caller
// POST /api/v1/me/tasks/:id/clear    clear a single task (must be terminal + owned)
//
// All four routes are bearer-authenticated; visibility is enforced
// per-row by user_id == request.user.sub. Client panel users see only
// their own tasks; admin panel users see only their own (PITR + other
// cluster-wide singletons are visible to their initiator only in
// Phase 1, per UX agreement).

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { getPool } from '../../db/index.js';
import {
  clearTasksRequestSchema,
  taskSseEventSchema,
} from '@k8s-hosting/api-contracts';
import * as service from './service.js';

interface JwtPayload {
  readonly sub: string;
  readonly role?: string;
  readonly panel?: 'admin' | 'client';
  readonly clientId?: string | null;
}

export async function taskCenterRoutes(app: FastifyInstance): Promise<void> {
  // ─── Snapshot ──────────────────────────────────────────────────────
  app.get('/me/tasks', { onRequest: [authenticate] }, async (request) => {
    const payload = request.user as JwtPayload;
    if (!payload?.sub) {
      throw new ApiError('INVALID_TOKEN', 'Invalid token', 401);
    }

    const sinceParam = (request.query as { since?: string } | undefined)?.since;
    let since: Date | null = null;
    if (sinceParam) {
      const parsed = new Date(sinceParam);
      if (Number.isNaN(parsed.getTime())) {
        throw new ApiError('VALIDATION_ERROR', 'since must be an ISO-8601 timestamp', 400);
      }
      since = parsed;
    }

    const tasks = await service.snapshot(app.db, {
      userId: payload.sub,
      clientId: payload.clientId ?? null,
      since,
    });

    return success({
      tasks,
      serverTime: new Date().toISOString(),
    });
  });

  // ─── SSE stream ────────────────────────────────────────────────────
  //
  // One PG connection per SSE connection running LISTEN tasks_user_<id>.
  // Heartbeat every 25 s. Hard timeout at 5 minutes — clients reconnect.
  // The chip falls back to polling (snapshot endpoint) when SSE is
  // unavailable, so the worst-case behavior is a 30 s perceived delay,
  // not a broken UI.
  //
  // Bearer is passed via the Authorization header — EventSource doesn't
  // support custom headers, so the chip uses fetch + ReadableStream
  // (works in all evergreen browsers). For pre-auth contexts (e.g.,
  // EventSource with cookie auth), see Phase 5 notes.
  app.get('/me/tasks/stream', { onRequest: [authenticate] }, async (request, reply) => {
    const payload = request.user as JwtPayload;
    if (!payload?.sub) {
      throw new ApiError('INVALID_TOKEN', 'Invalid token', 401);
    }
    const userId = payload.sub;
    // Channel must match the trigger's `'tasks_user_' || NEW.user_id::text`
    // form verbatim (migration 0090) — UUIDs include hyphens, which the
    // trigger preserves as a string-literal channel via pg_notify.
    //
    // Postgres NAMEDATALEN is 64 → channel names are silently truncated
    // at 63 bytes. The prefix is 11 chars; cap the remainder at 52 to
    // stay safely under (UUIDs are 36 chars so this is no-op today, but
    // defends against future non-UUID sub claims). Sanitize against
    // anything that would break pg's quoted-identifier syntax — the
    // LISTEN below quotes the channel so we accept hyphens.
    const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 52);
    const channel = `tasks_user_${sanitized}`;
    // Pre-build the quoted identifier so we never interpolate the
    // unquoted form into a LISTEN/UNLISTEN. Double quotes inside the
    // sanitised value can't appear (regex above), so simple wrapping
    // is sufficient.
    const channelQuoted = `"${channel}"`;

    // Acquire a dedicated pg client (NOT shared with Drizzle queries —
    // LISTEN holds it for the lifetime of the SSE connection). On drop,
    // release gracefully so we don't leak.
    let pool: pg.Pool | null = null;
    try {
      pool = getPool();
    } catch {
      pool = null;
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // disables nginx buffering
    reply.raw.flushHeaders();

    let closed = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let hardTimeout: NodeJS.Timeout | null = null;
    let pgClient: pg.PoolClient | null = null;

    const writeEvent = (event: string, data: string, id?: string): void => {
      if (closed) return;
      try {
        if (id) reply.raw.write(`id: ${id}\n`);
        reply.raw.write(`event: ${event}\n`);
        // Split data on newlines so multi-line payloads are valid SSE.
        for (const line of data.split('\n')) {
          reply.raw.write(`data: ${line}\n`);
        }
        reply.raw.write('\n');
      } catch {
        // Client gone. Cleanup happens on the 'close' handler.
      }
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      if (pgClient) {
        try {
          pgClient.removeAllListeners('notification');
          pgClient.query(`UNLISTEN ${channelQuoted}`).catch(() => undefined);
        } finally {
          pgClient.release();
        }
        pgClient = null;
      }
      try {
        reply.raw.end();
      } catch {
        // already closed
      }
    };

    request.raw.once('close', cleanup);
    request.raw.once('error', cleanup);

    // Heartbeat comment frame keeps proxies from idle-killing the conn.
    heartbeatTimer = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(`: keep-alive ${Date.now()}\n\n`);
      } catch {
        cleanup();
      }
    }, 25_000);

    // Hard 5-minute timeout — client reconnects with Last-Event-ID, no UX impact.
    hardTimeout = setTimeout(() => {
      writeEvent('reconnect', JSON.stringify({ reason: 'idle-rotate' }));
      cleanup();
    }, 5 * 60 * 1000);

    if (!pool) {
      // No pg pool registered on app — this is a bug, but bail with
      // a polite "use polling" event rather than crashing the request.
      writeEvent('error', JSON.stringify({ reason: 'sse-unavailable' }));
      cleanup();
      return reply;
    }

    try {
      pgClient = await pool.connect();
      pgClient.on('notification', (msg) => {
        if (msg.channel !== channel || !msg.payload) return;
        try {
          const parsed = taskSseEventSchema.safeParse(JSON.parse(msg.payload));
          if (!parsed.success) return;
          writeEvent('task', JSON.stringify(parsed.data), parsed.data.updatedAt);
        } catch {
          // Malformed payload from PG — drop quietly.
        }
      });
      pgClient.on('error', () => cleanup());
      await pgClient.query(`LISTEN ${channelQuoted}`);

      // Initial snapshot so the client doesn't need a separate poll on
      // open. Cap small to avoid a large opening payload.
      const initial = await service.snapshot(app.db, { userId, limit: 50 });
      writeEvent('snapshot', JSON.stringify({ tasks: initial }));
    } catch (err) {
      request.log.warn({ err }, 'tasks-sse: setup failed, falling back to client poll');
      writeEvent('error', JSON.stringify({ reason: 'listen-failed' }));
      cleanup();
    }

    return reply;
  });

  // ─── Clear (single + bulk) ─────────────────────────────────────────
  app.post('/me/tasks/clear', { onRequest: [authenticate] }, async (request) => {
    const payload = request.user as JwtPayload;
    if (!payload?.sub) {
      throw new ApiError('INVALID_TOKEN', 'Invalid token', 401);
    }

    const parsed = clearTasksRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    const cleared = await service.clear(app.db, payload.sub, parsed.data.ids);
    return success({ clearedCount: cleared });
  });
}
