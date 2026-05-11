/**
 * HTTP routes for per-client mTLS provider CRUD + cert lifecycle.
 *
 *   GET    /api/v1/clients/:clientId/mtls-providers
 *   POST   /api/v1/clients/:clientId/mtls-providers                       (upload OR generate)
 *   PATCH  /api/v1/clients/:clientId/mtls-providers/:pid
 *   DELETE /api/v1/clients/:clientId/mtls-providers/:pid
 *   POST   /api/v1/clients/:clientId/mtls-providers/:pid/issue-cert
 *   GET    /api/v1/clients/:clientId/mtls-providers/:pid/certificates
 *   GET    /api/v1/clients/:clientId/mtls-providers/:pid/certificates/:certId
 *   GET    /api/v1/clients/:clientId/mtls-providers/:pid/certificates/:certId/pem
 *   POST   /api/v1/clients/:clientId/mtls-providers/:pid/certificates/:certId/revoke
 *   GET    /api/v1/clients/:clientId/mtls-providers/:pid/crl              → metadata JSON
 *   GET    /api/v1/clients/:clientId/mtls-providers/:pid/crl.pem          → CRL body (text)
 *
 * Auth + tenancy: every request is gated by `authenticate` + `requireRole`
 * (admin / super_admin / client_admin) + `requireClientAccess`. The last
 * one reads `:clientId` from the URL and enforces it matches the JWT's
 * `clientId` claim — without it, a client_admin for tenant A could call
 * /clients/<tenant-B>/... and read tenant B's CA / certs (IDOR).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import {
  mtlsProviderInputSchema,
  mtlsProviderUpdateSchema,
  mtlsIssueCertInputSchema,
  listCertificatesQuerySchema,
  revokeCertificateInputSchema,
} from '@k8s-hosting/api-contracts';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  issueUserCert,
  listCertificates,
  getCertificate,
  getCertificatePem,
  revokeCertificate,
  unrevokeCertificate,
  deleteCertificate,
  getOrGenerateCrl,
  getCrlMetadata,
} from './service.js';
import { ingressMtlsConfigs } from '../../db/schema.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { syncRouteAnnotations } from '../ingress-routes/annotation-sync.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

function actingUserId(request: FastifyRequest): string | null {
  // request.user is set by `authenticate`. Different deployments use
  // different shapes — pick the first stable id field present.
  // `||` (not `??`) so empty-string ids are treated as missing.
  const u = (request as unknown as { user?: { id?: string; sub?: string } }).user;
  return (u?.id || u?.sub) ?? null;
}

export async function mtlsProvidersRoutes(app: FastifyInstance): Promise<void> {
  // Fail-closed: refuse to register the routes plugin if the at-rest
  // encryption key is missing. Falling back to a constant key would
  // silently encrypt CA private keys under known plaintext — a
  // DB-leak attacker would recover every CA private key.
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY
    ?? process.env.OIDC_ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error(
      'OIDC_ENCRYPTION_KEY is required (≥32 chars) — mTLS providers refuse to start with a null/short encryption key',
    );
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'client_admin'));
  // requireClientAccess gates every URL with a :clientId param so a
  // client_admin JWT for tenant A cannot pivot to tenant B. Admin /
  // super_admin tokens (no clientId claim) bypass this check and can
  // operate on any tenant — that's the platform-operator escape hatch.
  app.addHook('onRequest', requireClientAccess());

  // Public base URL for the CRL distribution point. Derived from
  // configuration, NOT request headers — trusting X-Forwarded-Host
  // would let a hostile client return an attacker-controlled URL to
  // the next caller of GET /crl, which the UI displays as a copyable
  // link. Falls back to the request's own scheme+host only when no
  // PUBLIC_URL is configured (dev/local).
  const publicBaseUrl =
    app.config?.PUBLIC_URL
    ?? process.env.PUBLIC_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? null;

  function crlPublicUrl(clientId: string, providerId: string, request: FastifyRequest): string {
    if (publicBaseUrl) {
      return `${publicBaseUrl.replace(/\/$/, '')}/api/v1/clients/${clientId}/mtls-providers/${providerId}/crl.pem`;
    }
    // Dev fallback. Logged once at startup below.
    const proto = request.protocol;
    const host = request.headers.host ?? 'localhost';
    return `${proto}://${host}/api/v1/clients/${clientId}/mtls-providers/${providerId}/crl.pem`;
  }
  if (!publicBaseUrl) {
    app.log.warn('PUBLIC_URL is not set — CRL distribution URLs will be derived from the request Host header. This is OK for local dev only.');
  }

  app.get('/clients/:clientId/mtls-providers', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const rows = await listProviders(app.db, clientId);
    return success(rows);
  });

  app.post('/clients/:clientId/mtls-providers', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = mtlsProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const created = await createProvider(app.db, encryptionKey, clientId, parsed.data);
    return success(created);
  });

  app.patch('/clients/:clientId/mtls-providers/:pid', async (request) => {
    const { clientId, pid } = request.params as { clientId: string; pid: string };
    const parsed = mtlsProviderUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await updateProvider(app.db, encryptionKey, clientId, pid, parsed.data);
    return success(updated);
  });

  app.delete('/clients/:clientId/mtls-providers/:pid', async (request) => {
    const { clientId, pid } = request.params as { clientId: string; pid: string };
    await deleteProvider(app.db, clientId, pid);
    return success({ deleted: true });
  });

  // Issue a fresh user cert from this provider's CA. The cert + key
  // are returned ONCE; the private key is never persisted server-side.
  // The cert itself is now persisted (as of v2) for audit + revocation.
  app.post('/clients/:clientId/mtls-providers/:pid/issue-cert', async (request) => {
    const { clientId, pid } = request.params as { clientId: string; pid: string };
    const parsed = mtlsIssueCertInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const issued = await issueUserCert(app.db, encryptionKey, clientId, pid, parsed.data);
    return success(issued);
  });

  app.get('/clients/:clientId/mtls-providers/:pid/certificates', async (request) => {
    const { clientId, pid } = request.params as { clientId: string; pid: string };
    const parsed = listCertificatesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await listCertificates(app.db, clientId, pid, parsed.data);
    return success(result);
  });

  app.get('/clients/:clientId/mtls-providers/:pid/certificates/:certId', async (request) => {
    const { clientId, pid, certId } = request.params as { clientId: string; pid: string; certId: string };
    const row = await getCertificate(app.db, clientId, pid, certId);
    return success(row);
  });

  app.get('/clients/:clientId/mtls-providers/:pid/certificates/:certId/pem', async (request, reply) => {
    const { clientId, pid, certId } = request.params as { clientId: string; pid: string; certId: string };
    const { certPem, serialHex, subjectCn } =
      await getCertificatePem(app.db, encryptionKey, clientId, pid, certId);
    // RFC 8555 — application/x-pem-file is the canonical type. Use a
    // Content-Disposition so browsers offer a clean filename.
    // Cache-Control: private,no-store because the response body is a
    // user-scoped credential — must not be cached by intermediaries.
    const safeCn = subjectCn.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'client';
    reply
      .header('Content-Type', 'application/x-pem-file')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="${safeCn}-${serialHex.slice(0, 8)}.pem"`);
    return certPem;
  });

  // Fan out annotation-sync to every route that consumes this provider
  // so the freshly-regenerated CRL lands in each route-mtls-* Secret
  // immediately. The service layer can't do this directly (no K8s
  // client by design — avoids cyclic deps). Used by revoke / unrevoke
  // / delete-cert: all three change the CRL membership and need to be
  // pushed to NGINX in the same request. Best-effort: K8s errors are
  // logged but don't fail the API call; the periodic reconciler will
  // pick up any laggards.
  async function fanOutCrlReconcile(clientId: string, providerId: string, action: string): Promise<void> {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8s = createK8sClients(kubeconfigPath);
      const consumers = await app.db
        .select({ routeId: ingressMtlsConfigs.ingressRouteId })
        .from(ingressMtlsConfigs)
        .where(eq(ingressMtlsConfigs.providerId, providerId));
      for (const c of consumers) {
        try {
          await syncRouteAnnotations(app.db, k8s, c.routeId, clientId);
        } catch (err) {
          app.log.warn({ err, routeId: c.routeId, providerId, action }, `mtls-${action}: failed to push CRL to route`);
        }
      }
    } catch (err) {
      // K8s client unavailable (no kubeconfig in tests / local dev).
      app.log.debug({ err, action }, `mtls-${action}: K8s reconcile skipped`);
    }
  }

  app.post('/clients/:clientId/mtls-providers/:pid/certificates/:certId/revoke', async (request) => {
    const { clientId, pid, certId } = request.params as { clientId: string; pid: string; certId: string };
    const parsed = revokeCertificateInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await revokeCertificate(
      app.db,
      clientId,
      pid,
      certId,
      parsed.data.reason,
      actingUserId(request),
    );
    await fanOutCrlReconcile(clientId, pid, 'revoke');
    return success(result);
  });

  app.post('/clients/:clientId/mtls-providers/:pid/certificates/:certId/unrevoke', async (request) => {
    const { clientId, pid, certId } = request.params as { clientId: string; pid: string; certId: string };
    const result = await unrevokeCertificate(app.db, clientId, pid, certId);
    await fanOutCrlReconcile(clientId, pid, 'unrevoke');
    return success(result);
  });

  app.delete('/clients/:clientId/mtls-providers/:pid/certificates/:certId', async (request, reply) => {
    const { clientId, pid, certId } = request.params as { clientId: string; pid: string; certId: string };
    await deleteCertificate(app.db, clientId, pid, certId);
    await fanOutCrlReconcile(clientId, pid, 'delete');
    reply.status(204);
    return null;
  });

  // CRL metadata (JSON). The /crl.pem sibling below serves the raw body.
  app.get('/clients/:clientId/mtls-providers/:pid/crl', async (request) => {
    const { clientId, pid } = request.params as { clientId: string; pid: string };
    const meta = await getCrlMetadata(app.db, clientId, pid, crlPublicUrl(clientId, pid, request));
    return success(meta);
  });

  app.get('/clients/:clientId/mtls-providers/:pid/crl.pem', async (request, reply) => {
    const { clientId, pid } = request.params as { clientId: string; pid: string };
    const { crlPem, crlNumber, lastGeneratedAt } =
      await getOrGenerateCrl(app.db, encryptionKey, clientId, pid);
    // Cache for 1 minute — long enough to absorb burst lookups, short
    // enough that a revocation propagates within the next reconcile
    // sweep (annotation-sync runs every 30s by default). ETag keys on
    // provider id + CRL number; both are globally unique, so the
    // header validates correctly across replicas.
    reply
      .header('Content-Type', 'application/x-pem-file')
      .header('Cache-Control', 'public, max-age=60')
      .header('ETag', `"crl-${pid}-${crlNumber}"`)
      .header('Last-Modified', lastGeneratedAt.toUTCString());
    return crlPem;
  });
}
