import { z } from 'zod';

// ─── Input Schemas ──────────────────────────────────────────────────────────

export const createSftpUserSchema = z.object({
  auth_method: z.enum(['password', 'ssh_key']),
  ssh_key_ids: z.array(z.string()).optional(),
  description: z.string().min(1, 'Description is required').max(255),
  home_path: z.string().max(512).regex(/^[a-zA-Z0-9/_.-]*$/, 'home_path must not contain ".." or special characters').refine((v) => !v.includes('..'), 'home_path must not contain ".."').optional(),
  allow_write: z.boolean().optional(),
  allow_delete: z.boolean().optional(),
  ip_whitelist: z.string().max(2000).nullable().optional(),
  max_concurrent_sessions: z.number().int().min(1).max(20).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

export const updateSftpUserSchema = z.object({
  description: z.string().max(255).optional(),
  enabled: z.boolean().optional(),
  home_path: z.string().max(512).regex(/^[a-zA-Z0-9/_.-]*$/, 'home_path must not contain ".." or special characters').refine((v) => !v.includes('..'), 'home_path must not contain ".."').optional(),
  allow_write: z.boolean().optional(),
  allow_delete: z.boolean().optional(),
  ip_whitelist: z.string().max(2000).nullable().optional(),
  max_concurrent_sessions: z.number().int().min(1).max(20).optional(),
  expires_at: z.string().datetime().nullable().optional(),
  ssh_key_ids: z.array(z.string()).optional(),
  auth_method: z.enum(['password', 'ssh_key']).optional(),
});

export const rotateSftpPasswordSchema = z.object({
  custom_password: z.string().min(12).max(128).optional(),
});

// ─── Response Schemas ───────────────────────────────────────────────────────

export const sftpUserResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  username: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  homePath: z.string(),
  allowWrite: z.boolean(),
  allowDelete: z.boolean(),
  ipWhitelist: z.string().nullable(),
  maxConcurrentSessions: z.number(),
  lastLoginAt: z.string().nullable(),
  lastLoginIp: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const sftpConnectionInfoSchema = z.object({
  host: z.string(),
  port: z.number(),
  ftps_port: z.number(),
  protocols: z.array(z.string()),
  username_format: z.string(),
  instructions: z.object({
    sftp: z.string(),
    scp: z.string(),
    rsync: z.string(),
    ftps: z.string(),
    sftp_key: z.string(),
    scp_key: z.string(),
    rsync_key: z.string(),
  }),
  ssh_key_note: z.string(),
});

export const sftpAuditLogSchema = z.object({
  id: z.string(),
  sftpUserId: z.string().nullable(),
  clientId: z.string(),
  event: z.string(),
  sourceIp: z.string(),
  protocol: z.string(),
  sessionId: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  bytesTransferred: z.number().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});

// ─── Inferred Types ─────────────────────────────────────────────────────────

export type CreateSftpUserInput = z.infer<typeof createSftpUserSchema>;
export type UpdateSftpUserInput = z.infer<typeof updateSftpUserSchema>;
export type RotateSftpPasswordInput = z.infer<typeof rotateSftpPasswordSchema>;
export type SftpUserResponse = z.infer<typeof sftpUserResponseSchema>;
export type SftpConnectionInfo = z.infer<typeof sftpConnectionInfoSchema>;
export type SftpAuditLogEntry = z.infer<typeof sftpAuditLogSchema>;
