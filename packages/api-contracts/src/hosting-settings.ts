import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const updateHostingSettingsSchema = z.object({
  redirect_www: z.boolean().optional(),
  redirect_https: z.boolean().optional(),
  forward_external: z.string().url().nullable().optional(),
  webroot_path: z.string().max(500).optional(),
  hosting_enabled: z.boolean().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const hostingSettingsResponseSchema = z.object({
  id: uuidField,
  domainId: uuidField,
  redirectWww: z.boolean(),
  redirectHttps: z.boolean(),
  forwardExternal: z.string().nullable(),
  webrootPath: z.string(),
  hostingEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type UpdateHostingSettingsInput = z.infer<typeof updateHostingSettingsSchema>;
export type HostingSettingsResponse = z.infer<typeof hostingSettingsResponseSchema>;
