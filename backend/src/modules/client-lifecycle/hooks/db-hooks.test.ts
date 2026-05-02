import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drizzle-orm's eq + update/delete chains in the same way the
// dispatcher tests do so we don't depend on a real DB.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ __testEq: true, col, val }),
  };
});

import { domainsStatusHook } from './db-domains.js';
import { cronjobsEnableHook } from './db-cronjobs.js';
import { mailboxesStatusHook } from './db-mailboxes.js';
import { emailAliasesEnableHook } from './db-email-aliases.js';
import { deploymentsStatusHook } from './db-deployments.js';
import { clientsStatusStampHook } from './db-clients-stamp.js';
import {
  domains, cronJobs, mailboxes, emailAliases, deployments, clients,
} from '../../../db/schema.js';
import type { HookCtx, Transition } from '../registry/index.js';

interface DbCall {
  table: 'domains' | 'cronJobs' | 'mailboxes' | 'emailAliases' | 'deployments' | 'clients';
  op: 'update' | 'delete';
  patch?: Record<string, unknown>;
  whereVal?: unknown;
}

function makeFakeDb() {
  const calls: DbCall[] = [];
  const tableOf = (t: unknown): DbCall['table'] => {
    if (t === domains) return 'domains';
    if (t === cronJobs) return 'cronJobs';
    if (t === mailboxes) return 'mailboxes';
    if (t === emailAliases) return 'emailAliases';
    if (t === deployments) return 'deployments';
    if (t === clients) return 'clients';
    throw new Error('unknown table');
  };
  return {
    db: {
      update: (t: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: async (cond: { val?: unknown }) => {
            calls.push({ table: tableOf(t), op: 'update', patch, whereVal: cond?.val });
            return [];
          },
        }),
      }),
      delete: (t: unknown) => ({
        where: async (cond: { val?: unknown }) => {
          calls.push({ table: tableOf(t), op: 'delete', whereVal: cond?.val });
          return [];
        },
      }),
    },
    calls,
  };
}

function ctx(transition: Transition, clientId = 'c1'): HookCtx {
  // Minimal HookCtx — k8s isn't used by DB hooks.
  return {
    db: {} as never,
    k8s: {} as never,
    clientId,
    namespace: 'client-test',
    transitionId: 't1',
    transition,
    attempt: 1,
  };
}

describe('domains-status hook', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fake = makeFakeDb(); });

  it('flips to active on active/restored', async () => {
    for (const t of ['active', 'restored'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      const r = await domainsStatusHook.run(c);
      expect(r.status).toBe('ok');
      expect(fake.calls.at(-1)).toMatchObject({ table: 'domains', patch: { status: 'active' } });
    }
  });

  it('flips to suspended on suspended/archived', async () => {
    for (const t of ['suspended', 'archived'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      await domainsStatusHook.run(c);
      expect(fake.calls.at(-1)).toMatchObject({ table: 'domains', patch: { status: 'suspended' } });
    }
  });
});

describe('cronjobs-enable hook', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fake = makeFakeDb(); });

  it('enables on active/restored', async () => {
    for (const t of ['active', 'restored'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      await cronjobsEnableHook.run(c);
      expect(fake.calls.at(-1)).toMatchObject({ table: 'cronJobs', patch: { enabled: 1 } });
    }
  });

  it('disables on suspended/archived', async () => {
    for (const t of ['suspended', 'archived'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      await cronjobsEnableHook.run(c);
      expect(fake.calls.at(-1)).toMatchObject({ table: 'cronJobs', patch: { enabled: 0 } });
    }
  });
});

describe('mailboxes-status hook', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fake = makeFakeDb(); });

  it('sets active on active/restored', async () => {
    for (const t of ['active', 'restored'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      await mailboxesStatusHook.run(c);
      expect(fake.calls.at(-1)).toMatchObject({ op: 'update', patch: { status: 'active' } });
    }
  });

  it('sets disabled on suspended', async () => {
    const c = { ...ctx('suspended'), db: fake.db as never };
    await mailboxesStatusHook.run(c);
    expect(fake.calls.at(-1)).toMatchObject({ op: 'update', patch: { status: 'disabled' } });
  });

  it('DELETEs on archived', async () => {
    const c = { ...ctx('archived'), db: fake.db as never };
    const r = await mailboxesStatusHook.run(c);
    expect(r.status).toBe('ok');
    expect(fake.calls.at(-1)).toMatchObject({ op: 'delete', table: 'mailboxes' });
  });
});

