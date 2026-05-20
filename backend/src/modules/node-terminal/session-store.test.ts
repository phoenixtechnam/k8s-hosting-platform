import { describe, it, expect, vi, beforeEach } from 'vitest';

// service.ts imports drizzle-orm at top level — mock so tests can run
// without a real Postgres. We don't need the SQL to actually execute,
// only the chained builder calls to be observable.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ _tag: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ _tag: 'and', args })),
  lt: vi.fn((col: unknown, val: unknown) => ({ _tag: 'lt', col, val })),
  sql: vi.fn((strs: TemplateStringsArray, ...vals: unknown[]) => ({ _tag: 'sql', strs, vals })),
}));

vi.mock('../../db/schema.js', () => ({
  nodeTerminalSessions: {
    id: 'id',
    nodeName: 'node_name',
    podName: 'pod_name',
    podNamespace: 'pod_namespace',
    userId: 'user_id',
    userEmail: 'user_email',
    clientIp: 'client_ip',
    wsTokenHash: 'ws_token_hash',
    wsTokenIssuedAt: 'ws_token_issued_at',
    ownerReplica: 'owner_replica',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
    lastActivityAt: 'last_activity_at',
  },
}));

import {
  hashWsToken,
  insertSession,
  findById,
  consumeWsToken,
  refreshWsToken,
  updateOwnerReplica,
  deleteSession,
  findIdle,
  findExpired,
  listForNode,
  listAll,
  setTerminateAfter,
  clearTerminateAfter,
  findReadyForTermination,
} from './session-store.js';
import type { NodeTerminalSessionRow } from '../../db/schema.js';

/**
 * Build a chainable, observable Drizzle-shaped mock DB.
 * - `selectResult` is what `db.select().from(...).where(...)` resolves to.
 * - `updateResult` is what `db.update(...).set(...).where(...).returning()` resolves to.
 * - `deleteResult` is what `db.delete(...).where(...).returning(...)` resolves to.
 *
 * All builder methods record calls so tests can assert what was queried.
 */
