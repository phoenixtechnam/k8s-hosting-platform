/**
 * Per-ingress mTLS access-control service.
 *
 * Mode B of the multi-mode access design. Stores the CA bundle
 * encrypted at rest (re-using OIDC_ENCRYPTION_KEY for v1) and
 * computes a fingerprint + Subject + notAfter on upload for UI
 * display. The CA bundle itself is never returned to the client —
 * the response only flags `caCertSet`.
 *
 * The reconciler (annotation-sync extension) materialises the CA
 * bundle as a K8s Secret in the client namespace and adds the
 * `auth-tls-*` annotations to the tenant Ingress.
 */

import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ingressMtlsConfigs, ingressRoutes } from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { IngressMtlsConfig } from '../../db/schema.js';

export interface IngressMtlsConfigInput {
  readonly enabled: boolean;
  readonly caCertPem?: string;
  readonly verifyMode?: 'on' | 'optional' | 'optional_no_ca';
  readonly subjectRegex?: string | null;
  readonly passCertToUpstream?: boolean;
  readonly passDnToUpstream?: boolean;
}

export interface IngressMtlsConfigResponse {
  readonly enabled: boolean;
  readonly caCertSet: boolean;
  readonly caCertFingerprint: string | null;
  readonly caCertSubject: string | null;
  readonly caCertExpiresAt: string | null;
  readonly verifyMode: 'on' | 'optional' | 'optional_no_ca';
  readonly subjectRegex: string | null;
  readonly passCertToUpstream: boolean;
  readonly passDnToUpstream: boolean;
  readonly lastError: string | null;
  readonly lastReconciledAt: string | null;
}

interface CaCertMetadata {
  readonly fingerprint: string;
  readonly subject: string;
  readonly expiresAt: Date;
}

/**
 * Parse a PEM bundle (which may contain root + intermediates) and
 * extract metadata from the FIRST certificate. Returns null when
 * parsing fails — the caller treats that as a 422 Bad Request.
 */
export function parseCaCert(pem: string): CaCertMetadata | null {
  // Match the first BEGIN/END CERTIFICATE block. node:crypto's
  // X509Certificate constructor only accepts a single cert, not a
  // bundle, so we slice out the first one for metadata.
  const match = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  );
  if (!match) return null;
  try {
    const cert = new X509Certificate(match[0]);
    const der = cert.raw;
    const fingerprint = createHash('sha256').update(der).digest('hex');
    return {
      fingerprint,
      subject: cert.subject,
      expiresAt: new Date(cert.validTo),
    };
  } catch {
    return null;
  }
}

export async function getMtlsConfig(
  db: Database,
  routeId: string,
): Promise<IngressMtlsConfigResponse | null> {
  const [row] = await db
    .select()
    .from(ingressMtlsConfigs)
    .where(eq(ingressMtlsConfigs.ingressRouteId, routeId));
  if (!row) return null;
  return rowToResponse(row);
}

