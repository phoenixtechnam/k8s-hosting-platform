import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const uploadSslCertSchema = z.object({
  certificate: z.string().min(1).refine(
    (val) => val.trimStart().startsWith('-----BEGIN CERTIFICATE-----'),
    { message: 'Certificate must be in PEM format (starts with -----BEGIN CERTIFICATE-----)' },
  ),
  private_key: z.string().min(1).refine(
    (val) => val.trimStart().startsWith('-----BEGIN'),
    { message: 'Private key must be in PEM format' },
  ),
  ca_bundle: z.string().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const sslCertResponseSchema = z.object({
  id: uuidField,
  domainId: uuidField,
  clientId: uuidField,
  issuer: z.string().nullable(),
  subject: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type UploadSslCertInput = z.infer<typeof uploadSslCertSchema>;
export type SslCertResponse = z.infer<typeof sslCertResponseSchema>;
