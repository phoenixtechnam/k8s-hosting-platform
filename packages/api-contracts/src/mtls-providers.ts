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

/** Issue-user-cert: input + output. */
export const mtlsIssueCertInputSchema = z.object({
  /** Common Name written into the user cert's Subject. */
  commonName: z.string().min(1).max(255),
  /** Cert lifetime in days. Capped at 365 in v1. */
  validityDays: z.number().int().positive().max(365).default(365),
  /** Optional Organization for the user cert Subject. */
  organization: z.string().max(255).optional(),
  /** Optional OU written into the user cert Subject. */
  organizationalUnit: z.string().max(255).optional(),
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
