import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { parseResourceValue } from '../../shared/resource-parser.js';

// GitHub Releases API for the upstream repo — no auth required for
// public repos and matches what release.yml publishes on `v*.*.*`
// tags. We previously hit GHCR's tags/list which requires auth for
// public images and always returned 401.
const RELEASES_API = 'https://api.github.com/repos/phoenixtechnam/k8s-hosting-platform/releases/latest';
// PLATFORM_VERSION is injected into the Deployment from the platform-
// version ConfigMap. Before that landed the default was a stale '0.1.0'
// which made the UI always show that regardless of reality; 'unknown'
// is now an explicit sentinel so the UI can distinguish "no version
// wired up" from "really running 0.1.0".
const CURRENT_VERSION = process.env.PLATFORM_VERSION?.replace(/^v/, '') ?? 'unknown';
const ENVIRONMENT = process.env.PLATFORM_ENV ?? 'production';

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.insert(platformSettings).values({ key, value }).onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

export async function getVersionInfo(db: Database) {
  const autoUpdate = (await getSetting(db, 'auto_update')) === 'true';
  const lastCheckedAt = await getSetting(db, 'last_update_check');
  let latestVersion = await getSetting(db, 'latest_version');

  // Check GHCR for latest version (cache for 5 minutes)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const lastCheck = lastCheckedAt ? new Date(lastCheckedAt).getTime() : 0;

  if (lastCheck < fiveMinutesAgo) {
    try {
      const response = await fetch(RELEASES_API, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'Accept': 'application/vnd.github+json' },
      });
      if (response.ok) {
        const data = await response.json() as { tag_name?: string };
        // Release tags are like `v1.2.3` — strip the leading v to
        // match the currentVersion format.
        const tag = (data.tag_name ?? '').replace(/^v/, '');
        if (/^\d+\.\d+\.\d+$/.test(tag)) {
          latestVersion = tag;
        }
      }
    } catch {
      // GitHub unreachable — use cached value
    }
    await setSetting(db, 'last_update_check', new Date().toISOString());
    if (latestVersion) {
      await setSetting(db, 'latest_version', latestVersion);
    }
  }

  // "unknown" currentVersion means PLATFORM_VERSION isn't wired up —
  // we can't compare semver, so never claim an update is available.
  const canCompare = CURRENT_VERSION !== 'unknown';
  const updateAvailable = canCompare && latestVersion !== null && latestVersion !== CURRENT_VERSION && isNewer(latestVersion, CURRENT_VERSION);

  const imageUpdateStrategy = ENVIRONMENT === 'production' ? 'manual' as const : 'auto' as const;
  const pendingVersion = await getSetting(db, 'pending_update_version');

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable,
    environment: ENVIRONMENT,
    autoUpdate,
    imageUpdateStrategy,
    pendingVersion,
    lastCheckedAt: lastCheckedAt ?? null,
  };
}

function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPat] = latest.split('.').map(Number);
  const [cMaj, cMin, cPat] = current.split('.').map(Number);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

export async function updateSettings(db: Database, autoUpdate: boolean) {
  await setSetting(db, 'auto_update', String(autoUpdate));
  return { autoUpdate };
}

// ─── Capacity Check ─────────────────────────────────────────────────────────


interface CapacityCheckResult {
  readonly totalCpu: number;
  readonly totalMemory: number;
  readonly totalStorage: number;
  readonly allocatedCpu: number;
  readonly allocatedMemory: number;
  readonly allocatedStorage: number;
  readonly requestedCpu: number;
  readonly requestedMemory: number;
  readonly requestedStorage: number;
  readonly fits: boolean;
  readonly warnings: readonly string[];
}

export async function getCapacityCheck(
  db: Database,
  appMinCpu: string,
  appMinMemory: string,
  appMinStorage: string,
): Promise<CapacityCheckResult> {
  // Read total node capacity from platform_settings (defaults for CX32)
  const cpuTotal = parseResourceValue(
    (await getSetting(db, 'node_cpu_total')) ?? '4',
    'cpu',
  );
  const memoryTotal = parseResourceValue(
    (await getSetting(db, 'node_memory_total')) ?? '8Gi',
    'memory',
  );
  const storageTotal = parseResourceValue(
    (await getSetting(db, 'node_storage_total')) ?? '80Gi',
    'storage',
  );

  // Sum allocated resources from running application instances
  // For Phase 1, since we don't have real instances yet, allocated is 0
  const allocatedCpu = 0;
  const allocatedMemory = 0;
  const allocatedStorage = 0;

  const requestedCpu = parseResourceValue(appMinCpu, 'cpu');
  const requestedMemory = parseResourceValue(appMinMemory, 'memory');
  const requestedStorage = parseResourceValue(appMinStorage, 'storage');

  const availableCpu = cpuTotal - allocatedCpu;
  const availableMemory = memoryTotal - allocatedMemory;
  const availableStorage = storageTotal - allocatedStorage;

  const warnings: string[] = [];
  let fits = true;

  if (requestedCpu > availableCpu) {
    fits = false;
    warnings.push(
      `This application requires ${requestedCpu.toFixed(2)} CPU but only ${availableCpu.toFixed(2)} CPU is available`,
    );
  } else if ((allocatedCpu + requestedCpu) / cpuTotal >= 0.95) {
    warnings.push(
      `Installing this application would use ${(((allocatedCpu + requestedCpu) / cpuTotal) * 100).toFixed(0)}% of total CPU`,
    );
  }

  if (requestedMemory > availableMemory) {
    fits = false;
    warnings.push(
      `This application requires ${requestedMemory.toFixed(2)}Gi memory but only ${availableMemory.toFixed(2)}Gi is available`,
    );
  } else if ((allocatedMemory + requestedMemory) / memoryTotal >= 0.95) {
    warnings.push(
      `Installing this application would use ${(((allocatedMemory + requestedMemory) / memoryTotal) * 100).toFixed(0)}% of total memory`,
    );
  }

  if (requestedStorage > availableStorage) {
    fits = false;
    warnings.push(
      `This application requires ${requestedStorage.toFixed(2)}Gi storage but only ${availableStorage.toFixed(2)}Gi is available`,
    );
  } else if ((allocatedStorage + requestedStorage) / storageTotal >= 0.95) {
    warnings.push(
      `Installing this application would use ${(((allocatedStorage + requestedStorage) / storageTotal) * 100).toFixed(0)}% of total storage`,
    );
  }

  return {
    totalCpu: cpuTotal,
    totalMemory: memoryTotal,
    totalStorage: storageTotal,
    allocatedCpu,
    allocatedMemory,
    allocatedStorage,
    requestedCpu,
    requestedMemory,
    requestedStorage,
    fits,
    warnings,
  };
}

export async function triggerUpdate(db: Database) {
  if (ENVIRONMENT !== 'production') {
    return { message: 'Auto-update environment — updates are deployed automatically via Flux', targetVersion: CURRENT_VERSION };
  }

  const info = await getVersionInfo(db);
  if (!info.updateAvailable || !info.latestVersion) {
    return { message: 'Already up to date', targetVersion: info.currentVersion };
  }

  // Record the target version. A CronJob (`platform-update-checker`)
  // periodically reads `pending_update_version` from the database and
  // triggers `flux reconcile kustomization platform` when set.
  await setSetting(db, 'pending_update_version', info.latestVersion);
  return { message: 'Update initiated — will be applied on next reconciliation cycle', targetVersion: info.latestVersion };
}
