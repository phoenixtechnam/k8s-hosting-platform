import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { users, smtpRelayConfigs } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import type { Database } from '../../db/index.js';

interface NotificationRow {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly message: string;
}

/**
 * Sends a notification email via the default SMTP relay.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function sendNotificationEmail(
  db: Database,
  notification: NotificationRow,
  encryptionKey: string,
): Promise<void> {
  try {
    // 1. Look up user email
    const [user] = await db
      .select({ email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, notification.userId));

    if (!user?.email) {
      return;
    }

    // 2. Get default SMTP relay config
    const [relay] = await db
      .select()
      .from(smtpRelayConfigs)
      .where(eq(smtpRelayConfigs.isDefault, 1));

    if (!relay || !relay.smtpHost) {
      return;
    }

    // 3. Decrypt auth password
    let authPassword: string | undefined;
    if (relay.authPasswordEncrypted) {
      try {
        authPassword = decrypt(relay.authPasswordEncrypted, encryptionKey);
      } catch {
        // Cannot decrypt — skip sending
        return;
      }
    }

    // 4. Create nodemailer transport
    const transport = nodemailer.createTransport({
      host: relay.smtpHost,
      port: relay.smtpPort ?? 587,
      secure: (relay.smtpPort ?? 587) === 465,
      auth: relay.authUsername
        ? { user: relay.authUsername, pass: authPassword ?? '' }
        : undefined,
    });

    // 5. Format and send email
    const typeEmoji: Record<string, string> = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌',
      success: '✅',
    };
    const emoji = typeEmoji[notification.type] ?? '';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1a1a2e;">${emoji} ${escapeHtml(notification.title)}</h2>
        <p style="color: #333; line-height: 1.6;">${escapeHtml(notification.message)}</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px;">
          This is an automated notification from the K8s Hosting Platform.
        </p>
      </div>
    `.trim();

    const fromAddress = relay.authUsername ?? `noreply@${relay.smtpHost}`;

    await transport.sendMail({
      from: fromAddress,
      to: user.email,
      subject: `[Hosting Platform] ${notification.title}`,
      html,
    });
  } catch (err) {
    // Fire-and-forget: log but never throw
    if (process.env.NODE_ENV !== 'test') {
      console.error('[email-sender] Failed to send notification email:', err);
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
