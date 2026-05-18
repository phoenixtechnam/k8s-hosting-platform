/**
 * SYSTEM tenant internal routes.
 *
 * Single endpoint:
 *   POST /api/v1/internal/system-tenant/ensure
 *
 * Called by scripts/bootstrap.sh after the platform-api comes up
 * healthy. Server-side startup runs the same code path automatically,
 * so this endpoint is mainly a way for bootstrap.sh to learn the
 * outcome (was SYSTEM newly created vs. already existed?) and surface
 * that in operator-visible install logs.
 *
 * Auth: PLATFORM_INTERNAL_TOKEN bearer token — same pattern as
 * /internal/mail/snapshot-last-run. Never exposed to end users.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { bootstrapSystemTenant } from './bootstrap.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

interface RequestHeaders {
  authorization?: string | string[];
}

/** Constant-time compare. timingSafeEqual throws if the buffers are
 *  different lengths, so we early-return false in that case to keep
 *  the side-channel from leaking the expected length. */
function safeTokenEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireInternalToken(req: FastifyRequest): void {
  const expected = process.env.PLATFORM_INTERNAL_TOKEN;
  if (!expected) {
    throw new ApiError(
      'INTERNAL_TOKEN_NOT_CONFIGURED',
      'PLATFORM_INTERNAL_TOKEN env var must be set for /internal/* endpoints',
      503,
    );
  }
  const headers = req.headers as RequestHeaders;
  const raw = headers.authorization ?? '';
  const token = Array.isArray(raw) ? raw[0] ?? '' : raw;
  if (!token.startsWith('Bearer ') || !safeTokenEqual(token.slice(7), expected)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid internal token', 401);
  }
}

export async function systemTenantRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/system-tenant/ensure', async (request: FastifyRequest, _reply: FastifyReply) => {
    requireInternalToken(request);

    const cfg = app.config as Record<string, unknown> | undefined;
    const kubeconfigPath = cfg?.KUBECONFIG_PATH as string | undefined;
    let k8s = null;
    try {
      k8s = createK8sClients(kubeconfigPath);
    } catch {
      // Pre-k8s bootstrap step or test environment — proceed without
      // namespace provisioning.
    }

    const result = await bootstrapSystemTenant(app.db, {
      k8s,
      log: {
        info: (msg) => app.log.info(msg),
        warn: (msg, err) => app.log.warn({ err }, msg),
      },
    });

    return success({
      tenantId: result.tenantId,
      created: result.created,
      alreadyExisted: result.alreadyExisted,
      apexDomainCreated: result.apexDomainCreated,
      adminUserCreated: result.adminUserCreated,
      baseDomain: result.baseDomain,
      namespaceProvisioningTaskId: result.namespaceProvisioningTaskId,
    });
  });
}
