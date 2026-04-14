/**
 * Platform system settings — single-row configuration.
 *
 * Provides a cached getSettings() function that other modules call to read
 * settings without hitting the DB on every request. Cache is invalidated
 * on update and refreshed every 60 seconds.
 */

import { eq } from 'drizzle-orm';
import { systemSettings, platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { SystemSettings } from '../../db/schema.js';

const SETTINGS_ID = 'system';
const CACHE_TTL_MS = 60_000;

let cachedSettings: SystemSettings | null = null;
let cacheTimestamp = 0;

/**
 * Get system settings with in-memory caching.
 * Falls back to env vars for settings not yet stored in DB.
 */
export async function getSettings(db: Database): Promise<SystemSettings> {
  const now = Date.now();
  if (cachedSettings && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedSettings;
  }

  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));

  if (row) {
    cachedSettings = row;
    cacheTimestamp = now;
    return row;
  }

  // No row exists yet — insert defaults
  const defaults = {
    id: SETTINGS_ID,
    platformName: 'Hosting Platform',
    apiRateLimit: 100,
  };
  await db.insert(systemSettings).values(defaults).onConflictDoNothing();
  const [created] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  cachedSettings = created;
  cacheTimestamp = now;
  return created;
}

/**
 * Update system settings. Invalidates cache.
 */
export async function updateSettings(
  db: Database,
  input: Partial<Omit<SystemSettings, 'id' | 'updatedAt'>>,
): Promise<SystemSettings> {
  await db.update(systemSettings)
    .set(input)
    .where(eq(systemSettings.id, SETTINGS_ID));

  // Propagate to the key-value platformSettings table (used by ingress-routes/service.ts)
  if (input.ingressBaseDomain !== undefined) {
    await db.insert(platformSettings).values({ key: 'ingress_base_domain', value: input.ingressBaseDomain ?? '' })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: input.ingressBaseDomain ?? '' } });
  }

  // Invalidate cache
  cachedSettings = null;
  cacheTimestamp = 0;

  return getSettings(db);
}

/**
 * Get a single setting value with env var fallback.
 * Use this in other modules for settings that were previously env vars.
 */
export async function getSetting<K extends keyof SystemSettings>(
  db: Database,
  key: K,
  envFallback?: string,
): Promise<SystemSettings[K] | string> {
  const settings = await getSettings(db);
  const value = settings[key];
  if (value !== null && value !== undefined && value !== '') return value;
  return envFallback ?? process.env[key.toUpperCase()] ?? '';
}