describe('email-aliases-enable hook', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fake = makeFakeDb(); });

  it('enables on active/restored', async () => {
    for (const t of ['active', 'restored'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      await emailAliasesEnableHook.run(c);
      expect(fake.calls.at(-1)).toMatchObject({ op: 'update', patch: { enabled: 1 } });
    }
  });

  it('disables on suspended', async () => {
    const c = { ...ctx('suspended'), db: fake.db as never };
    await emailAliasesEnableHook.run(c);
    expect(fake.calls.at(-1)).toMatchObject({ op: 'update', patch: { enabled: 0 } });
  });

  it('DELETEs on archived', async () => {
    const c = { ...ctx('archived'), db: fake.db as never };
    await emailAliasesEnableHook.run(c);
    expect(fake.calls.at(-1)).toMatchObject({ op: 'delete', table: 'emailAliases' });
  });
});

describe('deployments-status hook', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fake = makeFakeDb(); });

  it('noops on active/restored/deleted', async () => {
    for (const t of ['active', 'restored', 'deleted'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      const r = await deploymentsStatusHook.run(c);
      expect(r.status).toBe('noop');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('sets stopped on suspended/archived', async () => {
    for (const t of ['suspended', 'archived'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      const r = await deploymentsStatusHook.run(c);
      expect(r.status).toBe('ok');
      expect(fake.calls.at(-1)).toMatchObject({ table: 'deployments', patch: { status: 'stopped' } });
    }
  });
});

describe('Phase 3 registry topology', () => {
  // Regression test for the CRITICAL caught in code review: the
  // clients-status-stamp hook's `after` list named hooks that don't
  // subscribe to `deleted`, which made topoSortForTransition('deleted')
  // throw UNKNOWN_AFTER. The fix excludes `deleted` from this hook's
  // transitions; this test enforces that.
  it('all transitions topo-sort without throwing once Phase 3 hooks are registered', async () => {
    const { _resetRegistryForTests, topoSortForTransition } = await import('../registry/index.js');
    const { registerAllLifecycleHooks } = await import('./index.js');
    _resetRegistryForTests();
    registerAllLifecycleHooks();
    for (const t of ['active', 'suspended', 'archived', 'restored', 'deleted'] as const) {
      // Should not throw — each transition's `after` graph must close
      // within the subset of hooks subscribed to it.
      expect(() => topoSortForTransition(t)).not.toThrow();
    }
    _resetRegistryForTests();
  });
});

describe('clients-status-stamp hook', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fake = makeFakeDb(); });

  it('noops on deleted', async () => {
    const c = { ...ctx('deleted'), db: fake.db as never };
    const r = await clientsStatusStampHook.run(c);
    expect(r.status).toBe('noop');
    expect(fake.calls).toHaveLength(0);
  });

  it('clears timestamps + sets status=active on active/restored', async () => {
    for (const t of ['active', 'restored'] as const) {
      const c = { ...ctx(t), db: fake.db as never };
      await clientsStatusStampHook.run(c);
      expect(fake.calls.at(-1)).toMatchObject({
        table: 'clients',
        patch: { status: 'active', suspendedAt: null, archivedAt: null },
      });
    }
  });

  it('sets status=suspended + suspendedAt on suspended', async () => {
    const c = { ...ctx('suspended'), db: fake.db as never };
    await clientsStatusStampHook.run(c);
    const last = fake.calls.at(-1)!;
    expect(last.table).toBe('clients');
    expect((last.patch as { status: string }).status).toBe('suspended');
    expect((last.patch as { suspendedAt: unknown }).suspendedAt).toBeInstanceOf(Date);
  });

  it('sets status=archived + archivedAt on archived', async () => {
    const c = { ...ctx('archived'), db: fake.db as never };
    await clientsStatusStampHook.run(c);
    const last = fake.calls.at(-1)!;
    expect(last.table).toBe('clients');
    expect((last.patch as { status: string }).status).toBe('archived');
    expect((last.patch as { archivedAt: unknown }).archivedAt).toBeInstanceOf(Date);
  });
});
