import { z } from 'zod';

// System Backup, Phase 1: secrets-bundle export.
//
// Scope: cluster-state recovery artifacts (secrets, system DBs,
// Stalwart BLOB, longhorn snapshots — NOT customer/tenant data).
// Tenant data is owned by Tenant Backup (backups-v2).
//
// Phase 1 ships only the secrets-bundle subsystem.

export const systemBackupKindSchema = z.enum(['secrets', 'pg_dump']);
export type SystemBackupKind = z.infer<typeof systemBackupKindSchema>;

export const systemBackupRunStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed']);
export type SystemBackupRunStatus = z.infer<typeof systemBackupRunStatusSchema>;

// One row in `system_backup_runs`. The `payload` column on the
// server-side row is never returned over the wire — the API surfaces
// a single-use download URL when status='succeeded' and downloaded_at
// is null. Once downloaded, the download fields go null and the
// payload bytes are wiped (audit metadata stays).
export const systemBackupRunSchema = z.object({
  id: z.string().uuid(),
  kind: systemBackupKindSchema,
  status: systemBackupRunStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().length(64).nullable(),
  errorEnvelope: z.unknown().nullable(),
  operatorUserId: z.string().nullable(),
  operatorIp: z.string().nullable(),
  operatorUserAgent: z.string().nullable(),
  // Inventory the operator can show without re-decrypting the bundle.
  manifest: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
  })).nullable(),
  // Single-use download. Present only when status='succeeded' AND
  // downloaded_at IS NULL AND now() < downloadUrlExpiresAt.
  downloadUrl: z.string().nullable(),
  downloadUrlExpiresAt: z.string().datetime().nullable(),
  downloadedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  // Phase 2 — pg_dump source identity (NULL for kind='secrets').
  sourceNamespace: z.string().nullable(),
  sourceCluster: z.string().nullable(),
  sourceDatabase: z.string().nullable(),
  targetConfigId: z.string().nullable(),
  bundleId: z.string().nullable(),
  artifactName: z.string().nullable(),
  jobName: z.string().nullable(),
});
export type SystemBackupRun = z.infer<typeof systemBackupRunSchema>;

// RFC 1123 DNS label: lowercase alnum with hyphens, 1-63 chars, no
// leading/trailing hyphen. Matches what k8s accepts for namespace,
// CNPG cluster name, and Postgres database name (DNS-label is a safe
// over-approximation for SQL identifiers and avoids surprising
// quoting in pg_dump args).
const dnsLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a lowercase DNS label (a-z, 0-9, hyphens)');

export const pgDumpRequestSchema = z.object({
  sourceNamespace: dnsLabelSchema,
  sourceCluster: dnsLabelSchema,
  sourceDatabase: dnsLabelSchema,
  targetConfigId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
export type PgDumpRequest = z.infer<typeof pgDumpRequestSchema>;

// Query params for GET /pg-dump/runs.
export const pgDumpListQuerySchema = z.object({
  namespace: dnsLabelSchema.optional(),
  cluster: dnsLabelSchema.optional(),
  limit: z.string().regex(/^\d+$/, 'must be a positive integer').optional(),
});
export type PgDumpListQuery = z.infer<typeof pgDumpListQuerySchema>;

export const pgDumpResponseSchema = z.object({
  runId: z.string().uuid(),
  status: systemBackupRunStatusSchema,
  jobName: z.string(),
  pollUrl: z.string(),
});
export type PgDumpResponse = z.infer<typeof pgDumpResponseSchema>;

// POST /api/v1/system-backup/secrets/export — kicks off a fresh export.
// Returns 202 + the run id. Client polls GET /runs/:id until terminal.
export const exportSecretsBundleRequestSchema = z.object({
  // Optional reason for the audit log. Free-form, ≤500 chars.
  reason: z.string().max(500).optional(),
});
export type ExportSecretsBundleRequest = z.infer<typeof exportSecretsBundleRequestSchema>;

export const exportSecretsBundleResponseSchema = z.object({
  runId: z.string().uuid(),
  status: systemBackupRunStatusSchema,
  pollUrl: z.string(),
});
export type ExportSecretsBundleResponse = z.infer<typeof exportSecretsBundleResponseSchema>;

// GET /api/v1/system-backup/secrets/runs — list (server wraps in {data:[...]}).
export const listSecretsBundleRunsResponseSchema = z.array(systemBackupRunSchema);
export type ListSecretsBundleRunsResponse = z.infer<typeof listSecretsBundleRunsResponseSchema>;

// GET /api/v1/system-backup/secrets/manifest — read-only inventory of
// what *would* be included in the next bundle. No secret values
// returned, only namespace/name pairs.
export const secretsBundleManifestResponseSchema = z.object({
  items: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
    present: z.boolean(),
  })),
  operatorRecipient: z.string().nullable(),
});
export type SecretsBundleManifestResponse = z.infer<typeof secretsBundleManifestResponseSchema>;

// POST /api/v1/system-backup/secrets/import-dryrun — multipart upload
// of an age-encrypted bundle + the operator private key, returns a
// diff between the bundle's contents and the live cluster state. Used
// by operators to verify a bundle decrypts cleanly + matches the
// expected secret list before re-bootstrapping. NEVER mutates state.
export const importDryrunResponseSchema = z.object({
  bundleManifest: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
    sha256: z.string().length(64),
  })),
  diff: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
    change: z.enum(['create', 'update', 'identical', 'remove']),
    detail: z.string().nullable(),
  })),
  decryptOk: z.boolean(),
  bundleCreatedAt: z.string().datetime().nullable(),
});
export type ImportDryrunResponse = z.infer<typeof importDryrunResponseSchema>;
