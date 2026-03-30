import { z } from 'zod';

// ─── Response ───────────────────────────────────────────────────────────────

export const tlsSettingsResponseSchema = z.object({
  clusterIssuerName: z.string(),
  autoTlsEnabled: z.boolean(),
});

// ─── Input ──────────────────────────────────────────────────────────────────

export const updateTlsSettingsSchema = z.object({
  clusterIssuerName: z.string().min(1).max(255).optional(),
  autoTlsEnabled: z.boolean().optional(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type TlsSettingsResponse = z.infer<typeof tlsSettingsResponseSchema>;
export type UpdateTlsSettingsInput = z.infer<typeof updateTlsSettingsSchema>;
