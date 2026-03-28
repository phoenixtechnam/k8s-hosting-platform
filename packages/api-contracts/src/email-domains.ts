import { z } from 'zod';

export const enableEmailDomainSchema = z.object({
  max_mailboxes: z.number().int().min(1).max(1000).default(50),
  max_quota_mb: z.number().int().min(100).max(102400).default(10240),
  catch_all_address: z.string().email().optional(),
});

export type EnableEmailDomainInput = z.infer<typeof enableEmailDomainSchema>;

export const updateEmailDomainSchema = z.object({
  enabled: z.boolean().optional(),
  max_mailboxes: z.number().int().min(1).max(1000).optional(),
  max_quota_mb: z.number().int().min(100).max(102400).optional(),
  catch_all_address: z.string().email().nullable().optional(),
  spam_threshold_junk: z.number().min(1).max(20).optional(),
  spam_threshold_reject: z.number().min(5).max(30).optional(),
});

export type UpdateEmailDomainInput = z.infer<typeof updateEmailDomainSchema>;

export const emailDomainResponseSchema = z.object({
  id: z.string(),
  domainId: z.string(),
  clientId: z.string(),
  domainName: z.string(),
  enabled: z.number(),
  dkimSelector: z.string(),
  dkimPublicKey: z.string().nullable(),
  maxMailboxes: z.number(),
  maxQuotaMb: z.number(),
  catchAllAddress: z.string().nullable(),
  mxProvisioned: z.number(),
  spfProvisioned: z.number(),
  dkimProvisioned: z.number(),
  dmarcProvisioned: z.number(),
  spamThresholdJunk: z.string(),
  spamThresholdReject: z.string(),
  mailboxCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EmailDomainResponse = z.infer<typeof emailDomainResponseSchema>;
