import { z } from 'zod';

export const generateManifestSchema = z.object({
  overrides: z.object({
    cpu_limit: z.string().optional(),
    memory_limit: z.string().optional(),
    storage_limit: z.string().optional(),
    replica_count: z.number().int().min(1).max(10).optional(),
  }).optional(),
});

export type GenerateManifestInput = z.infer<typeof generateManifestSchema>;

export const manifestFileSchema = z.object({
  filename: z.string(),
  content: z.string(),
});

export const manifestResponseSchema = z.object({
  clientId: z.string(),
  namespace: z.string(),
  manifests: z.array(manifestFileSchema),
});

export type ManifestResponse = z.infer<typeof manifestResponseSchema>;
