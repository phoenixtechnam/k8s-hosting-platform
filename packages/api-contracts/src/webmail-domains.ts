import { z } from 'zod';

// RFC 1123 hostname: alphanumeric labels separated by dots, optional hyphens
// inside labels (not at start/end), max 253 chars, each label max 63 chars.
const HOSTNAME_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

// RFC 2606 / RFC 6761 reserved and private-use TLDs. These are rejected because
// cert-manager's public ACME challenge will always fail for non-routable hosts,
// producing a row stuck in (ingressProvisioned=1, certificateProvisioned=0)
// with no recovery path. Local-dev and testing should use a real test domain
// (e.g. via a sandbox DNS provider) or be injected via the DB directly.
const RESERVED_TLD_REGEX = /\.(local|localhost|internal|intranet|lan|corp|home|invalid|test|example|localdomain)$/i;

export const createWebmailDomainSchema = z.object({
  hostname: z
    .string()
    .min(1)
    .max(253)
    .regex(HOSTNAME_REGEX, 'Invalid hostname (must be a valid FQDN)')
    .refine(
      (h) => !RESERVED_TLD_REGEX.test(h),
      'Reserved or non-routable TLDs are not allowed (public ACME certs cannot be issued for them)',
    )
    .transform((s) => s.toLowerCase()),
});

export type CreateWebmailDomainInput = z.infer<typeof createWebmailDomainSchema>;

// Open string instead of closed enum so frontend doesn't hard-fail if the
// backend adds a new status value (e.g. 'no_cluster', 'retrying').
export const webmailDomainResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  hostname: z.string(),
  status: z.string(),
  ingressProvisioned: z.number(),
  certificateProvisioned: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WebmailDomainResponse = z.infer<typeof webmailDomainResponseSchema>;
