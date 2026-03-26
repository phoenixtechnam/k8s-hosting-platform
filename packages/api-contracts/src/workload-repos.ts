import { z } from 'zod';
import { uuidField } from './shared.js';

const githubUrlPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const addRepoInputSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().regex(githubUrlPattern, 'Must be a GitHub repository URL (https://github.com/owner/repo)'),
  branch: z.string().min(1).max(100).default('main'),
  auth_token: z.string().max(500).optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).default(60),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const workloadRepoResponseSchema = z.object({
  id: uuidField,
  name: z.string(),
  url: z.string(),
  branch: z.string(),
  syncIntervalMinutes: z.number(),
  lastSyncedAt: z.string().nullable(),
  status: z.string(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type AddRepoInput = z.infer<typeof addRepoInputSchema>;
export type WorkloadRepoResponse = z.infer<typeof workloadRepoResponseSchema>;