export async function upsertMtlsConfig(
  db: Database,
  encryptionKey: string,
  routeId: string,
  input: IngressMtlsConfigInput,
): Promise<IngressMtlsConfigResponse> {
  // Validate the route exists upfront so we return a clean 404 rather
  // than a generic FK violation.
  const [route] = await db
    .select()
    .from(ingressRoutes)
    .where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('INGRESS_ROUTE_NOT_FOUND', 'ingress route not found', 404);
  }

  // Optionally decode + validate the CA bundle. When omitted, we
  // preserve the existing one (or remain unset for a brand-new row).
  let caMetadata: CaCertMetadata | null = null;
  let caCertEncrypted: string | null | undefined;
  if (input.caCertPem !== undefined) {
    if (!input.caCertPem) {
      // Explicit empty string = clear the cert
      caCertEncrypted = null;
    } else {
      caMetadata = parseCaCert(input.caCertPem);
      if (!caMetadata) {
        throw new ApiError('INVALID_CA_CERT', 'CA bundle could not be parsed as PEM', 422);
      }
      caCertEncrypted = encrypt(input.caCertPem, encryptionKey);
    }
  }

  // enabled=true requires a CA cert on file (either uploaded now or
  // already stored). Otherwise we'd silently render an Ingress with
  // an `auth-tls-secret` annotation pointing at an empty Secret.
  const [existing] = await db
    .select()
    .from(ingressMtlsConfigs)
    .where(eq(ingressMtlsConfigs.ingressRouteId, routeId));
  const willHaveCert = caCertEncrypted !== null
    && (caCertEncrypted !== undefined || existing?.caCertPemEncrypted);
  if (input.enabled && !willHaveCert) {
    throw new ApiError(
      'CA_CERT_REQUIRED',
      'CA bundle must be uploaded before enabling mTLS',
      422,
    );
  }

  const now = new Date();
  const next = {
    enabled: input.enabled,
    verifyMode: input.verifyMode ?? existing?.verifyMode ?? 'on',
    subjectRegex:
      input.subjectRegex !== undefined ? input.subjectRegex : (existing?.subjectRegex ?? null),
    passCertToUpstream:
      input.passCertToUpstream ?? existing?.passCertToUpstream ?? false,
    passDnToUpstream: input.passDnToUpstream ?? existing?.passDnToUpstream ?? true,
    updatedAt: now,
    lastError: null as string | null,
  };

  if (existing) {
    await db
      .update(ingressMtlsConfigs)
      .set({
        ...next,
        ...(caCertEncrypted !== undefined ? { caCertPemEncrypted: caCertEncrypted } : {}),
        ...(caMetadata
          ? {
              caCertFingerprint: caMetadata.fingerprint,
              caCertSubject: caMetadata.subject,
              caCertExpiresAt: caMetadata.expiresAt,
            }
          : caCertEncrypted === null
            ? { caCertFingerprint: null, caCertSubject: null, caCertExpiresAt: null }
            : {}),
      })
      .where(eq(ingressMtlsConfigs.ingressRouteId, routeId));
  } else {
    await db.insert(ingressMtlsConfigs).values({
      id: randomUUID(),
      ingressRouteId: routeId,
      caCertPemEncrypted: caCertEncrypted ?? null,
      caCertFingerprint: caMetadata?.fingerprint ?? null,
      caCertSubject: caMetadata?.subject ?? null,
      caCertExpiresAt: caMetadata?.expiresAt ?? null,
      ...next,
    });
  }

  const result = await getMtlsConfig(db, routeId);
  if (!result) {
    throw new ApiError('INTERNAL_ERROR', 'mTLS config disappeared after upsert', 500);
  }
  return result;
}

export async function deleteMtlsConfig(db: Database, routeId: string): Promise<void> {
  await db.delete(ingressMtlsConfigs).where(eq(ingressMtlsConfigs.ingressRouteId, routeId));
}

/**
 * Reconciler-facing: load an enabled config (with the decrypted CA
 * bundle ready for Secret materialisation). Returns null when no
 * config exists or the config is disabled.
 */
export async function loadEnabledForRoute(
  db: Database,
  encryptionKey: string,
  routeId: string,
): Promise<{ config: IngressMtlsConfig; caCertPem: string } | null> {
  const [row] = await db
    .select()
    .from(ingressMtlsConfigs)
    .where(eq(ingressMtlsConfigs.ingressRouteId, routeId));
  if (!row || !row.enabled || !row.caCertPemEncrypted) return null;
  return {
    config: row,
    caCertPem: decrypt(row.caCertPemEncrypted, encryptionKey),
  };
}

function rowToResponse(row: IngressMtlsConfig): IngressMtlsConfigResponse {
  return {
    enabled: row.enabled,
    caCertSet: row.caCertPemEncrypted !== null,
    caCertFingerprint: row.caCertFingerprint,
    caCertSubject: row.caCertSubject,
    caCertExpiresAt: row.caCertExpiresAt?.toISOString() ?? null,
    verifyMode: row.verifyMode as 'on' | 'optional' | 'optional_no_ca',
    subjectRegex: row.subjectRegex,
    passCertToUpstream: row.passCertToUpstream,
    passDnToUpstream: row.passDnToUpstream,
    lastError: row.lastError,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
  };
}
