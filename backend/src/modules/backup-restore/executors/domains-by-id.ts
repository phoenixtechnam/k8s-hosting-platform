/**
 * Restore executor: `domains-by-id`.
 *
 * Reads `components/config/db-rows.json.gz` from the bundle, picks
 * rows in the `domains` table whose `id` matches the selector, and
 * UPSERTs them via INSERT … ON CONFLICT (id) DO UPDATE.
 *
 * DNS / cluster-side reconciliation:
 *   PowerDNS records and ingress objects are reconciled by the
 *   domain lifecycle hooks against the `domains` table — restoring
 *   the row is sufficient to put the domain back into the same
 *   intended state. Operators who need a hard re-publish trigger
 *   that from the domain detail page after the restore completes.
 *
 * Selector shapes (per api-contracts/restore.ts):
 *   { kind: 'all' }                         — restore every domain in bundle
 *   { kind: 'ids', domainIds: ['dom-…', …] }
 */

import type { FastifyInstance } from 'fastify';
import type { BackupStore } from '../../backups-v2/bundle-store.js';
import type { RestoreItem } from '../../../db/schema.js';
import { readAndAuthorizeConfigDump, applyIdFilteredUpsert } from './_shared.js';

interface Selector {
  kind: 'all' | 'ids';
  domainIds?: readonly string[];
}

export async function execDomainsByIdItem(args: {
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
  } else if (selector.kind === 'ids' && Array.isArray(selector.domainIds) && selector.domainIds.length > 0) {
    ids = selector.domainIds;
  } else {
    throw new Error(`domains-by-id: unsupported selector ${JSON.stringify(selector)}`);
  }

  await applyIdFilteredUpsert({
    app,
    item,
    dump,
    cartItemTable: 'domains',
    sqlTable: 'domains',
    ids,
    bundleSizeBytes: JSON.stringify(dump.tables.domains ?? []).length,
  });
}
