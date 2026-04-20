import { eq, inArray, like } from 'drizzle-orm';
import { z } from 'zod';
import { platformSettings } from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

/**
 * Storage-lifecycle platform settings.
 *
 * Persisted in `platform_settings` under keys prefixed with
 * `storage.snapshot.*` and `storage.retention.*`. Secret-bearing fields
 * (`s3_secret_access_key`, `azure_connection_string`) are encrypted at
 * rest with OIDC_ENCRYPTION_KEY before insert — the raw row never
 * contains plaintext credentials.
 *
 * A small in-process cache (60s TTL) avoids hammering the DB on every
 * snapshot Job. `saveStorageLifecycleSettings` invalidates the cache
 * atomically with the write so the next read reflects the change.
 */

export const storageLifecycleSettingsSchema = z.object({
  backend: z.enum(['hostpath', 's3', 'azure']).optional(),
  hostpathRoot: z.string().min(1).max(255).optional(),

  s3Bucket: z.string().min(1).max(255).nullable().optional(),
  s3Region: z.string().min(1).max(64).nullable().optional(),
  s3Endpoint: z.string().url().nullable().optional(),
  s3AccessKeyId: z.string().min(1).max(255).nullable().optional(),
  s3SecretAccessKey: z.string().min(1).max(255).nullable().optional(),

  azureContainer: z.string().min(1).max(255).nullable().optional(),
  azureConnectionString: z.string().min(1).max(2048).nullable().optional(),

  retentionManualDays: z.number().int().min(1).max(3650).optional(),
  retentionPreResizeDays: z.number().int().min(1).max(3650).optional(),
  retentionPreArchiveDays: z.number().int().min(1).max(3650).optional(),
});

export type StorageLifecycleSettingsInput = z.infer<typeof storageLifecycleSettingsSchema>;

export interface StorageLifecycleSettings {
  readonly backend: 'hostpath' | 's3' | 'azure';
  readonly hostpathRoot: string;

  readonly s3Bucket: string | null;
  readonly s3Region: string | null;
  readonly s3Endpoint: string | null;
  readonly s3AccessKeyId: string | null;
  readonly s3SecretAccessKey: string | null;

  readonly azureContainer: string | null;
  readonly azureConnectionString: string | null;

  readonly retentionManualDays: number;
  readonly retentionPreResizeDays: number;
  readonly retentionPreArchiveDays: number;
}

export interface RedactedStorageLifecycleSettings
  extends Omit<StorageLifecycleSettings, 's3SecretAccessKey' | 'azureConnectionString'> {
  readonly s3SecretAccessKey: null;
  readonly s3SecretAccessKeySet: boolean;
  readonly azureConnectionString: null;
  readonly azureConnectionStringSet: boolean;
}

// ─── Key mapping ────────────────────────────────────────────────────────

type FieldKey = keyof StorageLifecycleSettingsInput;

// Maps camelCase field names to DB keys. Secrets are flagged here so
// encryption is applied uniformly on save and attempted on load.
const FIELD_TO_KEY: Record<FieldKey, { readonly key: string; readonly secret: boolean }> = {
  backend: { key: 'storage.snapshot.backend', secret: false },
  hostpathRoot: { key: 'storage.snapshot.hostpath_root', secret: false },
  s3Bucket: { key: 'storage.snapshot.s3_bucket', secret: false },
  s3Region: { key: 'storage.snapshot.s3_region', secret: false },
  s3Endpoint: { key: 'storage.snapshot.s3_endpoint', secret: false },
  s3AccessKeyId: { key: 'storage.snapshot.s3_access_key_id', secret: false },
  s3SecretAccessKey: { key: 'storage.snapshot.s3_secret_access_key', secret: true },
  azureContainer: { key: 'storage.snapshot.azure_container', secret: false },
  azureConnectionString: { key: 'storage.snapshot.azure_connection_string', secret: true },
  retentionManualDays: { key: 'storage.retention.manual_days', secret: false },
  retentionPreResizeDays: { key: 'storage.retention.pre_resize_days', secret: false },
  retentionPreArchiveDays: { key: 'storage.retention.pre_archive_days', secret: false },
};

const KEY_TO_FIELD: Record<string, FieldKey> = Object.fromEntries(
  (Object.entries(FIELD_TO_KEY) as Array<[FieldKey, { key: string }]>).map(([f, v]) => [v.key, f]),
);

const DEFAULTS: StorageLifecycleSettings = {
  backend: 'hostpath',
  hostpathRoot: '/var/lib/platform/snapshots',
  s3Bucket: null,
  s3Region: null,
  s3Endpoint: null,
  s3AccessKeyId: null,
  s3SecretAccessKey: null,
  azureContainer: null,
  azureConnectionString: null,
  retentionManualDays: 30,
  retentionPreResizeDays: 7,
  retentionPreArchiveDays: 90,
};

