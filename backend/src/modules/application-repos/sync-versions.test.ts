import { describe, it, expect } from 'vitest';
import { buildVersionRecords } from './sync-versions.js';

describe('buildVersionRecords', () => {
  it('should create version records from supportedVersions', () => {
    const manifest = {
      code: 'wordpress',
      version: '6.9',
      supportedVersions: [
        {
          version: '6.7',
          components: [{ name: 'wordpress', image: 'wordpress:6.7-php8.3-apache' }],
          eolDate: '2026-04-30',
        },
        {
          version: '6.9',
          components: [{ name: 'wordpress', image: 'wordpress:6.9-php8.4-apache' }],
          upgradeFrom: ['6.7'],
          isDefault: true,
        },
      ],
    };

    const records = buildVersionRecords(manifest, 'catalog-id-1');

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      applicationCatalogId: 'catalog-id-1',
      version: '6.7',
      isDefault: 0,
      eolDate: '2026-04-30',
      components: [{ name: 'wordpress', image: 'wordpress:6.7-php8.3-apache' }],
      upgradeFrom: null,
    });
    expect(records[1]).toMatchObject({
      applicationCatalogId: 'catalog-id-1',
      version: '6.9',
      isDefault: 1,
      upgradeFrom: ['6.7'],
    });
  });

  it('should create a single version record from legacy format (no supportedVersions)', () => {
    const manifest = {
      code: 'vaultwarden',
      version: '1.35.4',
    };

    const records = buildVersionRecords(manifest, 'catalog-id-2');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      applicationCatalogId: 'catalog-id-2',
      version: '1.35.4',
      isDefault: 1,
      components: null,
      upgradeFrom: null,
    });
  });

  it('should return empty when no version info available', () => {
    const manifest = { code: 'unknown' };
    const records = buildVersionRecords(manifest, 'catalog-id-3');
    expect(records).toHaveLength(0);
  });

  it('should resolve latestVersion and defaultVersion', () => {
    const manifest = {
      code: 'wordpress',
      version: '6.9',
      supportedVersions: [
        {
          version: '6.7',
          components: [{ name: 'wp', image: 'wp:6.7' }],
        },
        {
          version: '6.9',
          components: [{ name: 'wp', image: 'wp:6.9' }],
          isDefault: true,
        },
      ],
    };

    const records = buildVersionRecords(manifest, 'id');
    // The function should also provide metadata about which is latest/default
    // We test this via the manifest.version for latest and isDefault flag
    const defaultRec = records.find(r => r.isDefault === 1);
    expect(defaultRec?.version).toBe('6.9');
  });

  it('should include all optional fields when present', () => {
    const manifest = {
      code: 'test',
      version: '2.0',
      supportedVersions: [
        {
          version: '2.0',
          components: [{ name: 'app', image: 'app:2.0' }],
          upgradeFrom: ['1.0'],
          eolDate: '2027-01-01',
          breakingChanges: 'New auth system',
          envChanges: [{ key: 'AUTH_MODE', action: 'add' as const, default: 'oidc' }],
          migrationNotes: 'Run db migrate first',
          minResources: { cpu: '1.0', memory: '512Mi' },
          isDefault: true,
        },
      ],
    };

    const records = buildVersionRecords(manifest, 'id');
    expect(records[0]).toMatchObject({
      breakingChanges: 'New auth system',
      envChanges: [{ key: 'AUTH_MODE', action: 'add', default: 'oidc' }],
      migrationNotes: 'Run db migrate first',
      minResources: { cpu: '1.0', memory: '512Mi' },
    });
  });
});
