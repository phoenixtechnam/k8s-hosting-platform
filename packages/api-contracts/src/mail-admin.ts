import { z } from 'zod';

/**
 * Response from GET /admin/mail/webadmin-url.
 *
 * Returns everything the admin UI needs to launch Stalwart's web-admin
 * interface in a new tab. `url` is browser-reachable (via ingress),
 * `username` is the suggested login (fallback-admin user). The password
 * is deliberately NOT included — ops delivers it out-of-band or admins
 * already know it in dev.
 */
// URL must parse and use a safe scheme. Zod's `.url()` alone accepts
// `javascript:`, `data:`, etc. — we pin to http(s) so an operator-provided
// STALWART_WEBADMIN_URL can't smuggle an XSS payload into an `<a href>`.
const httpUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: 'URL must use http or https scheme',
  });

export const webadminUrlResponseSchema = z.object({
  url: httpUrlSchema,
  username: z.string().min(1),
});

export type WebadminUrlResponse = z.infer<typeof webadminUrlResponseSchema>;
