/**
 * EOL Scanner Service
 *
 * Scans applicationVersions for approaching/passed EOL dates.
 * Notifies admins, and optionally triggers forced upgrades after grace period.
 */

import { eq, and, lte, isNotNull, inArray } from 'drizzle-orm';
import {
  applicationVersions,
  applicationInstances,
  applicationUpgrades,
  platformSettings,
} from '../../db/schema.js';
import { createUpgradeRecord, getAvailableUpgradesForInstance } from '../application-upgrades/service.js';
import { notifyUser } from '../notifications/service.js';
import type { Database } from '../../db/index.js';

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
    .onDuplicateKeyUpdate({ set: { value } });
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
    .from(applicationVersions)
    .where(
      and(
        isNotNull(applicationVersions.eolDate),
        lte(applicationVersions.eolDate, warningThreshold.toISOString().split('T')[0]),
      ),
    );

  // Find instances on approaching-EOL versions
  for (const version of approachingEol) {
    const eolDate = version.eolDate ? new Date(version.eolDate) : null;
    if (!eolDate) continue;

    const isPastEol = eolDate <= now;
    const isPastGrace = eolDate <= forceThreshold;

    // Find all instances on this version
    const instances = await db
      .select()
      .from(applicationInstances)
      .where(
        and(
          eq(applicationInstances.applicationCatalogId, version.applicationCatalogId),
          eq(applicationInstances.installedVersion, version.version),
        ),
      );

    if (instances.length === 0) continue;

    // Get all versions for upgrade path resolution
    const allVersions = await db
      .select()
      .from(applicationVersions)
      .where(eq(applicationVersions.applicationCatalogId, version.applicationCatalogId));

    for (const instance of instances) {
      // Skip instances that are not running or already upgrading
      if (instance.status !== 'running') continue;
      if (instance.targetVersion) continue;

      // Check for active upgrades
      const [activeUpgrade] = await db
        .select({ id: applicationUpgrades.id })
        .from(applicationUpgrades)
        .where(
          and(
            eq(applicationUpgrades.instanceId, instance.id),
            inArray(applicationUpgrades.status, ['pending', 'backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back']),
          ),
        );

      if (activeUpgrade) continue;

      if (isPastGrace && settings.autoUpgradeEnabled) {
        // Force upgrade: find best available upgrade
        const available = getAvailableUpgradesForInstance(instance.installedVersion, allVersions);
        const target = available.find(v => v.status !== 'eol') ?? available[0];

        if (target) {
          try {
            const record = createUpgradeRecord({
              instanceId: instance.id,
              fromVersion: instance.installedVersion!,
              toVersion: target.version,
              triggeredBy: adminUserId,
              triggerType: 'forced',
            });

            await db.insert(applicationUpgrades).values(record);
            await db
              .update(applicationInstances)
              .set({ targetVersion: target.version })
              .where(eq(applicationInstances.id, instance.id));

            forcedUpgradesTriggered++;

            // Notify about forced upgrade
            await notifyUser(db, adminUserId, {
              type: 'warning',
              title: 'Forced Upgrade Triggered',
              message: `Instance '${instance.name}' auto-upgraded from v${instance.installedVersion} to v${target.version} (EOL passed + grace period expired)`,
              resourceType: 'application_instance',
              resourceId: instance.id,
            });
          } catch (err) {
            errors.push(`Failed to force-upgrade instance '${instance.name}': ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          errors.push(`No upgrade target found for instance '${instance.name}' on EOL version v${version.version}`);
        }
      } else if (isPastEol) {
        // EOL passed but still in grace period → warning
        const daysUntilForce = Math.ceil((eolDate.getTime() + settings.graceDays * 24 * 60 * 60 * 1000 - now.getTime()) / (24 * 60 * 60 * 1000));
        await notifyUser(db, adminUserId, {
          type: 'warning',
          title: 'Version EOL - Grace Period',
          message: `Instance '${instance.name}' is running EOL version v${version.version}. ${settings.autoUpgradeEnabled ? `Auto-upgrade in ${daysUntilForce} days.` : 'Manual upgrade required.'}`,
          resourceType: 'application_instance',
          resourceId: instance.id,
        });
        warningsSent++;
      } else {
        // Approaching EOL → info notification
        const daysUntilEol = Math.ceil((eolDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        await notifyUser(db, adminUserId, {
          type: 'info',
          title: 'Version Approaching EOL',
          message: `Instance '${instance.name}' is running v${version.version} which reaches EOL in ${daysUntilEol} days (${version.eolDate}).`,
          resourceType: 'application_instance',
          resourceId: instance.id,
        });
        warningsSent++;
      }
    }
  }

  return { warningsSent, forcedUpgradesTriggered, errors };
}