const NUMERIC_FIELDS: ReadonlySet<FieldKey> = new Set([
  'retentionManualDays',
  'retentionPreResizeDays',
  'retentionPreArchiveDays',
]);

// ─── Crypto helpers ─────────────────────────────────────────────────────

function encryptionKey(): string {
  // 32 bytes = 64 hex chars. The zero-key fallback is strictly
  // development-only — production refuses to encrypt secrets with a
  // known key. The boot-time check in config/index.ts logs a warning
  // but doesn't throw; this inline guard is the actual enforcement.
  const key = process.env.OIDC_ENCRYPTION_KEY;
  if (key) return key;
  if (process.env.NODE_ENV === 'production' || process.env.PLATFORM_ENV === 'production') {
    throw new Error('storage-lifecycle settings: OIDC_ENCRYPTION_KEY is required in production — refusing to encrypt with a zero key');
  }
  return '0'.repeat(64);
}

function encryptSecret(plaintext: string): string {
  return encrypt(plaintext, encryptionKey());
}

function decryptSecret(ciphertext: string): string {
  return decrypt(ciphertext, encryptionKey());
}

// ─── Cache ──────────────────────────────────────────────────────────────

let cache: { at: number; value: StorageLifecycleSettings } | null = null;
const CACHE_TTL_MS = 60 * 1000;

export function resetStorageLifecycleSettingsCache(): void {
  cache = null;
}

// ─── Load ───────────────────────────────────────────────────────────────

export async function loadStorageLifecycleSettings(db: Database): Promise<StorageLifecycleSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(like(platformSettings.key, 'storage.%'));

  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const { key, value } of rows) {
    const field = KEY_TO_FIELD[key];
    if (!field) continue;
    const meta = FIELD_TO_KEY[field];

    let parsed: unknown = value;
    if (meta.secret) {
      try {
        parsed = decryptSecret(value);
      } catch {
        // Unreadable ciphertext — treat as unset rather than crashing the
        // factory. The UI still shows "secret set" via the redacted view.
        parsed = null;
      }
    }
    if (NUMERIC_FIELDS.has(field)) {
      const n = Number(parsed);
      // A corrupted row could contain a non-numeric string; `Number()`
      // would yield NaN and poison downstream date math. Fall back to
      // the default and log rather than persisting an Invalid Date.
      if (!Number.isFinite(n)) {
        console.warn(`[storage-settings] ignoring non-numeric value for ${field}: ${String(parsed)}`);
        continue;
      }
      parsed = n;
    }
    out[field] = parsed;
  }

  const resolved = out as unknown as StorageLifecycleSettings;
  cache = { at: Date.now(), value: resolved };
  return resolved;
}

// ─── Save ───────────────────────────────────────────────────────────────

export async function saveStorageLifecycleSettings(
  db: Database,
  input: StorageLifecycleSettingsInput,
): Promise<void> {
  const parsed = storageLifecycleSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Invalid storage-lifecycle settings: ${parsed.error.errors[0].message}`,
      400,
      { field: parsed.error.errors[0].path.join('.') },
    );
  }

  const fields = Object.entries(parsed.data) as Array<[FieldKey, unknown]>;
  for (const [field, rawValue] of fields) {
    if (rawValue === undefined) continue;
    const meta = FIELD_TO_KEY[field];
    const key = meta.key;

    if (rawValue === null) {
      await db.delete(platformSettings).where(eq(platformSettings.key, key));
      continue;
    }

    let stored: string;
    if (meta.secret) {
      stored = encryptSecret(String(rawValue));
    } else if (typeof rawValue === 'number') {
      stored = String(rawValue);
    } else {
      stored = String(rawValue);
    }

    await db
      .insert(platformSettings)
      .values({ key, value: stored })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: stored } });
  }

  resetStorageLifecycleSettingsCache();
}

// ─── Redact for API response ────────────────────────────────────────────

export async function getRedactedStorageLifecycleSettings(
  db: Database,
): Promise<RedactedStorageLifecycleSettings> {
  const s = await loadStorageLifecycleSettings(db);
  return {
    ...s,
    s3SecretAccessKey: null,
    s3SecretAccessKeySet: s.s3SecretAccessKey !== null,
    azureConnectionString: null,
    azureConnectionStringSet: s.azureConnectionString !== null,
  };
}

// ─── Utility: probe which keys are present (for migrations) ─────────────

export async function getRawStorageSettingKeys(db: Database): Promise<string[]> {
  const rows = await db
    .select({ key: platformSettings.key })
    .from(platformSettings)
    .where(inArray(platformSettings.key, Object.values(FIELD_TO_KEY).map((m) => m.key)));
  return rows.map((r) => r.key);
}
