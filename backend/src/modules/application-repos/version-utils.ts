/**
 * Utility functions for application version path validation and resolution.
 */

export interface SupportedVersion {
  readonly version: string;
  readonly components: readonly { name: string; image: string }[];
  readonly upgradeFrom?: readonly string[];
  readonly eolDate?: string;
  readonly breakingChanges?: string;
  readonly envChanges?: readonly { key: string; action: string; oldKey?: string; default?: unknown }[];
  readonly migrationNotes?: string;
  readonly minResources?: { cpu?: string; memory?: string; storage?: string };
  readonly isDefault?: boolean;
}

/**
 * Check if upgrading from `fromVersion` to `toVersion` is valid
 * according to the supportedVersions upgrade paths.
 */
export function canUpgrade(
  supportedVersions: readonly SupportedVersion[],
  fromVersion: string,
  toVersion: string,
): boolean {
  const target = supportedVersions.find(v => v.version === toVersion);
  if (!target) return false;
  if (!target.upgradeFrom || target.upgradeFrom.length === 0) return false;
  return target.upgradeFrom.includes(fromVersion);
}

/**
 * Get all versions that `fromVersion` can upgrade to.
 */
export function getAvailableUpgrades(
  supportedVersions: readonly SupportedVersion[],
  fromVersion: string,
): readonly SupportedVersion[] {
  return supportedVersions.filter(
    v => v.upgradeFrom?.includes(fromVersion) && v.version !== fromVersion,
  );
}

/**
 * Find the shortest upgrade path from `fromVersion` to `toVersion`.
 * Returns the ordered list of intermediate versions (excluding fromVersion, including toVersion),
 * or null if no path exists.
 */
export function findUpgradePath(
  supportedVersions: readonly SupportedVersion[],
  fromVersion: string,
  toVersion: string,
): readonly string[] | null {
  if (fromVersion === toVersion) return [];

  // Direct upgrade?
  if (canUpgrade(supportedVersions, fromVersion, toVersion)) {
    return [toVersion];
  }

  // BFS for shortest path
  const queue: { version: string; path: string[] }[] = [{ version: fromVersion, path: [] }];
  const visited = new Set<string>([fromVersion]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextVersions = getAvailableUpgrades(supportedVersions, current.version);

    for (const next of nextVersions) {
      if (visited.has(next.version)) continue;
      const newPath = [...current.path, next.version];

      if (next.version === toVersion) return newPath;

      visited.add(next.version);
      queue.push({ version: next.version, path: newPath });
    }
  }

  return null;
}

/**
 * Resolve the default version from supportedVersions.
 * Returns the version marked isDefault, or the last entry if none marked.
 */
export function resolveDefaultVersion(
  supportedVersions: readonly SupportedVersion[],
): string | null {
  if (supportedVersions.length === 0) return null;
  const defaultEntry = supportedVersions.find(v => v.isDefault);
  return defaultEntry?.version ?? supportedVersions[supportedVersions.length - 1].version;
}

/**
 * Determine the version status based on eolDate.
 */
export function resolveVersionStatus(
  eolDate: string | undefined,
  now: Date = new Date(),
): 'available' | 'deprecated' | 'eol' {
  if (!eolDate) return 'available';
  const eol = new Date(eolDate);
  if (isNaN(eol.getTime())) return 'available';

  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  if (now.getTime() >= eol.getTime()) return 'eol';
  if (now.getTime() >= eol.getTime() - thirtyDaysMs) return 'deprecated';
  return 'available';
}
