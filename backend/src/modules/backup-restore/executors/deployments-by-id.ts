/**
 * Restore executor: `deployments-by-id`.
 *
 * Reads `components/config/db-rows.json.gz` from the bundle, picks
 * rows in the `deployments` table whose `id` matches the selector,
 * and UPSERTs them via INSERT … ON CONFLICT (id) DO UPDATE.
 *
 * Cluster-side reconciliation (Kustomization, NetworkPolicy, etc.)
 * is left to the existing deployment lifecycle hooks — they pick up
 * DB changes on their next tick. This executor's job is to restore
 * the DB state of record; it does NOT re-provision cluster resources
 * directly. Operators who need a hard re-apply trigger that from the
 * deployment detail page after the restore completes.
 *
 * Selector shapes (per api-contracts/restore.ts):
 *   { kind: 'all' }                         — restore every deployment in bundle
 *   { kind: 'ids', deploymentIds: ['dep-…', …] }
 */

import type { FastifyInstance } from 'fastify';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import type { RestoreItem } from '../../../db/schema.js';
import { readAndAuthorizeConfigDump, applyIdFilteredUpsert } from './_shared.js';

interface Selector {
  kind: 'all' | 'ids';
  deploymentIds?: readonly string[];
}

export async function execDeploymentsByIdItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item, store } = args;
  const selector = item.selector as unknown as Selector;
  const dump = await readAndAuthorizeConfigDump({ app, item, store });

  let ids: 'all' | readonly string[];
  if (selector.kind === 'all') {
    ids = 'all';
  } else if (selector.kind === 'ids' && Array.isArray(selector.deploymentIds) && selector.deploymentIds.length > 0) {
    ids = selector.deploymentIds;
  } else {
    throw new Error(`deployments-by-id: unsupported selector ${JSON.stringify(selector)}`);
  }

  await applyIdFilteredUpsert({
    app,
    item,
    dump,
    cartItemTable: 'deployments',
    sqlTable: 'deployments',
    ids,
    bundleSizeBytes: JSON.stringify(dump.tables.deployments ?? []).length,
  });
}
