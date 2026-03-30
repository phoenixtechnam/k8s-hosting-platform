/**
 * Application upgrade orchestration service.
 *
 * Handles upgrade validation, state machine transitions,
 * and available upgrade resolution.
 */

import type { TriggerType } from '@k8s-hosting/api-contracts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UpgradeContext {
  readonly instanceId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly triggeredBy: string;
  readonly triggerType: TriggerType;
  readonly isPatch?: boolean;
}

interface InstanceLike {
  readonly id: string;
  readonly applicationCatalogId: string;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly status: string;
}

interface VersionLike {
  readonly version: string;
  readonly upgradeFrom: readonly string[] | null;
  readonly isDefault: number;
  readonly breakingChanges: string | null;
  readonly migrationNotes: string | null;
  readonly envChanges: readonly { key: string; action: string; oldKey?: string; default?: unknown }[] | null;
  readonly minResources: { cpu?: string; memory?: string; storage?: string } | null;
  readonly status: string;
}

interface ActiveUpgradeLike {
  readonly id: string;
  readonly status: string;
}

interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

interface TransitionResult {
  readonly valid: boolean;
  readonly progressPct?: number;
  readonly statusMessage?: string;
}

// ─── Active upgrade statuses (in-progress, not terminal) ─────────────────────

const ACTIVE_STATUSES = new Set<string>([
  'pending', 'backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back',
]);

// ─── State machine transitions ───────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, { targets: readonly string[]; progressPct: number; statusMessage: string }> = {
  pending: {
    targets: ['backing_up', 'failed'],
    progressPct: 0,
    statusMessage: 'Waiting to start',
  },
  backing_up: {
    targets: ['pre_check', 'failed'],
    progressPct: 10,
    statusMessage: 'Creating backup',
  },
  pre_check: {
    targets: ['upgrading', 'failed'],
    progressPct: 25,
    statusMessage: 'Running pre-upgrade checks',
  },
  upgrading: {
    targets: ['health_check', 'rolling_back', 'failed'],
    progressPct: 50,
    statusMessage: 'Upgrading application',
  },
  health_check: {
    targets: ['completed', 'rolling_back', 'failed'],
    progressPct: 75,
    statusMessage: 'Verifying health',
  },
  rolling_back: {
    targets: ['rolled_back', 'failed'],
    progressPct: 80,
    statusMessage: 'Rolling back to previous version',
  },
  completed: {
    targets: [],
    progressPct: 100,
    statusMessage: 'Upgrade completed successfully',
  },
  failed: {
    targets: [],
    progressPct: -1,
    statusMessage: 'Upgrade failed',
  },
  rolled_back: {
    targets: [],
    progressPct: -1,
    statusMessage: 'Rolled back to previous version',
  },
};

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateUpgradeRequest(
  instance: InstanceLike,
  toVersion: string,
  versions: readonly VersionLike[],
  activeUpgrades: readonly ActiveUpgradeLike[],
): ValidationResult {
  // Must be running
  if (instance.status !== 'running') {
    return { valid: false, error: `Instance must be in running state (current: ${instance.status})` };
  }

  // Must have an installed version
  if (!instance.installedVersion) {
    return { valid: false, error: 'Instance has no installed version set' };
  }

  // Already on target?
  if (instance.installedVersion === toVersion) {
    return { valid: false, error: `Instance is already on version ${toVersion}` };
  }

  // Target version must exist
  const target = versions.find(v => v.version === toVersion);
  if (!target) {
    return { valid: false, error: `Target version '${toVersion}' not found in supported versions` };
  }

  // Upgrade path must be valid
  if (!target.upgradeFrom || !target.upgradeFrom.includes(instance.installedVersion)) {
    return {
      valid: false,
      error: `Upgrade from '${instance.installedVersion}' to '${toVersion}' is not allowed. Valid sources: ${(target.upgradeFrom ?? []).join(', ') || 'none'}`,
    };
  }

  // No concurrent upgrades
  const hasActive = activeUpgrades.some(u => ACTIVE_STATUSES.has(u.status));
  if (hasActive) {
    return { valid: false, error: 'Instance already has an active upgrade in progress' };
  }

  return { valid: true };
}

// ─── Available upgrades ──────────────────────────────────────────────────────

export function getAvailableUpgradesForInstance(
  installedVersion: string | null,
  versions: readonly VersionLike[],
): readonly VersionLike[] {
  if (!installedVersion) return [];

  return versions.filter(
    v => v.upgradeFrom?.includes(installedVersion) && v.version !== installedVersion,
  );
}

// ─── Record creation ─────────────────────────────────────────────────────────

export function createUpgradeRecord(ctx: UpgradeContext) {
  return {
    id: crypto.randomUUID(),
    instanceId: ctx.instanceId,
    fromVersion: ctx.fromVersion,
    toVersion: ctx.toVersion,
    status: 'pending' as const,
    triggeredBy: ctx.triggeredBy,
    triggerType: ctx.triggerType,
    backupId: null,
    progressPct: 0,
    statusMessage: 'Waiting to start',
    errorMessage: null,
    helmValues: null,
    rollbackHelmValues: null,
    startedAt: null,
    completedAt: null,
  };
}

// ─── State machine ───────────────────────────────────────────────────────────

export function transitionUpgrade(
  currentStatus: string,
  nextStatus: string,
): TransitionResult {
  const current = VALID_TRANSITIONS[currentStatus];
  if (!current) {
    return { valid: false };
  }

  if (!current.targets.includes(nextStatus)) {
    return { valid: false };
  }

  const next = VALID_TRANSITIONS[nextStatus];
  return {
    valid: true,
    progressPct: next?.progressPct ?? 0,
    statusMessage: next?.statusMessage ?? nextStatus,
  };
}