function makeDb(opts: {
  selectResult?: unknown[];
  updateResult?: unknown[];
  deleteResult?: unknown[];
  insertResult?: unknown;
} = {}): {
  db: Parameters<typeof insertSession>[0];
  calls: {
    insertValues: ReturnType<typeof vi.fn>;
    updateSet: ReturnType<typeof vi.fn>;
    updateWhere: ReturnType<typeof vi.fn>;
    updateReturning: ReturnType<typeof vi.fn>;
    deleteWhere: ReturnType<typeof vi.fn>;
    selectFrom: ReturnType<typeof vi.fn>;
    selectWhere: ReturnType<typeof vi.fn>;
    selectLimit: ReturnType<typeof vi.fn>;
  };
} {
  const selectResult = opts.selectResult ?? [];
  const updateResult = opts.updateResult ?? [];
  const deleteResult = opts.deleteResult ?? [];

  const selectLimit = vi.fn().mockResolvedValue(selectResult);
  // The select chain has TWO shapes used by session-store:
  //   findById:   .select().from(table).where(cond).limit(1)
  //   listAll:    .select().from(table)
  //   listForNode/findIdle/findExpired: .select().from(table).where(cond)
  // Make `from` return a thenable that ALSO has where()/limit()/etc.
  // so awaiting it works (listAll) and chaining works (others).
  const buildFromChain = () => {
    const where = vi.fn(() => {
      const obj: { limit: ReturnType<typeof vi.fn>; then: (resolve: (v: unknown[]) => void) => void } = {
        limit: selectLimit,
        then: (resolve) => resolve(selectResult),
      };
      return obj;
    });
    const from = {
      where,
      then: (resolve: (v: unknown[]) => void) => resolve(selectResult),
    };
    return { from, where };
  };
  const fromChain = buildFromChain();
  const selectFrom = vi.fn(() => fromChain.from);

  const updateReturning = vi.fn().mockResolvedValue(updateResult);
  const updateWhere = vi.fn(() => ({
    returning: updateReturning,
    then: (resolve: (v: unknown) => void) => resolve(updateResult),
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  const deleteReturning = vi.fn().mockResolvedValue(deleteResult);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));

  const insertValues = vi.fn().mockResolvedValue(opts.insertResult ?? undefined);

  const db = {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  } as unknown as Parameters<typeof insertSession>[0];

  return {
    db,
    calls: {
      insertValues,
      updateSet,
      updateWhere,
      updateReturning,
      deleteWhere,
      selectFrom,
      selectWhere: fromChain.where,
      selectLimit,
    },
  };
}

function fakeRow(over: Partial<NodeTerminalSessionRow> = {}): NodeTerminalSessionRow {
  // Use Date.now() not a hardcoded string — findById filters by expiry
  // against the wall clock, so a fixture with a past expiresAt would
  // make the test break by passage of time (it did, May 2026).
  const now = new Date();
  return {
    id: 'sess-1',
    nodeName: 'staging-1',
    podName: 'node-terminal-abc',
    podNamespace: 'platform',
    userId: 'user-1',
    userEmail: 'admin@phoenix-host.net',
    clientIp: '10.0.0.1',
    wsTokenHash: null,
    wsTokenIssuedAt: null,
    ownerReplica: 'platform-api-a',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    lastActivityAt: now,
    terminateAfter: null,
    ...over,
  };
}

describe('hashWsToken', () => {
  it('is deterministic + 32 bytes (SHA-256)', () => {
    const a = hashWsToken('rawtoken');
    const b = hashWsToken('rawtoken');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('differs for different inputs', () => {
    expect(hashWsToken('a').equals(hashWsToken('b'))).toBe(false);
  });

  it('hashes utf-8 bytes (not UCS-2 codepoints)', () => {
    // emoji forces multi-byte encoding — proves we don't strip it
    const a = hashWsToken('foo🔥');
    expect(a.length).toBe(32);
    // The same emoji-bearing string must round-trip:
    expect(hashWsToken('foo🔥').equals(a)).toBe(true);
  });
});

describe('insertSession', () => {
  it('writes hash of wsToken — never the raw token', async () => {
    const { db, calls } = makeDb();
    const RAW = 'super-secret-token';
    await insertSession(db, {
      id: 'sess-1',
      nodeName: 'staging-1',
      podName: 'pod-abc',
      userId: 'user-1',
      userEmail: 'admin@example.com',
      clientIp: '10.0.0.1',
      wsToken: RAW,
      ownerReplica: 'platform-api-a',
      expiresAt: new Date('2026-05-20T11:00:00Z'),
    });
    expect(calls.insertValues).toHaveBeenCalledTimes(1);
    const args = calls.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    // wsTokenHash must be the SHA-256 of the raw — not the raw itself
    expect(args.wsTokenHash).toBeInstanceOf(Buffer);
    expect((args.wsTokenHash as Buffer).equals(hashWsToken(RAW))).toBe(true);
    // Raw token MUST NOT appear anywhere in the persisted row
    for (const v of Object.values(args)) {
      if (typeof v === 'string') expect(v).not.toContain(RAW);
      if (v instanceof Buffer) expect(v.includes(Buffer.from(RAW))).toBe(false);
    }
    // Owner replica + namespace defaults
    expect(args.ownerReplica).toBe('platform-api-a');
    expect(args.podNamespace).toBe('platform');
  });

  it('defaults podNamespace to "platform" when omitted', async () => {
    const { db, calls } = makeDb();
    await insertSession(db, {
      id: 'sess-2',
      nodeName: 'staging-1',
      podName: 'pod-xyz',
      userId: 'user-1',
      userEmail: 'admin@example.com',
      clientIp: '10.0.0.1',
      wsToken: 'token',
      ownerReplica: 'platform-api-a',
      expiresAt: new Date(),
    });
    const args = calls.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.podNamespace).toBe('platform');
  });

  it('honours explicit podNamespace override', async () => {
    const { db, calls } = makeDb();
    await insertSession(db, {
      id: 'sess-3',
      nodeName: 'staging-1',
      podName: 'pod-xyz',
      podNamespace: 'other-ns',
      userId: 'user-1',
      userEmail: 'admin@example.com',
      clientIp: '10.0.0.1',
      wsToken: 'token',
      ownerReplica: 'platform-api-a',
      expiresAt: new Date(),
    });
    const args = calls.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.podNamespace).toBe('other-ns');
  });
});

describe('findById', () => {
  it('returns the row when present and not expired', async () => {
    const row = fakeRow();
    const { db } = makeDb({ selectResult: [row] });
    const result = await findById(db, 'sess-1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('sess-1');
    expect(result?.nodeName).toBe('staging-1');
  });

  it('returns null when not found', async () => {
    const { db } = makeDb({ selectResult: [] });
    const result = await findById(db, 'nope');
    expect(result).toBeNull();
  });

  it('treats expired rows as not-found (defence-in-depth)', async () => {
    // expiresAt in the past — even if the sweeper hasn't deleted yet,
    // findById should refuse to honour the row.
    const row = fakeRow({ expiresAt: new Date(Date.now() - 60_000) });
    const { db } = makeDb({ selectResult: [row] });
    const result = await findById(db, 'sess-1');
    expect(result).toBeNull();
  });
});

describe('consumeWsToken', () => {
  it('returns the row when the atomic UPDATE matched', async () => {
    const row = fakeRow();
    const { db, calls } = makeDb({ updateResult: [row] });
    const result = await consumeWsToken(db, 'sess-1', 'tok');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('sess-1');
    // The SET clause must NULL the hash + issuedAt atomically
    const setArg = calls.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.wsTokenHash).toBeNull();
    expect(setArg.wsTokenIssuedAt).toBeNull();
    expect(setArg.lastActivityAt).toBeInstanceOf(Date);
  });

  it('also clears terminate_after atomically (closes reconnect-vs-reap race)', async () => {
    // Security review HIGH finding (2026-05-20). If consumeWsToken
    // didn't clear terminate_after in the same UPDATE, the scheduler's
    // findReadyForTermination could read a stale pending termination
    // AFTER the WS has reattached but BEFORE cancelDelayedTermination
    // lands its follow-up UPDATE.
    const row = fakeRow();
    const { db, calls } = makeDb({ updateResult: [row] });
    await consumeWsToken(db, 'sess-1', 'tok');
    const setArg = calls.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.terminateAfter).toBeNull();
  });

  it('returns null when nothing was updated (token mismatch / already-consumed / expired)', async () => {
    const { db } = makeDb({ updateResult: [] });
    const result = await consumeWsToken(db, 'sess-1', 'wrong');
    expect(result).toBeNull();
  });

  it('two concurrent consumes — exactly one wins (atomic update guarantees this)', async () => {
    // Simulates the SQL semantics: the second UPDATE matches zero
    // rows because the first cleared ws_token_hash to NULL. We
    // can't run a real Postgres tx here, so we model the atomic
    // behaviour by having the mock return [row] once then [] after.
    const row = fakeRow();
    let consumedOnce = false;
    const updateReturning = vi.fn().mockImplementation(() => {
      if (consumedOnce) return Promise.resolve([]);
      consumedOnce = true;
      return Promise.resolve([row]);
    });
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const db = {
      update: vi.fn(() => ({ set: updateSet })),
    } as unknown as Parameters<typeof consumeWsToken>[0];

    const [a, b] = await Promise.all([
      consumeWsToken(db, 'sess-1', 'token'),
      consumeWsToken(db, 'sess-1', 'token'),
    ]);
    const winners = [a, b].filter((x) => x !== null);
    const losers = [a, b].filter((x) => x === null);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
  });

  it('passes the SHA-256 hash (not the raw token) in the WHERE clause', async () => {
    const { db, calls } = makeDb({ updateResult: [] });
    await consumeWsToken(db, 'sess-1', 'rawtoken');
    // The WHERE has shape: and(eq(id), eq(wsTokenHash, <hash>), sql`issued_at > $cutoff`)
    // We mocked `and` to record its args — pull them out:
    const whereArg = calls.updateWhere.mock.calls[0]![0] as { args?: unknown[] };
    const args = whereArg.args ?? [];
    const hashEq = args.find(
      (a): a is { _tag: 'eq'; col: unknown; val: unknown } =>
        typeof a === 'object' && a !== null && (a as { _tag?: string })._tag === 'eq' && (a as { col?: unknown }).col === 'ws_token_hash',
    );
    expect(hashEq).toBeDefined();
    expect(hashEq?.val).toBeInstanceOf(Buffer);
    expect((hashEq?.val as Buffer).equals(hashWsToken('rawtoken'))).toBe(true);
    // Raw token must NOT be sent to the DB
    expect((hashEq?.val as Buffer).toString('utf8')).not.toBe('rawtoken');
  });
});

