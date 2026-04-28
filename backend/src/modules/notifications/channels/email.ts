/**
 * Email notification channel — wraps the existing `sendNotificationEmail`
 * implementation in the channel interface so the registry can iterate
 * it the same way as in-app and future channels.
 *
 * Behaviour parity with the pre-channel code path is critical here:
 * the email-sender's existing logic (default SMTP relay lookup, password
 * decryption, HTML formatting) is preserved verbatim. This channel only
 * adds the availability gate and the typed DeliveryResult.
 *
 * Roadmap (PHASE_1_ROADMAP.md, Notification phases 2-3):
 *  - Phase 2: replace fire-and-forget with `notification_deliveries`
 *    audit + retry reconciler
 *  - Phase 3: consult per-user preferences before deliver() is called
 *    (preference filtering happens in the service layer, not here)
 */

import { sendNotificationEmail } from '../email-sender.js';
import type { NotificationChannel, DeliveryContext, DeliveryResult } from './types.js';

export const emailChannel: NotificationChannel = {
  id: 'email',
  /**
   * The encryption key (used to decrypt the SMTP relay's auth password)
   * is the only hard requirement for email delivery. Without it the
   * existing email-sender silently no-ops; making availability explicit
   * here lets the registry skip the channel cleanly.
   *
   * Reads `process.env.OIDC_ENCRYPTION_KEY` directly (the established
   * convention in this codebase — see service.ts pre-refactor and
   * app.ts startDkimScheduler). Tests override via the
   * `encryptionKey` field on DeliveryContext so isAvailable() can
   * return true regardless of process env.
   */
  isAvailable(): boolean {
    return Boolean(process.env.OIDC_ENCRYPTION_KEY);
  },
  async deliver(ctx: DeliveryContext): Promise<DeliveryResult> {
    const key = ctx.encryptionKey ?? process.env.OIDC_ENCRYPTION_KEY;
    if (!key) {
      return { status: 'skipped', reason: 'OIDC_ENCRYPTION_KEY not set' };
    }
    try {
      // sendNotificationEmail itself already silently catches and logs;
      // we wrap it again so any rejection path becomes a typed result
      // rather than an unhandled rejection at the registry level.
      await sendNotificationEmail(ctx.db, ctx.notification, key);
      return { status: 'delivered' };
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
