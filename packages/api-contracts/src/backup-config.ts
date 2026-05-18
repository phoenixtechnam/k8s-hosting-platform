import { z } from 'zod';

// S3 bucket naming per AWS rules: 3-63 chars, lowercase letters, digits,
// dots, hyphens. No leading/trailing dot or hyphen. Rejected early so
// the user sees a clear error rather than an opaque HeadBucket 400 from
// the provider.
const s3BucketRegex = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// http or https only. Rejects file://, s3://, bare hostnames etc. HeadBucket
// via @aws-sdk/tenant-s3 needs a full URL anyway; enforcing it at the
// contract makes tenant-side form validation stricter.
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
  // Phase 12.5 follow-up: EITHER ssh_key OR ssh_password (or both) is
  // required. The .refine() below enforces that. Operators who don't
  // want to manage SSH keypairs can use password auth — many SFTP
  // services (Hetzner Storage Box, corporate file servers) support it.
  ssh_key: z.string().min(1).max(16384).optional(),
  ssh_password: z.string().min(1).max(512).optional(),
  ssh_path: z.string().min(1).max(500),
  retention_days: z.number().int().min(1).max(365).default(30),
  schedule_expression: z.string().default('0 2 * * *'),
  enabled: z.boolean().default(true),
}).refine(
  (v) => Boolean(v.ssh_key || v.ssh_password),
  { message: 'ssh_key or ssh_password is required', path: ['ssh_key'] },
);

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

// Phase 9: CIFS/SMB target. Hostname or IP, share name, credentials.
// Password is stored encrypted by the backend on insert; the rclone
// Job re-obscures it server-side before passing to rclone via env var.
const cifsConfigSchema = z.object({
  storage_type: z.literal('cifs'),
  name: z.string().min(1).max(255),
  cifs_host: z.string().min(1).max(255),
  cifs_port: z.number().int().min(1).max(65535).default(445),
  cifs_share: z.string().min(1).max(255),
  cifs_user: z.string().min(1).max(255),
  cifs_password: z.string().min(1).max(512),
  cifs_domain: z.string().max(255).optional(),
  cifs_path: z.string().max(500).optional(),
  retention_days: z.number().int().min(1).max(365).default(30),
  schedule_expression: z.string().default('0 2 * * *'),
  enabled: z.boolean().default(true),
});

export const createBackupConfigSchema = z.discriminatedUnion('storage_type', [
  sshConfigSchema,
  s3ConfigSchema,
  cifsConfigSchema,
]);

export type CreateBackupConfigInput = z.infer<typeof createBackupConfigSchema>;

export const updateBackupConfigSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  ssh_host: z.string().optional(),
  ssh_port: z.number().int().min(1).max(65535).optional(),
  ssh_user: z.string().optional(),
  ssh_key: z.string().optional(),
  ssh_password: z.string().optional(),
  ssh_path: z.string().optional(),
  s3_endpoint: z.string().optional(),
  s3_bucket: z.string().optional(),
  s3_region: z.string().optional(),
  s3_access_key: z.string().optional(),
  s3_secret_key: z.string().optional(),
  s3_prefix: z.string().optional(),
  // Phase 9: CIFS update fields.
  cifs_host: z.string().optional(),
  cifs_port: z.number().int().min(1).max(65535).optional(),
  cifs_share: z.string().optional(),
  cifs_user: z.string().optional(),
  cifs_password: z.string().optional(),
  cifs_domain: z.string().optional(),
  cifs_path: z.string().optional(),
  retention_days: z.number().int().min(1).max(365).optional(),
  schedule_expression: z.string().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateBackupConfigInput = z.infer<typeof updateBackupConfigSchema>;

export const backupConfigResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  storageType: z.enum(['ssh', 's3', 'cifs']),
  sshHost: z.string().nullable(),
  sshPort: z.number().nullable(),
  sshUser: z.string().nullable(),
  sshPath: z.string().nullable(),
  s3Endpoint: z.string().nullable(),
  s3Bucket: z.string().nullable(),
  s3Region: z.string().nullable(),
  s3Prefix: z.string().nullable(),
  // Phase 9: CIFS fields (password redacted in responses).
  cifsHost: z.string().nullable(),
  cifsPort: z.number().nullable(),
  cifsShare: z.string().nullable(),
  cifsUser: z.string().nullable(),
  cifsDomain: z.string().nullable(),
  cifsPath: z.string().nullable(),
  retentionDays: z.number(),
  scheduleExpression: z.string().nullable(),
  enabled: z.number(),
  // Exactly one config per cluster may be active — the Longhorn reconciler
  // syncs this row to the BackupTarget CR + credentials Secret.
  active: z.boolean(),
  lastTestedAt: z.string().nullable(),
  lastTestStatus: z.string().nullable(),
  // Phase 10: last speedtest result. NULL until first run.
  lastSpeedtestAt: z.string().nullable(),
  lastSpeedtestUploadMbps: z.number().nullable(),
  lastSpeedtestDownloadMbps: z.number().nullable(),
  lastSpeedtestLatencyMs: z.number().nullable(),
  lastSpeedtestPayloadBytes: z.number().nullable(),
  lastSpeedtestError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BackupConfigResponse = z.infer<typeof backupConfigResponseSchema>;

// Phase 10: speedtest request + response. Payload defaults to 100 MB
// — operator may override for quick (10 MB) or thorough (1 GB) tests.
export const speedtestInputSchema = z.object({
  payloadBytes: z.number().int().min(1_048_576).max(1_073_741_824).default(104_857_600), // 1 MB - 1 GB; default 100 MB
});
export type SpeedtestInput = z.infer<typeof speedtestInputSchema>;

export const speedtestResultSchema = z.object({
  targetId: z.string(),
  targetName: z.string(),
  payloadBytes: z.number(),
  uploadMbps: z.number().nullable(),
  downloadMbps: z.number().nullable(),
  latencyMs: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  taskId: z.string().uuid().nullable(),
  operationId: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type SpeedtestResult = z.infer<typeof speedtestResultSchema>;
