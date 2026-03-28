import { z } from 'zod';
import { uuidField, githubUrlPattern } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const addAppRepoInputSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().regex(githubUrlPattern, 'Must be a GitHub repository URL (https://github.com/owner/repo)'),
  branch: z.string().min(1).max(100).default('main'),
  auth_token: z.string().max(500).optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).default(60),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const applicationRepoResponseSchema = z.object({
  id: uuidField,
  name: z.string(),
  url: z.string(),
  branch: z.string(),
  syncIntervalMinutes: z.number(),
  lastSyncedAt: z.string().nullable(),
  status: z.enum(['active', 'error', 'syncing']),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type AddAppRepoInput = z.input<typeof addAppRepoInputSchema>;
export type AddAppRepoOutput = z.infer<typeof addAppRepoInputSchema>;
export type ApplicationRepoResponse = z.infer<typeof applicationRepoResponseSchema>;
