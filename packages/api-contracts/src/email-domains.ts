import { z } from 'zod';

// max_mailboxes + max_quota_mb removed in round-2 refactor. Total
// mailbox count is now capped at the plan level via
// hosting_plans.max_mailboxes + clients.max_mailboxes_override.
// See backend/src/modules/mailboxes/limit.ts.

export const enableEmailDomainSchema = z.object({
  catch_all_address: z.string().email().optional(),
});

export type EnableEmailDomainInput = z.infer<typeof enableEmailDomainSchema>;

export const updateEmailDomainSchema = z.object({
  enabled: z.boolean().optional(),
  // Phase 2c.5: toggle the derived webmail.<domain> Ingress
  webmail_enabled: z.boolean().optional(),
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
  webmailEnabled: z.number().optional(),
  dkimSelector: z.string(),
  dkimPublicKey: z.string().nullable(),
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

// Round-4 Phase 1: disable preview. Returns the exact set of
// mailboxes, aliases, DNS records, and DKIM keys that would be
// removed when the client calls `DELETE .../disable` for this
// email domain. Used by the client panel to render a complete
// confirmation warning.
export const emailDomainDisablePreviewSchema = z.object({
  emailDomainId: z.string(),
  domainName: z.string(),
  mailboxes: z.array(
    z.object({
      id: z.string(),
      fullAddress: z.string(),
    }),
  ),
  aliases: z.array(
    z.object({
      id: z.string(),
      sourceAddress: z.string(),
    }),
  ),
  dnsRecords: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      name: z.string().nullable(),
      purpose: z.string().nullable(),
    }),
  ),
  dkimKeys: z.array(
    z.object({
      id: z.string(),
      selector: z.string(),
      status: z.string(),
    }),
  ),
  webmailHostname: z.string().nullable(),
});

export type EmailDomainDisablePreview = z.infer<typeof emailDomainDisablePreviewSchema>;
