// Daily auto-upgrade cron. Iterates deployments with autoUpgrade=true,
// finds the latest reachable version per the upgradeFrom chain, and runs
// the upgrade through the same service used by the manual API.
//
// Strict apps are ALWAYS skipped — the cron only acts on advisory/open
// entries. The autoUpgrade flag toggle itself rejects strict apps so this
// is defence-in-depth; if a strict app ever slips through, the upgrade
// service's guard will still reject the call.

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { catalogEntries, catalogEntryVersions, deployments } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { compareVersions, upgradeDeploymentVersion } from './upgrade-version.js';
import { parseJsonField } from './service.js';

/** Wall-clock budget per pass — never let one slow deploy starve the rest. */
const PASS_DEADLINE_MS = 30 * 60 * 1000; // 30 minutes
/** Per-deployment timeout — K8s deploys typically complete in < 60s. */
const PER_DEPLOYMENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface AutoUpgradeRunResult {
  readonly attempted: number;
  readonly upgraded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<{ deploymentId: string; error: string }>;
}

/**
 * Run one pass of the auto-upgrade cron. Designed to be called from the
 * server.ts boot loop on a 24-hour interval. Safe to invoke ad-hoc for
 * testing — idempotent (re-running picks up where the previous run left off,
 * but skips deployments already on the latest reachable version).
 */
export async function runAutoUpgradePass(
  db: Database,
  k8s: K8sClients | null,
): Promise<AutoUpgradeRunResult> {
  if (!k8s) {
    return { attempted: 0, upgraded: 0, skipped: 0, failed: 0, failures: [] };
  }

  // Pull every running deployment with autoUpgrade=true. Failed / stopped /
  // pending deployments aren't auto-upgraded — the operator needs to address
  // their state first.
  const candidates = await db
    .select()
    .from(deployments)
    .where(eq(deployments.autoUpgrade, true));

  const running = candidates.filter((d) => d.status === 'running');

  let upgraded = 0;
  let skipped = 0;
  const failures: Array<{ deploymentId: string; error: string }> = [];

  const startedAt = Date.now();
  for (const dep of running) {
    if (Date.now() - startedAt > PASS_DEADLINE_MS) {
      // Hit the wall-clock budget. Remaining deployments are recorded as
      // skipped so the metric reflects "we didn't try" vs "they had nothing to do".
      const remaining = running.length - upgraded - skipped - failures.length;
      skipped += remaining;
      break;
    }
    try {
      const [entry] = await db
        .select()
        .from(catalogEntries)
        .where(eq(catalogEntries.id, dep.catalogEntryId));
      if (!entry) {
        skipped++;
        continue;
      }
      const lockMode = (entry.versionLockMode ?? 'advisory') as 'strict' | 'advisory' | 'open';
      if (lockMode === 'strict') {
        // Defence-in-depth: should never happen because setAutoUpgrade
        // rejects strict apps. If a manifest sync ever flips an app TO
        // strict after the toggle was set, this catches it.
        skipped++;
        continue;
      }

      // Compute the latest reachable version (one-hop). Don't walk chains
      // automatically — that's the customer's call for strict apps, and
      // auto-upgrade on advisory/open apps shouldn't be doing multi-step
      // jumps without an operator there to validate.
      const versions = await db
        .select()
        .from(catalogEntryVersions)
        .where(eq(catalogEntryVersions.catalogEntryId, entry.id));
      const installed = dep.installedVersion;
      const directlyReachable = versions
        .filter((v) => v.version !== installed)
        .filter((v) => {
          if (lockMode === 'open' || !installed) return true;
          const from = parseJsonField<string[]>(v.upgradeFrom) ?? [];
          return from.includes(installed);
        });

      if (directlyReachable.length === 0) {
        skipped++;
        continue;
      }

      // Pick the highest version using the numeric-aware comparator.
      // String sort breaks on "1.10" vs "1.9" — see compareVersions docs.
      const latest = directlyReachable
        .slice()
        .sort((a, b) => compareVersions(b.version, a.version))[0];

      // Per-deployment timeout — if K8s deploy hangs, don't starve the
      // rest of the pass. The status reconciler will pick up the failed
      // pod within its next cycle.
      await withTimeout(
        upgradeDeploymentVersion(db, dep.clientId, dep.id, { targetVersion: latest.version }, k8s),
        PER_DEPLOYMENT_TIMEOUT_MS,
        `upgradeDeploymentVersion(${dep.id})`,
      );
      upgraded++;
    } catch (err) {
      failures.push({
        deploymentId: dep.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    attempted: running.length,
    upgraded,
    skipped,
    failed: failures.length,
    failures,
  };
}

/** Wrap a promise with a wall-clock timeout. Rejects with descriptive Error. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
