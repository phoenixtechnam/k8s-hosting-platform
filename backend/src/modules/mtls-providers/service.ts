/**
 * Per-client mTLS provider service. Stores reusable CA cert + optional
 * private key (encrypted at rest using OIDC_ENCRYPTION_KEY for v1).
 */

import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import {
  clientMtlsProviders,
  ingressMtlsConfigs,
} from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import { generateSelfSignedCa, signClientCert, bundlePkcs12 } from './cert-ops.js';
import type { Database } from '../../db/index.js';
import type {
  MtlsProviderInput,
  MtlsProviderUpdate,
  MtlsProviderResponse,
  MtlsIssueCertInput,
  MtlsIssueCertResponse,
} from '@k8s-hosting/api-contracts';

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
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    caCertFingerprint: r.caCertFingerprint,
    caCertSubject: r.caCertSubject,
    caCertExpiresAt: r.caCertExpiresAt.toISOString(),
    canIssue: r.canIssue,
    consumerCount: r.consumerCount,
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
  const { certPem, keyPem } = await signClientCert({
    caCertPem,
    caKeyPem,
    commonName: input.commonName,
    organization: input.organization,
    organizationalUnit: input.organizationalUnit,
    validityDays: input.validityDays,
  });
  const meta = parseCaMetadata(certPem);

  // Optional PKCS#12 bundle for Windows / macOS keychain import.
  // Triggered by `pkcs12: true` OR (legacy compat) a non-empty
  // pkcs12Password. Password is optional — empty string produces a
  // passwordless .p12 which Windows 10/11 + macOS 11+ accept.
  let pkcs12Base64: string | null = null;
  const wantPkcs12 = input.pkcs12 === true
    || (typeof input.pkcs12Password === 'string' && input.pkcs12Password.length > 0);
  if (wantPkcs12) {
    const bundle = await bundlePkcs12({
      certPem,
      keyPem,
      caCertPem,
      password: input.pkcs12Password ?? '',
      friendlyName: input.commonName,
    });
    pkcs12Base64 = Buffer.from(bundle).toString('base64');
  }

  return {
    certPem,
    keyPem,
    caCertPem,
    subject: meta.subject,
    expiresAt: meta.expiresAt.toISOString(),
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
