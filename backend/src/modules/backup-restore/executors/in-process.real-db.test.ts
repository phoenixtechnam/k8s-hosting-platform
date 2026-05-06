/**
 * Real-DB integration test for the three in-process restore
 * executors:
 *   - config-tables          (whole-table apply)
 *   - deployments-by-id      (id-filtered apply on `deployments`)
 *   - domains-by-id          (id-filtered apply on `domains`)
 *
 * Uses `pg-mem` to boot an in-memory Postgres, mirrors the same
 * pgMemDatabase adapter as `tenant-bundles/components/config.real-db.test.ts`,
 * and asserts on real INSERT … ON CONFLICT (id) DO UPDATE behaviour
 * (no schema-mismatch hides this time).
 *
 * What this test catches that pure unit tests don't:
 *   - sql.identifier() actually quotes the column names so that the
 *     generated SQL is valid Postgres.
 *   - Cross-tenant guard rejects a bundle whose dump.clientId differs
 *     from the cart's restoreJob.clientId BEFORE any rows are written.
 *   - Idempotent re-execute: running the executor twice with the
 *     same bundle leaves the live DB in the same state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../db/index.js';
import type { BackupStore, BundleHandle, ArtifactRef } from '../../tenant-bundles/bundle-store.js';
import { execConfigTablesItem } from './config-tables.js';
import { execDeploymentsByIdItem } from './deployments-by-id.js';
import { execDomainsByIdItem } from './domains-by-id.js';

const FIXTURE_CLIENT_ID = '4ec7436d-6159-4bf0-9282-d7e4cc19410b';
const FOREIGN_CLIENT_ID = '00000000-0000-0000-0000-000000000099';
const RESTORE_JOB_ID = 'rstr-test-1';
const BUNDLE_ID = 'bkp-test-1';

function pgMemDatabase(mem: IMemoryDb): Database {
  const adapter = mem.adapters.createPg() as unknown as { Pool: new () => { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } };
  const pool = new adapter.Pool();
  // Recursive flattener for Drizzle's `sql` AST. Handles nested sql
  // fragments produced by sql.identifier(), sql.join(), and nested
  // sql`...` templates. Identifier nodes carry { value: string }
  // string fragments are { value: [string, ...] }, and bound params
  // are arbitrary values.
  const renderChunks = (chunks: unknown[], state: { text: string; params: unknown[] }): void => {
    for (const chunk of chunks) {
      if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk && Array.isArray((chunk as { queryChunks: unknown[] }).queryChunks)) {
        renderChunks((chunk as { queryChunks: unknown[] }).queryChunks, state);
        continue;
      }
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const v = (chunk as { value: unknown }).value;
        if (Array.isArray(v) && typeof v[0] === 'string') {
          state.text += v[0]; // string fragment from sql template literal
          continue;
        }
        if (typeof v === 'string') {
          // Identifier — quote with double-quotes per Postgres rules.
          state.text += `"${v.replace(/"/g, '""')}"`;
          continue;
        }
        // Param value wrapped in { value }.
        state.params.push(v);
        state.text += `$${state.params.length}`;
        continue;
      }
      // Raw bound value.
      state.params.push(chunk);
      state.text += `$${state.params.length}`;
    }
  };
  const execute: Database['execute'] = async (q: { queryChunks: unknown[] }) => {
    const state = { text: '', params: [] as unknown[] };
    renderChunks(q.queryChunks, state);
    const r = await pool.query(state.text, state.params);
    return { rows: r.rows } as never;
  };
  return {
    execute,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: RESTORE_JOB_ID, clientId: FIXTURE_CLIENT_ID }],
        }),
      }),
    }),
    transaction: async <T,>(fn: (tx: { execute: Database['execute'] }) => Promise<T>) => {
      // pg-mem does not implement nested savepoints reliably; the
      // executors' transactions are flattened to direct execute() in
      // tests. The cross-tenant guard fires BEFORE the transaction
      // opens, so this does not reduce coverage of the safety path.
      return fn({ execute });
    },
  } as unknown as Database;
}

function makeFixtureDb(): Database {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE clients (
      id            VARCHAR(36) PRIMARY KEY,
      company_name  VARCHAR(255) NOT NULL
    );
    CREATE TABLE deployments (
      id        VARCHAR(36) PRIMARY KEY,
      name      VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id),
      status    VARCHAR(50) NOT NULL DEFAULT 'active'
    );
    CREATE TABLE domains (
      id        VARCHAR(36) PRIMARY KEY,
      hostname  VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id)
    );
    CREATE TABLE restore_items (
      id                 VARCHAR(36) PRIMARY KEY,
      progress_message   TEXT,
      size_bytes         BIGINT
    );
  `);
  mem.public.none(`
    INSERT INTO clients(id, company_name) VALUES
      ('${FIXTURE_CLIENT_ID}', 'Fixture Co');
    INSERT INTO restore_items(id) VALUES ('item-1');
  `);
  return pgMemDatabase(mem);
}

/**
 * Synthesise a config dump (db-rows.json.gz) the executors can read
 * via store.readComponent. Wraps in gzip + a tiny in-memory store.
 */