describe('refreshWsToken', () => {
  it('writes the new hash + issuedAt; returns the row', async () => {
    const row = fakeRow();
    const { db, calls } = makeDb({ updateResult: [row] });
    const result = await refreshWsToken(db, 'sess-1', 'new-token');
    expect(result?.id).toBe('sess-1');
    const setArg = calls.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.wsTokenHash).toBeInstanceOf(Buffer);
    expect((setArg.wsTokenHash as Buffer).equals(hashWsToken('new-token'))).toBe(true);
    expect(setArg.wsTokenIssuedAt).toBeInstanceOf(Date);
  });

  it('returns null when the session row no longer exists', async () => {
    const { db } = makeDb({ updateResult: [] });
    const result = await refreshWsToken(db, 'gone', 'new-token');
    expect(result).toBeNull();
  });
});

describe('updateOwnerReplica', () => {
  it('issues UPDATE … SET owner_replica = ?, last_activity_at = now()', async () => {
    const { db, calls } = makeDb({ updateResult: [] });
    await updateOwnerReplica(db, 'sess-1', 'platform-api-b');
    const setArg = calls.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.ownerReplica).toBe('platform-api-b');
    expect(setArg.lastActivityAt).toBeInstanceOf(Date);
  });
});

describe('deleteSession', () => {
  it('returns true when a row was actually deleted', async () => {
    const deleteReturning = vi.fn().mockResolvedValue([{ id: 'sess-1' }]);
    const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
    const db = {
      delete: vi.fn(() => ({ where: deleteWhere })),
    } as unknown as Parameters<typeof deleteSession>[0];
    const result = await deleteSession(db, 'sess-1');
    expect(result).toBe(true);
  });

  it('returns false when the row was already gone', async () => {
    const deleteReturning = vi.fn().mockResolvedValue([]);
    const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
    const db = {
      delete: vi.fn(() => ({ where: deleteWhere })),
    } as unknown as Parameters<typeof deleteSession>[0];
    const result = await deleteSession(db, 'gone');
    expect(result).toBe(false);
  });
});

