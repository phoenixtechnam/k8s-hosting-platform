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

// ─── Types ───────────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type User = z.infer<typeof userSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
