import { z } from 'zod';

export const createAdminUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1).max(255),
  password: z.string().min(8).max(128),
  role_name: z.enum(['admin', 'support', 'billing', 'read_only']),
});

export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;

export const updateAdminUserSchema = z.object({
  full_name: z.string().min(1).max(255).optional(),
  role_name: z.enum(['admin', 'support', 'billing', 'read_only']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: z.string().min(8).max(128).optional(),
});

export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;

export const adminUserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  roleName: z.string(),
  status: z.string(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;
