import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Response Schemas ────────────────────────────────────────────────────────

export const containerImageResponseSchema = z.object({
  id: uuidField,
  code: z.string(),
  name: z.string(),
  imageType: z.string(),
  registryUrl: z.string().nullable(),
  digest: z.string().nullable(),
  supportedVersions: z.array(z.string()).nullable(),
  status: z.string(),
  sourceRepoId: z.string().nullable(),
  manifestUrl: z.string().nullable(),
  hasDockerfile: z.number(),
  minPlan: z.string().nullable(),
  resourceCpu: z.string().nullable(),
  resourceMemory: z.string().nullable(),
  envVars: z.array(z.record(z.string(), z.string())).nullable(),
  tags: z.array(z.string()).nullable(),
  createdAt: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type ContainerImageResponse = z.infer<typeof containerImageResponseSchema>;
