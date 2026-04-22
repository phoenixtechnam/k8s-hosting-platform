import { z } from 'zod';

// Reject plain HTTP in non-dev. httpUrl from backup-config is stricter —
// admin-entered URLs for embedded iframes MUST be https, so this schema
// goes further and refuses http:// outright. Localhost is fine via the
// DinD dev overlay where ingress serves https on :2011 anyway.
const httpsUrl = z.string().url().refine(
  (v) => v.startsWith('https://') || v.startsWith('http://localhost') || v.startsWith('http://127.0.0.1'),
  { message: 'must be https:// (http allowed only for localhost)' },
);

// RFC 1123 hostname. Lowercase letters/digits/hyphens per label,
// max 253 chars total, at least two labels (mail.example.com, not just
// `mail`). Trailing dots tolerated — we strip before storage.
const fqdn = z.string()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\.?$/i,
    { message: 'must be a valid fully-qualified domain name' },
  );

// Reset-to-default sentinel. Null on the wire means "delete the row, fall
// back to the apex-derived default". The frontend's Reset button sends
// null; the backend's service treats undefined as "no change", null as
// "delete", and a non-empty string as "set".
const resetOrValue = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.null()]).optional();

export const platformUrlsResponseSchema = z.object({
  apex: z.string(),
  longhornUrl: z.object({
    value: z.string(),
    default: z.string(),
    source: z.enum(['db', 'default']),
  }),
  stalwartAdminUrl: z.object({
    value: z.string(),
    default: z.string(),
    source: z.enum(['db', 'default']),
  }),
  webmailUrl: z.object({
    value: z.string(),
    default: z.string(),
    source: z.enum(['db', 'default']),
  }),
  mailServerHostname: z.object({
    value: z.string(),
    default: z.string(),
    source: z.enum(['db', 'default']),
  }),
});

export const updatePlatformUrlsSchema = z.object({
  longhornUrl: resetOrValue(httpsUrl),
  stalwartAdminUrl: resetOrValue(httpsUrl),
  webmailUrl: resetOrValue(httpsUrl),
  mailServerHostname: resetOrValue(fqdn),
});

export type PlatformUrlsResponse = z.infer<typeof platformUrlsResponseSchema>;
export type UpdatePlatformUrlsInput = z.infer<typeof updatePlatformUrlsSchema>;
