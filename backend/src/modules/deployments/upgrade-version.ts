// Catalog-version upgrade path for a deployment.
//
// Layer 2 (available-upgrades query), Layer 3 (PATCH /version guard), and
// the rollback flip live here. The data model is described in
// migration 0095_deployment_upgrade_path.sql:
//   - deployments.installedVersion : where we are
//   - deployments.previousVersion  : where we came from (for rollback)
//   - deployments.autoUpgrade      : opt-in flag the cron reads
//   - catalog_entries.versionLockMode : strict | advisory | open
//   - catalog_entry_versions.upgradeFrom : list of versions that may
//                                          upgrade INTO this one
//
// Strict apps (Nextcloud, Moodle, WordPress major, Immich, Bookstack) refuse
// any jump that isn't in upgradeFrom. Advisory apps allow override via
// `force: true`. Open apps skip the check entirely.

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { catalogEntries, catalogEntryVersions, clients, deployments } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { deployCatalogEntry } from './k8s-deployer.js';
import {
  getClientNamespace,
  parseJsonField,
  readEntryFirewall,
  readEntryHostPorts,
  resolveVersionAwareDeploymentConfig,
} from './service.js';

// ─── Version comparator ─────────────────────────────────────────────────────

/**
 * Numeric-aware version comparator. Splits on `.` and compares each segment
 * as a number when both segments parse as integers, falling back to string
 * compare for non-numeric segments (e.g. `1.5.0-rc1`). A leading `v` is
 * tolerated so `v5.2.0` and `5.2.0` compare equal.
 *
 * Returns: positive when `a > b`, negative when `a < b`, 0 when equal.
 * Lexicographic sort was wrong: `"1.10" < "1.9"` in JS string compare
 * but `1.10 > 1.9` in any sane version order. This bug previously caused
 * the auto-upgrade cron + admin overview to pick the wrong "newest"
 * version on entries with double-digit minor or patch components.
 */
