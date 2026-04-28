/**
 * Per-ingress mTLS access control — API contract.
 *
 * Mode B of the multi-mode access control design. Modeled as a
 * GENERAL feature (any CA), not Ziti-specific — operators may upload
 * their internal corporate CA, an HSM-issued cert chain, a Ziti
 * intermediate, or any other PEM-encoded CA bundle. NGINX validates
 * incoming HTTPS requests against this CA bundle via the standard
 * `auth-tls-secret` annotation.
 *
 * Layers cleanly with OIDC: when both are configured on the same
 * ingress, NGINX runs auth_request (OIDC) AND requires a valid client
 * certificate (mTLS). LE HTTP-01 renewal continues to work — the
 * solver Ingress is a separate resource with its own annotations
 * and the `verifyClient` setting only applies to the gated location.
 */
import { z } from 'zod';

export const mtlsVerifyModeSchema = z.enum(['on', 'optional', 'optional_no_ca']);
export type MtlsVerifyMode = z.infer<typeof mtlsVerifyModeSchema>;

/**
 * Per-ingress mTLS config. The CA cert is uploaded inline (PEM bundle)
 * and stored encrypted at rest; the platform syncs it as a K8s Secret
 * in the client namespace. Inline upload (no separate provider table)
 * because in practice each ingress has its own CA — sharing a CA across
 * many ingresses doesn't model real customer use cases (different
 * apps trust different identity sources).
 */
export const ingressMtlsConfigSchema = z.object({
  enabled: z.boolean(),
  /**
   * PEM-encoded CA bundle. Required on create; optional on update
   * (omitted = keep current). May contain multiple concatenated certs
   * (root + intermediates).
   */
  caCertPem: z.string().min(1).optional(),
  /**
   * NGINX auth-tls-verify-client mode:
   *   - 'on': reject requests without a valid client cert (default)
   *   - 'optional': verify when supplied, allow through when absent
   *     (combine with OIDC for cert-or-OIDC fallback)
   *   - 'optional_no_ca': same as optional but does not advertise the
   *     accepted CA list during the TLS handshake (useful when the
   *     CA list is large)
   */
  verifyMode: mtlsVerifyModeSchema.default('on'),
  /**
   * Optional Subject filter applied AFTER cert validation. When set,
   * the cert's Subject DN must match this regular expression — useful
   * for restricting access to a specific OU or CN pattern. NULL = no
   * post-validation Subject check.
   */
  subjectRegex: z.string().nullable().optional(),
  /**
   * When true, the verified client certificate is forwarded to the
   * upstream app via the `ssl-client-cert` header (URL-encoded PEM).
   * The app can then decode it for additional authorization decisions.
   */
  passCertToUpstream: z.boolean().default(false),
  /**
   * When true, the certificate Subject DN is forwarded as
   * `X-SSL-Client-DN`, even if the full cert isn't passed.
   */
  passDnToUpstream: z.boolean().default(true),
});
export type IngressMtlsConfigInput = z.infer<typeof ingressMtlsConfigSchema>;

/**
 * Server-rendered response. The CA cert itself is never returned;
 * instead `caCertSet` indicates whether one is on file plus a
 * fingerprint for visual diff.
 */
export const ingressMtlsConfigResponseSchema = z.object({
  enabled: z.boolean(),
  caCertSet: z.boolean(),
  /** SHA-256 of the CA cert DER, hex-encoded. Null when no cert. */
  caCertFingerprint: z.string().nullable(),
  /** First cert in the bundle's Subject DN, for human display. */
  caCertSubject: z.string().nullable(),
  /** First cert in the bundle's notAfter, ISO-8601. */
  caCertExpiresAt: z.string().nullable(),
  verifyMode: mtlsVerifyModeSchema,
  subjectRegex: z.string().nullable(),
  passCertToUpstream: z.boolean(),
  passDnToUpstream: z.boolean(),
  lastError: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
});
export type IngressMtlsConfigResponse = z.infer<typeof ingressMtlsConfigResponseSchema>;
