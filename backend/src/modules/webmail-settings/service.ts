/**
 * Webmail platform settings.
 *
 * Stores the operator-configurable default webmail URL that's used
 * when a mailbox's domain doesn't have its own derived webmail Ingress
 * yet (e.g. because webmail_enabled=false on the email_domain, or the
 * email_domain doesn't exist because the mailbox is on the shared
 * platform domain). Phase 2c.5 adds per-email-domain webmail Ingresses,
 * but the default still exists as a fallback.
 *
 * Single setting today; structured as a module to make room for future
 * settings (e.g. webmail theme, default plugins, disable list) without
 * more schema churn.
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

export async function getWebmailSettings(db: Database) {
  const defaultWebmailUrl = await getSetting(db, 'default_webmail_url');
  return {
    defaultWebmailUrl: defaultWebmailUrl ?? defaultUrlFromEnv(),
  };
}

export async function updateWebmailSettings(
  db: Database,
  input: { defaultWebmailUrl?: string },
) {
  if (input.defaultWebmailUrl !== undefined) {
    await setSetting(db, 'default_webmail_url', input.defaultWebmailUrl);
  }
  return getWebmailSettings(db);
}

export async function getDefaultWebmailUrl(db: Database): Promise<string> {
  const settings = await getWebmailSettings(db);
  return settings.defaultWebmailUrl;
}
