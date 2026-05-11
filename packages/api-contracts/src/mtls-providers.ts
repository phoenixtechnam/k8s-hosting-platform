/**
 * Per-client mTLS provider — API contract.
 *
 * Reusable CA cert (and optional CA private key) referenced by zero
 * or more ingress_mtls_configs.providerId. Two creation paths:
 *
 *   - upload: operator pastes a PEM CA bundle, optionally with the
 *             matching private key (only required if they want to
 *             use the "issue user cert" action later)
 *   - generate: server mints a fresh self-signed CA + private key
 *               (operator never sees the key — it stays in the DB
 *               encrypted, used for subsequent issue-cert actions)
 *
 * The "issue user cert" action signs a brand-new client cert against
 * a stored provider's CA + key. The cert + key are returned ONCE in
 * the response (not persisted), so the operator must save them
 * locally / hand them to the end user.
 */
import { z } from 'zod';

export const mtlsProviderUploadSchema = z.object({
  source: z.literal('upload'),
  name: z.string().min(1).max(120),
  /** PEM-encoded CA bundle (root + intermediates). Required. */
  caCertPem: z.string().min(1),
  /**
   * PEM-encoded CA private key. Optional. When supplied, the provider
   * gains the can_issue capability — the issue-user-cert action will
   * sign new client certs with this key.
   */
  caKeyPem: z.string().min(1).optional(),
});

export const mtlsProviderGenerateSchema = z.object({
  source: z.literal('generate'),
  name: z.string().min(1).max(120),
  /** Common Name written into the generated CA cert's Subject. */
  commonName: z.string().min(1).max(255),
  /** Cert lifetime in days (default 365 * 5). */
  validityDays: z.number().int().positive().max(3650).default(1825),
  /** Optional Organization for the cert Subject. */
  organization: z.string().max(255).optional(),
});

export const mtlsProviderInputSchema = z.discriminatedUnion('source', [
  mtlsProviderUploadSchema,
  mtlsProviderGenerateSchema,
]);
export type MtlsProviderInput = z.infer<typeof mtlsProviderInputSchema>;

/** PATCH input — every field optional, source can't change after creation. */
export const mtlsProviderUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** Replace the CA cert PEM (re-derives fingerprint + subject + expiry). */
  caCertPem: z.string().min(1).optional(),
  /**
   * Replace the CA private key. Set to empty string '' to CLEAR (lose
   * issue-cert capability). Omit entirely to keep current.
   */
  caKeyPem: z.string().optional(),
});
export type MtlsProviderUpdate = z.infer<typeof mtlsProviderUpdateSchema>;

export const mtlsProviderResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** SHA-256 of the CA cert DER, hex-encoded. */
  caCertFingerprint: z.string(),
  caCertSubject: z.string(),
  caCertExpiresAt: z.string(),
  /** True when a CA private key is on file (presence-only). */
  canIssue: z.boolean(),
  /** Number of ingress_mtls_configs referencing this provider. */
  consumerCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MtlsProviderResponse = z.infer<typeof mtlsProviderResponseSchema>;

// Subject DN fields flow into the openssl `-subj` argument and into
// the PKCS#12 friendly name. Forbid ASCII control bytes (incl. CR/LF,
// NUL, TAB) so a malicious commonName can't break the `/`-delimited
// subject parser or smuggle a second openssl token via newline. The
// upper bound (0x7e) keeps the field in printable ASCII; certs with
// non-Latin subjects would need a separate IA5String/UTF8String path.
const SUBJECT_FIELD_REGEX = /^[\x20-\x7e]+$/;

/** Issue-user-cert: input + output. */
export const mtlsIssueCertInputSchema = z.object({
  /** Common Name written into the user cert's Subject. */
  commonName: z.string().min(1).max(255).regex(SUBJECT_FIELD_REGEX, 'must be printable ASCII'),
  /** Cert lifetime in days. Capped at 365 in v1. */
  validityDays: z.number().int().positive().max(365).default(365),
  /** Optional Organization for the user cert Subject. */
  organization: z.string().max(255).regex(SUBJECT_FIELD_REGEX, 'must be printable ASCII').optional(),
  /** Optional OU written into the user cert Subject. */
  organizationalUnit: z.string().max(255).regex(SUBJECT_FIELD_REGEX, 'must be printable ASCII').optional(),
  /**
   * Set to true to also receive a base64-encoded PKCS#12 bundle
   * (cert + key + CA) — the format Windows / macOS keychain / most
   * browsers expect for client-cert import.
   *
   * When omitted (or false), no .p12 bundle is generated.
   */
  pkcs12: z.boolean().optional(),
  /**
   * Optional PKCS#12 export password. When non-empty AND `pkcs12` is
   * true, the bundle is encrypted with this password. Empty / omitted
   * = passwordless .p12 (no password prompt during import — Windows
   * 10/11 + macOS 11+ accept empty passwords; some legacy clients
   * still prompt and accept "" as the answer).
   *
   * Backwards compat: supplying `pkcs12Password` alone (without
   * `pkcs12: true`) is treated as `pkcs12: true` so existing callers
   * keep working.
   */
  pkcs12Password: z.string().max(255).optional(),
});
export type MtlsIssueCertInput = z.infer<typeof mtlsIssueCertInputSchema>;

