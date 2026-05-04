/**
 * Internal route — frps server posts connect/disconnect/auth-fail
 * events here so we can update last_seen_at, last_used_ip, and write
 * audit rows.
 *
 *   POST /api/v1/internal/private-workers/connect-event
 *
 * Auth is a shared-secret header `X-Internal-Token`. The matching value
 * comes from `INTERNAL_API_SHARED_SECRET` (or `PLATFORM_INTERNAL_SECRET`
 * as a legacy alias — same secret as the SFTP gateway uses on its
 * `X-Internal-Auth` header). We accept either env var name so operators
 * can keep one secret across all internal callers.
 */

import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordConnectEvent } from './service.js';
import { success } from '../../shared/response.js';

const connectEventSchema = z.object({
  slug: z.string().min(1).max(60),
  event: z.enum(['connect', 'disconnect', 'auth-fail']),
  // Defense-in-depth: fail before the DB constraint by validating the IP
  // shape here. The PG `inet` column rejects non-IP values too, but a
  // bare regex catch lets us return a clean 400 to the caller.
  ip: z.string().min(1).max(64).regex(/^[0-9a-fA-F:.]+$/, 'ip must be a valid IPv4/IPv6 address'),
});

function resolveInternalSecret(): string | null {
  const candidates = [
    process.env.INTERNAL_API_SHARED_SECRET,
    process.env.PLATFORM_INTERNAL_SECRET,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  // HMAC both inputs with a session-random key, then compare the digests.
  // The digests are fixed-length so timingSafeEqual works in constant time
  // regardless of input length — eliminating the length-oracle that an
  // attacker could otherwise use to probe the secret's byte length.
  const key = crypto.randomBytes(32);
  const aDigest = crypto.createHmac('sha256', key).update(a).digest();
  const bDigest = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(aDigest, bDigest);
}

export async function privateWorkerInternalRoutes(app: FastifyInstance): Promise<void> {
  // Constant-time secret comparison; refuses if no secret is configured.
  app.addHook('onRequest', async (request, reply) => {
    const secret = resolveInternalSecret();
    const provided = request.headers['x-internal-token'];
    if (!secret || typeof provided !== 'string' || !timingSafeEqualStr(provided, secret)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  });

  app.post('/internal/private-workers/connect-event', async (request, reply) => {
    const parsed = connectEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid payload' });
    }
    const { slug, event, ip } = parsed.data;
    const result = await recordConnectEvent(app.db, slug, ip, event);
    if (!result.matched) {
      // Don't leak whether the slug exists — the agent may be calling
      // with an old token after the worker was deleted. Return 200 so
      // the agent backs off rather than retrying a 404 forever.
      return success({ recorded: false });
    }
    return success({ recorded: true });
  });
}
