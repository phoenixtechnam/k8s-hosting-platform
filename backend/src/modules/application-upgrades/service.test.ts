import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateUpgradeRequest,
  getAvailableUpgradesForInstance,
  createUpgradeRecord,
  transitionUpgrade,
  type UpgradeContext,
} from './service.js';

// ─── Mock data ───────────────────────────────────────────────────────────────

const mockVersions = [
  {
    id: 'v1',
    applicationCatalogId: 'cat1',
    version: '6.7',
    isDefault: 0,
    eolDate: '2026-04-30',
    components: [{ name: 'wordpress', image: 'wordpress:6.7-php8.3-apache' }],
    upgradeFrom: null,
    breakingChanges: null,
    envChanges: null,
    migrationNotes: null,
    minResources: null,
    status: 'deprecated' as const,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
  {
    id: 'v2',
    applicationCatalogId: 'cat1',
    version: '6.8',
    isDefault: 0,
    eolDate: null,
    components: [{ name: 'wordpress', image: 'wordpress:6.8-php8.4-apache' }],
    upgradeFrom: ['6.7'],
    breakingChanges: 'PHP 8.2 minimum',
    envChanges: null,
    migrationNotes: null,
    minResources: null,
    status: 'available' as const,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
  {
    id: 'v3',
    applicationCatalogId: 'cat1',
    version: '6.9',
    isDefault: 1,
    eolDate: null,
    components: [{ name: 'wordpress', image: 'wordpress:6.9-php8.4-apache' }],
    upgradeFrom: ['6.7', '6.8'],
    breakingChanges: null,
    envChanges: null,
    migrationNotes: 'Direct upgrade from 6.7 or 6.8 supported.',
    minResources: null,
    status: 'available' as const,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
];

const mockInstance = {
  id: 'inst1',
  clientId: 'client1',
  applicationCatalogId: 'cat1',
  name: 'my-wordpress',
  domainName: 'example.com',
  configuration: null,
  helmReleaseName: 'wp-client1',
  installedVersion: '6.7',
  targetVersion: null,
  lastUpgradedAt: null,
  status: 'running' as const,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateUpgradeRequest', () => {
  it('should pass when upgrade path is valid', () => {
    const result = validateUpgradeRequest(mockInstance, '6.9', mockVersions, []);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject when instance is not running', () => {
    const stoppedInstance = { ...mockInstance, status: 'stopped' as const };
    const result = validateUpgradeRequest(stoppedInstance, '6.9', mockVersions, []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('running');
  });

  it('should reject when target version not found', () => {
    const result = validateUpgradeRequest(mockInstance, '7.0', mockVersions, []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should reject when upgrade path is not allowed', () => {
    const instance = { ...mockInstance, installedVersion: '6.9' };
    const result = validateUpgradeRequest(instance, '6.7', mockVersions, []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('should reject when there is already an active upgrade', () => {
    const activeUpgrades = [{ id: 'up1', status: 'upgrading' as const }];
    const result = validateUpgradeRequest(mockInstance, '6.9', mockVersions, activeUpgrades);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('already');
  });

  it('should reject when installedVersion is null', () => {
    const noVersion = { ...mockInstance, installedVersion: null };
    const result = validateUpgradeRequest(noVersion, '6.9', mockVersions, []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('installed version');
  });

  it('should reject when already on target version', () => {
    const onTarget = { ...mockInstance, installedVersion: '6.9' };
    const result = validateUpgradeRequest(onTarget, '6.9', mockVersions, []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('already');
  });
});

describe('getAvailableUpgradesForInstance', () => {
  it('should return 6.8 and 6.9 for instance on 6.7', () => {
    const upgrades = getAvailableUpgradesForInstance('6.7', mockVersions);
    expect(upgrades.map(u => u.version)).toEqual(['6.8', '6.9']);
  });

  it('should return only 6.9 for instance on 6.8', () => {
    const upgrades = getAvailableUpgradesForInstance('6.8', mockVersions);
    expect(upgrades.map(u => u.version)).toEqual(['6.9']);
  });

  it('should return empty for instance on latest', () => {
    const upgrades = getAvailableUpgradesForInstance('6.9', mockVersions);
    expect(upgrades).toEqual([]);
  });

  it('should return empty for null installedVersion', () => {
    const upgrades = getAvailableUpgradesForInstance(null, mockVersions);
    expect(upgrades).toEqual([]);
  });
});

describe('createUpgradeRecord', () => {
  it('should create a pending upgrade record', () => {
    const record = createUpgradeRecord({
      instanceId: 'inst1',
      fromVersion: '6.7',
      toVersion: '6.9',
      triggeredBy: 'admin1',
      triggerType: 'manual',
    });

    expect(record.id).toBeDefined();
    expect(record.status).toBe('pending');
    expect(record.progressPct).toBe(0);
    expect(record.fromVersion).toBe('6.7');
    expect(record.toVersion).toBe('6.9');
    expect(record.triggeredBy).toBe('admin1');
    expect(record.triggerType).toBe('manual');
  });
});

describe('transitionUpgrade', () => {
  it('should transition from pending to backing_up', () => {
    const result = transitionUpgrade('pending', 'backing_up');
    expect(result.valid).toBe(true);
    expect(result.progressPct).toBe(10);
  });

  it('should transition from backing_up to pre_check', () => {
    const result = transitionUpgrade('backing_up', 'pre_check');
    expect(result.valid).toBe(true);
    expect(result.progressPct).toBe(25);
  });

  it('should transition from pre_check to upgrading', () => {
    const result = transitionUpgrade('pre_check', 'upgrading');
    expect(result.valid).toBe(true);
    expect(result.progressPct).toBe(50);
  });

  it('should transition from upgrading to health_check', () => {
    const result = transitionUpgrade('upgrading', 'health_check');
    expect(result.valid).toBe(true);
    expect(result.progressPct).toBe(75);
  });

  it('should transition from health_check to completed', () => {
    const result = transitionUpgrade('health_check', 'completed');
    expect(result.valid).toBe(true);
    expect(result.progressPct).toBe(100);
  });

  it('should allow transition to rolling_back from upgrading', () => {
    const result = transitionUpgrade('upgrading', 'rolling_back');
    expect(result.valid).toBe(true);
  });

  it('should allow transition to rolling_back from health_check', () => {
    const result = transitionUpgrade('health_check', 'rolling_back');
    expect(result.valid).toBe(true);
  });

  it('should allow transition to failed from any active state', () => {
    for (const state of ['backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back'] as const) {
      const result = transitionUpgrade(state, 'failed');
      expect(result.valid).toBe(true);
    }
  });

  it('should reject invalid transition from completed', () => {
    const result = transitionUpgrade('completed', 'upgrading');
    expect(result.valid).toBe(false);
  });

  it('should reject invalid transition from pending to upgrading (skipping steps)', () => {
    const result = transitionUpgrade('pending', 'upgrading');
    expect(result.valid).toBe(false);
  });
});
