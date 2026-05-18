import { z } from 'zod';

// ─── Step-up re-authentication for privileged operations ────────────
//
// A "step-up" is a fresh credential challenge required when the user
// hasn't proven a credential recently enough for a privileged action
// (e.g. opening a root shell on a cluster node). Freshness is tracked
// by users.last_credential_check_at; default window is 30 minutes.
//
// Methods are derived from the user's auth config:
//   • 'password'  — user has a passwordHash set
//   • 'passkey'   — user has passkey_mode IN ('alternative','second_factor')
//
// Multi-method users (passwordHash AND passkey enabled) MUST pass
// every applicable method to satisfy step-up; the backend returns the
// list and the frontend collects them in sequence.

export const stepUpMethodSchema = z.union([
  z.literal('password'),
  z.literal('passkey'),
]);
export type StepUpMethod = z.infer<typeof stepUpMethodSchema>;

// Purposes are tagged so we can extend the freshness policy per-action
// later (e.g. shorter window for tenant deletes) without a breaking
// change. Today only 'node_terminal' uses it.
export const stepUpPurposeSchema = z.union([
  z.literal('node_terminal'),
]);
export type StepUpPurpose = z.infer<typeof stepUpPurposeSchema>;

// ─── Status (GET /me/step-up/status?purpose=node_terminal) ─────────

export const stepUpStatusQuerySchema = z.object({
  purpose: stepUpPurposeSchema,
});
export type StepUpStatusQuery = z.infer<typeof stepUpStatusQuerySchema>;

export const stepUpStatusResponseSchema = z.object({
  data: z.object({
    required: z.boolean(),
    methods: z.array(stepUpMethodSchema),
    lastCredentialCheckAt: z.string().datetime().nullable(),
    maxAgeSeconds: z.number().int().positive(),
  }),
});
export type StepUpStatusResponse = z.infer<typeof stepUpStatusResponseSchema>;

// ─── Password step-up (POST /me/step-up/password) ──────────────────

export const stepUpPasswordRequestSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});
export type StepUpPasswordRequest = z.infer<typeof stepUpPasswordRequestSchema>;

// ─── Passkey step-up (POST /me/step-up/passkey/options + /verify) ─

// Begin: server returns the WebAuthn challenge bound to this user.
export const stepUpPasskeyOptionsResponseSchema = z.object({
  data: z.unknown(), // Server-issued PublicKeyCredentialRequestOptionsJSON
});
export type StepUpPasskeyOptionsResponse = z.infer<typeof stepUpPasskeyOptionsResponseSchema>;

// Verify: client returns the AuthenticationResponseJSON.
export const stepUpPasskeyVerifyRequestSchema = z.object({
  response: z.unknown(),
});
export type StepUpPasskeyVerifyRequest = z.infer<typeof stepUpPasskeyVerifyRequestSchema>;

// ─── Shared success response ───────────────────────────────────────

export const stepUpSuccessResponseSchema = z.object({
  data: z.object({
    ok: z.literal(true),
    methodVerified: stepUpMethodSchema,
    lastCredentialCheckAt: z.string().datetime(),
  }),
});
export type StepUpSuccessResponse = z.infer<typeof stepUpSuccessResponseSchema>;
