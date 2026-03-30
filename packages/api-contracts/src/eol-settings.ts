import { z } from 'zod';

// ─── Response ───────────────────────────────────────────────────────────────

export const eolSettingsResponseSchema = z.object({
  graceDays: z.number(),
  warningDays: z.number(),
  autoUpgradeEnabled: z.boolean(),
});

// ─── Input ──────────────────────────────────────────────────────────────────

export const updateEolSettingsSchema = z.object({
  graceDays: z.number().int().min(1).max(365).optional(),
  warningDays: z.number().int().min(1).max(365).optional(),
  autoUpgradeEnabled: z.boolean().optional(),
});

// ─── Scan Result ────────────────────────────────────────────────────────────

export const eolScanResultSchema = z.object({
  warningsSent: z.number(),
  forcedUpgradesTriggered: z.number(),
  errors: z.array(z.string()),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type EolSettingsResponse = z.infer<typeof eolSettingsResponseSchema>;
export type UpdateEolSettingsInput = z.infer<typeof updateEolSettingsSchema>;
export type EolScanResult = z.infer<typeof eolScanResultSchema>;