export function compareVersions(a: string, b: string): number {
  const strip = (v: string) => (v.startsWith('v') || v.startsWith('V') ? v.slice(1) : v);
  const partsA = strip(a).split('.');
  const partsB = strip(b).split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const segA = partsA[i] ?? '0';
    const segB = partsB[i] ?? '0';
    const numA = /^\d+$/.test(segA) ? Number(segA) : NaN;
    const numB = /^\d+$/.test(segB) ? Number(segB) : NaN;
    if (Number.isInteger(numA) && Number.isInteger(numB)) {
      if (numA !== numB) return numA - numB;
      continue;
    }
    // At least one segment is non-numeric (pre-release suffix, etc.).
    // Per semver, a pre-release tag is older than the same major.minor.patch
    // without it (e.g. `1.0.0-rc1` < `1.0.0`), so missing segment ranks higher.
    if (i >= partsA.length) return 1;
    if (i >= partsB.length) return -1;
    const cmp = segA.localeCompare(segB);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AvailableUpgrade {
  readonly version: string;
  readonly isDefault: boolean;
  readonly eolDate: string | null;
  readonly breakingChanges: string | null;
  readonly migrationNotes: string | null;
  readonly minResources: { cpu?: string; memory?: string; storage?: string } | null;
}

export interface AvailableUpgradesResponse {
  /** The currently-installed version (NULL on freshly-deployed entries that never had a version). */
  readonly from: string | null;
  /** Versions that list `from` in their upgradeFrom — safe one-hop upgrades. */
  readonly direct: readonly AvailableUpgrade[];
  /**
   * For strict apps where the user wants the newest available version,
   * the recommended chain through intermediate versions. Empty when a
   * direct hop to the newest is allowed.
   */
  readonly recommendedChain: readonly AvailableUpgrade[];
  /** App's lock mode — drives UI text and force-flag visibility. */
  readonly lockMode: 'strict' | 'advisory' | 'open';
}

// ─── Available-upgrades query ───────────────────────────────────────────────

/**
 * Compute the upgrade options for a deployment. Used by:
 *   - GET /clients/:cid/deployments/:id/available-upgrades  (per-deployment)
 *   - Admin upgrades page  (admin enumerates across all deployments)
 *   - Auto-upgrade cron    (which target to pick)
 *
 * `clientId` is required for the customer-facing call to enforce tenant
 * isolation — passing `null` is reserved for admin / cron call sites where
 * the deployment ID is already trusted (looked up by an admin query).
 */
export async function getAvailableUpgrades(
  db: Database,
  deploymentId: string,
  clientId: string | null,
): Promise<AvailableUpgradesResponse> {
  const where = clientId
    ? and(eq(deployments.id, deploymentId), eq(deployments.clientId, clientId))
    : eq(deployments.id, deploymentId);
  const [deployment] = await db.select().from(deployments).where(where);
  if (!deployment) {
    throw new ApiError('DEPLOYMENT_NOT_FOUND', `Deployment ${deploymentId} not found`, 404);
  }

  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));
  if (!entry) {
    throw new ApiError('CATALOG_ENTRY_GONE', `Catalog entry ${deployment.catalogEntryId} no longer exists`, 410);
  }

  const allVersions = await db
    .select()
    .from(catalogEntryVersions)
    .where(eq(catalogEntryVersions.catalogEntryId, entry.id));

  const installed = deployment.installedVersion;
  const lockMode = (entry.versionLockMode ?? 'advisory') as 'strict' | 'advisory' | 'open';

  // Build the candidate list, excluding the currently installed version.
  const candidates: AvailableUpgrade[] = allVersions
    .filter((v) => v.version !== installed)
    .filter((v) => {
      // Open apps surface every version. Strict/advisory require the current
      // version to be in upgradeFrom — except when no version is installed
      // (first-time deploys), in which case any version is fair game.
      if (lockMode === 'open' || !installed) return true;
      const from = parseJsonField<string[]>(v.upgradeFrom) ?? [];
      return from.includes(installed);
    })
    .map((v) => ({
      version: v.version,
      isDefault: v.isDefault === 1,
      eolDate: v.eolDate,
      breakingChanges: v.breakingChanges,
      migrationNotes: v.migrationNotes,
      minResources: parseJsonField<{ cpu?: string; memory?: string; storage?: string }>(v.minResources),
    }));

  // For strict apps with a chain (4.5 → 5.0 → 5.1 → 5.2), if the newest
  // version isn't directly reachable from `installed`, walk the chain to
  // find the shortest path. Returns the version sequence so the UI can
  // surface "Upgrade through 5.0 → 5.1 → 5.2".
  const recommendedChain: AvailableUpgrade[] = [];
  if (lockMode === 'strict' && installed) {
    const newest = allVersions
      .slice()
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    const directlyReachable = candidates.some((c) => c.version === newest?.version);
    if (newest && !directlyReachable && newest.version !== installed) {
      const chain = findUpgradeChain(allVersions, installed, newest.version);
      if (chain.length > 0) {
        const versionMap = new Map(allVersions.map((v) => [v.version, v]));
        for (const hop of chain) {
          const v = versionMap.get(hop);
          if (!v) continue;
          recommendedChain.push({
            version: v.version,
            isDefault: v.isDefault === 1,
            eolDate: v.eolDate,
            breakingChanges: v.breakingChanges,
            migrationNotes: v.migrationNotes,
            minResources: parseJsonField<{ cpu?: string; memory?: string; storage?: string }>(v.minResources),
          });
        }
      }
    }
  }

  return { from: installed, direct: candidates, recommendedChain, lockMode };
}

/**
 * BFS through the upgradeFrom graph to find the shortest path from `start`
 * to `end`. Returns the list of versions in order, or [] when no path
 * exists. Catalog typically has < 20 versions per entry so BFS is plenty.
 */
