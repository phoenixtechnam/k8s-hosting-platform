/**
 * Per-client mTLS provider service. Stores reusable CA cert + optional
 * private key (encrypted at rest using OIDC_ENCRYPTION_KEY for v1).
 *
 * As of migration 0097 this module also owns the `client_certificates`
 * lifecycle:
 *   * issueUserCert persists each issued cert (PEM encrypted, key NEVER
 *     stored) for audit + future revocation.
 *   * revokeCertificate marks revokedAt + reason, bumps the provider's
 *     crl_number, and invalidates the cached CRL.
 *   * getOrGenerateCrl rebuilds the CRL PEM from the revoked-cert set
 *     when the cache is empty; otherwise serves the cached body.
 */

import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { eq, and, sql, desc, lt, isNotNull, isNull, inArray } from 'drizzle-orm';
import {
  clientCertificates,
  clientMtlsProviders,
  ingressMtlsConfigs,
  ingressRoutes,
} from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import { generateSelfSignedCa, signClientCert, bundlePkcs12, generateCrl } from './cert-ops.js';
import type { CrlRevokedEntry, CrlReason } from './cert-ops.js';
import type { Database } from '../../db/index.js';
import type {
  MtlsProviderInput,
  MtlsProviderUpdate,
  MtlsProviderResponse,
  MtlsIssueCertInput,
  MtlsIssueCertResponse,
  CertificateResponse,
  CertificateStatus,
  CertificateRevocationReason,
  ListCertificatesQuery,
  ListCertificatesResponse,
  CrlMetadataResponse,
} from '@k8s-hosting/api-contracts';

/** Defaults for CRL generation. CRL validity 7d strikes a balance between
 *  ingress re-fetch frequency and propagation latency for new revocations. */
const CRL_VALIDITY_DAYS = 7;

/**
 * RFC 5280 CRLReason — symbolic strings. Mirrors
 * certificateRevocationReasonSchema in the API contract; kept locally
 * so we can validate values returned from the DB at the boundary
 * (defense in depth in case a column was hand-edited).
 */
const VALID_CRL_REASONS = new Set<CrlReason>([
  'unspecified', 'keyCompromise', 'caCompromise', 'affiliationChanged',
  'superseded', 'cessationOfOperation', 'certificateHold',
  'privilegeWithdrawn', 'aaCompromise',
]);

function normaliseCrlReason(raw: string | null): CrlReason {
  if (raw && VALID_CRL_REASONS.has(raw as CrlReason)) {
    return raw as CrlReason;
  }
  return 'unspecified';
}

const VALID_REVOCATION_REASONS: ReadonlySet<CertificateRevocationReason> = new Set([
  'unspecified', 'keyCompromise', 'caCompromise', 'affiliationChanged',
  'superseded', 'cessationOfOperation', 'privilegeWithdrawn',
  'aaCompromise',
]);

function normaliseRevocationReason(raw: string | null): CertificateRevocationReason | null {
  if (raw === null) return null;
  if (VALID_REVOCATION_REASONS.has(raw as CertificateRevocationReason)) {
    return raw as CertificateRevocationReason;
  }
  // Unknown stored reason — coerce to 'unspecified' rather than
  // throwing or surfacing the raw string to the client.
  return 'unspecified';
}

interface CaCertMetadata {
  readonly fingerprint: string;
  readonly subject: string;
  readonly expiresAt: Date;
}

function parseCaMetadata(pem: string): CaCertMetadata {
  const match = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  );
  if (!match) {
    throw new ApiError('INVALID_CA_CERT', 'CA bundle could not be parsed as PEM', 422);
  }
  try {
    const cert = new X509Certificate(match[0]);
    return {
      fingerprint: createHash('sha256').update(cert.raw).digest('hex'),
      subject: cert.subject,
      expiresAt: new Date(cert.validTo),
    };
  } catch (err) {
    throw new ApiError(
      'INVALID_CA_CERT',
      `CA cert parse failed: ${err instanceof Error ? err.message : String(err)}`,
      422,
    );
  }
}

