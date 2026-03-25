import { z } from 'zod';

const githubUrlPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

export const addRepoInputSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().regex(githubUrlPattern, 'Must be a GitHub repository URL (https://github.com/owner/repo)'),
  branch: z.string().min(1).max(100).default('main'),
  auth_token: z.string().max(500).optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).default(60),
});

export type AddRepoInput = z.infer<typeof addRepoInputSchema>;