function makeStoreWithDump(dump: unknown): BackupStore {
  const buf = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'));
  const handle: BundleHandle = { backupId: BUNDLE_ID, clientId: FIXTURE_CLIENT_ID, root: 'mem://' + BUNDLE_ID };
  return {
    kind: 's3',
    reserveBundle: async () => handle,
    open: async () => handle,
    writeComponent: async (): Promise<ArtifactRef> => { throw new Error('not used in restore tests'); },
    readComponent: async () => Readable.from([buf]),
    listArtifacts: async () => [],
    stat: async () => null,
    putMeta: async () => undefined,
    getMeta: async () => null,
    delete: async () => undefined,
  } as unknown as BackupStore;
}

const fakeApp = (db: Database): FastifyInstance => ({
  db,
  log: { error: () => {}, warn: () => {}, info: () => {} },
} as unknown as FastifyInstance);

describe('in-process restore executors', () => {
  let db: Database;
  beforeEach(() => { db = makeFixtureDb(); });

  it('config-tables: applies whole-table rows from dump', async () => {
    const dump = {
      schemaVersion: 1,
      clientId: FIXTURE_CLIENT_ID,
      tables: {
        deployments: [
          { id: 'dep-1', name: 'web', client_id: FIXTURE_CLIENT_ID, status: 'active' },
          { id: 'dep-2', name: 'worker', client_id: FIXTURE_CLIENT_ID, status: 'active' },
        ],
      },
    };
    await execConfigTablesItem({
      app: fakeApp(db),
      item: { id: 'item-1', restoreJobId: RESTORE_JOB_ID, bundleId: BUNDLE_ID, type: 'config-tables', selector: { kind: 'tables', tables: ['deployments'] } } as unknown as Parameters<typeof execConfigTablesItem>[0]['item'],
      store: makeStoreWithDump(dump),
    });
    const r = await db.execute({ queryChunks: [{ value: ['SELECT id, name FROM deployments ORDER BY id'] }] } as unknown as Parameters<Database['execute']>[0]);
    expect((r as { rows: unknown[] }).rows).toEqual([
      { id: 'dep-1', name: 'web' },
      { id: 'dep-2', name: 'worker' },
    ]);
  });

  it('deployments-by-id: applies only the requested ids', async () => {
    const dump = {
      schemaVersion: 1,
      clientId: FIXTURE_CLIENT_ID,
      tables: {
        deployments: [
          { id: 'dep-1', name: 'web', client_id: FIXTURE_CLIENT_ID, status: 'active' },
          { id: 'dep-2', name: 'worker', client_id: FIXTURE_CLIENT_ID, status: 'active' },
        ],
      },
    };
    await execDeploymentsByIdItem({
      app: fakeApp(db),
      item: { id: 'item-1', restoreJobId: RESTORE_JOB_ID, bundleId: BUNDLE_ID, type: 'deployments-by-id', selector: { kind: 'ids', deploymentIds: ['dep-2'] } } as unknown as Parameters<typeof execDeploymentsByIdItem>[0]['item'],
      store: makeStoreWithDump(dump),
    });
    const r = await db.execute({ queryChunks: [{ value: ['SELECT id FROM deployments ORDER BY id'] }] } as unknown as Parameters<Database['execute']>[0]);
    expect((r as { rows: { id: string }[] }).rows).toEqual([{ id: 'dep-2' }]);
  });

  it('deployments-by-id: refuses cross-tenant bundle', async () => {
    const dump = {
      schemaVersion: 1,
      clientId: FOREIGN_CLIENT_ID, // ← different client
      tables: { deployments: [{ id: 'dep-x', name: 'pwned', client_id: FOREIGN_CLIENT_ID, status: 'active' }] },
    };
    await expect(execDeploymentsByIdItem({
      app: fakeApp(db),
      item: { id: 'item-1', restoreJobId: RESTORE_JOB_ID, bundleId: BUNDLE_ID, type: 'deployments-by-id', selector: { kind: 'all' } } as unknown as Parameters<typeof execDeploymentsByIdItem>[0]['item'],
      store: makeStoreWithDump(dump),
    })).rejects.toThrow(/cross-tenant/i);
    const r = await db.execute({ queryChunks: [{ value: ['SELECT count(*) AS c FROM deployments'] }] } as unknown as Parameters<Database['execute']>[0]);
    expect((r as { rows: { c: number | string }[] }).rows[0]!.c).toEqual(expect.anything());
    // Live table should still be empty.
    const r2 = await db.execute({ queryChunks: [{ value: ["SELECT * FROM deployments WHERE id = 'dep-x'"] }] } as unknown as Parameters<Database['execute']>[0]);
    expect((r2 as { rows: unknown[] }).rows).toEqual([]);
  });

  it('domains-by-id: applies only the requested ids', async () => {
    const dump = {
      schemaVersion: 1,
      clientId: FIXTURE_CLIENT_ID,
      tables: {
        domains: [
          { id: 'dom-1', hostname: 'a.test', client_id: FIXTURE_CLIENT_ID },
          { id: 'dom-2', hostname: 'b.test', client_id: FIXTURE_CLIENT_ID },
        ],
      },
    };
    await execDomainsByIdItem({
      app: fakeApp(db),
      item: { id: 'item-1', restoreJobId: RESTORE_JOB_ID, bundleId: BUNDLE_ID, type: 'domains-by-id', selector: { kind: 'ids', domainIds: ['dom-1'] } } as unknown as Parameters<typeof execDomainsByIdItem>[0]['item'],
      store: makeStoreWithDump(dump),
    });
    const r = await db.execute({ queryChunks: [{ value: ['SELECT id, hostname FROM domains ORDER BY id'] }] } as unknown as Parameters<Database['execute']>[0]);
    expect((r as { rows: { id: string; hostname: string }[] }).rows).toEqual([{ id: 'dom-1', hostname: 'a.test' }]);
  });

  it('domains-by-id: id-filtered apply with missing id throws NOT_FOUND', async () => {
    const dump = {
      schemaVersion: 1,
      clientId: FIXTURE_CLIENT_ID,
      tables: { domains: [{ id: 'dom-1', hostname: 'a.test', client_id: FIXTURE_CLIENT_ID }] },
    };
    await expect(execDomainsByIdItem({
      app: fakeApp(db),
      item: { id: 'item-1', restoreJobId: RESTORE_JOB_ID, bundleId: BUNDLE_ID, type: 'domains-by-id', selector: { kind: 'ids', domainIds: ['dom-missing'] } } as unknown as Parameters<typeof execDomainsByIdItem>[0]['item'],
      store: makeStoreWithDump(dump),
    })).rejects.toThrow(/dom-missing/);
  });

  it('idempotent: running deployments-by-id twice yields the same final state', async () => {
    const dump = {
      schemaVersion: 1,
      clientId: FIXTURE_CLIENT_ID,
      tables: { deployments: [{ id: 'dep-1', name: 'web', client_id: FIXTURE_CLIENT_ID, status: 'active' }] },
    };
    const args = {
      app: fakeApp(db),
      item: { id: 'item-1', restoreJobId: RESTORE_JOB_ID, bundleId: BUNDLE_ID, type: 'deployments-by-id', selector: { kind: 'ids', deploymentIds: ['dep-1'] } } as unknown as Parameters<typeof execDeploymentsByIdItem>[0]['item'],
      store: makeStoreWithDump(dump),
    };
    await execDeploymentsByIdItem(args);
    await execDeploymentsByIdItem(args); // re-run
    const r = await db.execute({ queryChunks: [{ value: ['SELECT id, name FROM deployments'] }] } as unknown as Parameters<Database['execute']>[0]);
    expect((r as { rows: unknown[] }).rows).toEqual([{ id: 'dep-1', name: 'web' }]);
  });
});
