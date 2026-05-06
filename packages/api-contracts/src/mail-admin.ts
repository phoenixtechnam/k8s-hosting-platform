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
 * Outcome of the post-Secret-patch pod-recycle step inside the rotation
 * flow. The rotation always patches the Secret first (that's the
 * source-of-truth update); the recycle then forces Stalwart pods to be
 * replaced so they read the new env value immediately instead of
 * waiting for Stakater Reloader's async rollout (which can lag minutes
 * or fail outright if pods crash on startup).
 *
 * Surfaced in the response so the admin UI can show:
 *   "✓ rotated; 3 pods recycled" (success)
 *   "⚠ rotated; recycle failed (see server logs)" (best-effort failure)
 *
 * Code-review HIGH from 2026-05-06: without this field, an RBAC failure
 * on pods/delete would leave drift in place and the operator would only
 * find out by grepping platform-api logs. Surfaces operationally now.
 */
export const recycleResultSchema = z.object({
  /** Number of pods successfully deleted. */
  deletedCount: z.number().int().min(0),
  /** Per-pod error messages (empty array when all deletes succeeded). */
  errors: z.array(z.string()),
  /**
   * `null` when the recycle wasn't requested (e.g. webmail-master
   * rotation, where Roundcube is rolled separately). Present only on
   * the admin rotation path.
   */
}).nullable();
export type RecycleResult = z.infer<typeof recycleResultSchema>;

/**
 * POST /admin/mail/rotate-stalwart-password
 *
 * Generates a fresh random password, writes both the cleartext and the
 * bcrypt hash into the `stalwart-secrets` k8s Secret, then rolls Stalwart
 * and platform-api so they pick up the new values. Returns the new
 * credentials + the ISO timestamp the rotation was verified.
 *
 * `recycleResult` is the outcome of the explicit pod-recycle step; null
 * for rotation paths that don't recycle pods (webmail-master).
 */
export const rotateStalwartPasswordResponseSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  rotatedAt: z.string().datetime(),
  recycleResult: recycleResultSchema.optional(),
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
