import { z } from 'zod';

/**
 * GET /admin/mail/stalwart-credentials
 *
 * Returns the Stalwart fallback-admin credentials so the admin panel can
 * surface them to a super_admin/admin/support user (who already has the
 * power to `kubectl get secret` the cluster, so this is not a privilege
 * escalation). The UI only reveals these on an explicit click.
 */
export const stalwartCredentialsResponseSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type StalwartCredentialsResponse = z.infer<typeof stalwartCredentialsResponseSchema>;

/**
 * POST /admin/mail/rotate-stalwart-password
 *
 * Generates a fresh random password, writes both the cleartext and the
 * bcrypt hash into the `stalwart-secrets` k8s Secret, then rolls Stalwart
 * and platform-api so they pick up the new values. Returns the new
 * credentials + the ISO timestamp the rotation was verified.
 */
export const rotateStalwartPasswordResponseSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  rotatedAt: z.string().datetime(),
});
export type RotateStalwartPasswordResponse = z.infer<typeof rotateStalwartPasswordResponseSchema>;

/**
 * POST /admin/mail/rotate-webmail-master-password
 *
 * Cut 3 (2026-05-05): rotate the Stalwart `master@master.local` Account
 * password (consumed by Roundcube's jwt_auth plugin for IMAP master-user
 * impersonation). Three-step:
 *   1. JMAP x:Account/set update credentials/0/secret on the master Account.
 *   2. Patch `roundcube-secrets.STALWART_MASTER_PASSWORD` in the mail ns.
 *   3. Roll the Roundcube Deployment so its env vars pick up the new
 *      password (Roundcube reads STALWART_MASTER_PASSWORD at process
 *      start, NOT via volume-mount refresh).
 *
 * Same response shape as rotate-stalwart-password — operator gets the
 * cleartext password once and must capture it.
 */
export const rotateWebmailMasterPasswordResponseSchema = rotateStalwartPasswordResponseSchema;
export type RotateWebmailMasterPasswordResponse = z.infer<typeof rotateWebmailMasterPasswordResponseSchema>;
