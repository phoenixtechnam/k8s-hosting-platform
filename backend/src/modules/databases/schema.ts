import { z } from 'zod';

const nameRegex = /^[a-zA-Z0-9_]+$/;

export const createDatabaseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(nameRegex, 'Name must contain only alphanumeric characters and underscores'),
  db_type: z.enum(['mysql', 'postgresql']).default('mysql'),
});

export const updateDatabaseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(nameRegex, 'Name must contain only alphanumeric characters and underscores')
    .optional(),
});

export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type UpdateDatabaseInput = z.infer<typeof updateDatabaseSchema>;
