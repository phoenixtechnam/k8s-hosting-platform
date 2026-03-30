/**
 * Builds application_versions records from a catalog manifest.
 * Handles both the new supportedVersions format and the legacy single-version format.
 */

import { resolveVersionStatus } from './version-utils.js';

interface VersionComponent {
  readonly name: string;
  readonly image: string;
}

interface ManifestSupportedVersion {
  readonly version: string;
  readonly components: readonly VersionComponent[];
  readonly upgradeFrom?: readonly string[];
  readonly eolDate?: string;
  readonly breakingChanges?: string;
  readonly envChanges?: readonly { key: string; action: string; oldKey?: string; default?: unknown }[];
  readonly migrationNotes?: string;
  readonly minResources?: { cpu?: string; memory?: string; storage?: string };
  readonly isDefault?: boolean;
}

interface ManifestInput {
  readonly code: string;
  readonly version?: string;
  readonly supportedVersions?: readonly ManifestSupportedVersion[];
}

export interface VersionRecord {
  readonly applicationCatalogId: string;
  readonly version: string;
  readonly isDefault: number;
  readonly eolDate: string | null;
  readonly components: readonly VersionComponent[] | null;
  readonly upgradeFrom: readonly string[] | null;
  readonly breakingChanges: string | null;
  readonly envChanges: readonly { key: string; action: string; oldKey?: string; default?: unknown }[] | null;
  readonly migrationNotes: string | null;
  readonly minResources: { cpu?: string; memory?: string; storage?: string } | null;
  readonly status: 'available' | 'deprecated' | 'eol';
}

export function buildVersionRecords(
  manifest: ManifestInput,
  applicationCatalogId: string,
): readonly VersionRecord[] {
  if (manifest.supportedVersions && manifest.supportedVersions.length > 0) {
    return manifest.supportedVersions.map(sv => ({
      applicationCatalogId,
      version: sv.version,
      isDefault: sv.isDefault ? 1 : 0,
      eolDate: sv.eolDate ?? null,
      components: sv.components ?? null,
      upgradeFrom: sv.upgradeFrom && sv.upgradeFrom.length > 0
        ? [...sv.upgradeFrom]
        : null,
      breakingChanges: sv.breakingChanges ?? null,
      envChanges: sv.envChanges && sv.envChanges.length > 0
        ? [...sv.envChanges]
        : null,
      migrationNotes: sv.migrationNotes ?? null,
      minResources: sv.minResources ?? null,
      status: resolveVersionStatus(sv.eolDate),
    }));
  }

  // Legacy format: single version field
  if (manifest.version) {
    return [{
      applicationCatalogId,
      version: manifest.version,
      isDefault: 1,
      eolDate: null,
      components: null,
      upgradeFrom: null,
      breakingChanges: null,
      envChanges: null,
      migrationNotes: null,
      minResources: null,
      status: 'available' as const,
    }];
  }

  return [];
}
