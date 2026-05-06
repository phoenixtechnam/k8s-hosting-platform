import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../../db/index.js';
import { buildConfigDump, captureConfigComponent, CONFIG_DUMP_TABLES, CONFIG_DUMP_SCHEMA_VERSION } from './config.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';

function fakeDb(rowsByQuery: (sqlText: string) => unknown[]): Database {
  return {
    execute: vi.fn(async (q: { queryChunks?: unknown[] }) => {
      // Drizzle's sql template stores fragments as { value: [str] } chunks
      // interleaved with parameter values. Concat just the fragment strings —
      // that's the SQL skeleton we want to match against in tests.
      const chunks = q.queryChunks ?? [];
      const text = chunks
        .map((c) => {
          if (c && typeof c === 'object' && 'value' in c) {
            const v = (c as { value: unknown }).value;
            if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
          }
          return '';
        })
        .join(' ');
      return { rows: rowsByQuery(text) };
    }),
  } as unknown as Database;
}

describe('buildConfigDump', () => {
  it('returns a stable manifest shape with schemaVersion + clientId', async () => {
    const db = fakeDb(() => []);
    const dump = await buildConfigDump(db, '4ec7436d-6159-4bf0-9282-d7e4cc19410b');
    expect(dump.schemaVersion).toBe(CONFIG_DUMP_SCHEMA_VERSION);
    expect(dump.clientId).toBe('4ec7436d-6159-4bf0-9282-d7e4cc19410b');
    expect(typeof dump.exportedAt).toBe('string');
    // All declared tables show up as keys, even when empty.
    for (const t of CONFIG_DUMP_TABLES) {
      expect(dump.tables).toHaveProperty(t);
      expect(Array.isArray(dump.tables[t])).toBe(true);
    }
  });

  it('captures rows returned by the SELECT for each table', async () => {
    const db = fakeDb((q) => {
      if (/^\s*SELECT \* FROM clients\b/.test(q)) return [{ id: 'c1', userId: 'u1' }];
      if (/^\s*SELECT \* FROM domains\b/.test(q)) return [{ id: 'd1', clientId: 'c1' }];
      return [];
    });
    const dump = await buildConfigDump(db, 'c1');
    expect((dump.tables.clients as unknown[]).length).toBe(1);
    expect((dump.tables.domains as unknown[]).length).toBe(1);
    expect((dump.tables.users as unknown[]).length).toBe(0); // mock returns []
  });
});

describe('captureConfigComponent', () => {
  it('writes a gzipped JSON manifest via the BackupStore and reports row count', async () => {
    const writes: { component: string; name: string; body: Buffer }[] = [];
    const fakeStore = {
      kind: 'hostpath',
      writeComponent: vi.fn(async (_h: BundleHandle, component: string, name: string, body: Readable) => {
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        writes.push({ component, name, body: buf });
        return { component, name, sizeBytes: buf.length };
      }),
    } as unknown as BackupStore;

    const db = fakeDb((q) => (/^\s*SELECT \* FROM clients\b/.test(q) ? [{ id: 'c1' }] : []));
    const handle: BundleHandle = { bundleId: 'bk', _backend: {} };

    const r = await captureConfigComponent({ db, clientId: 'c1', store: fakeStore, handle });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.component).toBe('config');
    expect(writes[0]!.name).toBe('db-rows.json.gz');

    const decoded = JSON.parse(gunzipSync(writes[0]!.body).toString('utf8'));
    expect(decoded.schemaVersion).toBe(CONFIG_DUMP_SCHEMA_VERSION);
    expect(decoded.clientId).toBe('c1');

    expect(r.rowCount).toBe(1);
    expect(r.sizeBytes).toBe(writes[0]!.body.length);
  });
});
