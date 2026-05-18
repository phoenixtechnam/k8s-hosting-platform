/**
 * Secrets-bundle coverage audit (DR-bundle roadmap, Phase 0).
 *
 * Detects Secrets in the cluster that are NOT covered by any backup
 * mechanism so DR-readiness gaps surface at create-time, not at
 * disaster-time. See docs/04-deployment/DR_BUNDLE_ROADMAP.md.
 *
 * Classification:
 *   - DENIED   — auto-managed by k8s/operators (SA tokens, helm release
 *                state, cert-manager TLS, sealed-secret unsealed copies,
 *                CNPG-managed credentials). NOT bundle candidates by
 *                design; restoring them would conflict with the operator
 *                that owns them.
 *   - COVERED  — matches the Tier-1 BUNDLE_SECRET_LIST OR lives in a
 *                tenant namespace (`client-*`) the daily CronJob sweeps.
 *   - ALLOWED  — explicitly excluded via the secrets-audit-allowlist
 *                ConfigMap with an operator-supplied reason.
 *   - UNCOVERED — every other Secret. These represent silent DR risk.
 */

import { z } from 'zod';

export const secretCoverageCategorySchema = z.enum([
  /** Auto-managed by k8s (SA token), Helm, cert-manager, sealed-secrets, CNPG, etc. */
  'denied',
  /** Matches BUNDLE_SECRET_LIST (Tier-1, fixed). */
  'tier-1-bundle',
  /** Namespace `client-*` — covered by the nightly secrets-backup CronJob's namespace sweep. */
  'tier-2-tenant-sweep',
  /** Operator added to the allowlist with a documented reason. */
  'allowlisted',
  /** UNCOVERED — silent DR risk. */
  'uncovered',
]);
export type SecretCoverageCategory = z.infer<typeof secretCoverageCategorySchema>;

/** A single Secret + its coverage classification. */
export const auditedSecretSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  /** The k8s `type` field (e.g. `Opaque`, `kubernetes.io/tls`). */
  type: z.string().max(253),
  /** ISO timestamp of the Secret's `metadata.creationTimestamp`. */
  createdAt: z.string().datetime(),
  ageSeconds: z.number().int().min(0),
  /** OwnerReference[0].kind if present (e.g. `Certificate` for cert-manager). */
  ownerKind: z.string().nullable(),
  ownerName: z.string().nullable(),
  category: secretCoverageCategorySchema,
  /** Why the classifier put it in that bucket — human-readable, short. */
  reason: z.string(),
});
export type AuditedSecret = z.infer<typeof auditedSecretSchema>;

/** Aggregate audit result returned by `GET /admin/system-backup/secrets-audit`. */
export const secretsAuditResultSchema = z.object({
  generatedAt: z.string().datetime(),
  totalSecretsCount: z.number().int().min(0),
  byCategory: z.object({
    denied: z.number().int().min(0),
    tier1Bundle: z.number().int().min(0),
    tier2TenantSweep: z.number().int().min(0),
    allowlisted: z.number().int().min(0),
    uncovered: z.number().int().min(0),
  }),
  /** True iff `byCategory.uncovered === 0`. Drives the UI banner colour. */
  healthy: z.boolean(),
  /** Only the UNCOVERED rows. Operator should act on each: either add
   *  to the allowlist (with a documented reason) or extend the bundle. */
  uncoveredSecrets: z.array(auditedSecretSchema),
  /** Allowlist as observed at audit time. Useful for the UI to surface
   *  "X items currently allowlisted" without a second API call. */
  allowlistedSecrets: z.array(auditedSecretSchema),
});
export type SecretsAuditResult = z.infer<typeof secretsAuditResultSchema>;

export const secretsAuditResponseSchema = z.object({ data: secretsAuditResultSchema });
export type SecretsAuditResponse = z.infer<typeof secretsAuditResponseSchema>;

// ─── Allowlist CRUD ────────────────────────────────────────────────────

/** One entry in the secrets-audit-allowlist ConfigMap. */
export const allowlistEntrySchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  /** Why this Secret is intentionally NOT in any bundle. Required. */
  reason: z.string().min(10).max(500),
  /** Set by the API from req.user.sub on write. */
  addedBy: z.string().max(200),
  addedAt: z.string().datetime(),
});
export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;

export const listAllowlistResponseSchema = z.object({
  data: z.object({ entries: z.array(allowlistEntrySchema) }),
});
export type ListAllowlistResponse = z.infer<typeof listAllowlistResponseSchema>;

export const addAllowlistEntryRequestSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  reason: z.string().min(10).max(500),
});
export type AddAllowlistEntryRequest = z.infer<typeof addAllowlistEntryRequestSchema>;
