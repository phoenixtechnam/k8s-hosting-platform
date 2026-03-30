import { describe, it, expect } from 'vitest';
import {
  canUpgrade,
  getAvailableUpgrades,
  findUpgradePath,
  resolveDefaultVersion,
  resolveVersionStatus,
  type SupportedVersion,
} from './version-utils.js';

const wpVersions: readonly SupportedVersion[] = [
  {
    version: '6.7',
    components: [{ name: 'wordpress', image: 'wordpress:6.7-php8.3-apache' }],
    eolDate: '2026-04-30',
  },
  {
    version: '6.8',
    components: [{ name: 'wordpress', image: 'wordpress:6.8-php8.4-apache' }],
    upgradeFrom: ['6.7'],
    eolDate: '2026-09-30',
  },
  {
    version: '6.9',
    components: [{ name: 'wordpress', image: 'wordpress:6.9-php8.4-apache' }],
    upgradeFrom: ['6.7', '6.8'],
    isDefault: true,
  },
];

describe('canUpgrade', () => {
  it('should allow direct upgrade from 6.7 to 6.8', () => {
    expect(canUpgrade(wpVersions, '6.7', '6.8')).toBe(true);
  });

  it('should allow direct upgrade from 6.7 to 6.9 (skip)', () => {
    expect(canUpgrade(wpVersions, '6.7', '6.9')).toBe(true);
  });

  it('should allow direct upgrade from 6.8 to 6.9', () => {
    expect(canUpgrade(wpVersions, '6.8', '6.9')).toBe(true);
  });

  it('should reject downgrade from 6.9 to 6.7', () => {
    expect(canUpgrade(wpVersions, '6.9', '6.7')).toBe(false);
  });

  it('should reject upgrade to unknown version', () => {
    expect(canUpgrade(wpVersions, '6.7', '7.0')).toBe(false);
  });

  it('should reject upgrade from unknown version', () => {
    expect(canUpgrade(wpVersions, '6.6', '6.7')).toBe(false);
  });

  it('should reject upgrade when target has no upgradeFrom', () => {
    expect(canUpgrade(wpVersions, '6.6', '6.7')).toBe(false);
  });
});

describe('getAvailableUpgrades', () => {
  it('should return 6.8 and 6.9 for version 6.7', () => {
    const upgrades = getAvailableUpgrades(wpVersions, '6.7');
    expect(upgrades.map(v => v.version)).toEqual(['6.8', '6.9']);
  });

  it('should return only 6.9 for version 6.8', () => {
    const upgrades = getAvailableUpgrades(wpVersions, '6.8');
    expect(upgrades.map(v => v.version)).toEqual(['6.9']);
  });

  it('should return empty for latest version', () => {
    const upgrades = getAvailableUpgrades(wpVersions, '6.9');
    expect(upgrades).toEqual([]);
  });

  it('should return empty for unknown version', () => {
    const upgrades = getAvailableUpgrades(wpVersions, '5.0');
    expect(upgrades).toEqual([]);
  });
});

describe('findUpgradePath', () => {
  it('should return empty for same version', () => {
    expect(findUpgradePath(wpVersions, '6.9', '6.9')).toEqual([]);
  });

  it('should find direct path from 6.7 to 6.9', () => {
    expect(findUpgradePath(wpVersions, '6.7', '6.9')).toEqual(['6.9']);
  });

  it('should find direct path from 6.8 to 6.9', () => {
    expect(findUpgradePath(wpVersions, '6.8', '6.9')).toEqual(['6.9']);
  });

  it('should return null for impossible downgrade', () => {
    expect(findUpgradePath(wpVersions, '6.9', '6.7')).toBeNull();
  });

  it('should find multi-step path when direct path not available', () => {
    // Sequential-only versions: A -> B -> C (no skip)
    const sequential: SupportedVersion[] = [
      { version: 'A', components: [{ name: 'x', image: 'x:a' }] },
      { version: 'B', components: [{ name: 'x', image: 'x:b' }], upgradeFrom: ['A'] },
      { version: 'C', components: [{ name: 'x', image: 'x:c' }], upgradeFrom: ['B'] },
    ];
    expect(findUpgradePath(sequential, 'A', 'C')).toEqual(['B', 'C']);
  });

  it('should return null when no path exists', () => {
    const disconnected: SupportedVersion[] = [
      { version: 'A', components: [{ name: 'x', image: 'x:a' }] },
      { version: 'B', components: [{ name: 'x', image: 'x:b' }] },
    ];
    expect(findUpgradePath(disconnected, 'A', 'B')).toBeNull();
  });
});

describe('resolveDefaultVersion', () => {
  it('should return version marked isDefault', () => {
    expect(resolveDefaultVersion(wpVersions)).toBe('6.9');
  });

  it('should return last version if none marked default', () => {
    const noDefault: SupportedVersion[] = [
      { version: '1.0', components: [{ name: 'x', image: 'x:1' }] },
      { version: '2.0', components: [{ name: 'x', image: 'x:2' }] },
    ];
    expect(resolveDefaultVersion(noDefault)).toBe('2.0');
  });

  it('should return null for empty array', () => {
    expect(resolveDefaultVersion([])).toBeNull();
  });
});

describe('resolveVersionStatus', () => {
  it('should return available when no eolDate', () => {
    expect(resolveVersionStatus(undefined)).toBe('available');
  });

  it('should return available when eolDate is far in the future', () => {
    expect(resolveVersionStatus('2099-12-31')).toBe('available');
  });

  it('should return deprecated when within 30 days of EOL', () => {
    const now = new Date('2026-04-15');
    expect(resolveVersionStatus('2026-04-30', now)).toBe('deprecated');
  });

  it('should return eol when past eolDate', () => {
    const now = new Date('2026-05-01');
    expect(resolveVersionStatus('2026-04-30', now)).toBe('eol');
  });

  it('should return available for invalid date', () => {
    expect(resolveVersionStatus('not-a-date')).toBe('available');
  });
});
