import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { auditLogs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  getStepUpStatus,
  verifyStepUpPassword,
  DEFAULT_STEP_UP_MAX_AGE_MS,
} from './step-up-service.js';
import {
  beginAuthentication,
  completeAuthentication,
  loadPasskeyConfig,
} from './passkey-service.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  stepUpStatusQuerySchema,
  stepUpPasswordRequestSchema,
  stepUpPasskeyVerifyRequestSchema,
  type StepUpMethod,
  type StepUpPurpose,
} from '@k8s-hosting/api-contracts';

// Required bearer-auth (no cookie fallback). Step-up always operates
// inside an existing session; if the caller can't present a bearer
// token, the platform-session cookie alone is not enough — same CSRF
// posture as the rest of passkey-routes.
async function assertBearerAuth(request: FastifyRequest): Promise<void> {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    throw invalidToken();
  }
  await request.jwtVerify();
  const payload = request.user as { step?: string };
  // Reject pre-auth tokens (they carry step:'passkey_2fa').
  if (payload.step) {
    throw invalidToken();
  }
}

async function recordStepUpAudit(
  db: Database,
  actorId: string,
  actionType: 'step_up.password.success' | 'step_up.password.failed' |
              'step_up.passkey.success' | 'step_up.passkey.failed' |
              'step_up.status',
  request: FastifyRequest,
  changes?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType,
      resourceType: 'step_up',
      resourceId: actorId,
      actorId,
      actorType: 'user',
      httpMethod: request.method,
      httpPath: request.url.slice(0, 500),
      httpStatus: actionType.endsWith('.failed') ? 401 : 200,
      changes: changes ?? null,
      ipAddress: request.ip,
    });
  } catch (err) {
    request.log.warn({ err }, 'step-up audit write failed');
  }
}

export async function stepUpRoutes(app: FastifyInstance): Promise<void> {
  const passkeyConfig = loadPasskeyConfig();

  /**
   * GET /me/step-up/status?purpose=node_terminal
   * Returns freshness state + enabled methods for the calling user.
   * Used by the frontend to decide whether to prompt for re-auth
   * before opening a privileged surface.
   */
  app.get('/me/step-up/status', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string };
    const parsed = stepUpStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }
    // Purpose-specific freshness can be tuned per-action later. Today
    // every purpose uses the default 30-min window.
    void (parsed.data.purpose satisfies StepUpPurpose);
    const status = await getStepUpStatus(app.db, payload.sub, DEFAULT_STEP_UP_MAX_AGE_MS);
    return reply.send({
      data: {
        required: status.required,
        methods: status.methods,
        lastCredentialCheckAt: status.lastCredentialCheckAt?.toISOString() ?? null,
        maxAgeSeconds: Math.floor(status.maxAgeMs / 1000),
      },
    });
  });

  /**
   * POST /me/step-up/password
   * Verifies the caller's password. On success, bumps
   * users.last_credential_check_at and returns the new timestamp.
   * Rate-limited tighter than /auth/login because the user is already
   * authenticated — repeated step-up failures are bot-style probing.
   */
  app.post('/me/step-up/password', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string };
    const parsed = stepUpPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }
    try {
      const at = await verifyStepUpPassword(app.db, payload.sub, parsed.data.password);
      await recordStepUpAudit(app.db, payload.sub, 'step_up.password.success', request);
      const method: StepUpMethod = 'password';
      return reply.send({
        data: {
          ok: true as const,
          methodVerified: method,
          lastCredentialCheckAt: at.toISOString(),
        },
      });
    } catch (err) {
      // Best-effort audit on failure — the user is real (bearer-auth
      // already verified the JWT) so we know who attempted.
      await recordStepUpAudit(app.db, payload.sub, 'step_up.password.failed', request, {
        reason: err instanceof ApiError ? err.code : 'unknown',
      });
      throw err;
    }
  });

  /**
   * POST /me/step-up/passkey/options
   * Begin a passkey step-up challenge scoped to the authenticated user
   * (NOT userless — the user is already known). On success the client
   * receives a WebAuthn PublicKeyCredentialRequestOptionsJSON.
   */
  app.post('/me/step-up/passkey/options', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'tenant' };
    const options = await beginAuthentication(app.db, passkeyConfig, payload.panel, payload.sub);
    return reply.send({ data: options });
  });

  /**
   * POST /me/step-up/passkey/verify
   * Complete the passkey step-up. completeAuthentication() already
   * bumps users.last_credential_check_at on success (see
   * passkey-service.ts). We re-fetch the freshness timestamp here so
   * the response shape matches /me/step-up/password.
   */
  app.post('/me/step-up/passkey/verify', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'tenant' };
    const parsed = stepUpPasskeyVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }
    try {
      const result = await completeAuthentication(app.db, passkeyConfig, {
        panel: payload.panel,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: parsed.data.response as any,
        expectedUserId: payload.sub,
      });
      // Reject cross-user passkey reuse — completeAuthentication
      // already enforces this via expectedUserId, but be belt-and-braces.
      if (result.user.id !== payload.sub) {
        throw new ApiError('STEP_UP_FAILED', 'Step-up authentication failed', 401);
      }
      await recordStepUpAudit(app.db, payload.sub, 'step_up.passkey.success', request, {
        passkeyId: result.passkeyId,
      });
      const method: StepUpMethod = 'passkey';
      // Security finding M3: read back the DB-committed
      // last_credential_check_at value rather than minting a wall-clock
      // timestamp here. If the row write failed mid-transaction, the
      // re-read surfaces the truth and the client sees the right
      // freshness boundary.
      const [row] = await app.db
        .select({ at: users.lastCredentialCheckAt })
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1);
      const at = row?.at ?? new Date();
      return reply.send({
        data: {
          ok: true as const,
          methodVerified: method,
          lastCredentialCheckAt: at.toISOString(),
        },
      });
    } catch (err) {
      await recordStepUpAudit(app.db, payload.sub, 'step_up.passkey.failed', request, {
        reason: err instanceof ApiError ? err.code : 'unknown',
      });
      throw err;
    }
  });
}
