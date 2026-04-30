import { z } from 'zod';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6, 'New password must be at least 6 characters'),
});

export const updateProfileSchema = z.object({
  full_name: z.string().min(1).max(255).optional(),
  email: z.string().email().optional(),
  // IANA timezone string, e.g. "Europe/Berlin". Null clears the user-level
  // override and falls back to the system default on display.
  timezone: z.string().min(1).max(50).nullable().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: z.enum(['super_admin', 'admin', 'billing', 'support', 'read_only', 'client_admin', 'client_user']),
});

export const loginResponseSchema = z.object({
  data: z.object({
    token: z.string(),
    user: userSchema,
  }),
});

// ─── Passkey (WebAuthn) ──────────────────────────────────────────────────────

export const passkeyModeSchema = z.union([z.literal('alternative'), z.literal('second_factor'), z.null()]);
export type PasskeyMode = z.infer<typeof passkeyModeSchema>;

// Per-passkey row returned to the UI. Never exposes credentialId or
// publicKey — the client only needs display + lifecycle info.
export const passkeySummarySchema = z.object({
  id: z.string(),
  nickname: z.string(),
  aaguid: z.string().nullable(),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type PasskeySummary = z.infer<typeof passkeySummarySchema>;

export const passkeyRegistrationCompleteSchema = z.object({
  response: z.unknown(), // Browser-issued AttestationResponseJSON; opaque to us.
  nickname: z.string().min(1).max(100),
});
export type PasskeyRegistrationCompleteInput = z.infer<typeof passkeyRegistrationCompleteSchema>;

export const passkeyLoginOptionsRequestSchema = z.object({
  panel: z.union([z.literal('admin'), z.literal('client')]).optional(),
  pre_auth_token: z.string().optional(),
});
export type PasskeyLoginOptionsRequest = z.infer<typeof passkeyLoginOptionsRequestSchema>;

export const passkeyLoginVerifyRequestSchema = z.object({
  panel: z.union([z.literal('admin'), z.literal('client')]).optional(),
  response: z.unknown(),
  pre_auth_token: z.string().optional(),
});
export type PasskeyLoginVerifyRequest = z.infer<typeof passkeyLoginVerifyRequestSchema>;

export const passkeyModeUpdateSchema = z.object({
  mode: passkeyModeSchema,
});
export type PasskeyModeUpdateInput = z.infer<typeof passkeyModeUpdateSchema>;

// 2FA-step-1 response: when the password login succeeded but the
// user opted into 'second_factor' mode, the server returns this
// instead of session tokens. The frontend transitions to a passkey
// prompt and calls /auth/passkey/login/{options,verify} with the
// pre_auth_token attached.
export const loginPasskeyRequiredResponseSchema = z.object({
  data: z.object({
    requires_passkey: z.literal(true),
    pre_auth_token: z.string(),
    expires_in: z.number(),
    user: z.object({
      id: z.string(),
      email: z.string(),
      fullName: z.string(),
      role: z.string(),
      panel: z.string().optional(),
      clientId: z.string().nullable().optional(),
    }),
  }),
});
export type LoginPasskeyRequiredResponse = z.infer<typeof loginPasskeyRequiredResponseSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type User = z.infer<typeof userSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
