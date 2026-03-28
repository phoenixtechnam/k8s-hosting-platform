import { z } from 'zod';

export const platformVersionResponseSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  environment: z.string(),
  autoUpdate: z.boolean(),
  lastCheckedAt: z.string().nullable(),
});

export const updateSettingsSchema = z.object({
  autoUpdate: z.boolean(),
});

export const triggerUpdateResponseSchema = z.object({
  message: z.string(),
  targetVersion: z.string(),
});

export type PlatformVersionResponse = z.infer<typeof platformVersionResponseSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type TriggerUpdateResponse = z.infer<typeof triggerUpdateResponseSchema>;
