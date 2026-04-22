import { z } from 'zod';

// S3 bucket naming per AWS rules: 3-63 chars, lowercase letters, digits,
// dots, hyphens. No leading/trailing dot or hyphen. Rejected early so
// the user sees a clear error rather than an opaque HeadBucket 400 from
// the provider.
const s3BucketRegex = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// http or https only. Rejects file://, s3://, bare hostnames etc. HeadBucket
// via @aws-sdk/client-s3 needs a full URL anyway; enforcing it at the
// contract makes client-side form validation stricter.
const httpUrl = z.string().url().refine(
  (v) => v.startsWith('http://') || v.startsWith('https://'),
  { message: 'must be http:// or https:// URL' },
);
// Access/secret length bands are from the S3 spec and cover AWS IAM,
// MinIO, Hetzner Object Storage, Wasabi, Backblaze B2 etc. 16..128 on the
// access key id is AWS's documented range; the secret is always base64-
// looking and generally 40-ish chars, but we allow up to 256 for future-
// proofing against providers that mint larger tokens.
const s3AccessKey = z.string()
  .min(16, { message: 's3_access_key must be at least 16 characters' })
  .max(128, { message: 's3_access_key must be at most 128 characters' })
  .regex(/^[A-Za-z0-9+/=_-]+$/, { message: 's3_access_key has invalid characters' });
const s3SecretKey = z.string()
  .min(1, { message: 's3_secret_key is required' })
  .max(256, { message: 's3_secret_key must be at most 256 characters' });
const s3Bucket = z.string()
  .min(3, { message: 's3_bucket must be 3-63 characters' })
  .max(63, { message: 's3_bucket must be 3-63 characters' })
  .regex(s3BucketRegex, {
    message: 's3_bucket must be lowercase letters/digits/dots/hyphens, not start or end with dot or hyphen',
  });

const sshConfigSchema = z.object({
  storage_type: z.literal('ssh'),
  name: z.string().min(1).max(255),
  ssh_host: z.string().min(1).max(255),
  ssh_port: z.number().int().min(1).max(65535).default(22),
  ssh_user: z.string().min(1).max(100),
  ssh_key: z.string().min(1),
  ssh_path: z.string().min(1).max(500),
  retention_days: z.number().int().min(1).max(365).default(30),
  schedule_expression: z.string().default('0 2 * * *'),
  enabled: z.boolean().default(true),
});

const s3ConfigSchema = z.object({
  storage_type: z.literal('s3'),
  name: z.string().min(1).max(255),
  s3_endpoint: httpUrl,
  s3_bucket: s3Bucket,
  s3_region: z.string().min(2).max(32).regex(/^[a-z0-9-]+$/, {
    message: 's3_region must be lowercase letters/digits/hyphens',
  }),
  s3_access_key: s3AccessKey,
  s3_secret_key: s3SecretKey,
  s3_prefix: z.string().max(255).optional(),
  retention_days: z.number().int().min(1).max(365).default(30),
  schedule_expression: z.string().default('0 2 * * *'),
  enabled: z.boolean().default(true),
});

export const createBackupConfigSchema = z.discriminatedUnion('storage_type', [
  sshConfigSchema,
  s3ConfigSchema,
]);

export type CreateBackupConfigInput = z.infer<typeof createBackupConfigSchema>;

export const updateBackupConfigSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  ssh_host: z.string().optional(),
  ssh_port: z.number().int().min(1).max(65535).optional(),
  ssh_user: z.string().optional(),
  ssh_key: z.string().optional(),
  ssh_path: z.string().optional(),
  s3_endpoint: z.string().optional(),
  s3_bucket: z.string().optional(),
  s3_region: z.string().optional(),
  s3_access_key: z.string().optional(),
  s3_secret_key: z.string().optional(),
  s3_prefix: z.string().optional(),
  retention_days: z.number().int().min(1).max(365).optional(),
  schedule_expression: z.string().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateBackupConfigInput = z.infer<typeof updateBackupConfigSchema>;

export const backupConfigResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  storageType: z.enum(['ssh', 's3']),
  sshHost: z.string().nullable(),
  sshPort: z.number().nullable(),
  sshUser: z.string().nullable(),
  sshPath: z.string().nullable(),
  s3Endpoint: z.string().nullable(),
  s3Bucket: z.string().nullable(),
  s3Region: z.string().nullable(),
  s3Prefix: z.string().nullable(),
  retentionDays: z.number(),
  scheduleExpression: z.string().nullable(),
  enabled: z.number(),
  // Exactly one config per cluster may be active — the Longhorn reconciler
  // syncs this row to the BackupTarget CR + credentials Secret.
  active: z.boolean(),
  lastTestedAt: z.string().nullable(),
  lastTestStatus: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BackupConfigResponse = z.infer<typeof backupConfigResponseSchema>;
