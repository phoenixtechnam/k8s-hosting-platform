import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createProtectedDirectorySchema = z.object({
  path: z.string().min(1).max(500),
  realm: z.string().min(1).max(255).default('Restricted Area'),
});

export const updateProtectedDirectorySchema = z.object({
  realm: z.string().min(1).max(255).optional(),
});

export const createProtectedDirectoryUserSchema = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(6).max(255),
});

export const changeProtectedDirectoryUserPasswordSchema = z.object({
  password: z.string().min(6).max(255),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const protectedDirectoryResponseSchema = z.object({
  id: uuidField,
  domainId: uuidField,
  path: z.string(),
  realm: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const protectedDirectoryUserResponseSchema = z.object({
  id: uuidField,
  directoryId: uuidField,
  username: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateProtectedDirectoryInput = z.infer<typeof createProtectedDirectorySchema>;
export type UpdateProtectedDirectoryInput = z.infer<typeof updateProtectedDirectorySchema>;
export type CreateProtectedDirectoryUserInput = z.infer<typeof createProtectedDirectoryUserSchema>;
export type ProtectedDirectoryResponse = z.infer<typeof protectedDirectoryResponseSchema>;
export type ProtectedDirectoryUserResponse = z.infer<typeof protectedDirectoryUserResponseSchema>;
