import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// ─── Defaults ────────────────────────────────────────────────────────────────

// Environment variable override for local DinD (set in .env.local)
const ENV_DEFAULT_STORAGE_CLASS = process.env.DEFAULT_STORAGE_CLASS;

const DEFAULTS = {
  defaultStorageClass: ENV_DEFAULT_STORAGE_CLASS ?? 'longhorn',
  storageOvercommitRatio: 1.5,
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getStorageSettings(db: Database) {
  const storageClass = await getSetting(db, 'default_storage_class');
  const overcommit = await getSetting(db, 'storage_overcommit_ratio');

  return {
    defaultStorageClass: storageClass ?? DEFAULTS.defaultStorageClass,
    storageOvercommitRatio: overcommit ? parseFloat(overcommit) : DEFAULTS.storageOvercommitRatio,
  };
}

export async function updateStorageSettings(
  db: Database,
  input: { defaultStorageClass?: string; storageOvercommitRatio?: number },
) {
  if (input.defaultStorageClass !== undefined) {
    await setSetting(db, 'default_storage_class', input.defaultStorageClass);
  }
  if (input.storageOvercommitRatio !== undefined) {
    await setSetting(db, 'storage_overcommit_ratio', String(input.storageOvercommitRatio));
  }

  return getStorageSettings(db);
}

/**
 * Get the default storage class name for PVC generation.
 * Used by the k8s manifest generator.
 */
export async function getDefaultStorageClass(db: Database): Promise<string> {
  const settings = await getStorageSettings(db);
  return settings.defaultStorageClass;
}

/**
 * Calculate effective storage limit after applying overcommit ratio.
 * e.g., 10Gi plan limit × 1.5 overcommit = 15Gi effective
 */
export async function getEffectiveStorageLimit(
  db: Database,
  planStorageGi: number,
): Promise<number> {
  const settings = await getStorageSettings(db);
  return planStorageGi * settings.storageOvercommitRatio;
}
