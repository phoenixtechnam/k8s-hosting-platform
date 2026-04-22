import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/**
 * Platform URL settings — Longhorn dashboard, Stalwart web-admin, webmail,
 * and the mail server hostname. All four are operator-editable from the
 * admin panel; defaults derive from `ingress_base_domain` so fresh
 * installs show reasonable sub-domains without any manual configuration.
 *
 * Rows live in the key-value `platform_settings` table to dodge the
 * single-row schema migration path (avoids a DB migration entirely, and
 * the existing webmail-settings module already stored its two keys here).
 * When a row is absent, `getPlatformUrls()` returns the apex-derived
 * default with `source: 'default'` — the UI uses that to render "Default:
 * <x>" hints and to decide whether the row is authoritative or computed.
 */

const KEYS = {
  apex: 'ingress_base_domain',
  longhorn: 'longhorn_url',
  stalwart: 'stalwart_admin_url',
  // These two keys predate this module (webmail-settings owns them).
  // We keep the key names so there's one DB source of truth — writes
  // here are visible to webmail-settings and vice versa.
  webmail: 'default_webmail_url',
  mailHost: 'mail_server_hostname',
} as const;

export interface UrlField {
  readonly value: string;
  readonly default: string;
  readonly source: 'db' | 'default';
}

export interface PlatformUrls {
  readonly longhornUrl: UrlField;
  readonly stalwartAdminUrl: UrlField;
  readonly webmailUrl: UrlField;
  readonly mailServerHostname: UrlField;
  readonly apex: string;
}

export interface PlatformUrlsInput {
  readonly longhornUrl?: string | null;
  readonly stalwartAdminUrl?: string | null;
  readonly webmailUrl?: string | null;
  readonly mailServerHostname?: string | null;
}

export function computeDefaults(apex: string): {
  longhornUrl: string;
  stalwartAdminUrl: string;
  webmailUrl: string;
  mailServerHostname: string;
} {
  const normalised = apex.trim().replace(/\.+$/, '');
  if (!normalised) {
    return { longhornUrl: '', stalwartAdminUrl: '', webmailUrl: '', mailServerHostname: '' };
  }
  return {
    longhornUrl: `https://longhorn.${normalised}/`,
    stalwartAdminUrl: `https://mail-admin.${normalised}/`,
    webmailUrl: `https://webmail.${normalised}/`,
    mailServerHostname: `mail.${normalised}`,
  };
}

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.insert(platformSettings).values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

async function deleteSetting(db: Database, key: string): Promise<void> {
  await db.delete(platformSettings).where(eq(platformSettings.key, key));
}

function resolveField(stored: string | null, fallback: string): UrlField {
  if (stored !== null && stored !== '') {
    return { value: stored, default: fallback, source: 'db' };
  }
  return { value: fallback, default: fallback, source: 'default' };
}

export async function getPlatformUrls(db: Database): Promise<PlatformUrls> {
  const apex = (await getSetting(db, KEYS.apex)) ?? '';
  const defaults = computeDefaults(apex);
  const [longhorn, stalwart, webmail, mailHost] = await Promise.all([
    getSetting(db, KEYS.longhorn),
    getSetting(db, KEYS.stalwart),
    getSetting(db, KEYS.webmail),
    getSetting(db, KEYS.mailHost),
  ]);
  return {
    apex,
    longhornUrl: resolveField(longhorn, defaults.longhornUrl),
    stalwartAdminUrl: resolveField(stalwart, defaults.stalwartAdminUrl),
    webmailUrl: resolveField(webmail, defaults.webmailUrl),
    mailServerHostname: resolveField(mailHost, defaults.mailServerHostname),
  };
}

export async function updatePlatformUrls(db: Database, input: PlatformUrlsInput): Promise<void> {
  // null = reset to default (delete the row), undefined = leave alone,
  // string = set. This matches the PATCH semantics the UI expects when
  // the operator clicks "Reset to default".
  const ops: Array<Promise<void>> = [];
  if (input.longhornUrl !== undefined) {
    ops.push(input.longhornUrl === null ? deleteSetting(db, KEYS.longhorn) : setSetting(db, KEYS.longhorn, input.longhornUrl));
  }
  if (input.stalwartAdminUrl !== undefined) {
    ops.push(input.stalwartAdminUrl === null ? deleteSetting(db, KEYS.stalwart) : setSetting(db, KEYS.stalwart, input.stalwartAdminUrl));
  }
  if (input.webmailUrl !== undefined) {
    ops.push(input.webmailUrl === null ? deleteSetting(db, KEYS.webmail) : setSetting(db, KEYS.webmail, input.webmailUrl));
  }
  if (input.mailServerHostname !== undefined) {
    ops.push(input.mailServerHostname === null ? deleteSetting(db, KEYS.mailHost) : setSetting(db, KEYS.mailHost, input.mailServerHostname));
  }
  await Promise.all(ops);
}
