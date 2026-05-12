import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks BEFORE importing the module under test — the module's
// top-level `import` of stalwart-jmap/client resolves once and we need
// the mock in place at that resolution time.
vi.mock('../../stalwart-jmap/client.js', () => ({
  findMailboxByEmail: vi.fn(),
  createMailbox: vi.fn(),
  getJmapSession: vi.fn(),
}));

import {
  findMailboxByEmail,
  createMailbox,
  getJmapSession,
} from '../../stalwart-jmap/client.js';
import { ensureStalwartPrincipals } from './ensure-stalwart-principals.js';

const findMock = findMailboxByEmail as unknown as ReturnType<typeof vi.fn>;
const createMock = createMailbox as unknown as ReturnType<typeof vi.fn>;
const sessionMock = getJmapSession as unknown as ReturnType<typeof vi.fn>;

function makeApp(dbRows: Array<{
  id: string;
  fullAddress: string;
  stalwartPrincipalId: string | null;
  displayName: string | null;
  quotaMb: number;
}>) {
  const selected: typeof dbRows = [];
  const updateCalls: Array<{ id: string; stalwartPrincipalId: string }> = [];
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(dbRows),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((patch: { stalwartPrincipalId: string }) => ({
          where: vi.fn(() => {
            updateCalls.push({ id: 'captured-by-eq', ...patch });
            return Promise.resolve();
          }),
        })),
      })),
    },
    _selected: selected,
    _updateCalls: updateCalls,
  } as never;
}

describe('ensureStalwartPrincipals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.mockResolvedValue({
      primaryAccounts: { 'urn:ietf:params:jmap:principals': 'acct-principals' },
    });
  });

  it('reports existing for principals already in Stalwart', async () => {
    findMock.mockResolvedValue({ id: 'stw-1', type: 'individual', name: 'a@example.com', emails: ['a@example.com'] });
    const app = makeApp([]);
    const result = await ensureStalwartPrincipals({ app, addresses: ['a@example.com'] });
    expect(result.outcomes).toEqual([{ status: 'existing', address: 'a@example.com' }]);
    expect(result.recreated).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('recreates principal when missing in Stalwart but DB row present', async () => {
    findMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 'stw-recreated', type: 'individual', name: 'b@example.com', emails: ['b@example.com'] });
    const app = makeApp([{
      id: 'mb-1',
      fullAddress: 'b@example.com',
      stalwartPrincipalId: null,
      displayName: 'Bob',
      quotaMb: 1024,
    }]);
    const result = await ensureStalwartPrincipals({ app, addresses: ['b@example.com'] });
    expect(result.recreated).toBe(1);
    expect(result.outcomes[0]).toEqual({
      status: 'recreated',
      address: 'b@example.com',
      stalwartPrincipalId: 'stw-recreated',
    });
    expect(createMock).toHaveBeenCalledOnce();
    const callArgs = createMock.mock.calls[0]![0] as { input: { quota?: { storage: number } } };
    // Quota: 1024 MB → 1024 * 1024 * 1024 bytes.
    expect(callArgs.input.quota?.storage).toBe(1073741824);
  });

  it('omits quota when DB row has quotaMb=0 (unlimited)', async () => {
    findMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 'stw-recreated', type: 'individual', name: 'c@example.com', emails: ['c@example.com'] });
    const app = makeApp([{
      id: 'mb-2',
      fullAddress: 'c@example.com',
      stalwartPrincipalId: null,
      displayName: null,
      quotaMb: 0,
    }]);
    const result = await ensureStalwartPrincipals({ app, addresses: ['c@example.com'] });
    expect(result.recreated).toBe(1);
    const callArgs = createMock.mock.calls[0]![0] as { input: { quota?: unknown } };
    expect(callArgs.input.quota).toBeUndefined();
  });

  it('returns failed with MAILBOX_ROW_MISSING when both Stalwart AND DB are missing', async () => {
    findMock.mockResolvedValue(null);
    const app = makeApp([]); // no DB rows
    const result = await ensureStalwartPrincipals({ app, addresses: ['nope@example.com'] });
    expect(result.recreated).toBe(0);
    expect(result.outcomes[0]?.status).toBe('failed');
    if (result.outcomes[0]?.status === 'failed') {
      expect(result.outcomes[0].reason).toContain('MAILBOX_ROW_MISSING');
      expect(result.outcomes[0].reason).toContain('config-tables');
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it('throws STALWART_UNAVAILABLE if JMAP session fails', async () => {
    sessionMock.mockRejectedValue(new Error('network down'));
    const app = makeApp([]);
    try {
      await ensureStalwartPrincipals({ app, addresses: ['a@example.com'] });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      expect(e.code).toBe('STALWART_UNAVAILABLE');
      expect(e.message).toMatch(/network down/);
    }
  });

  it('handles mixed batch: existing + recreate + failed', async () => {
    findMock.mockImplementation(async ({ email }: { email: string }) => {
      if (email === 'exists@example.com') {
        return { id: 'stw-exists', type: 'individual', name: email, emails: [email] };
      }
      return null;
    });
    createMock.mockResolvedValue({ id: 'stw-new', type: 'individual', name: 'recreate@example.com', emails: ['recreate@example.com'] });
    const app = makeApp([{
      id: 'mb-r',
      fullAddress: 'recreate@example.com',
      stalwartPrincipalId: null,
      displayName: null,
      quotaMb: 512,
    }]);
    const result = await ensureStalwartPrincipals({
      app,
      addresses: ['exists@example.com', 'recreate@example.com', 'missing@example.com'],
    });
    expect(result.recreated).toBe(1);
    expect(result.outcomes.map((o) => o.status))
      .toEqual(['existing', 'recreated', 'failed']);
  });
});
