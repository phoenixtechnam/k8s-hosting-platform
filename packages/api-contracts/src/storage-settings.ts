import { z } from 'zod';

// ─── Storage Settings (platform-level, stored in platform_settings) ─────────

export const storageSettingsResponseSchema = z.object({
  defaultStorageClass: z.string(),
  storageOvercommitRatio: z.number(),
});

export const updateStorageSettingsSchema = z.object({
  defaultStorageClass: z.string().min(1).max(100).optional(),
  storageOvercommitRatio: z.number().min(1.0).max(5.0).optional(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type StorageSettingsResponse = z.infer<typeof storageSettingsResponseSchema>;
export type UpdateStorageSettingsInput = z.infer<typeof updateStorageSettingsSchema>;
