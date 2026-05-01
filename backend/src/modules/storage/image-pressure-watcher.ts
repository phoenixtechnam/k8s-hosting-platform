/**
 * Image Pressure Watcher — Phase 3 disk-pressure cron.
 *
 * Runs every 60s. For each node that is under DiskPressure (as reported by
 * the kubelet condition) OR whose image cache exceeds 75% of ephemeral-storage
 * capacity, it reaps the largest purgeable images first until projected usage
 * drops below the configured imageGcLowThreshold (default 60%) or no
 * candidates remain.
 *
 * Safety: images currently in use by any pod are never touched.
 * All removals are delegated to reapImageNow() which inserts an image_reap_log
 * row with triggeredBy='pressure_watcher'.
 *
 * Admin notification: after each node-level purge an 'info' notification is
 * written for all admin users.
 */

import { inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { users, notifications } from '../../db/schema.js';
import { getSettings } from '../system-settings/service.js';
import { getInUseImages, classifyImageByNames, isAnyNameInUse } from './service.js';
import { reapImageNow } from './image-reaper.js';

const WATCHER_INTERVAL_MS = 60_000; // 1 minute
const PRESSURE_IMAGE_FRACTION = 0.75; // 75% of ephemeral-storage used → trigger
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per node

// HIGH #2: a single tick can take longer than the interval (a reap polls a
// privileged pod up to 180s). If we don't gate concurrent ticks, ticks pile
// up and fan out duplicate purge pods. Module-level flag is fine — even
// with N replicas each replica's flag scopes its own ticks.
let ticking = false;

// HIGH #3: per-node last-notified timestamps. Suppresses duplicate
// notifications when a node stays under sustained pressure across many
// ticks. Resets on process restart, which is acceptable.
const lastNotifiedAt = new Map<string, number>();

interface RawNodeImage {
  names?: readonly string[] | null;
  sizeBytes?: number;
}

interface NodeCondition {
  type?: string;
  status?: string;
}

interface RawNode {
  metadata?: { name?: string };
  status?: {
    conditions?: readonly NodeCondition[];
    images?: readonly RawNodeImage[];
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
  };
}

function parseStorage(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) return parseInt(value, 10) || 0;
  const num = parseFloat(match[1]);
  const unit = match[2] ?? '';
  const multipliers: Record<string, number> = {
    '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4,
  };
  return Math.round(num * (multipliers[unit] ?? 1));
}

function isUnderDiskPressure(node: RawNode): boolean {
  return (node.status?.conditions ?? []).some(
    c => c.type === 'DiskPressure' && c.status === 'True',
  );
}

/**
 * True when image cache bytes exceed PRESSURE_IMAGE_FRACTION of the node's
 * ephemeral-storage capacity (used as a proxy for overall image fs usage).
 */
function isImageCacheHigh(node: RawNode): boolean {
  const capacityStr = node.status?.capacity?.['ephemeral-storage'];
  if (!capacityStr) return false;
  const capacity = parseStorage(capacityStr);
  if (capacity <= 0) return false;
  const imageBytes = (node.status?.images ?? []).reduce((s, img) => s + (img.sizeBytes ?? 0), 0);
  return imageBytes / capacity > PRESSURE_IMAGE_FRACTION;
}

async function notifyAdmins(
  db: Database,
  title: string,
  message: string,
): Promise<void> {
  try {
    const adminRows = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.roleName, ['super_admin', 'admin']));
    for (const a of adminRows) {
      await db.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: a.id,
        type: 'info',
        title,
        message,
        resourceType: 'image_cache',
        resourceId: null,
      }).catch(() => {
        // Non-fatal
      });
    }
  } catch {
    // Non-fatal: notification failure must not disrupt the watcher
  }
}

