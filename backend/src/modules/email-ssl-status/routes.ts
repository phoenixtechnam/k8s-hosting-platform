import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { getMailServerHostname } from '../webmail-settings/service.js';
import { probeAllListeners } from './service.js';

/**
 * Strict hostname validation per RFC 1123: labels A-Z/a-z/0-9/hyphen,
 * dot-separated, max 253 chars total, max 63 chars per label, no
 * leading/trailing hyphens, must contain at least one dot. Used as
 * a defence-in-depth check before passing the operator-configured
 * mail-server hostname into the TLS probe (SNI field). Without this,
 * a compromised platform_settings row could inject arbitrary SNI
 * payloads or extremely long strings.
 */
function isValidHostname(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (!value.includes('.')) return false;
  const labelRe = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  return value.split('.').every((label) => labelRe.test(label));
}

/**
 * GET /api/v1/admin/email-settings/ssl-status
 *
 * Returns per-port TLS handshake results for the platform mail server.
 * Cached 30s in-process. Lazy-loaded by the admin Email Settings card —
 * not fired automatically on page load (would slow the admin panel by
 * 6 × ~150ms even when the operator isn't looking at the card).
 *
 * Auth: super_admin or admin (visibility into mail server cert state
 * isn't sensitive in the same way credentials are, but it's still an
 * operator concern, not a tenant concern).
 *
 * Query params:
 *   ?refresh=1 — bypass the cache (forces a fresh handshake)
 */
export async function emailSslStatusRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  app.get<{ Querystring: { refresh?: string } }>(
    '/admin/email-settings/ssl-status',
    async (request) => {
      const hostname = await getMailServerHostname(app.db);
      // Defence-in-depth: even though the platform_settings row is
      // operator-only-writable, validate the hostname before passing
      // it to TLS-handshake APIs so a malformed value (manual SQL,
      // restored bad backup) can't inject arbitrary SNI strings.
      if (!isValidHostname(hostname)) {
        throw new ApiError(
          'INVALID_MAIL_SERVER_HOSTNAME',
          `Configured mail server hostname '${hostname}' is not a valid RFC 1123 FQDN`,
          500,
        );
      }
      const bypassCache = request.query.refresh === '1' || request.query.refresh === 'true';
      const statuses = await probeAllListeners(hostname, { bypassCache });
      return success({
        host: hostname,
        listeners: statuses,
        cachedTtlMs: bypassCache ? 0 : 30_000,
      });
    },
  );
}
