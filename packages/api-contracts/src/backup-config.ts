import { z } from 'zod';

const sshConfigSchema = z.object({
  storage_type: z.literal('ssh'),
  name: z.string().min(1).max(255),
  ssh_host: z.string().min(1),
  ssh_port: z.number().int().min(1).max(65535).default(22),
  ssh_user: z.string().min(1),
  ssh_key: z.string().min(1),
  ssh_path: z.string().min(1),
  retention_days: z.number().int().min(1).max(365).default(30),
  schedule_expression: z.string().default('0 2 * * *'),
  enabled: z.boolean().default(true),
});

const s3ConfigSchema = z.object({
  storage_type: z.literal('s3'),
  name: z.string().min(1).max(255),
  s3_endpoint: z.string().min(1),
  s3_bucket: z.string().min(1),
  s3_region: z.string().min(1),
  s3_access_key: z.string().min(1),
  s3_secret_key: z.string().min(1),
  s3_prefix: z.string().optional(),
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
  lastTestedAt: z.string().nullable(),
  lastTestStatus: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BackupConfigResponse = z.infer<typeof backupConfigResponseSchema>;
