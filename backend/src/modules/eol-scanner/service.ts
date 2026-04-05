/**
 * EOL Scanner Service
 *
 * Scans catalogEntryVersions for approaching/passed EOL dates.
 * Notifies admins, and optionally triggers forced upgrades after grace period.
 */

import { eq, and, lte, isNotNull, inArray } from 'drizzle-orm';
import {
  catalogEntryVersions,
  deployments,
  deploymentUpgrades,
  platformSettings,
} from '../../db/schema.js';
import { notifyUser } from '../notifications/service.js';
import type { Database } from '../../db/index.js';

// ─── Inline upgrade helpers (previously from application-upgrades/service) ───

interface UpgradeRecordInput {
  readonly deploymentId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly triggeredBy: string;
  readonly triggerType: 'manual' | 'batch' | 'forced';
}

function createUpgradeRecord(input: UpgradeRecordInput) {
  return {
    id: crypto.randomUUID(),
    deploymentId: input.deploymentId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    triggeredBy: input.triggeredBy,
    triggerType: input.triggerType,
    status: 'pending' as const,
    progressPct: 0,
  };
}

function getAvailableUpgradesForDeployment(
  currentVersion: string,
  allVersions: Array<{ version: string; status: string; upgradeFrom?: string[] | readonly string[] | null }>,
) {
  return allVersions.filter(v => {
    if (v.version === currentVersion) return false;
    if (v.upgradeFrom && !v.upgradeFrom.includes(currentVersion)) return false;
    return true;
  });
}

// ─── Settings Keys ──────────────────────────────────────────────────────────

const SETTING_EOL_GRACE_DAYS = 'eol_grace_days';
const SETTING_EOL_AUTO_UPGRADE = 'eol_auto_upgrade_enabled';
const SETTING_EOL_WARNING_DAYS = 'eol_warning_days';

const DEFAULT_GRACE_DAYS = 30;
const DEFAULT_WARNING_DAYS = 60;
const DEFAULT_AUTO_UPGRADE = false;

// ─── Platform settings helpers ──────────────────────────────────────────────

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

// ─── EOL Settings ───────────────────────────────────────────────────────────

export interface EolSettings {
  readonly graceDays: number;
  readonly warningDays: number;
  readonly autoUpgradeEnabled: boolean;
}

export async function getEolSettings(db: Database): Promise<EolSettings> {
  const graceDays = await getSetting(db, SETTING_EOL_GRACE_DAYS);
  const warningDays = await getSetting(db, SETTING_EOL_WARNING_DAYS);
  const autoUpgrade = await getSetting(db, SETTING_EOL_AUTO_UPGRADE);

  return {
    graceDays: graceDays ? parseInt(graceDays, 10) : DEFAULT_GRACE_DAYS,
    warningDays: warningDays ? parseInt(warningDays, 10) : DEFAULT_WARNING_DAYS,
    autoUpgradeEnabled: autoUpgrade === 'true' ? true : DEFAULT_AUTO_UPGRADE,
  };
}

export async function updateEolSettings(
  db: Database,
  input: { graceDays?: number; warningDays?: number; autoUpgradeEnabled?: boolean },
): Promise<EolSettings> {
  if (input.graceDays !== undefined) {
    await setSetting(db, SETTING_EOL_GRACE_DAYS, String(input.graceDays));
  }
  if (input.warningDays !== undefined) {
    await setSetting(db, SETTING_EOL_WARNING_DAYS, String(input.warningDays));
  }
  if (input.autoUpgradeEnabled !== undefined) {
    await setSetting(db, SETTING_EOL_AUTO_UPGRADE, String(input.autoUpgradeEnabled));
  }
  return getEolSettings(db);
}

// ─── Scanner ────────────────────────────────────────────────────────────────

export interface ScanResult {
  readonly warningsSent: number;
  readonly forcedUpgradesTriggered: number;
  readonly errors: readonly string[];
}

/**
 * Run the EOL scanner:
 * 1. Find versions with eolDate approaching (within warningDays) → notify
 * 2. Find versions with eolDate passed + graceDays → forced upgrade if enabled
 */
