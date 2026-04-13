import { z } from 'zod';

export const createSshKeySchema = z.object({
  name: z.string().min(1).max(255),
  public_key: z.string().min(20).max(10000),
});

export const sshKeyResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  publicKey: z.string(),
  keyFingerprint: z.string(),
  keyAlgorithm: z.string().nullable(),
  createdAt: z.string(),
});

export const updateSshKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  public_key: z.string().min(20).max(10000).optional(),
});

export type CreateSshKeyInput = z.infer<typeof createSshKeySchema>;
export type UpdateSshKeyInput = z.infer<typeof updateSshKeySchema>;
export type SshKeyResponse = z.infer<typeof sshKeyResponseSchema>;
