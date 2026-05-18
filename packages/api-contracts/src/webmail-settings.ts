import { z } from 'zod';
import { webmailEngineSchema } from './mailboxes.js';

// Accept any URL the operator types — we intentionally don't force
// https:// or a .com TLD so local dev and corporate intranets can use
// internal hostnames. At least one character prevents "save empty".
export const updateWebmailSettingsSchema = z.object({
  defaultWebmailUrl: z.string().min(1).max(255).url().optional(),
  // Phase 3.A.1: the platform-wide mail server hostname Stalwart
  // advertises on SMTP/IMAP banners and in its TLS certificate.
  // All customer `mail.<domain>` records CNAME to this hostname.
  mailServerHostname: z
    .string()
    .min(1)
    .max(253)
    .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, 'Invalid hostname')
    .optional(),
  // Phase 3.B.3: global default per-customer email send rate limit
  // (messages per hour). null = no default (Stalwart uses its built-in
  // defaults). 0 = all customers blocked unless an override allows.
  emailSendRateLimitDefault: z.number().int().min(0).max(1000000).nullable().optional(),
  // ADR-039 Phase 10: which webmail UI the platform mints handoff
  // tokens for. The backend already maps `roundcube` → `?_task=login&_jwt=`
  // and `bulwark` → `/_impersonate?token=` in generateWebmailToken.
  defaultWebmailEngine: webmailEngineSchema.optional(),
  // 2026-05-18: Webmail feature visibility — three independent flags
  // that hide the matching tab/icon in the webmail UI via CSS. The
  // underlying Stalwart DAV endpoints stay reachable (DAV clients
  // like Thunderbird and iOS continue working) — this is UI-only.
  // All default to false (hidden) so the fresh-install experience
  // is mail-only.
  webmailShowContacts: z.boolean().optional(),
  webmailShowCalendar: z.boolean().optional(),
  webmailShowFiles: z.boolean().optional(),
});

export type UpdateWebmailSettingsInput = z.infer<typeof updateWebmailSettingsSchema>;

export const webmailSettingsResponseSchema = z.object({
  defaultWebmailUrl: z.string(),
  mailServerHostname: z.string().optional(),
  emailSendRateLimitDefault: z.number().nullable().optional(),
  defaultWebmailEngine: webmailEngineSchema,
  // 2026-05-18 (see updateWebmailSettingsSchema). Always present in
  // the response so the admin UI can render the toggle state
  // deterministically; backend coerces unset keys to false.
  webmailShowContacts: z.boolean(),
  webmailShowCalendar: z.boolean(),
  webmailShowFiles: z.boolean(),
});

export type WebmailSettingsResponse = z.infer<typeof webmailSettingsResponseSchema>;
