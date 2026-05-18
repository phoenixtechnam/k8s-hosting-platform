/**
 * Integration coverage for the mail-target sync wired into
 * `setAssignments('system_mail', ...)`.
 *
 * The k8s-touching parts are mocked at the loadCore boundary so the
 * test only exercises the DB + resolver flow + the action-classification
 * branches inside syncMailResticSecretFromAssignment.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { setAssignments } from '../snapshot-classes/service.js';
import { systemSettings } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';

const dbAvailable = await isDbAvailable();
const db = getTestDb();

// ─── k8s mock — captures applyResticSecret / deleteResticSecret calls ─────
//
// Mock loadCore() by intercepting the dynamic import of the k8s client
// at module-evaluation time. We swap it for a stub that records every
// "apply" / "delete" call so the test can assert what the sync did.

interface MockCalls {
  applied: Array<Record<string, string>>;
  deleted: number;
}

const k8sMockCalls: MockCalls = { applied: [], deleted: 0 };

function makeCoreStub() {
  return {
    // Password secret: pretend it doesn't exist on the first read so
    // getOrCreateResticPassword generates a new password and tries to
    // create the Secret. The create call is allowed (no-op stub).
    readNamespacedSecret: vi.fn(async () => {
      const err = new Error('not found') as Error & { code: number };
      err.code = 404;
      throw err;
    }),
    createNamespacedSecret: vi.fn(async () => ({})),
    // applyResticSecret prefers update-first; let replace succeed so
    // we observe the env-var payload it sent.
    replaceNamespacedSecret: vi.fn(async (args: { body: { data: Record<string, string> } }) => {
      // Decode base64 values so the test asserts plaintext env-vars.
      const decoded: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.body.data)) {
        decoded[k] = Buffer.from(v, 'base64').toString('utf8');
      }
      k8sMockCalls.applied.push(decoded);
      return {};
    }),
    deleteNamespacedSecret: vi.fn(async () => {
      k8sMockCalls.deleted += 1;
      return {};
    }),
  };
}

vi.mock('@kubernetes/client-node', async () => {
  // Minimal shape used by mail-target-sync.ts's loadCore.
  return {
    KubeConfig: class {
      loadFromFile() { /* no-op */ }
      loadFromCluster() { /* no-op */ }
      makeApiClient() { return makeCoreStub(); }
    },
    CoreV1Api: class {},
    BatchV1Api: class {},
  };
});

// Re-import AFTER vi.mock is registered.
const { syncMailResticSecretFromAssignment } = await import('./mail-target-sync.js');

// ─── Fixtures ────────────────────────────────────────────────────────────

async function insertTarget(name: string, storageType: 's3' | 'ssh' | 'cifs' = 's3'): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO backup_configurations (
      id, name, "storageType", retention_days, schedule_expression,
      enabled, active, s3_bucket, s3_endpoint, s3_prefix,
      ssh_host, ssh_user, ssh_port, ssh_path,
      created_at, updated_at
    ) VALUES (
      ${id}, ${name}, ${storageType}, 30, '0 2 * * *',
      1, false,
      ${storageType === 's3' ? 'test-bucket' : null},
      ${storageType === 's3' ? 'https://example.com' : null},
      ${storageType === 's3' ? 'mail' : null},
      ${storageType === 'ssh' ? 'sftp.example.com' : null},
      ${storageType === 'ssh' ? 'backup' : null},
      ${storageType === 'ssh' ? 22 : null},
      ${storageType === 'ssh' ? '/srv/restic' : null},
      NOW(), NOW()
    )
  `);
  return id;
}

async function clearMail() {
  k8sMockCalls.applied = [];
  k8sMockCalls.deleted = 0;
  await db.execute(sql`DELETE FROM backup_target_assignments WHERE snapshot_class = 'system_mail'`);
  await db.execute(sql`DELETE FROM backup_configurations WHERE name LIKE 'mt-test-%'`);
  await db.update(systemSettings)
    .set({ mailSnapshotBackupStoreId: null })
    .where(eq(systemSettings.id, 'system'));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)('mail-target-sync', () => {
  beforeAll(async () => {
    await runMigrations();
    // Ensure SETTINGS row exists for the update-fallback path.
    await db.execute(sql`
      INSERT INTO system_settings (id) VALUES ('system')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  beforeEach(clearMail);

  it('deletes Secret + clears mirror when no system_mail assignment exists', async () => {
    const r = await syncMailResticSecretFromAssignment(db, '0'.repeat(64));
    expect(r.action).toBe('deleted');
    expect(r.targetId).toBeNull();
    expect(k8sMockCalls.deleted).toBe(1);
    expect(k8sMockCalls.applied).toHaveLength(0);
  });

  it('applies Secret with restic env when system_mail assignment exists', async () => {
    const t = await insertTarget('mt-test-s3', 's3');
    await setAssignments(db, 'system_mail', {
      assignments: [{ targetId: t, priority: 0 }],
    });

    const r = await syncMailResticSecretFromAssignment(db, '0'.repeat(64));

    expect(r.action).toBe('applied');
    expect(r.targetId).toBe(t);
    expect(r.storageType).toBe('s3');
    expect(k8sMockCalls.applied).toHaveLength(1);
    const env = k8sMockCalls.applied[0];
    expect(env.RESTIC_REPOSITORY).toBe('s3:https://example.com/test-bucket/mail/mail-snapshots');
    expect(env.RESTIC_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
    // mirror column gets updated
    const [{ mirror }] = await db.execute(
      sql`SELECT mail_snapshot_backup_store_id AS mirror FROM system_settings WHERE id = 'system'`,
    ) as unknown as Array<{ mirror: string | null }>;
    expect(mirror).toBe(t);
  });

  it('routes legacy PATCH through setAssignments (TOCTOU-c lock)', async () => {
    const t = await insertTarget('mt-test-legacy', 's3');

    // Call legacy passthrough.
    const { updateMailSnapshotBackupTarget } = await import('./snapshot-settings.js');
    await updateMailSnapshotBackupTarget(
      { backupStoreId: t },
      db,
      { kubeconfigPath: undefined },
      '0'.repeat(64),
    );

    // Assignment row exists, system_mail class.
    const rows = await db.execute(
      sql`SELECT target_id FROM backup_target_assignments WHERE snapshot_class = 'system_mail'`,
    ) as unknown as Array<{ target_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(t);
  });

  it('clears assignment + deletes Secret when legacy PATCH passes null', async () => {
    const t = await insertTarget('mt-test-clear', 's3');
    await setAssignments(db, 'system_mail', { assignments: [{ targetId: t, priority: 0 }] });

    const { updateMailSnapshotBackupTarget } = await import('./snapshot-settings.js');
    await updateMailSnapshotBackupTarget(
      { backupStoreId: null },
      db,
      { kubeconfigPath: undefined },
      '0'.repeat(64),
    );

    const rows = await db.execute(
      sql`SELECT target_id FROM backup_target_assignments WHERE snapshot_class = 'system_mail'`,
    ) as unknown as Array<{ target_id: string }>;
    expect(rows).toHaveLength(0);
  });
});
