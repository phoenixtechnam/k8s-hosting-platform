import { z } from 'zod';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const saveOidcGlobalSettingsSchema = z.object({
  disable_local_auth_admin: z.boolean().optional(),
  disable_local_auth_client: z.boolean().optional(),
  break_glass_secret: z.string().min(8).optional(),
  protect_admin_via_proxy: z.boolean().optional(),
  protect_client_via_proxy: z.boolean().optional(),
  break_glass_path: z.string().max(100).nullable().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const oidcGlobalSettingsResponseSchema = z.object({
  disableLocalAuthAdmin: z.boolean(),
  disableLocalAuthClient: z.boolean(),
  hasBreakGlassSecret: z.boolean(),
  protectAdminViaProxy: z.boolean(),
  protectClientViaProxy: z.boolean(),
  breakGlassPath: z.string().nullable(),
});

export const breakGlassPathResponseSchema = z.object({
  breakGlassPath: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type SaveOidcGlobalSettingsInput = z.infer<typeof saveOidcGlobalSettingsSchema>;
export type OidcGlobalSettingsResponse = z.infer<typeof oidcGlobalSettingsResponseSchema>;
export type BreakGlassPathResponse = z.infer<typeof breakGlassPathResponseSchema>;