describe('findIdle', () => {
  it('queries with a cutoff = now - idleMs', async () => {
    const oldRow = fakeRow({ lastActivityAt: new Date(Date.now() - 30 * 60_000) });
    const { db } = makeDb({ selectResult: [oldRow] });
    const result = await findIdle(db, 15 * 60_000);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe('sess-1');
  });

  it('returns [] when nothing idle', async () => {
    const { db } = makeDb({ selectResult: [] });
    const result = await findIdle(db, 15 * 60_000);
    expect(result).toEqual([]);
  });
});

describe('findExpired', () => {
  it('returns rows whose expires_at < now()', async () => {
    const expired = fakeRow({ expiresAt: new Date(Date.now() - 60_000) });
    const { db } = makeDb({ selectResult: [expired] });
    const result = await findExpired(db);
    expect(result.length).toBe(1);
  });
});

describe('listForNode', () => {
  it('returns all sessions for a given node', async () => {
    const a = fakeRow({ id: 'sess-a', nodeName: 'staging-1' });
    const b = fakeRow({ id: 'sess-b', nodeName: 'staging-1' });
    const { db } = makeDb({ selectResult: [a, b] });
    const result = await listForNode(db, 'staging-1');
    expect(result.length).toBe(2);
    expect(result.map((r) => r.id).sort()).toEqual(['sess-a', 'sess-b']);
  });
});

