import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bulwarkSettingsPurgeHook } from './bulwark-settings-purge.js';
import type { HookCtx } from '../registry/index.js';

function makeCtx(overrides: Partial<HookCtx> = {}): HookCtx {
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([
      { fullAddress: 'alice@example.com' },
      { fullAddress: 'bob@example.com' },
    ]),
  } as unknown as HookCtx['db'];
  return {
    db,
    k8s: {} as never,
    clientId: 'c1',
    namespace: 'tenant-c1',
    transitionId: 't1',
    transition: 'archived',
    attempt: 1,
    log: vi.fn(),
    ...overrides,
  } as HookCtx;
}

describe('bulwark-settings-purge', () => {
  const ORIGINAL_ENV = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LIFECYCLE_HOOK_BULWARK_SETTINGS_PURGE;
    process.env.LIFECYCLE_HOOK_BULWARK_ADMIN_TOKEN = 'test-token';
    process.env.LIFECYCLE_HOOK_BULWARK_JMAP_URL = 'https://stalwart.example.com';
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, status: 'unlinked' }),
      text: () => Promise.resolve('{"ok":true,"status":"unlinked"}'),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('returns noop for non-archived transitions', async () => {
    const result = await bulwarkSettingsPurgeHook.run(makeCtx({ transition: 'active' }));
    expect(result.status).toBe('noop');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns noop when kill-switch is active', async () => {
    process.env.LIFECYCLE_HOOK_BULWARK_SETTINGS_PURGE = 'disable';
    const result = await bulwarkSettingsPurgeHook.run(makeCtx());
    expect(result.status).toBe('noop');
    expect(result.detail).toMatch(/kill-switch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns noop with helpful message when ADMIN_TOKEN unset (Roundcube-only stack)', async () => {
    delete process.env.LIFECYCLE_HOOK_BULWARK_ADMIN_TOKEN;
    const result = await bulwarkSettingsPurgeHook.run(makeCtx());
    expect(result.status).toBe('noop');
    expect(result.detail).toMatch(/LIFECYCLE_HOOK_BULWARK_ADMIN_TOKEN unset/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns noop when client has no mailboxes', async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as HookCtx['db'];
    const result = await bulwarkSettingsPurgeHook.run(makeCtx({ db }));
    expect(result.status).toBe('noop');
    expect(result.detail).toMatch(/no mailboxes/);
  });

  it('calls DELETE /__impersonator/settings for every mailbox with correct payload', async () => {
    const result = await bulwarkSettingsPurgeHook.run(makeCtx());
    expect(result.status).toBe('ok');
    expect(result.detail).toMatch(/2 unlinked/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bulwark-impersonator.mail.svc.cluster.local/__impersonator/settings',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-admin-token': 'test-token',
        }),
      }),
    );
    const calls = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).username).sort();
    expect(calls).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('treats already_absent as success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, status: 'already_absent' }),
      text: () => Promise.resolve('{"ok":true,"status":"already_absent"}'),
    });
    const result = await bulwarkSettingsPurgeHook.run(makeCtx());
    expect(result.status).toBe('ok');
    expect(result.detail).toMatch(/0 unlinked, 2 already absent/);
  });

  it('returns failed with envelope when one or more accounts fail', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, status: 'unlinked' }),
        text: () => Promise.resolve('{"ok":true,"status":"unlinked"}'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'unlink failed' }),
        text: () => Promise.resolve('{"error":"unlink failed"}'),
      });
    const result = await bulwarkSettingsPurgeHook.run(makeCtx());
    expect(result.status).toBe('failed');
    expect(result.envelope?.title).toMatch(/Failed to purge/);
    expect(result.envelope?.detail).toMatch(/bob@example\.com/);
    expect(result.envelope?.remediation?.[0]).toMatch(/impersonator pod/);
  });

  it('returns failed on transport error', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const result = await bulwarkSettingsPurgeHook.run(makeCtx());
    expect(result.status).toBe('failed');
    expect(result.envelope?.detail).toMatch(/connection refused/);
  });

  it('blocking=continue so failures do not abort the transition', () => {
    expect(bulwarkSettingsPurgeHook.blocking).toBe('continue');
  });

  it('runs only on archived transition', () => {
    expect(bulwarkSettingsPurgeHook.transitions).toEqual(['archived']);
  });

  it('order=210 (before mailboxes-status which is 220)', () => {
    expect(bulwarkSettingsPurgeHook.order).toBe(210);
  });
});
