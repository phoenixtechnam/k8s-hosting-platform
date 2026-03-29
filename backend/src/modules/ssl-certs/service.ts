import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { sslCertificates, domains } from '../../db/schema.js';
import { encrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { UploadSslCertInput } from '@k8s-hosting/api-contracts';

function parseCertInfo(pem: string): {
  readonly issuer: string;
  readonly subject: string;
  readonly expiresAt: Date;
} {
  const cert = new crypto.X509Certificate(pem);
  return {
    issuer: cert.issuer,
    subject: cert.subject,
    expiresAt: new Date(cert.validTo),
  };
}

function sanitizeCert(row: typeof sslCertificates.$inferSelect) {
  return {
    id: row.id,
    domainId: row.domainId,
    clientId: row.clientId,
    issuer: row.issuer,
    subject: row.subject,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function uploadCert(
  db: Database,
  clientId: string,
  domainId: string,
  input: UploadSslCertInput,
  encryptionKey: string,
) {
  // Verify the domain belongs to this client
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for client '${clientId}'`, 404);
  }

  // Validate PEM format
  if (!input.certificate.trimStart().startsWith('-----BEGIN CERTIFICATE-----')) {
    throw new ApiError('INVALID_CERTIFICATE', 'Certificate must be in PEM format', 400);
  }

  // Parse cert info
  let certInfo: ReturnType<typeof parseCertInfo>;
  try {
    certInfo = parseCertInfo(input.certificate);
  } catch {
    throw new ApiError('INVALID_CERTIFICATE', 'Failed to parse certificate — ensure it is a valid X.509 PEM certificate', 400);
  }

  // Encrypt private key
  const privateKeyEncrypted = encrypt(input.private_key, encryptionKey);

  // Upsert — delete existing cert for this domain if any
  const [existing] = await db
    .select({ id: sslCertificates.id })
    .from(sslCertificates)
    .where(eq(sslCertificates.domainId, domainId));

  if (existing) {
    await db.delete(sslCertificates).where(eq(sslCertificates.id, existing.id));
  }

  const id = crypto.randomUUID();
  await db.insert(sslCertificates).values({
    id,
    domainId,
    clientId,
    certificate: input.certificate,
    privateKeyEncrypted,
    caBundle: input.ca_bundle ?? null,
    issuer: certInfo.issuer,
    subject: certInfo.subject,
    expiresAt: certInfo.expiresAt,
  });

  const [created] = await db
    .select()
    .from(sslCertificates)
    .where(eq(sslCertificates.id, id));

  return sanitizeCert(created);
}

export async function getCert(
  db: Database,
  clientId: string,
  domainId: string,
) {
  const [cert] = await db
    .select()
    .from(sslCertificates)
    .where(and(eq(sslCertificates.domainId, domainId), eq(sslCertificates.clientId, clientId)));

  if (!cert) {
    throw new ApiError('SSL_CERT_NOT_FOUND', `No SSL certificate found for domain '${domainId}'`, 404);
  }

  return sanitizeCert(cert);
}

export async function deleteCert(
  db: Database,
  clientId: string,
  domainId: string,
) {
  const [cert] = await db
    .select({ id: sslCertificates.id })
    .from(sslCertificates)
    .where(and(eq(sslCertificates.domainId, domainId), eq(sslCertificates.clientId, clientId)));

  if (!cert) {
    throw new ApiError('SSL_CERT_NOT_FOUND', `No SSL certificate found for domain '${domainId}'`, 404);
  }

  await db.delete(sslCertificates).where(eq(sslCertificates.id, cert.id));
}