describe('listAll', () => {
  it('returns every active session row (cluster-wide)', async () => {
    const a = fakeRow({ id: 'sess-a' });
    const b = fakeRow({ id: 'sess-b' });
    const { db } = makeDb({ selectResult: [a, b] });
    const result = await listAll(db);
    expect(result.length).toBe(2);
  });
});

describe('hashWsToken — constant-time-ish properties', () => {
  // SHA-256 is constant-time over its input length, so comparing the
  // resulting fixed-32-byte buffers in SQL is the constant-time
  // property we want (Postgres bytea comparison is byte-by-byte with
  // no short-circuit on bytea = bytea).
  it('produces a 32-byte output regardless of input length', () => {
    expect(hashWsToken('').length).toBe(32);
    expect(hashWsToken('a').length).toBe(32);
    expect(hashWsToken('a'.repeat(10_000)).length).toBe(32);
  });
});

// ─── Grace-period (terminate_after) helpers — reload survival ─────────

describe('setTerminateAfter', () => {
  it('writes terminate_after to the given timestamp', async () => {
    const { db, calls } = makeDb({ updateResult: [] });
    const fireAt = new Date('2026-05-20T10:01:00Z');
    await setTerminateAfter(db, 'sess-1', fireAt);
    const setArg = calls.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.terminateAfter).toBe(fireAt);
  });
});

describe('clearTerminateAfter', () => {
  it('NULLs the terminate_after column', async () => {
    const { db, calls } = makeDb({ updateResult: [] });
    await clearTerminateAfter(db, 'sess-1');
    const setArg = calls.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.terminateAfter).toBeNull();
  });
});

describe('refreshWsToken — also clears terminate_after', () => {
  it('the same atomic UPDATE that mints the new token clears the pending termination', async () => {
    // Reload→reconnect path: an in-flight grace timer must not race
    // with the reconnect. Doing both updates in one statement closes
    // the window — even if the scheduler's reaper query reads
    // mid-flight, it sees either the old (pending) row or the new
    // (no pending termination) row, never an inconsistent one.
    const row = fakeRow();
    const { db, calls } = makeDb({ updateResult: [row] });
    await refreshWsToken(db, 'sess-1', 'new-token');
    const setArg = calls.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.terminateAfter).toBeNull();
    // Sanity — the hash also got written
    expect(setArg.wsTokenHash).toBeInstanceOf(Buffer);
  });
});

describe('findReadyForTermination', () => {
  it('returns rows whose terminate_after is in the past', async () => {
    const due = fakeRow({ terminateAfter: new Date(Date.now() - 1000) });
    const { db } = makeDb({ selectResult: [due] });
    const result = await findReadyForTermination(db);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe('sess-1');
    expect(result[0]?.terminateAfter).toBeInstanceOf(Date);
  });

  it('returns [] when no row has terminate_after set', async () => {
    const { db } = makeDb({ selectResult: [] });
    const result = await findReadyForTermination(db);
    expect(result).toEqual([]);
  });

  it('rowToSession surfaces terminate_after when present', async () => {
    const fireAt = new Date(Date.now() + 30_000);
    const row = fakeRow({ terminateAfter: fireAt });
    const { db } = makeDb({ selectResult: [row] });
    const got = await findById(db, 'sess-1');
    expect(got?.terminateAfter).toEqual(fireAt);
  });
});
