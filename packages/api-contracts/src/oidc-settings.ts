import { z } from 'zod';

// ─── Input Schemas ───────────────────────────────────────────────────────────

// Path token used in the break-glass IngressRoute's match expression
// + stripPrefix Middleware. The value is interpolated unescaped into a
// Traefik match rule (Host(`x`) && PathPrefix(`/<path>`)), so we
// restrict it to lowercase alphanumerics + hyphen — the same charset
// the regenerator emits (`bg-<32-hex>`). The `.regex` guard is defence-
// in-depth against a direct DB write that would otherwise allow
// path-traversal sequences (`/..`), backticks (Traefik match-expression
// escape), or whitespace. Auto-generated values always match this
// shape; operator-set values must too.
const BREAK_GLASS_PATH_RE = /^[a-z0-9-]+$/;

export const saveOidcGlobalSettingsSchema = z.object({
  disable_local_auth_admin: z.boolean().optional(),
  disable_local_auth_client: z.boolean().optional(),
  break_glass_secret: z.string().min(8).optional(),
  protect_admin_via_proxy: z.boolean().optional(),
  protect_client_via_proxy: z.boolean().optional(),
  break_glass_path: z.union([
    z.string().min(1).max(100).regex(BREAK_GLASS_PATH_RE, {
      message: 'break_glass_path must contain only lowercase alphanumerics and hyphens',
    }),
    z.null(),
  ]).optional(),
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
