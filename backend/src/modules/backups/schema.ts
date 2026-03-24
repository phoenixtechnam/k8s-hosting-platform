import { z } from 'zod';

export const createBackupSchema = z.object({
  backup_type: z.enum(['manual', 'scheduled']).default('manual'),
  resource_type: z.string().max(50).default('full'),
  resource_id: z.string().uuid().optional(),
  notes: z.string().max(1000).optional(),
});

export type CreateBackupInput = z.infer<typeof createBackupSchema>;
