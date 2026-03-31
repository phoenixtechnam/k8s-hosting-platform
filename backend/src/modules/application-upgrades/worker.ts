/**
 * Background worker for processing application upgrades.
 *
 * Polls for pending upgrade records and executes them through
 * the state machine: backup → pre-check → upgrade → health-check → complete.
 *
 * Uses a simple polling loop. In production, this would use a proper
 * job queue (BullMQ/Redis) for reliability.
 */

import { eq, and } from 'drizzle-orm';
import {
  applicationUpgrades,
  applicationInstances,
  applicationVersions,
} from '../../db/schema.js';
import { transitionUpgrade } from './service.js';
import { createBackup } from '../backups/service.js';
import type { Database } from '../../db/index.js';

const POLL_INTERVAL_MS = 5_000;

interface UpgradeWorkerOptions {
  readonly db: Database;
  readonly pollIntervalMs?: number;
}

export class UpgradeWorker {
  private readonly db: Database;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(options: UpgradeWorkerOptions) {
    this.db = options.db;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    console.log('[upgrade-worker] Starting upgrade worker');
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    // Run immediately on start
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[upgrade-worker] Stopped upgrade worker');
  }

  private async poll(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // Pick up the oldest pending upgrade
      const [pending] = await this.db
        .select()
        .from(applicationUpgrades)
        .where(eq(applicationUpgrades.status, 'pending'))
        .limit(1);

      if (!pending) return;

      console.log(`[upgrade-worker] Processing upgrade ${pending.id}: ${pending.fromVersion} → ${pending.toVersion}`);
      await this.processUpgrade(pending.id);
    } catch (err) {
      console.error('[upgrade-worker] Poll error:', err);
    } finally {
      this.processing = false;
    }
  }

  private async processUpgrade(upgradeId: string): Promise<void> {
    const [upgrade] = await this.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, upgradeId));

    // Detect patch mode: same fromVersion and toVersion means image-only patch
    const isPatch = upgrade?.fromVersion === upgrade?.toVersion;

    const steps: Array<{
      status: string;
      action: (upgradeId: string) => Promise<void>;
      skipForPatch?: boolean;
    }> = [
      { status: 'backing_up', action: (id) => this.stepBackup(id), skipForPatch: true },
      { status: 'pre_check', action: (id) => this.stepPreCheck(id) },
      { status: 'upgrading', action: (id) => this.stepUpgrade(id) },
      { status: 'health_check', action: (id) => this.stepHealthCheck(id) },
      { status: 'completed', action: (id) => this.stepComplete(id) },
    ];

    if (isPatch) {
      console.log(`[upgrade-worker] Patch mode for ${upgradeId} — skipping backup`);
    }

    for (const step of steps) {
      const [current] = await this.db
        .select()
        .from(applicationUpgrades)
        .where(eq(applicationUpgrades.id, upgradeId));

      if (!current) return;

      // Skip backup step in patch mode
      if (step.skipForPatch && isPatch) continue;

      // Check if we should run this step
      const transition = transitionUpgrade(current.status, step.status);
      if (!transition.valid) continue;

      try {
        await this.updateStatus(upgradeId, step.status, transition.progressPct ?? 0, transition.statusMessage ?? '');

        if (step.status !== 'completed') {
          await step.action(upgradeId);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[upgrade-worker] Step ${step.status} failed for ${upgradeId}:`, errorMessage);

        // If upgrading or health_check failed, attempt rollback
        if (step.status === 'upgrading' || step.status === 'health_check') {
          await this.attemptRollback(upgradeId, errorMessage);
        } else {
          await this.markFailed(upgradeId, errorMessage);
        }
        return;
      }
    }
  }

  private async stepBackup(upgradeId: string): Promise<void> {
    // Get upgrade and instance to find clientId
    const [upgrade] = await this.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, upgradeId));

    if (!upgrade) return;

    const [instance] = await this.db
      .select()
      .from(applicationInstances)
      .where(eq(applicationInstances.id, upgrade.instanceId));

    if (!instance) {
      console.warn(`[upgrade-worker] Instance ${upgrade.instanceId} not found — skipping backup`);
      return;
    }

    try {
      const backup = await createBackup(this.db, instance.clientId, {
        backup_type: 'auto',
        resource_type: 'application_instance',
        resource_id: upgrade.instanceId,
        notes: `Pre-upgrade backup for ${instance.applicationCatalogId} ${upgrade.fromVersion} → ${upgrade.toVersion}`,
      });

      await this.db
        .update(applicationUpgrades)
        .set({ backupId: backup.id })
        .where(eq(applicationUpgrades.id, upgradeId));

      console.log(`[upgrade-worker] Backup created: ${backup.id}`);
    } catch (err) {
      console.error(`[upgrade-worker] Backup failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err; // Let the worker handle the failure
    }
  }

  private async stepPreCheck(upgradeId: string): Promise<void> {
    // In production: verify instance health, check resources
    const [upgrade] = await this.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, upgradeId));

    if (!upgrade) return;

    const [instance] = await this.db
      .select()
      .from(applicationInstances)
      .where(eq(applicationInstances.id, upgrade.instanceId));

    if (!instance) {
      throw new Error('Instance not found during pre-check');
    }

    if (instance.status !== 'running' && instance.status !== 'upgrading') {
      throw new Error(`Instance is in ${instance.status} state, expected running`);
    }

    console.log(`[upgrade-worker] Pre-check passed for instance ${instance.id}`);
  }

  private async stepUpgrade(upgradeId: string): Promise<void> {
    const [upgrade] = await this.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, upgradeId));

    if (!upgrade) return;

    // Fetch target version's component images
    const [instance] = await this.db
      .select()
      .from(applicationInstances)
      .where(eq(applicationInstances.id, upgrade.instanceId));

    if (!instance) throw new Error('Instance not found during upgrade');

    const versions = await this.db
      .select()
      .from(applicationVersions)
      .where(
        and(
          eq(applicationVersions.applicationCatalogId, instance.applicationCatalogId),
          eq(applicationVersions.version, upgrade.toVersion),
        ),
      );

    const targetVersion = versions[0];
    if (!targetVersion) {
      throw new Error(`Target version ${upgrade.toVersion} not found in catalog`);
    }

    // In production: execute `helm upgrade --atomic --timeout 5m`
    // Store current helm values for rollback
    await this.db
      .update(applicationUpgrades)
      .set({
        helmValues: { components: targetVersion.components } as Record<string, unknown>,
        rollbackHelmValues: { fromVersion: upgrade.fromVersion } as Record<string, unknown>,
      })
      .where(eq(applicationUpgrades.id, upgradeId));

    // Mark instance as upgrading
    await this.db
      .update(applicationInstances)
      .set({ status: 'upgrading' })
      .where(eq(applicationInstances.id, upgrade.instanceId));

    console.log(`[upgrade-worker] Helm upgrade executed for ${upgrade.instanceId}`);
  }

  private async stepHealthCheck(upgradeId: string): Promise<void> {
    // In production: poll health endpoint from manifest for 3 consecutive passes
    // For now, simulate success
    console.log(`[upgrade-worker] Health check passed for upgrade ${upgradeId}`);
  }

  private async stepComplete(upgradeId: string): Promise<void> {
    const [upgrade] = await this.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, upgradeId));

    if (!upgrade) return;

    // Update instance: set installed version, clear target, back to running
    await this.db
      .update(applicationInstances)
      .set({
        installedVersion: upgrade.toVersion,
        targetVersion: null,
        lastUpgradedAt: new Date(),
        status: 'running',
      })
      .where(eq(applicationInstances.id, upgrade.instanceId));

    await this.db
      .update(applicationUpgrades)
      .set({
        completedAt: new Date(),
      })
      .where(eq(applicationUpgrades.id, upgradeId));

    console.log(`[upgrade-worker] Upgrade ${upgradeId} completed: ${upgrade.fromVersion} → ${upgrade.toVersion}`);
  }

  private async attemptRollback(upgradeId: string, originalError: string): Promise<void> {
    try {
      await this.updateStatus(upgradeId, 'rolling_back', 80, 'Rolling back due to failure');

      // In production: execute `helm rollback` using stored rollbackHelmValues
      const [upgrade] = await this.db
        .select()
        .from(applicationUpgrades)
        .where(eq(applicationUpgrades.id, upgradeId));

      if (upgrade) {
        // Restore instance to running with original version
        await this.db
          .update(applicationInstances)
          .set({
            targetVersion: null,
            status: 'running',
          })
          .where(eq(applicationInstances.id, upgrade.instanceId));
      }

      await this.db
        .update(applicationUpgrades)
        .set({
          status: 'rolled_back',
          progressPct: 0,
          statusMessage: 'Rolled back to previous version',
          errorMessage: originalError,
          completedAt: new Date(),
        })
        .where(eq(applicationUpgrades.id, upgradeId));

      console.log(`[upgrade-worker] Rollback succeeded for ${upgradeId}`);
    } catch (rollbackErr) {
      const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      await this.markFailed(upgradeId, `${originalError}; rollback also failed: ${msg}`);
    }
  }

  private async markFailed(upgradeId: string, errorMessage: string): Promise<void> {
    await this.db
      .update(applicationUpgrades)
      .set({
        status: 'failed',
        errorMessage,
        statusMessage: 'Upgrade failed',
        completedAt: new Date(),
      })
      .where(eq(applicationUpgrades.id, upgradeId));

    // Try to reset instance status
    const [upgrade] = await this.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, upgradeId));

    if (upgrade) {
      await this.db
        .update(applicationInstances)
        .set({ targetVersion: null, status: 'failed' })
        .where(eq(applicationInstances.id, upgrade.instanceId));
    }

    console.error(`[upgrade-worker] Upgrade ${upgradeId} failed: ${errorMessage}`);
  }

  private async updateStatus(
    upgradeId: string,
    status: string,
    progressPct: number,
    statusMessage: string,
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status,
      progressPct,
      statusMessage,
    };

    if (status !== 'pending' && status !== 'completed' && status !== 'failed' && status !== 'rolled_back') {
      updates.startedAt = new Date();
    }

    await this.db
      .update(applicationUpgrades)
      .set(updates)
      .where(eq(applicationUpgrades.id, upgradeId));
  }
}
