import { z } from 'zod';

// ─── Storage Overview ────────────────────────────────────────────────────────

export const storageOverviewSchema = z.object({
  node: z.object({
    name: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number(),
  }),
  system: z.object({
    platformDatabase: z.object({ usedBytes: z.number() }),
    redis: z.object({ usedBytes: z.number() }),
    dockerImages: z.object({ totalBytes: z.number(), count: z.number() }),
  }),
  clients: z.array(
    z.object({
      clientId: z.string(),
      companyName: z.string(),
      namespace: z.string(),
      usedBytes: z.number(),
    }),
  ),
  total: z.object({
    systemBytes: z.number(),
    clientBytes: z.number(),
  }),
});

export type StorageOverviewResponse = z.infer<typeof storageOverviewSchema>;

// ─── Image Inventory ─────────────────────────────────────────────────────────

export const imageEntrySchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  inUse: z.boolean(),
  protected: z.boolean(),
});

export const imageInventorySchema = z.object({
  images: z.array(imageEntrySchema),
  totalBytes: z.number(),
  purgeableBytes: z.number(),
  purgeableCount: z.number(),
});

export type ImageEntry = z.infer<typeof imageEntrySchema>;
export type ImageInventoryResponse = z.infer<typeof imageInventorySchema>;

// ─── Purge Request/Response ──────────────────────────────────────────────────

export const purgeImagesInputSchema = z.object({
  dryRun: z.boolean().default(true),
});

export const purgeImagesResponseSchema = z.object({
  dryRun: z.boolean(),
  removedImages: z.array(z.string()),
  freedBytes: z.number(),
  errors: z.array(z.string()),
});

export type PurgeImagesInput = z.infer<typeof purgeImagesInputSchema>;
export type PurgeImagesResponse = z.infer<typeof purgeImagesResponseSchema>;
