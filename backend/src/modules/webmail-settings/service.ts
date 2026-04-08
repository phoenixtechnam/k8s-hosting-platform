/**
 * Platform mail / webmail settings.
 *
 * Phase 2c.5 introduced this module for a single setting —
 * `default_webmail_url`. Phase 3.A.1 extends it with the mail server
 * hostname setting that drives Stalwart's certificate provisioning
 * and the Stalwart TOML config's `hostname = ...` line.
 *
 * Both settings live in the key-value `platform_settings` table. No
 * schema changes required for new keys — they're just rows.
 */

import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Read env at call time, not module-load time, so tests and runtime
// env changes are reflected. Fall back to a hardcoded sentinel only
// when neither the DB setting nor the env var is configured.
function defaultUrlFromEnv(): string {
  return process.env.WEBMAIL_URL ?? 'https://webmail.example.com';
}

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

function defaultMailHostnameFromEnv(): string {
  return process.env.STALWART_HOSTNAME ?? process.env.MAIL_SERVER_HOSTNAME ?? 'mail.example.com';
}

export async function getWebmailSettings(db: Database) {
  const defaultWebmailUrl = await getSetting(db, 'default_webmail_url');
  const mailServerHostname = await getSetting(db, 'mail_server_hostname');
  const rateLimitRaw = await getSetting(db, 'email_send_rate_limit_default');
  const emailSendRateLimitDefault = rateLimitRaw ? parseInt(rateLimitRaw, 10) : null;
  return {
    defaultWebmailUrl: defaultWebmailUrl ?? defaultUrlFromEnv(),
    mailServerHostname: mailServerHostname ?? defaultMailHostnameFromEnv(),
    emailSendRateLimitDefault: Number.isFinite(emailSendRateLimitDefault) ? emailSendRateLimitDefault : null,
  };
}

export async function updateWebmailSettings(
  db: Database,
  input: {
    defaultWebmailUrl?: string;
    mailServerHostname?: string;
    emailSendRateLimitDefault?: number | null;
  },
) {
  if (input.defaultWebmailUrl !== undefined) {
    await setSetting(db, 'default_webmail_url', input.defaultWebmailUrl);
  }
  if (input.mailServerHostname !== undefined) {
    await setSetting(db, 'mail_server_hostname', input.mailServerHostname);
  }
  if (input.emailSendRateLimitDefault !== undefined) {
    if (input.emailSendRateLimitDefault === null) {
      // Clear the setting (Stalwart will have no global throttle rule)
      await setSetting(db, 'email_send_rate_limit_default', '');
    } else {
      await setSetting(db, 'email_send_rate_limit_default', String(input.emailSendRateLimitDefault));
    }
  }
  return getWebmailSettings(db);
}

export async function getDefaultWebmailUrl(db: Database): Promise<string> {
  const settings = await getWebmailSettings(db);
  return settings.defaultWebmailUrl;
}

export async function getMailServerHostname(db: Database): Promise<string> {
  const settings = await getWebmailSettings(db);
  return settings.mailServerHostname;
}
