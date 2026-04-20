import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import {
  loadStorageLifecycleSettings,
  saveStorageLifecycleSettings,
  getRedactedStorageLifecycleSettings,
  resetStorageLifecycleSettingsCache,
} from './settings.js';

const db = getTestDb();
// Probe once at suite load so we can skip the whole file when there's
// no test postgres available. Without this guard the beforeAll hook
// below surfaces a connect-ECONNREFUSED as an "Error" in vitest output
// even though the test bodies would individually be skipped.
const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('storage-lifecycle settings', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    resetStorageLifecycleSettingsCache();
    await db.execute(sql`DELETE FROM platform_settings WHERE setting_key LIKE 'storage.snapshot.%' OR setting_key LIKE 'storage.retention.%'`);
  });

  it('returns defaults when no rows exist', async () => {
    const s = await loadStorageLifecycleSettings(db);
    expect(s.backend).toBe('hostpath');
    expect(s.hostpathRoot).toBe('/var/lib/platform/snapshots');
    expect(s.retentionManualDays).toBe(30);
    expect(s.retentionPreResizeDays).toBe(7);
    expect(s.retentionPreArchiveDays).toBe(90);
  });

  it('persists and retrieves hostpath settings', async () => {
    await saveStorageLifecycleSettings(db, {
      backend: 'hostpath',
      hostpathRoot: '/mnt/snaps',
      retentionManualDays: 14,
    });
    const s = await loadStorageLifecycleSettings(db);
    expect(s.backend).toBe('hostpath');
    expect(s.hostpathRoot).toBe('/mnt/snaps');
    expect(s.retentionManualDays).toBe(14);
  });

  it('encrypts s3 secrets at rest', async () => {
    await saveStorageLifecycleSettings(db, {
      backend: 's3',
      s3Bucket: 'my-bucket',
      s3Region: 'us-east-1',
      s3AccessKeyId: 'AKIA-TEST',
      s3SecretAccessKey: 'plaintext-secret-DO-NOT-LEAK',
    });
    // Raw row must not contain the plaintext secret.
    const rows = await db.execute<{ setting_key: string; setting_value: string }>(
      sql`SELECT setting_key, setting_value FROM platform_settings WHERE setting_key = 'storage.snapshot.s3_secret_access_key'`,
    );
    const row = rows.rows[0];
    expect(row).toBeDefined();
    expect(row.setting_value).not.toContain('plaintext-secret-DO-NOT-LEAK');
    // But the service can still decrypt for the factory.
    const s = await loadStorageLifecycleSettings(db);
    expect(s.s3SecretAccessKey).toBe('plaintext-secret-DO-NOT-LEAK');
  });

  it('redacts secrets for GET response', async () => {
    await saveStorageLifecycleSettings(db, {
      backend: 's3',
      s3Bucket: 'my-bucket',
      s3Region: 'us-east-1',
      s3AccessKeyId: 'AKIA-TEST',
      s3SecretAccessKey: 'plaintext-secret',
    });
    const redacted = await getRedactedStorageLifecycleSettings(db);
    // Non-secret fields pass through.
    expect(redacted.backend).toBe('s3');
    expect(redacted.s3Bucket).toBe('my-bucket');
    expect(redacted.s3AccessKeyId).toBe('AKIA-TEST');
    // Secret is redacted — never returned to the client.
    expect(redacted.s3SecretAccessKey).toBeNull();
    expect(redacted.s3SecretAccessKeySet).toBe(true);
  });

  it('leaves other platform_settings rows untouched on save', async () => {
    await db.execute(sql`INSERT INTO platform_settings (setting_key, setting_value) VALUES ('unrelated.key', 'unrelated_value') ON CONFLICT DO NOTHING`);
    await saveStorageLifecycleSettings(db, { backend: 'hostpath', hostpathRoot: '/mnt/snaps' });
    const rows = await db.execute<{ setting_value: string }>(sql`SELECT setting_value FROM platform_settings WHERE setting_key = 'unrelated.key'`);
    expect(rows.rows[0]?.setting_value).toBe('unrelated_value');
  });

  it('cache invalidates on save', async () => {
    await saveStorageLifecycleSettings(db, { backend: 'hostpath', hostpathRoot: '/first' });
    const before = await loadStorageLifecycleSettings(db);
    expect(before.hostpathRoot).toBe('/first');
    await saveStorageLifecycleSettings(db, { hostpathRoot: '/second' });
    const after = await loadStorageLifecycleSettings(db);
    expect(after.hostpathRoot).toBe('/second');
  });

  it('rejects unknown backend values', async () => {
    await expect(saveStorageLifecycleSettings(db, { backend: 'wormhole' as unknown as 'hostpath' })).rejects.toThrow();
  });
});
