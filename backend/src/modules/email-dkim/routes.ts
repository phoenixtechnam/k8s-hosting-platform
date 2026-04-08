import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { eq, and } from 'drizzle-orm';
import { emailDomains, emailDkimKeys } from '../../db/schema.js';
import { formatDkimDnsValue } from '../email-domains/dkim.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

const autoRotateBodySchema = z
  .object({
    rotationAgeDays: z.number().int().positive().max(3650).optional(),
  })
  .strict();

const encryptionKey = (): string =>
  process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY */;

/**
 * Phase 3 T1.1 — DKIM rotation endpoints.
 *
 * Scopes:
 *   - Admin scope      /admin/email/dkim/*         super_admin + admin
 *   - Client scope     /clients/:cid/email/domains/:did/dkim/*
 *
 * All endpoints return DKIM key metadata only — the encrypted private
 * key is never exposed via the HTTP API. The DNS record (name + TXT
 * value) IS returned because operators need it to publish manually
 * in secondary/cname mode.
 */
export async function emailDkimRoutes(app: FastifyInstance): Promise<void> {
  // ─── Client-scoped routes ────────────────────────────────────────────

  // GET  /clients/:clientId/email/domains/:domainId/dkim/keys
  app.get('/clients/:clientId/email/domains/:domainId/dkim/keys', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const [ed] = await app.db
      .select({ id: emailDomains.id })
      .from(emailDomains)
      .where(and(eq(emailDomains.clientId, clientId), eq(emailDomains.domainId, domainId)));
    if (!ed) {
      throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', 'Email domain not found', 404);
    }
    const keys = await service.listDkimKeys(app.db, ed.id);
    // The raw encrypted private key is never returned. The public
    // key is pre-formatted into the DNS TXT value the operator would
    // publish, so the UI doesn't need to re-implement
    // formatDkimDnsValue.
    const safe = keys.map((k) => ({
      id: k.id,
      emailDomainId: k.emailDomainId,
      selector: k.selector,
      status: k.status,
      dnsRecordValue: formatDkimDnsValue(k.publicKey),
      dnsVerifiedAt: k.dnsVerifiedAt,
      activatedAt: k.activatedAt,
      retiredAt: k.retiredAt,
      createdAt: k.createdAt,
      updatedAt: k.updatedAt,
    }));
    return success(safe);
  });

  // POST /clients/:clientId/email/domains/:domainId/dkim/rotate
  // Generate a new DKIM key. For primary mode this publishes DNS and
  // flips to active; for cname/secondary it leaves the key pending and
  // returns the DNS record the operator must publish manually.
  app.post('/clients/:clientId/email/domains/:domainId/dkim/rotate', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const [ed] = await app.db
      .select({ id: emailDomains.id })
      .from(emailDomains)
      .where(and(eq(emailDomains.clientId, clientId), eq(emailDomains.domainId, domainId)));
    if (!ed) {
      throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', 'Email domain not found', 404);
    }
    const result = await service.rotateDkimKey(app.db, ed.id, encryptionKey());
    reply.status(201).send(success(result));
  });

  // POST /clients/:clientId/email/domains/:domainId/dkim/keys/:keyId/activate
  // Manually activate a pending key (cname/secondary mode only).
  app.post('/clients/:clientId/email/domains/:domainId/dkim/keys/:keyId/activate', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId, domainId, keyId } = request.params as {
      clientId: string;
      domainId: string;
      keyId: string;
    };
    // Sanity-check the key belongs to this (client, domain).
    const [ed] = await app.db
      .select({ id: emailDomains.id })
      .from(emailDomains)
      .where(and(eq(emailDomains.clientId, clientId), eq(emailDomains.domainId, domainId)));
    if (!ed) {
      throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', 'Email domain not found', 404);
    }
    const [key] = await app.db
      .select({ emailDomainId: emailDkimKeys.emailDomainId })
      .from(emailDkimKeys)
      .where(eq(emailDkimKeys.id, keyId));
    if (!key || key.emailDomainId !== ed.id) {
      throw new ApiError('DKIM_KEY_NOT_FOUND', 'DKIM key not found for this domain', 404);
    }
    const result = await service.activatePendingKey(app.db, keyId);
    return success({
      id: result.id,
      status: result.status,
      activatedAt: result.activatedAt,
    });
  });

  // ─── Admin scope (cross-client) ──────────────────────────────────────

  // POST /admin/email/dkim/auto-rotate
  // Trigger a platform-wide rotation scan. Only rotates primary-mode
  // email domains. Useful for operators who want to force rotation
  // before the next scheduled cycle.
  app.post('/admin/email/dkim/auto-rotate', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const parsed = autoRotateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const result = await service.autoRotatePrimaryDomains(
      app.db,
      encryptionKey(),
      parsed.data,
    );
    return success(result);
  });
}
