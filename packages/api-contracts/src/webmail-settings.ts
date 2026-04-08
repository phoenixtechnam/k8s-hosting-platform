import { z } from 'zod';

// Accept any URL the operator types — we intentionally don't force
// https:// or a .com TLD so local dev and corporate intranets can use
// internal hostnames. At least one character prevents "save empty".
export const updateWebmailSettingsSchema = z.object({
  defaultWebmailUrl: z.string().min(1).max(255).url().optional(),
});

export type UpdateWebmailSettingsInput = z.infer<typeof updateWebmailSettingsSchema>;

export const webmailSettingsResponseSchema = z.object({
  defaultWebmailUrl: z.string(),
});

export type WebmailSettingsResponse = z.infer<typeof webmailSettingsResponseSchema>;
