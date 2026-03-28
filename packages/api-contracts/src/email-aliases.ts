import { z } from 'zod';

export const createEmailAliasSchema = z.object({
  source_address: z.string().email(),
  destination_addresses: z.array(z.string().email()).min(1).max(20),
});

export type CreateEmailAliasInput = z.infer<typeof createEmailAliasSchema>;

export const updateEmailAliasSchema = z.object({
  destination_addresses: z.array(z.string().email()).min(1).max(20).optional(),
  enabled: z.boolean().optional(),
});

export type UpdateEmailAliasInput = z.infer<typeof updateEmailAliasSchema>;

export const emailAliasResponseSchema = z.object({
  id: z.string(),
  emailDomainId: z.string(),
  clientId: z.string(),
  sourceAddress: z.string(),
  destinationAddresses: z.array(z.string()),
  enabled: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EmailAliasResponse = z.infer<typeof emailAliasResponseSchema>;