export async function runEolScan(
  db: Database,
  adminUserId: string,
): Promise<ScanResult> {
  const settings = await getEolSettings(db);
  const now = new Date();
  const warningThreshold = new Date(now.getTime() + settings.warningDays * 24 * 60 * 60 * 1000);
  const forceThreshold = new Date(now.getTime() - settings.graceDays * 24 * 60 * 60 * 1000);

  let warningsSent = 0;
  let forcedUpgradesTriggered = 0;
  const errors: string[] = [];

  // Find versions approaching EOL (eolDate <= warningThreshold AND eolDate > now)
  const approachingEol = await db
    .select()
    .from(catalogEntryVersions)
    .where(
      and(
        isNotNull(catalogEntryVersions.eolDate),
        lte(catalogEntryVersions.eolDate, warningThreshold.toISOString().split('T')[0]),
      ),
    );

  // Find deployments on approaching-EOL versions
  for (const version of approachingEol) {
    const eolDate = version.eolDate ? new Date(version.eolDate) : null;
    if (!eolDate) continue;

    const isPastEol = eolDate <= now;
    const isPastGrace = eolDate <= forceThreshold;

    // Find all deployments on this version
    const affectedDeployments = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.catalogEntryId, version.catalogEntryId),
          eq(deployments.installedVersion, version.version),
        ),
      );

    if (affectedDeployments.length === 0) continue;

    // Get all versions for upgrade path resolution
    const allVersions = await db
      .select()
      .from(catalogEntryVersions)
      .where(eq(catalogEntryVersions.catalogEntryId, version.catalogEntryId));

    for (const deployment of affectedDeployments) {
      // Skip deployments that are not running or already upgrading
      if (deployment.status !== 'running') continue;
      if (deployment.targetVersion) continue;

      // Check for active upgrades
      const [activeUpgrade] = await db
        .select({ id: deploymentUpgrades.id })
        .from(deploymentUpgrades)
        .where(
          and(
            eq(deploymentUpgrades.deploymentId, deployment.id),
            inArray(deploymentUpgrades.status, ['pending', 'backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back']),
          ),
        );

      if (activeUpgrade) continue;

      if (isPastGrace && settings.autoUpgradeEnabled) {
        // Force upgrade: find best available upgrade
        const available = getAvailableUpgradesForDeployment(deployment.installedVersion!, allVersions);
        const target = available.find(v => v.status !== 'eol') ?? available[0];

        if (target) {
          try {
            const record = createUpgradeRecord({
              deploymentId: deployment.id,
              fromVersion: deployment.installedVersion!,
              toVersion: target.version,
              triggeredBy: adminUserId,
              triggerType: 'forced',
            });

            await db.insert(deploymentUpgrades).values(record);
            await db
              .update(deployments)
              .set({ targetVersion: target.version })
              .where(eq(deployments.id, deployment.id));

            forcedUpgradesTriggered++;

            // Notify about forced upgrade
            await notifyUser(db, adminUserId, {
              type: 'warning',
              title: 'Forced Upgrade Triggered',
              message: `Deployment '${deployment.name}' auto-upgraded from v${deployment.installedVersion} to v${target.version} (EOL passed + grace period expired)`,
              resourceType: 'deployment',
              resourceId: deployment.id,
            });
          } catch (err) {
            errors.push(`Failed to force-upgrade deployment '${deployment.name}': ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          errors.push(`No upgrade target found for deployment '${deployment.name}' on EOL version v${version.version}`);
        }
      } else if (isPastEol) {
        // EOL passed but still in grace period → warning
        const daysUntilForce = Math.ceil((eolDate.getTime() + settings.graceDays * 24 * 60 * 60 * 1000 - now.getTime()) / (24 * 60 * 60 * 1000));
        await notifyUser(db, adminUserId, {
          type: 'warning',
          title: 'Version EOL - Grace Period',
          message: `Deployment '${deployment.name}' is running EOL version v${version.version}. ${settings.autoUpgradeEnabled ? `Auto-upgrade in ${daysUntilForce} days.` : 'Manual upgrade required.'}`,
          resourceType: 'deployment',
          resourceId: deployment.id,
        });
        warningsSent++;
      } else {
        // Approaching EOL → info notification
        const daysUntilEol = Math.ceil((eolDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        await notifyUser(db, adminUserId, {
          type: 'info',
          title: 'Version Approaching EOL',
          message: `Deployment '${deployment.name}' is running v${version.version} which reaches EOL in ${daysUntilEol} days (${version.eolDate}).`,
          resourceType: 'deployment',
          resourceId: deployment.id,
        });
        warningsSent++;
      }
    }
  }

  return { warningsSent, forcedUpgradesTriggered, errors };
}
