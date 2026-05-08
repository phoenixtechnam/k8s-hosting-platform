import { describe, it, expect } from 'vitest';
import { BACKUP_META_SCHEMA_VERSION, type BackupMetaV1 } from '@k8s-hosting/api-contracts';
import { BackupMetaError, parseMeta, serializeMeta, componentDir, META_FILENAME } from './meta.js';

const VALID_META: BackupMetaV1 = {
  schemaVersion: BACKUP_META_SCHEMA_VERSION,
  backupId: 'bkp-aaaa',
  clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b',
  capturedAt: '2026-05-01T10:00:00.000Z',
  platformVersion: '0.3.1',
  initiator: 'admin',
  systemTrigger: null,
  label: 'Manual 2026-05-01',
  components: {
    files: { sizeBytes: 100, fileCount: 5, sha256: 'a'.repeat(64) },
  },
  nodePlacement: null,
  expiresAt: '2026-06-01T10:00:00.000Z',
  retentionDays: 30,
  description: null,
  // v2 fields
  client: {
    companyName: 'Acme Co',
    companyEmail: 'admin@acme.test',
    contactEmail: null,
    status: 'active',
    kubernetesNamespace: 'client-acme-deadbeef',
    regionId: '7707111e-21f6-49b6-9eea-a26a007fa2a1',
    planId: 'a383c4ce-ff5e-427b-b6c8-76fea6af043c',
    workerNodeName: null,
    storageTier: 'local',
    timezone: 'UTC',
    storageLimitOverride: null,
    cpuLimitOverride: null,
    memoryLimitOverride: null,
    maxSubUsersOverride: null,
    maxMailboxesOverride: null,
    monthlyPriceOverride: null,
    emailSendRateLimit: null,
    subscriptionExpiresAt: null,
    counts: { mailboxes: 0, domains: 0, deployments: 0 },
  },
  domainsSummary: [],
  deploymentsSummary: [],
};

describe('serializeMeta / parseMeta', () => {
  it('round-trips a valid manifest byte-for-byte', () => {
    const buf = serializeMeta(VALID_META);
    const round = parseMeta(buf);
    expect(round).toEqual(VALID_META);
  });

  it('rejects an unknown schemaVersion with a stable code', () => {
    const fake = JSON.stringify({ ...VALID_META, schemaVersion: 99 });
    expect(() => parseMeta(fake)).toThrowError(BackupMetaError);
    try {
      parseMeta(fake);
    } catch (err) {
      expect((err as BackupMetaError).code).toBe('UNKNOWN_SCHEMA_VERSION');
    }
  });

  it('rejects malformed JSON with INVALID_JSON', () => {
    try {
      parseMeta('{not json');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as BackupMetaError).code).toBe('INVALID_JSON');
    }
  });

  it('rejects schema-violating payloads with INVALID_META', () => {
    const broken = JSON.stringify({ ...VALID_META, retentionDays: -1 });
    try {
      parseMeta(broken);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as BackupMetaError).code).toBe('INVALID_META');
    }
  });

  it('serializeMeta refuses to write a malformed payload', () => {
    const bad = { ...VALID_META, retentionDays: -1 } as unknown as BackupMetaV1;
    expect(() => serializeMeta(bad)).toThrow();
  });
});

describe('componentDir / META_FILENAME', () => {
  it('canonical names match the spec', () => {
    expect(META_FILENAME).toBe('meta.json');
    expect(componentDir('files')).toBe('components/files');
    expect(componentDir('mailboxes')).toBe('components/mailboxes');
    expect(componentDir('config')).toBe('components/config');
    expect(componentDir('secrets')).toBe('components/secrets');
  });
});
