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
import { getInUseImages, classifyImage } from './service.js';
import { reapImageNow } from './image-reaper.js';

const WATCHER_INTERVAL_MS = 60_000; // 1 minute
const PRESSURE_IMAGE_FRACTION = 0.75; // 75% of ephemeral-storage used → trigger

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
        const inUse = names.some(n => inUseSet.has(n));
        const isProtected = classifyImage(imageRef, inUse).protected;
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
      await notifyAdmins(db, title, message);
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
    tick(db, k8s, log).catch(err => {
      log.warn({ err }, '[pressure-watcher] tick failed');
    });
  }, WATCHER_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}
