import { z } from 'zod';

export const createMailboxSchema = z.object({
  local_part: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid mailbox name'),
  password: z.string().min(8).max(128),
  display_name: z.string().max(255).optional(),
  quota_mb: z.number().int().min(50).max(102400).default(1024),
  mailbox_type: z.enum(['mailbox', 'forward_only']).default('mailbox'),
});

export type CreateMailboxInput = z.infer<typeof createMailboxSchema>;

export const updateMailboxSchema = z.object({
  password: z.string().min(8).max(128).optional(),
  display_name: z.string().max(255).optional(),
  quota_mb: z.number().int().min(50).max(102400).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  auto_reply: z.boolean().optional(),
  auto_reply_subject: z.string().max(255).optional(),
  auto_reply_body: z.string().max(10000).optional(),
});

export type UpdateMailboxInput = z.infer<typeof updateMailboxSchema>;

export const mailboxResponseSchema = z.object({
  id: z.string(),
  emailDomainId: z.string(),
  clientId: z.string(),
  localPart: z.string(),
  fullAddress: z.string(),
  displayName: z.string().nullable(),
  quotaMb: z.number(),
  usedMb: z.number(),
  status: z.string(),
  mailboxType: z.string(),
  autoReply: z.number(),
  autoReplySubject: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MailboxResponse = z.infer<typeof mailboxResponseSchema>;

export const mailboxAccessSchema = z.object({
  user_id: z.string().uuid(),
  access_level: z.enum(['full', 'read_only']).default('full'),
});

export type MailboxAccessInput = z.infer<typeof mailboxAccessSchema>;

export const webmailTokenResponseSchema = z.object({
  token: z.string(),
  mailbox: z.string(),
  webmailUrl: z.string(),
});

export type WebmailTokenResponse = z.infer<typeof webmailTokenResponseSchema>;