export async function listProviders(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<MtlsProviderResponse>> {
  const rows = await db
    .select({
      id: clientMtlsProviders.id,
      name: clientMtlsProviders.name,
      caCertFingerprint: clientMtlsProviders.caCertFingerprint,
      caCertSubject: clientMtlsProviders.caCertSubject,
      caCertExpiresAt: clientMtlsProviders.caCertExpiresAt,
      canIssue: clientMtlsProviders.canIssue,
      createdAt: clientMtlsProviders.createdAt,
      updatedAt: clientMtlsProviders.updatedAt,
      consumerCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${ingressMtlsConfigs}
        WHERE ${ingressMtlsConfigs.providerId} = ${clientMtlsProviders.id}
      )`,
    })
    .from(clientMtlsProviders)
    .where(eq(clientMtlsProviders.clientId, clientId));

  // Bulk-fetch consumers in one query so the per-provider mapping is
  // O(N) instead of an N+1 SELECT per provider.
  const providerIds = rows.map((r) => r.id);
  const consumers = providerIds.length > 0
    ? await db
      .select({
        providerId: ingressMtlsConfigs.providerId,
        routeId: ingressRoutes.id,
        hostname: ingressRoutes.hostname,
      })
      .from(ingressMtlsConfigs)
      .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressMtlsConfigs.ingressRouteId))
      .where(inArray(ingressMtlsConfigs.providerId, providerIds))
    : [];

  const byProvider = new Map<string, Array<{ routeId: string; hostname: string }>>();
  for (const c of consumers) {
    if (!c.providerId) continue;
    const arr = byProvider.get(c.providerId) ?? [];
    arr.push({ routeId: c.routeId, hostname: c.hostname });
    byProvider.set(c.providerId, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    caCertFingerprint: r.caCertFingerprint,
    caCertSubject: r.caCertSubject,
    caCertExpiresAt: r.caCertExpiresAt.toISOString(),
    canIssue: r.canIssue,
    consumerCount: r.consumerCount,
    consumers: byProvider.get(r.id) ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function createProvider(
  db: Database,
  encryptionKey: string,
  clientId: string,
  input: MtlsProviderInput,
): Promise<MtlsProviderResponse> {
  let caCertPem: string;
  let caKeyPem: string | undefined;

  if (input.source === 'upload') {
    caCertPem = input.caCertPem;
    caKeyPem = input.caKeyPem;
  } else {
    // Generate a new self-signed CA + key. Both stay encrypted in DB;
    // the operator never sees the key, but the issue-user-cert action
    // can sign new client certs with it.
    const generated = await generateSelfSignedCa({
      commonName: input.commonName,
      organization: input.organization,
      validityDays: input.validityDays,
    });
    caCertPem = generated.certPem;
    caKeyPem = generated.keyPem;
  }

  const meta = parseCaMetadata(caCertPem);
  const id = randomUUID();
  await db.insert(clientMtlsProviders).values({
    id,
    clientId,
    name: input.name,
    caCertPemEncrypted: encrypt(caCertPem, encryptionKey),
    caKeyPemEncrypted: caKeyPem ? encrypt(caKeyPem, encryptionKey) : null,
    caCertFingerprint: meta.fingerprint,
    caCertSubject: meta.subject,
    caCertExpiresAt: meta.expiresAt,
    canIssue: Boolean(caKeyPem),
  });
  const all = await listProviders(db, clientId);
  const created = all.find((p) => p.id === id);
  if (!created) {
    throw new ApiError('INTERNAL_ERROR', 'provider disappeared after insert', 500);
  }
  return created;
}

export async function updateProvider(
  db: Database,
  encryptionKey: string,
  clientId: string,
  providerId: string,
  input: MtlsProviderUpdate,
): Promise<MtlsProviderResponse> {
  const [existing] = await db
    .select()
    .from(clientMtlsProviders)
    .where(and(eq(clientMtlsProviders.id, providerId), eq(clientMtlsProviders.clientId, clientId)));
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'mTLS provider not found', 404);
  }
  const update: Partial<typeof clientMtlsProviders.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) update.name = input.name;
  if (input.caCertPem !== undefined) {
    const meta = parseCaMetadata(input.caCertPem);
    update.caCertPemEncrypted = encrypt(input.caCertPem, encryptionKey);
    update.caCertFingerprint = meta.fingerprint;
    update.caCertSubject = meta.subject;
    update.caCertExpiresAt = meta.expiresAt;
  }
  if (input.caKeyPem !== undefined) {
    if (input.caKeyPem === '') {
      update.caKeyPemEncrypted = null;
      update.canIssue = false;
    } else {
      update.caKeyPemEncrypted = encrypt(input.caKeyPem, encryptionKey);
      update.canIssue = true;
    }
  }
  await db
    .update(clientMtlsProviders)
    .set(update)
    .where(eq(clientMtlsProviders.id, providerId));
  const all = await listProviders(db, clientId);
  const updated = all.find((p) => p.id === providerId);
  if (!updated) {
    throw new ApiError('INTERNAL_ERROR', 'provider disappeared after update', 500);
  }
  return updated;
}

export async function deleteProvider(
  db: Database,
  clientId: string,
  providerId: string,
): Promise<void> {
  const consumers = await db
    .select()
    .from(ingressMtlsConfigs)
    .where(eq(ingressMtlsConfigs.providerId, providerId));
  if (consumers.length > 0) {
    throw new ApiError(
      'PROVIDER_IN_USE',
      `Provider is referenced by ${consumers.length} ingress(es); detach them first`,
      409,
    );
  }
  await db
    .delete(clientMtlsProviders)
    .where(and(eq(clientMtlsProviders.id, providerId), eq(clientMtlsProviders.clientId, clientId)));
}

export async function issueUserCert(
  db: Database,
  encryptionKey: string,
  clientId: string,
  providerId: string,
  input: MtlsIssueCertInput,
): Promise<MtlsIssueCertResponse> {
  const [provider] = await db
    .select()
    .from(clientMtlsProviders)
    .where(and(eq(clientMtlsProviders.id, providerId), eq(clientMtlsProviders.clientId, clientId)));
  if (!provider) {
    throw new ApiError('NOT_FOUND', 'mTLS provider not found', 404);
  }
  if (!provider.caKeyPemEncrypted || !provider.canIssue) {
    throw new ApiError(
      'PROVIDER_CANNOT_ISSUE',
      'Provider has no CA private key on file. Upload one or generate a new provider first.',
      422,
    );
  }
  const caCertPem = decrypt(provider.caCertPemEncrypted, encryptionKey);
  const caKeyPem = decrypt(provider.caKeyPemEncrypted, encryptionKey);
  const signed = await signClientCert({
    caCertPem,
    caKeyPem,
    commonName: input.commonName,
    organization: input.organization,
    organizationalUnit: input.organizationalUnit,
    validityDays: input.validityDays,
  });

  // Optional PKCS#12 bundle for Windows / macOS keychain import.
  // Triggered by `pkcs12: true` OR (legacy compat) a non-empty
  // pkcs12Password. Password is optional — empty string produces a
  // passwordless .p12 which Windows 10/11 + macOS 11+ accept.
  //
  // We build the bundle BEFORE the DB insert so a build failure
  // (e.g. openssl edge case on a particular password) can't leave a
  // dangling cert row that has no .p12 next to it. The operator
  // retries the issuance and gets a single row, not duplicates.
  let pkcs12Base64: string | null = null;
  const wantPkcs12 = input.pkcs12 === true
    || (typeof input.pkcs12Password === 'string' && input.pkcs12Password.length > 0);
  if (wantPkcs12) {
    const bundle = await bundlePkcs12({
      certPem: signed.certPem,
      keyPem: signed.keyPem,
      caCertPem,
      password: input.pkcs12Password ?? '',
      friendlyName: input.commonName,
    });
    pkcs12Base64 = Buffer.from(bundle).toString('base64');
  }

  // Persist the cert (PEM encrypted) so the operator can audit/revoke
  // it later. Private key is NEVER persisted — it's returned once in
  // the response and the operator alone is responsible for it.
  const certRowId = randomUUID();
  await db.insert(clientCertificates).values({
    id: certRowId,
    providerId: provider.id,
    clientId,
    serialHex: signed.serialHex,
    certPemEncrypted: encrypt(signed.certPem, encryptionKey),
    certFingerprintSha256: signed.fingerprintSha256,
    subjectCn: input.commonName.slice(0, 255),
    subjectFull: signed.subject.slice(0, 500),
    issuedAt: new Date(),
    expiresAt: signed.expiresAt,
  });

  return {
    id: certRowId,
    serialHex: signed.serialHex,
    certPem: signed.certPem,
    keyPem: signed.keyPem,
    caCertPem,
    subject: signed.subject,
    expiresAt: signed.expiresAt.toISOString(),
    pkcs12Base64,
  };
}

/**
 * Reconciler-facing: load the decrypted CA cert for a provider. Used
 * by annotation-sync to materialise the Secret on the tenant Ingress
 * when an mTLS config references this provider.
 */
export async function loadProviderCaCert(
  db: Database,
  encryptionKey: string,
  providerId: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(clientMtlsProviders)
    .where(eq(clientMtlsProviders.id, providerId));
  if (!row) return null;
  return decrypt(row.caCertPemEncrypted, encryptionKey);
}

// ─── Cert lifecycle (added in v2) ───────────────────────────────────

function deriveStatus(row: { revokedAt: Date | null; expiresAt: Date }, now: Date): CertificateStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() < now.getTime()) return 'expired';
  return 'active';
}

function toCertificateResponse(
  row: {
    id: string;
    providerId: string;
    serialHex: string;
    certFingerprintSha256: string;
    subjectCn: string;
    subjectFull: string;
    issuedAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    revocationReason: string | null;
    revokedByUserId: string | null;
  },
  now: Date,
): CertificateResponse {
  return {
    id: row.id,
    providerId: row.providerId,
    serialHex: row.serialHex,
    fingerprintSha256: row.certFingerprintSha256,
    subjectCn: row.subjectCn,
    subjectFull: row.subjectFull,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revocationReason: normaliseRevocationReason(row.revocationReason),
    revokedByUserId: row.revokedByUserId,
    status: deriveStatus(row, now),
  };
}

async function ensureProviderScope(
  db: Database,
  clientId: string,
  providerId: string,
): Promise<void> {
  const [provider] = await db
    .select({ id: clientMtlsProviders.id })
    .from(clientMtlsProviders)
    .where(and(
      eq(clientMtlsProviders.id, providerId),
      eq(clientMtlsProviders.clientId, clientId),
    ));
  if (!provider) {
    throw new ApiError('NOT_FOUND', 'mTLS provider not found', 404);
  }
}

export async function listCertificates(
  db: Database,
  clientId: string,
  providerId: string,
  query: ListCertificatesQuery,
): Promise<ListCertificatesResponse> {
  await ensureProviderScope(db, clientId, providerId);
  const now = new Date();
  // Filter by status. "active"/"expired" both have revokedAt IS NULL;
  // we discriminate by expiresAt relative to now. "revoked" has
  // revokedAt IS NOT NULL.
  const baseFilter = eq(clientCertificates.providerId, providerId);
  let statusFilter;
  if (query.status === 'revoked') {
    statusFilter = isNotNull(clientCertificates.revokedAt);
  } else if (query.status === 'active') {
    statusFilter = and(
      isNull(clientCertificates.revokedAt),
      sql`${clientCertificates.expiresAt} >= ${now}`,
    );
  } else if (query.status === 'expired') {
    statusFilter = and(
      isNull(clientCertificates.revokedAt),
      lt(clientCertificates.expiresAt, now),
    );
  }
  const where = statusFilter ? and(baseFilter, statusFilter) : baseFilter;

  // Cursor-based pagination: cursor is the issuedAt ISO of the last
  // row returned; we order by issued_at DESC then id DESC to break ties.
  const limit = query.limit ?? 50;
  let cursorFilter;
  if (query.cursor) {
    const ts = new Date(query.cursor);
    if (Number.isNaN(ts.getTime())) {
      throw new ApiError('VALIDATION_ERROR', 'cursor must be an ISO-8601 timestamp', 400);
    }
    cursorFilter = lt(clientCertificates.issuedAt, ts);
  }
  const finalWhere = cursorFilter ? and(where, cursorFilter) : where;
  const rows = await db
    .select()
    .from(clientCertificates)
    .where(finalWhere)
    .orderBy(desc(clientCertificates.issuedAt), desc(clientCertificates.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const items = trimmed.map((r) => toCertificateResponse(r, now));
  const nextCursor = hasMore && trimmed.length > 0
    ? trimmed[trimmed.length - 1].issuedAt.toISOString()
    : null;
  return { items, nextCursor };
}

export async function getCertificate(
  db: Database,
  clientId: string,
  providerId: string,
  certId: string,
): Promise<CertificateResponse> {
  await ensureProviderScope(db, clientId, providerId);
  const [row] = await db
    .select()
    .from(clientCertificates)
    .where(and(
      eq(clientCertificates.id, certId),
      eq(clientCertificates.providerId, providerId),
    ));
  if (!row) {
    throw new ApiError('NOT_FOUND', 'certificate not found', 404);
  }
  return toCertificateResponse(row, new Date());
}

/**
 * Re-download the encrypted cert PEM. Private key is NOT recoverable —
 * it was returned once at issuance.
 */
export async function getCertificatePem(
  db: Database,
  encryptionKey: string,
  clientId: string,
  providerId: string,
  certId: string,
): Promise<{ certPem: string; serialHex: string; subjectCn: string }> {
  await ensureProviderScope(db, clientId, providerId);
  const [row] = await db
    .select()
    .from(clientCertificates)
    .where(and(
      eq(clientCertificates.id, certId),
      eq(clientCertificates.providerId, providerId),
    ));
  if (!row) {
    throw new ApiError('NOT_FOUND', 'certificate not found', 404);
  }
  return {
    certPem: decrypt(row.certPemEncrypted, encryptionKey),
    serialHex: row.serialHex,
    subjectCn: row.subjectCn,
  };
}

/**
 * Hard-delete a certificate. Removes the row and invalidates the CRL
 * cache so the next regeneration omits this serial. Implicitly
 * "un-revokes" a previously revoked cert from the CRL's perspective —
 * a relying party that re-fetches the CRL will no longer see this
 * serial listed, so a still-extant cert+key pair (in the wild) regains
 * access. The route handler enforces an explicit confirmation in the
 * UI; here we just do what's asked.
 *
 * Idempotent: deleting a non-existent cert returns silently.
 */
export async function deleteCertificate(
  db: Database,
  clientId: string,
  providerId: string,
  certId: string,
): Promise<void> {
  await ensureProviderScope(db, clientId, providerId);
  const now = new Date();
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(clientCertificates)
      .where(and(
        eq(clientCertificates.id, certId),
        eq(clientCertificates.providerId, providerId),
      ))
      .returning({ id: clientCertificates.id, revokedAt: clientCertificates.revokedAt });
    if (deleted.length === 0) {
      // Already gone — idempotent.
      return;
    }
    // Only invalidate the CRL if the deleted cert was revoked (i.e. it
    // was actually in the CRL). For an active cert deletion, the CRL is
    // unchanged.
    if (deleted[0].revokedAt) {
      await tx
        .update(clientMtlsProviders)
        .set({
          crlNumber: sql`${clientMtlsProviders.crlNumber} + 1`,
          crlPem: null,
          crlLastGeneratedAt: null,
          updatedAt: now,
        })
        .where(eq(clientMtlsProviders.id, providerId));
      await tx
        .update(ingressMtlsConfigs)
        .set({ updatedAt: now })
        .where(eq(ingressMtlsConfigs.providerId, providerId));
    }
  });
}

/**
 * Reverse a revocation. NULLs out `revoked_at`, `revocation_reason`,
 * and `revoked_by_user_id`. Bumps `crl_number` and invalidates the
 * cached CRL so the next regeneration omits the serial.
 *
 * Use case: revoked-by-mistake recovery. Per RFC 5280 §5.3.1 this maps
 * to CRLReason 8 (`removeFromCRL`); we don't surface that wire-format
 * code because we never emit it — the relying party just observes the
 * serial vanish from subsequent CRLs.
 *
 * No-op (returns the existing row) when the cert is already active.
 */
export async function unrevokeCertificate(
  db: Database,
  clientId: string,
  providerId: string,
  certId: string,
): Promise<CertificateResponse> {
  await ensureProviderScope(db, clientId, providerId);
  const [existing] = await db
    .select()
    .from(clientCertificates)
    .where(and(
      eq(clientCertificates.id, certId),
      eq(clientCertificates.providerId, providerId),
    ));
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'certificate not found', 404);
  }
  if (!existing.revokedAt) {
    return toCertificateResponse(existing, new Date());
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(clientCertificates)
      .set({
        revokedAt: null,
        revocationReason: null,
        revokedByUserId: null,
      })
      .where(eq(clientCertificates.id, certId));
    await tx
      .update(clientMtlsProviders)
      .set({
        crlNumber: sql`${clientMtlsProviders.crlNumber} + 1`,
        crlPem: null,
        crlLastGeneratedAt: null,
        updatedAt: now,
      })
      .where(eq(clientMtlsProviders.id, providerId));
  });

  await db
    .update(ingressMtlsConfigs)
    .set({ updatedAt: now })
    .where(eq(ingressMtlsConfigs.providerId, providerId));

  return getCertificate(db, clientId, providerId, certId);
}

export async function revokeCertificate(
  db: Database,
  clientId: string,
  providerId: string,
  certId: string,
  reason: CertificateRevocationReason,
  revokedByUserId: string | null,
): Promise<CertificateResponse> {
  await ensureProviderScope(db, clientId, providerId);
  const [existing] = await db
    .select()
    .from(clientCertificates)
    .where(and(
      eq(clientCertificates.id, certId),
      eq(clientCertificates.providerId, providerId),
    ));
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'certificate not found', 404);
  }
  if (existing.revokedAt) {
    // Idempotent — re-return the existing state instead of erroring.
    return toCertificateResponse(existing, new Date());
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(clientCertificates)
      .set({
        revokedAt: now,
        revocationReason: reason,
        revokedByUserId,
      })
      .where(eq(clientCertificates.id, certId));
    // Bump CRL number + invalidate cache. The reconciler will
    // regenerate the CRL on its next pass; reads go through
    // getOrGenerateCrl() which produces a fresh one lazily.
    await tx
      .update(clientMtlsProviders)
      .set({
        crlNumber: sql`${clientMtlsProviders.crlNumber} + 1`,
        crlPem: null,
        crlLastGeneratedAt: null,
        updatedAt: now,
      })
      .where(eq(clientMtlsProviders.id, providerId));
  });

  // Best-effort: enqueue reconciliation of every ingress route that
  // references this provider so the new CRL propagates to NGINX. The
  // service layer doesn't import the K8s client (avoids cyclic deps);
  // instead we touch ingress_mtls_configs.updated_at — annotation-sync
  // picks up the change in its next sweep.
  await db
    .update(ingressMtlsConfigs)
    .set({ updatedAt: now })
    .where(eq(ingressMtlsConfigs.providerId, providerId));

  return getCertificate(db, clientId, providerId, certId);
}

interface BuiltCrl {
  readonly crlPem: string;
  readonly crlNumber: number;
  readonly lastGeneratedAt: Date;
  readonly revokedCount: number;
}

/**
 * Single-source CRL builder. Wrapped in a transaction with
 * `SELECT ... FOR UPDATE` on the provider row so that two concurrent
 * lazy regenerations cannot both bump crl_number to the same value
 * (which would violate the X.509 CRL Number monotonicity invariant
 * required by RFC 5280 §5.1.2.3 and rejected by OpenSSL).
 *
 * Returns the cached PEM if present, otherwise generates a fresh one
 * inside the same lock and writes it back.
 */
async function buildOrLoadCrl(
  db: Database,
  encryptionKey: string,
  providerId: string,
): Promise<BuiltCrl | null> {
  return db.transaction(async (tx) => {
    // Lock the provider row. Drizzle's `.for('update')` translates
    // to `FOR UPDATE` on Postgres.
    const [provider] = await tx
      .select()
      .from(clientMtlsProviders)
      .where(eq(clientMtlsProviders.id, providerId))
      .for('update');
    if (!provider) return null;
    if (!provider.caKeyPemEncrypted) return null;

    // Count the revoked set under the same lock so the cache-hit
    // path returns a consistent revoked_count.
    const revokedRows = await tx
      .select({
        serialHex: clientCertificates.serialHex,
        revokedAt: clientCertificates.revokedAt,
        revocationReason: clientCertificates.revocationReason,
      })
      .from(clientCertificates)
      .where(and(
        eq(clientCertificates.providerId, providerId),
        isNotNull(clientCertificates.revokedAt),
      ));

    if (provider.crlPem && provider.crlLastGeneratedAt) {
      return {
        crlPem: provider.crlPem,
        crlNumber: provider.crlNumber,
        lastGeneratedAt: provider.crlLastGeneratedAt,
        revokedCount: revokedRows.length,
      };
    }

    const caCertPem = decrypt(provider.caCertPemEncrypted, encryptionKey);
    const caKeyPem = decrypt(provider.caKeyPemEncrypted, encryptionKey);
    const entries: CrlRevokedEntry[] = revokedRows
      .filter((r) => r.revokedAt !== null)
      .map((r) => ({
        serialHex: r.serialHex,
        revokedAt: r.revokedAt as Date,
        reason: normaliseCrlReason(r.revocationReason),
      }));
    const newCrlNumber = (provider.crlNumber ?? 0) + 1;
    const { crlPem } = await generateCrl({
      caCertPem,
      caKeyPem,
      crlNumber: newCrlNumber,
      validityDays: CRL_VALIDITY_DAYS,
      revokedEntries: entries,
    });
    const now = new Date();
    await tx
      .update(clientMtlsProviders)
      .set({
        crlPem,
        crlLastGeneratedAt: now,
        crlNumber: newCrlNumber,
        updatedAt: now,
      })
      .where(eq(clientMtlsProviders.id, providerId));
    return { crlPem, crlNumber: newCrlNumber, lastGeneratedAt: now, revokedCount: entries.length };
  });
}

/**
 * Return the CRL PEM for a provider, regenerating it from the
 * `client_certificates` table when the cache is empty. Tenant-scoped.
 *
 * Empty CRLs (no revocations on file) are still produced — they're
 * a valid signal "no revocations" to a relying party.
 */
export async function getOrGenerateCrl(
  db: Database,
  encryptionKey: string,
  clientId: string,
  providerId: string,
): Promise<BuiltCrl> {
  await ensureProviderScope(db, clientId, providerId);
  const built = await buildOrLoadCrl(db, encryptionKey, providerId);
  if (!built) {
    // Provider has no CA private key — can't sign a CRL.
    throw new ApiError(
      'PROVIDER_CANNOT_SIGN_CRL',
      'Provider has no CA private key on file — cannot sign a CRL. Upload the matching CA key first.',
      422,
    );
  }
  return built;
}

/**
 * Reconciler-facing: load the CRL PEM for a provider (regenerating
 * lazily if missing). Returns null when the provider has no CA key
 * (cannot sign), so the reconciler skips the ca.crl Secret key.
 */
export async function loadProviderCrlForReconciler(
  db: Database,
  encryptionKey: string,
  providerId: string,
): Promise<string | null> {
  const built = await buildOrLoadCrl(db, encryptionKey, providerId);
  return built?.crlPem ?? null;
}

export async function getCrlMetadata(
  db: Database,
  clientId: string,
  providerId: string,
  publicCrlUrl: string,
): Promise<CrlMetadataResponse> {
  await ensureProviderScope(db, clientId, providerId);
  const [provider] = await db
    .select({
      crlNumber: clientMtlsProviders.crlNumber,
      crlLastGeneratedAt: clientMtlsProviders.crlLastGeneratedAt,
    })
    .from(clientMtlsProviders)
    .where(eq(clientMtlsProviders.id, providerId));
  if (!provider) {
    throw new ApiError('NOT_FOUND', 'mTLS provider not found', 404);
  }
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(clientCertificates)
    .where(and(
      eq(clientCertificates.providerId, providerId),
      isNotNull(clientCertificates.revokedAt),
    ));
  return {
    crlNumber: provider.crlNumber,
    lastGeneratedAt: provider.crlLastGeneratedAt
      ? provider.crlLastGeneratedAt.toISOString()
      : null,
    revokedCount: n ?? 0,
    crlUrl: publicCrlUrl,
  };
}