export const mtlsIssueCertResponseSchema = z.object({
  /**
   * Cert identifier inside the platform DB. New in v2 — lets the
   * client UI deep-link to /certificates/:id (e.g. revoke from the
   * issuance toast) without round-tripping a list call.
   */
  id: z.string(),
  /** Hex-encoded serial number (lowercase, no leading 0x). New in v2. */
  serialHex: z.string(),
  /** PEM-encoded user cert. Returned ONCE — not persisted server-side. */
  certPem: z.string(),
  /** PEM-encoded user private key. Returned ONCE — not persisted. */
  keyPem: z.string(),
  /** PEM-encoded CA cert (the issuer), for the user's trust chain. */
  caCertPem: z.string(),
  /** Cert Subject DN (for display in the response toast). */
  subject: z.string(),
  /** Expires-at (ISO-8601). */
  expiresAt: z.string(),
  /**
   * Base64-encoded PKCS#12 bundle. Present only when the request
   * supplied a `pkcs12Password`. Decode + offer as a download for
   * Windows-friendly cert import.
   */
  pkcs12Base64: z.string().nullable(),
});
export type MtlsIssueCertResponse = z.infer<typeof mtlsIssueCertResponseSchema>;

// ─── Issued-cert lifecycle (added in v2) ────────────────────────────

/**
 * RFC 5280 §5.3.1 CRLReason codes — symbolic strings. The wire format
 * is intentionally restricted to a small, audit-friendly set; the
 * server maps these to the numeric codes for the CRL itself.
 *
 * Excluded: `certificateHold` (the platform does not support unhold;
 * once revoked, a cert stays revoked), `removeFromCRL` (unhold).
 */
export const certificateRevocationReasonSchema = z.enum([
  'unspecified',
  'keyCompromise',
  'caCompromise',
  'affiliationChanged',
  'superseded',
  'cessationOfOperation',
  'privilegeWithdrawn',
  'aaCompromise',
]);
export type CertificateRevocationReason = z.infer<typeof certificateRevocationReasonSchema>;

/**
 * Status derived server-side from (revokedAt, expiresAt, now):
 *   * revoked  — revokedAt IS NOT NULL
 *   * expired  — expiresAt < now AND revokedAt IS NULL
 *   * active   — otherwise
 */
export const certificateStatusSchema = z.enum(['active', 'revoked', 'expired']);
export type CertificateStatus = z.infer<typeof certificateStatusSchema>;

export const certificateResponseSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  /** Hex-encoded serial number (lowercase, no leading 0x). */
  serialHex: z.string(),
  /** SHA-256 of the cert DER, hex-encoded. */
  fingerprintSha256: z.string(),
  /** Subject CN for compact table rendering. */
  subjectCn: z.string(),
  /** Full Subject DN (slashed form, e.g. "/O=Acme/CN=alice"). */
  subjectFull: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revocationReason: certificateRevocationReasonSchema.nullable(),
  revokedByUserId: z.string().nullable(),
  status: certificateStatusSchema,
});
export type CertificateResponse = z.infer<typeof certificateResponseSchema>;

export const listCertificatesQuerySchema = z.object({
  status: certificateStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});
export type ListCertificatesQuery = z.infer<typeof listCertificatesQuerySchema>;

export const listCertificatesResponseSchema = z.object({
  items: z.array(certificateResponseSchema),
  nextCursor: z.string().nullable(),
});
export type ListCertificatesResponse = z.infer<typeof listCertificatesResponseSchema>;

export const revokeCertificateInputSchema = z.object({
  reason: certificateRevocationReasonSchema.default('unspecified'),
});
export type RevokeCertificateInput = z.infer<typeof revokeCertificateInputSchema>;

/**
 * GET /providers/:pid/crl.pem — returns the current CRL as text/plain
 * with the PEM body. Cache-friendly; the server bumps Last-Modified
 * and ETag whenever a revocation occurs.
 */
export const crlMetadataResponseSchema = z.object({
  crlNumber: z.number().int().nonnegative(),
  lastGeneratedAt: z.string().nullable(),
  revokedCount: z.number().int().nonnegative(),
  crlUrl: z.string(),
});
export type CrlMetadataResponse = z.infer<typeof crlMetadataResponseSchema>;