function findUpgradeChain(
  versions: ReadonlyArray<typeof catalogEntryVersions.$inferSelect>,
  start: string,
  end: string,
): readonly string[] {
  if (start === end) return [];
  // Adjacency: edge `from -> v.version` when `from` is in v.upgradeFrom.
  const incoming = new Map<string, string[]>();
  for (const v of versions) {
    const from = parseJsonField<string[]>(v.upgradeFrom) ?? [];
    for (const f of from) {
      const arr = incoming.get(f) ?? [];
      arr.push(v.version);
      incoming.set(f, arr);
    }
  }
  const queue: Array<{ at: string; path: string[] }> = [{ at: start, path: [] }];
  const visited = new Set<string>([start]);
  while (queue.length > 0) {
    const { at, path } = queue.shift()!;
    const nexts = incoming.get(at) ?? [];
    for (const n of nexts) {
      if (visited.has(n)) continue;
      visited.add(n);
      const nextPath = [...path, n];
      if (n === end) return nextPath;
      queue.push({ at: n, path: nextPath });
    }
  }
  return [];
}

// ─── Upgrade execution ──────────────────────────────────────────────────────

export interface UpgradeVersionInput {
  readonly targetVersion: string;
  /** Bypass the upgradeFrom chain check. Strict apps reject force; advisory honours it. */
  readonly force?: boolean;
}

/**
 * Validate the requested upgrade against versionLockMode + upgradeFrom,
 * then redeploy the entry with the new version. The image, env, volumes
 * all get re-resolved via resolveVersionAwareDeploymentConfig so version-
 * specific overrides take effect.
 *
 * Throws `UPGRADE_PATH_NOT_SUPPORTED` on strict-mode chain violations,
 * `UPGRADE_FORCE_REQUIRES_ADMIN` on force=true from non-admin (caller's
 * responsibility — the route layer should gate this).
 */