async function tick(
  db: Database,
  k8s: K8sClients,
  log: FastifyBaseLogger,
): Promise<void> {
  const settings = await getSettings(db);
  const lowThresholdFraction = settings.imageGcLowThreshold / 100;

  let nodeList: readonly RawNode[] = [];
  try {
    const raw = await k8s.core.listNode();
    nodeList = (raw as { items?: typeof nodeList }).items ?? [];
  } catch {
    log.warn('[pressure-watcher] listNode failed — skipping tick');
    return;
  }

  const inUseSet = await getInUseImages(k8s);

  for (const node of nodeList) {
    const nodeName = node.metadata?.name ?? 'unknown';
    const underPressure = isUnderDiskPressure(node);
    const cacheHigh = isImageCacheHigh(node);
    if (!underPressure && !cacheHigh) continue;

    log.info({ node: nodeName, underPressure, cacheHigh }, '[pressure-watcher] node needs image eviction');

    const images = node.status?.images ?? [];
    const capacityStr = node.status?.capacity?.['ephemeral-storage'] ?? '0';
    const capacity = parseStorage(capacityStr);

    // Build list of purgeable images on this node, sorted largest-first
    const candidates = images
      .flatMap(img => {
        const names = img.names ?? [];
        if (names.length === 0) return [];
        // Find a usable crictl reference
        const realTag = names.find(n => n.includes(':') && !n.includes('@sha256') && !n.endsWith(':<none>'));
        const digestRef = names.find(n => n.includes('@sha256:'));
        const imageRef = realTag ?? digestRef ?? names[0];
        // HIGH #4 + #1: use the same normalisation paths the aggregator uses
        // so docker.io/library/* and digest-vs-tag mismatches don't leak.
        const inUse = isAnyNameInUse(names, inUseSet);
        const isProtected = classifyImageByNames(names, inUse).protected;
        if (inUse || isProtected) return [];
        return [{ imageRef, sizeBytes: img.sizeBytes ?? 0 }];
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes); // largest first

    if (candidates.length === 0) {
      log.info({ node: nodeName }, '[pressure-watcher] no purgeable images on node');
      continue;
    }

    let projectedImageBytes = images.reduce((s, img) => s + (img.sizeBytes ?? 0), 0);
    let totalReclaimedBytes = 0;
    let reclaimedCount = 0;

    for (const candidate of candidates) {
      // Stop when projected usage is below the low threshold
      if (capacity > 0 && projectedImageBytes / capacity <= lowThresholdFraction) break;

      const result = await reapImageNow(db, k8s, {
        image: candidate.imageRef,
        triggeredBy: 'pressure_watcher',
        triggerRef: nodeName,
      });

      if (!result.skipped) {
        projectedImageBytes -= candidate.sizeBytes;
        totalReclaimedBytes += result.reclaimedBytes;
        reclaimedCount++;
      }
    }

    if (reclaimedCount > 0) {
      const mb = Math.round(totalReclaimedBytes / (1024 * 1024));
      const title = `Auto-purged ${reclaimedCount} image${reclaimedCount !== 1 ? 's' : ''} on node ${nodeName}`;
      const message = `Reclaimed ${mb} MB of image cache storage due to disk pressure.`;
      log.info({ node: nodeName, reclaimedCount, mb }, '[pressure-watcher] ' + message);

      // HIGH #3: cooldown guard. Don't spam admins with one notification per
      // tick when the node sits above the threshold continuously.
      const now = Date.now();
      const last = lastNotifiedAt.get(nodeName) ?? 0;
      if (now - last >= NOTIFY_COOLDOWN_MS) {
        lastNotifiedAt.set(nodeName, now);
        await notifyAdmins(db, title, message);
      } else {
        log.debug(
          { node: nodeName, sinceLastMs: now - last },
          '[pressure-watcher] skipping notification — within cooldown',
        );
      }
    }
  }
}

export interface PressureWatcherHandle {
  stop: () => void;
}

export function startImagePressureWatcher(
  db: Database,
  k8s: K8sClients,
  log: FastifyBaseLogger,
): PressureWatcherHandle {
  const timer = setInterval(() => {
    if (ticking) {
      log.debug('[pressure-watcher] previous tick still running — skipping');
      return;
    }
    ticking = true;
    tick(db, k8s, log)
      .catch(err => {
        log.warn({ err }, '[pressure-watcher] tick failed');
      })
      .finally(() => {
        ticking = false;
      });
  }, WATCHER_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}

/**
 * Test-only: reset module-level state (ticking flag, notification cooldown
 * map). Vitest runs tests in the same process; without this guard, state
 * leaks between cases.
 */
export function _resetWatcherStateForTests(): void {
  ticking = false;
  lastNotifiedAt.clear();
}
