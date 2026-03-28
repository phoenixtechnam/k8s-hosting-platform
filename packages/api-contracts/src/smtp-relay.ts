import { z } from 'zod';

const mailgunConfigSchema = z.object({
  provider_type: z.literal('mailgun'),
  name: z.string().min(1).max(255),
  smtp_host: z.string().default('smtp.mailgun.org'),
  smtp_port: z.number().int().default(587),
  auth_username: z.string().min(1),
  auth_password: z.string().min(1),
  region: z.enum(['us', 'eu']).default('eu'),
  enabled: z.boolean().default(true),
});

const postmarkConfigSchema = z.object({
  provider_type: z.literal('postmark'),
  name: z.string().min(1).max(255),
  smtp_host: z.string().default('smtp.postmarkapp.com'),
  smtp_port: z.number().int().default(587),
  api_key: z.string().min(1),
  enabled: z.boolean().default(true),
});

const directConfigSchema = z.object({
  provider_type: z.literal('direct'),
  name: z.string().min(1).max(255),
  enabled: z.boolean().default(true),
});

export const createSmtpRelaySchema = z.discriminatedUnion('provider_type', [
  mailgunConfigSchema,
  postmarkConfigSchema,
  directConfigSchema,
]);

export type CreateSmtpRelayInput = z.infer<typeof createSmtpRelaySchema>;

export const updateSmtpRelaySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  smtp_host: z.string().optional(),
  smtp_port: z.number().int().optional(),
  auth_username: z.string().optional(),
  auth_password: z.string().optional(),
  api_key: z.string().optional(),
  region: z.string().optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

export type UpdateSmtpRelayInput = z.infer<typeof updateSmtpRelaySchema>;

export const smtpRelayResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerType: z.string(),
  isDefault: z.number(),
  enabled: z.number(),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().nullable(),
  authUsername: z.string().nullable(),
  region: z.string().nullable(),
  lastTestedAt: z.string().nullable(),
  lastTestStatus: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SmtpRelayResponse = z.infer<typeof smtpRelayResponseSchema>;