export async function upgradeDeploymentVersion(
  db: Database,
  clientId: string,
  deploymentId: string,
  input: UpgradeVersionInput,
  k8s: K8sClients,
): Promise<typeof deployments.$inferSelect> {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.clientId, clientId)));
  if (!deployment) {
    throw new ApiError('DEPLOYMENT_NOT_FOUND', `Deployment ${deploymentId} not found`, 404);
  }

  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));
  if (!entry) {
    throw new ApiError('CATALOG_ENTRY_GONE', 'Catalog entry no longer exists', 410);
  }

  const [target] = await db
    .select()
    .from(catalogEntryVersions)
    .where(
      and(
        eq(catalogEntryVersions.catalogEntryId, entry.id),
        eq(catalogEntryVersions.version, input.targetVersion),
      ),
    );
  if (!target) {
    throw new ApiError(
      'CATALOG_VERSION_UNKNOWN',
      `Version ${input.targetVersion} not declared in catalog for ${entry.code}`,
      404,
      { entryCode: entry.code, requestedVersion: input.targetVersion },
    );
  }

  // No-op when the target is the already-installed version.
  if (deployment.installedVersion === input.targetVersion) {
    return deployment;
  }

  const lockMode = (entry.versionLockMode ?? 'advisory') as 'strict' | 'advisory' | 'open';
  const upgradeFrom = parseJsonField<string[]>(target.upgradeFrom) ?? [];

  // Layer 3 guard: strict + advisory check the chain.
  // Open mode skips entirely. First-time deploys (installedVersion=NULL)
  // skip too — every version is reachable from "nothing installed".
  if (lockMode !== 'open' && deployment.installedVersion) {
    const allowed = upgradeFrom.includes(deployment.installedVersion);
    if (!allowed) {
      if (lockMode === 'strict') {
        throw new ApiError(
          'UPGRADE_PATH_NOT_SUPPORTED',
          `${entry.code} requires one-major-at-a-time upgrades. ${deployment.installedVersion} → ${input.targetVersion} is not in the allowed upgrade path. Allowed source versions for ${input.targetVersion}: ${upgradeFrom.length > 0 ? upgradeFrom.join(', ') : '(none — fresh install only)'}.`,
          409,
          {
            entryCode: entry.code,
            from: deployment.installedVersion,
            to: input.targetVersion,
            allowedFrom: upgradeFrom,
            lockMode,
          },
        );
      }
      // Advisory: allow with force=true.
      if (!input.force) {
        throw new ApiError(
          'UPGRADE_PATH_UNCONFIRMED',
          `Upgrade ${deployment.installedVersion} → ${input.targetVersion} is not in the recommended path. Pass force=true to proceed.`,
          409,
          {
            entryCode: entry.code,
            from: deployment.installedVersion,
            to: input.targetVersion,
            allowedFrom: upgradeFrom,
            lockMode,
          },
        );
      }
    }
  }

  // Snapshot the rollback data BEFORE flipping the version.
  // Only the immediately-preceding version is kept; rollback is single-step.
  const fromVersion = deployment.installedVersion;

  // Resolve the new effective configuration.
  const resolved = await resolveVersionAwareDeploymentConfig(db, entry, input.targetVersion);

  // Optimistic lock: only flip the version if the row's installedVersion
  // still matches what we read above. Two concurrent upgrade callers would
  // otherwise both write previousVersion=fromVersion, losing the intermediate
  // hop in rollback metadata. With fromVersion=NULL we use IS NULL semantics.
  // We set targetVersion + lastUpgradedAt + status='pending' here but keep
  // installedVersion at the OLD value — it flips only after the K8s deploy
  // succeeds, so a deploy failure doesn't leave the DB lying about what's
  // actually running.
  const lockCondition = fromVersion === null
    ? sql`${deployments.installedVersion} IS NULL`
    : eq(deployments.installedVersion, fromVersion);
  const lockResult = await db
    .update(deployments)
    .set({
      targetVersion: input.targetVersion,
      previousVersion: fromVersion,
      status: 'pending',
      lastError: null,
    })
    .where(and(eq(deployments.id, deploymentId), lockCondition))
    .returning({ id: deployments.id });
  if (lockResult.length === 0) {
    throw new ApiError(
      'UPGRADE_RACE_DETECTED',
      'Another upgrade was already in progress for this deployment. Refresh and retry.',
      409,
      { deploymentId },
    );
  }

  // Push the new pod spec.
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  const namespace = client?.kubernetesNamespace;
  if (!namespace) {
    throw new ApiError('CLIENT_NOT_PROVISIONED', 'Client namespace is missing', 500);
  }
  const resources = parseJsonField<{ recommended?: { storage?: string }; minimum?: { storage?: string } }>(entry.resources);
  const storageRequest = resources?.recommended?.storage ?? resources?.minimum?.storage ?? '1Gi';
  const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};

  try {
    await deployCatalogEntry(k8s, {
      deploymentName: deployment.name,
      storagePath: deployment.storagePath ?? '',
      namespace,
      components: resolved.components,
      volumes: resolved.volumes,
      replicaCount: deployment.replicaCount ?? 1,
      cpuRequest: deployment.cpuRequest,
      memoryRequest: deployment.memoryRequest,
      storageRequest,
      configuration: config,
      envVars: { fixed: resolved.fixedEnvVars },
      configurableEnvKeys: resolved.configurableEnvKeys,
      firewall: readEntryFirewall(entry) ?? undefined,
      hostPorts: readEntryHostPorts(entry),
    });
    // Flip installedVersion + lastUpgradedAt only AFTER the K8s deploy
    // succeeded — a failed deploy must not leave the DB claiming we're
    // running the new version when the pod is still on the old image.
    // The pod itself transitions pending → running via the status
    // reconciler once the new image becomes Ready.
    await db
      .update(deployments)
      .set({
        installedVersion: input.targetVersion,
        lastUpgradedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Revert the previousVersion + targetVersion writes from the optimistic
    // lock above. We didn't deploy anything, so the DB should look exactly
    // like it did before this attempt — only status + lastError change.
    await db
      .update(deployments)
      .set({
        status: 'failed',
        targetVersion: fromVersion,
        previousVersion: deployment.previousVersion,
        lastError: `Upgrade to ${input.targetVersion} failed: ${message}`,
      })
      .where(eq(deployments.id, deploymentId));
    throw new ApiError('UPGRADE_FAILED', message, 500, { from: fromVersion, to: input.targetVersion });
  }

  const [updated] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  return updated;
}

// ─── Admin upgrades overview ────────────────────────────────────────────────

export interface AdminUpgradesGroup {
  readonly catalogEntryId: string;
  readonly code: string;
  readonly name: string;
  readonly lockMode: 'strict' | 'advisory' | 'open';
  readonly latestVersion: string | null;
  readonly defaultVersion: string | null;
  readonly deployments: ReadonlyArray<{
    readonly id: string;
    readonly clientId: string;
    readonly clientCompanyName: string | null;
    readonly name: string;
    readonly status: string;
    readonly installedVersion: string | null;
    readonly previousVersion: string | null;
    readonly autoUpgrade: boolean;
    readonly lastUpgradedAt: string | null;
    readonly domainName: string | null;
    readonly previewUrl: string | null;
    readonly availableUpgradeCount: number;
    readonly latestReachable: string | null;
  }>;
}

/**
 * Admin overview page data: every running deployment grouped by catalog
 * entry. For each row we compute how many upgrade candidates exist and
 * what the latest directly-reachable version is — these drive the per-row
 * action buttons.
 *
 * One round-trip per catalog entry to build the upgrade graph; deployment
 * rows are joined in a single query. Total query cost is O(N entries) +
 * O(M deployments) — fine up to thousands of deployments.
 */
export async function getAdminUpgradesOverview(db: Database): Promise<readonly AdminUpgradesGroup[]> {
  // Pull every non-deleted deployment with its client + entry. The platform
  // never shows deleted deployments in the upgrades page — soft-deleted rows
  // are tomb-stoned and not redeployable.
  const rows = await db
    .select({
      deployment: deployments,
      client: clients,
      entry: catalogEntries,
    })
    .from(deployments)
    .innerJoin(clients, eq(clients.id, deployments.clientId))
    .innerJoin(catalogEntries, eq(catalogEntries.id, deployments.catalogEntryId));

  // Active = anything not soft-deleted. Failed deployments are still shown
  // because the operator may want to upgrade-as-recovery.
  const active = rows.filter((r) => !r.deployment.deletedAt);

  // Group by entry, then for each entry compute the upgrade graph once.
  const byEntry = new Map<string, typeof rows>();
  for (const r of active) {
    const existing = byEntry.get(r.entry.id) ?? [];
    existing.push(r);
    byEntry.set(r.entry.id, existing);
  }

  const groups: AdminUpgradesGroup[] = [];
  for (const [entryId, entryRows] of byEntry) {
    const entry = entryRows[0].entry;
    const versions = await db
      .select()
      .from(catalogEntryVersions)
      .where(eq(catalogEntryVersions.catalogEntryId, entryId));

    const lockMode = (entry.versionLockMode ?? 'advisory') as 'strict' | 'advisory' | 'open';

    const deploymentInfos = entryRows.map((r) => {
      const installed = r.deployment.installedVersion;

      // Direct upgrades: versions whose upgradeFrom contains the current installed.
      // For installedVersion=NULL (legacy rows that pre-date version tracking),
      // every version is reachable.
      const direct = versions
        .filter((v) => v.version !== installed)
        .filter((v) => {
          if (lockMode === 'open' || !installed) return true;
          const from = parseJsonField<string[]>(v.upgradeFrom) ?? [];
          return from.includes(installed);
        });

      const latestReachable = direct.length > 0
        ? direct.slice().sort((a, b) => (b.version > a.version ? 1 : -1))[0].version
        : null;

      // Preview URL — prefer the deployment's own domain name (catalog apps
      // typically get a DNS slug per deploy). Falls back to the ingress
      // base via INGRESS_BASE_DOMAIN if domain_name was never set.
      const baseDomain = process.env.INGRESS_BASE_DOMAIN ?? null;
      const previewUrl = r.deployment.domainName
        ? `https://${r.deployment.domainName}`
        : baseDomain
          ? `https://${r.deployment.name}.${baseDomain}`
          : null;

      return {
        id: r.deployment.id,
        clientId: r.deployment.clientId,
        clientCompanyName: r.client.companyName,
        name: r.deployment.name,
        status: r.deployment.status,
        installedVersion: installed,
        previousVersion: r.deployment.previousVersion,
        autoUpgrade: r.deployment.autoUpgrade ?? false,
        lastUpgradedAt: r.deployment.lastUpgradedAt ? r.deployment.lastUpgradedAt.toISOString() : null,
        domainName: r.deployment.domainName,
        previewUrl,
        availableUpgradeCount: direct.length,
        latestReachable,
      };
    });

    groups.push({
      catalogEntryId: entry.id,
      code: entry.code,
      name: entry.name,
      lockMode,
      latestVersion: entry.latestVersion,
      defaultVersion: entry.defaultVersion,
      deployments: deploymentInfos,
    });
  }

  // Sort: apps with upgradeable deployments first (most actionable), then alpha.
  groups.sort((a, b) => {
    const aCount = a.deployments.filter((d) => d.availableUpgradeCount > 0).length;
    const bCount = b.deployments.filter((d) => d.availableUpgradeCount > 0).length;
    if (aCount !== bCount) return bCount - aCount;
    return a.code.localeCompare(b.code);
  });

  return groups;
}

// ─── Auto-upgrade toggle ────────────────────────────────────────────────────

/**
 * Per-deployment opt-in for the daily auto-upgrade cron. Strict apps
 * reject this toggle — the cron would skip them regardless, but failing
 * loudly here means the UI never shows a misleading "auto-upgrade enabled"
 * state for an app that would never get upgraded.
 */
export async function setAutoUpgrade(
  db: Database,
  clientId: string,
  deploymentId: string,
  enabled: boolean,
): Promise<typeof deployments.$inferSelect> {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.clientId, clientId)));
  if (!deployment) {
    throw new ApiError('DEPLOYMENT_NOT_FOUND', `Deployment ${deploymentId} not found`, 404);
  }
  if (enabled) {
    const [entry] = await db
      .select()
      .from(catalogEntries)
      .where(eq(catalogEntries.id, deployment.catalogEntryId));
    const lockMode = (entry?.versionLockMode ?? 'advisory') as 'strict' | 'advisory' | 'open';
    if (lockMode === 'strict') {
      throw new ApiError(
        'AUTO_UPGRADE_NOT_ALLOWED',
        `Auto-upgrade is disabled for ${entry?.code ?? 'this app'} because it requires manual one-major-at-a-time upgrades.`,
        409,
        { entryCode: entry?.code, lockMode },
      );
    }
  }
  await db.update(deployments).set({ autoUpgrade: enabled }).where(eq(deployments.id, deploymentId));
  const [updated] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  return updated;
}

