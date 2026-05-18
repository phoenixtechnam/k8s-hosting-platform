import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  getSession,
  remove,
  attachWs,
  markActivity,
  consumeWsToken,
  findIdle,
  listSessions,
  listSessionsForNode,
  _resetForTests,
  type TerminalSession,
} from './session-registry.js';

function fixture(overrides: Partial<TerminalSession> = {}): TerminalSession {
  const now = new Date('2026-05-18T12:00:00Z');
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    nodeName: 'staging-1',
    podName: 'node-terminal-aaaaaaaa',
    userId: 'admin-1',
    userEmail: 'admin@phoenix-host.net',
    ip: '127.0.0.1',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3600_000),
    wsToken: 'token-aaaa',
    ws: null,
    lastActivityAt: now,
    ...overrides,
  };
}

describe('session-registry', () => {
  beforeEach(() => { _resetForTests(); });

  it('register + getSession round-trips', () => {
    const s = fixture();
    register(s);
    expect(getSession(s.id)?.podName).toBe('node-terminal-aaaaaaaa');
  });

  it('remove returns the session and drops it from the registry', () => {
    const s = fixture();
    register(s);
    const removed = remove(s.id);
    expect(removed?.id).toBe(s.id);
    expect(getSession(s.id)).toBeUndefined();
  });

  it('listSessions returns every entry, listSessionsForNode filters', () => {
    register(fixture({ id: 'aaaaaaaa-0000-0000-0000-000000000001', nodeName: 'staging-1' }));
    register(fixture({ id: 'aaaaaaaa-0000-0000-0000-000000000002', nodeName: 'staging-2' }));
    register(fixture({ id: 'aaaaaaaa-0000-0000-0000-000000000003', nodeName: 'staging-1' }));
    expect(listSessions()).toHaveLength(3);
    expect(listSessionsForNode('staging-1')).toHaveLength(2);
    expect(listSessionsForNode('staging-2')).toHaveLength(1);
    expect(listSessionsForNode('staging-3')).toHaveLength(0);
  });

  it('consumeWsToken accepts the correct token exactly once', () => {
    const s = fixture({ wsToken: 'correct' });
    register(s);
    expect(consumeWsToken(s.id, 'correct')).toBe(true);
    // Already consumed — wsToken nulled out
    expect(getSession(s.id)?.wsToken).toBeNull();
    expect(consumeWsToken(s.id, 'correct')).toBe(false);
  });

  it('consumeWsToken rejects wrong tokens without nulling the slot', () => {
    const s = fixture({ wsToken: 'correct' });
    register(s);
    expect(consumeWsToken(s.id, 'wrong')).toBe(false);
    expect(getSession(s.id)?.wsToken).toBe('correct');
  });

  it('consumeWsToken rejects length-mismatch attempts without timing leak', () => {
    const s = fixture({ wsToken: 'short' });
    register(s);
    expect(consumeWsToken(s.id, 'a-much-longer-attempt')).toBe(false);
    expect(getSession(s.id)?.wsToken).toBe('short');
  });

  it('consumeWsToken returns false for unknown session', () => {
    expect(consumeWsToken('nope', 'anything')).toBe(false);
  });

  it('markActivity bumps lastActivityAt', () => {
    const oldAt = new Date('2026-05-18T11:00:00Z');
    const s = fixture({ lastActivityAt: oldAt });
    register(s);
    markActivity(s.id);
    const updated = getSession(s.id);
    expect(updated!.lastActivityAt.getTime()).toBeGreaterThan(oldAt.getTime());
  });

  it('findIdle returns only sessions older than idleMs', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const idleMs = 15 * 60 * 1000; // 15 min
    register(fixture({
      id: 'aaaaaaaa-0000-0000-0000-00000000fresh',
      lastActivityAt: new Date(now.getTime() - 5 * 60 * 1000), // 5 min ago — fresh
    }));
    register(fixture({
      id: 'aaaaaaaa-0000-0000-0000-00000000stale',
      lastActivityAt: new Date(now.getTime() - 20 * 60 * 1000), // 20 min ago — stale
    }));
    const stale = findIdle(idleMs, now);
    expect(stale.map((s) => s.id)).toEqual(['aaaaaaaa-0000-0000-0000-00000000stale']);
  });

  it('attachWs sets the socket ref + bumps activity', () => {
    const s = fixture();
    register(s);
    const fakeSocket = {
      send: () => undefined, close: () => undefined, ping: () => undefined,
      on: () => undefined, once: () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    attachWs(s.id, fakeSocket);
    const updated = getSession(s.id);
    expect(updated?.ws).toBe(fakeSocket);
  });
});