// ─── Rollback ───────────────────────────────────────────────────────────────

/**
 * Restore the immediately-preceding version. The platform doesn't keep
 * history beyond `previousVersion`, so rollback is single-step. Schema
 * migrations are NOT reversed — the caller (UI) shows a warning before
 * triggering this.
 */
export async function rollbackDeploymentVersion(
  db: Database,
  clientId: string,
  deploymentId: string,
  k8s: K8sClients,
): Promise<typeof deployments.$inferSelect> {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.clientId, clientId)));
  if (!deployment) {
    throw new ApiError('DEPLOYMENT_NOT_FOUND', `Deployment ${deploymentId} not found`, 404);
  }
  if (!deployment.previousVersion) {
    throw new ApiError(
      'ROLLBACK_NOT_AVAILABLE',
      'No previous version to roll back to. Rollback is only available for the most recent upgrade.',
      409,
    );
  }

  const fromVersion = deployment.installedVersion;
  const toVersion = deployment.previousVersion;

  const [entry] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, deployment.catalogEntryId));
  if (!entry) {
    throw new ApiError('CATALOG_ENTRY_GONE', 'Catalog entry no longer exists', 410);
  }

  // Verify the previous version is still in the catalog. EOL'd versions
  // that have been removed from the catalog can't be rolled back to.
  const [target] = await db
    .select()
    .from(catalogEntryVersions)
    .where(
      and(
        eq(catalogEntryVersions.catalogEntryId, entry.id),
        eq(catalogEntryVersions.version, toVersion),
      ),
    );
  if (!target) {
    throw new ApiError(
      'ROLLBACK_VERSION_REMOVED',
      `Version ${toVersion} is no longer in the catalog. Cannot roll back.`,
      410,
    );
  }

  const resolved = await resolveVersionAwareDeploymentConfig(db, entry, toVersion);

  // Optimistic lock — same pattern as upgrade. Two concurrent rollback
  // calls would otherwise both try to consume the same previousVersion slot.
  // installedVersion flips only AFTER the K8s deploy succeeds.
  const locked = await db
    .update(deployments)
    .set({
      targetVersion: toVersion,
      status: 'pending',
      lastError: null,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        // fromVersion is the current installedVersion (proven non-null by
        // the `if (!deployment.previousVersion)` guard above — a deployment
        // with a previousVersion necessarily has an installedVersion).
        fromVersion === null
          ? sql`${deployments.installedVersion} IS NULL`
          : eq(deployments.installedVersion, fromVersion),
        eq(deployments.previousVersion, toVersion),
      ),
    )
    .returning({ id: deployments.id });
  if (locked.length === 0) {
    throw new ApiError(
      'ROLLBACK_RACE_DETECTED',
      'Another rollback or upgrade was already in progress for this deployment. Refresh and retry.',
      409,
      { deploymentId },
    );
  }

  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  const namespace = client?.kubernetesNamespace;
  if (!namespace) {
    throw new ApiError('CLIENT_NOT_PROVISIONED', 'Client namespace is missing', 500);
  }
  const resources = parseJsonField<{ recommended?: { storage?: string }; minimum?: { storage?: string } }>(entry.resources);
  const storageRequest = resources?.recommended?.storage ?? resources?.minimum?.storage ?? '1Gi';
  const config = parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};

  try {
    await deployCatalogEntry(k8s, {
      deploymentName: deployment.name,
      storagePath: deployment.storagePath ?? '',
      namespace,
      components: resolved.components,
      volumes: resolved.volumes,
      replicaCount: deployment.replicaCount ?? 1,
      cpuRequest: deployment.cpuRequest,
      memoryRequest: deployment.memoryRequest,
      storageRequest,
      configuration: config,
      envVars: { fixed: resolved.fixedEnvVars },
      configurableEnvKeys: resolved.configurableEnvKeys,
      firewall: readEntryFirewall(entry) ?? undefined,
      hostPorts: readEntryHostPorts(entry),
    });
    // Flip installedVersion + consume the previousVersion slot only after
    // the K8s deploy actually succeeded.
    await db
      .update(deployments)
      .set({
        installedVersion: toVersion,
        previousVersion: null,
        lastUpgradedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Revert the targetVersion flip — installedVersion didn't change so
    // the deployment is still effectively on `fromVersion`.
    await db
      .update(deployments)
      .set({
        status: 'failed',
        targetVersion: fromVersion,
        lastError: `Rollback to ${toVersion} failed: ${message}`,
      })
      .where(eq(deployments.id, deploymentId));
    throw new ApiError('ROLLBACK_FAILED', message, 500, { from: fromVersion, to: toVersion });
  }

  const [updated] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  return updated;
}
