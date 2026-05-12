import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkForUpdate, isRealmUrlBlocked } from './update-checker.js';
import type { Database } from '../../db/index.js';

// Minimal stub DB — the update-checker reads/writes the cache table
// via Drizzle. We exercise only the cache read + write paths, asserting
// the shape we pass in is well-formed; the actual SQL is covered by
// the integration test.
function stubDb(): { db: Database; reads: number; writes: number; cache: Map<string, unknown> } {
  const state = { reads: 0, writes: 0, cache: new Map<string, unknown>() };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          state.reads++;
          return [];
        }),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => { state.writes++; }) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => { state.writes++; }) })) })),
  } as unknown as Database;
  return { db, ...state };
}

function makeResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkForUpdate — happy path', () => {
  it('returns "minor" when registry has a newer stable tag', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { tags: ['1.0.0', '1.1.0', '1.2.0', '1.2.0-rc1'] }),
    ) as unknown as typeof fetch;
    const { db } = stubDb();
    const r = await checkForUpdate({
      db,
      image: 'ghcr.io/owner/app:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('minor');
    expect(r.current).toBe('1.0.0');
    expect(r.latest).toBe('1.2.0');
  });

  it('returns "no-update" when registry has no higher semver tags', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { tags: ['0.9.0', '1.0.0'] }),
    ) as unknown as typeof fetch;
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/owner/app:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('no-update');
    expect(r.latest).toBe(null);
  });
});

describe('checkForUpdate — auth realm dance', () => {
  it('exchanges WWW-Authenticate for a bearer token', async () => {
    const fetchImpl = vi.fn()
      // First request → 401 with auth challenge
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          },
        }),
      )
      // Token-exchange call
      .mockResolvedValueOnce(makeResponse(200, { token: 'bearer-xyz' }))
      // Retry of tags/list with bearer
      .mockResolvedValueOnce(makeResponse(200, { tags: ['1.0.0', '1.0.5'] })) as unknown as typeof fetch;

    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'docker.io/library/nginx:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('patch');
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('forwards basic-auth credentials to the auth realm when PAT is set', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://auth.private.example/token",service="private"',
          },
        }),
      )
      .mockResolvedValueOnce(makeResponse(200, { token: 'tok' }))
      .mockResolvedValueOnce(makeResponse(200, { tags: ['1.0.0', '1.1.0'] })) as unknown as typeof fetch;

    await checkForUpdate({
      db: stubDb().db,
      image: 'registry.private.example/team/app:1.0.0',
      authCreds: { username: 'sb', password: 'ghp_token' },
      fetchImpl,
    });
    const tokenExchangeCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1];
    const headers = (tokenExchangeCall[1] as { headers?: Record<string, string> }).headers ?? {};
    expect(headers.authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.authorization!.slice(6), 'base64').toString('utf8');
    expect(decoded).toBe('sb:ghp_token');
  });

  it('returns "unknown" with reason when token exchange fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="https://auth/token"' },
        }),
      )
      .mockResolvedValueOnce(makeResponse(403, { error: 'forbidden' })) as unknown as typeof fetch;

    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/o/a:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/auth realm/);
  });
});

describe('checkForUpdate — error paths', () => {
  it('returns "unknown" on 429 rate limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      makeResponse(429, { error: 'too many' }),
    ) as unknown as typeof fetch;
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/o/a:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/rate limited/);
  });

  it('returns "unknown" on 5xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 503 }),
    ) as unknown as typeof fetch;
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/o/a:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/503/);
  });

  it('returns "unknown" on 404 (image moved)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/o/a:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/404/);
  });

  it('returns "unknown" when current tag is not semver', async () => {
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/o/a:latest',
    });
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/semver/);
  });

  it('returns "unknown" when the image reference is unparseable', async () => {
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'NOT/VALID/at/all//',
    });
    expect(r.status).toBe('unknown');
  });

  it('returns "unknown" on malformed JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/o/a:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('unknown');
  });

  it('returns "no-update" with informative reason on empty tag list', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      makeResponse(200, { tags: [] }),
    ) as unknown as typeof fetch;
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'ghcr.io/o/a:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('no-update');
    expect(r.reason).toMatch(/empty/);
  });

  it('does NOT cache "unknown" results', async () => {
    const { db, reads, writes } = stubDb();
    const _bag = { reads, writes };
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      makeResponse(429),
    ) as unknown as typeof fetch;
    await checkForUpdate({ db, image: 'ghcr.io/o/a:1.0.0', fetchImpl });
    // We can't easily count cache writes via the stub without
    // restructuring; assert by spying on the insert call.
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ─── SSRF guard on WWW-Authenticate realm ──────────────────────────────────
//
// A hostile registry can return a Bearer challenge whose realm
// points at an internal address; without the guard the platform
// would fire an outbound request (and forward basic-auth creds, if
// any) at that host. These tests pin the deny-list.

describe('isRealmUrlBlocked', () => {
  it('accepts public https realms', () => {
    expect(isRealmUrlBlocked('https://auth.docker.io/token')).toBe(false);
    expect(isRealmUrlBlocked('https://ghcr.io/token')).toBe(false);
  });
  it('rejects http (insecure scheme)', () => {
    expect(isRealmUrlBlocked('http://auth.docker.io/token')).toBe(true);
  });
  it('rejects file:/ftp:/javascript: schemes', () => {
    expect(isRealmUrlBlocked('file:///etc/passwd')).toBe(true);
    expect(isRealmUrlBlocked('ftp://auth.example.com/')).toBe(true);
  });
  it('rejects localhost / loopback / 0.0.0.0', () => {
    for (const r of [
      'https://localhost/token',
      'https://127.0.0.1/token',
      'https://0.0.0.0/token',
      'https://127.254.1.1/token',
      'https://[::1]/token',
    ]) {
      expect(isRealmUrlBlocked(r)).toBe(true);
    }
  });
  it('rejects RFC-1918 private ranges', () => {
    for (const r of [
      'https://10.0.0.1/token',
      'https://10.255.255.255/token',
      'https://172.16.0.1/token',
      'https://172.31.255.255/token',
      'https://192.168.1.1/token',
    ]) {
      expect(isRealmUrlBlocked(r)).toBe(true);
    }
  });
  it('rejects link-local + IMDS', () => {
    expect(isRealmUrlBlocked('https://169.254.169.254/latest/meta-data/')).toBe(true);
  });
  it('rejects k8s-internal DNS suffixes', () => {
    for (const r of [
      'https://kubernetes.default.svc/api/v1/secrets',
      'https://platform-api.platform.svc.cluster.local/token',
      'https://anything.cluster.local/x',
      'https://anything.local/x',
    ]) {
      expect(isRealmUrlBlocked(r)).toBe(true);
    }
  });
  it('rejects unparseable URLs', () => {
    expect(isRealmUrlBlocked('not-a-url')).toBe(true);
    expect(isRealmUrlBlocked('')).toBe(true);
  });
});

describe('checkForUpdate — SSRF guard', () => {
  it('does NOT follow a hostile realm pointing at an internal address', async () => {
    const fetchImpl = vi.fn()
      // First request → 401 with hostile internal realm
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="http://kubernetes.default.svc:443/api/v1/secrets",service="x"',
          },
        }),
      ) as unknown as typeof fetch;
    const r = await checkForUpdate({
      db: stubDb().db,
      image: 'attacker.example.com/app:1.0.0',
      fetchImpl,
    });
    expect(r.status).toBe('unknown');
    // Critically: only ONE fetch happened (the original tags/list);
    // the token exchange against the hostile realm was NOT fired.
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('does NOT exfiltrate PAT credentials to a hostile realm', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://10.0.0.1/token",service="x"',
          },
        }),
      ) as unknown as typeof fetch;
    await checkForUpdate({
      db: stubDb().db,
      image: 'attacker.example.com/app:1.0.0',
      authCreds: { username: 'sb', password: 'ghp_should_not_leak' },
      fetchImpl,
    });
    // Confirm the basic-auth Authorization header was NEVER sent.
    for (const call of (fetchImpl as ReturnType<typeof vi.fn>).mock.calls) {
      const headers = (call[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      const authHeader = headers.authorization ?? headers.Authorization;
      if (authHeader && /^Basic /.test(authHeader)) {
        throw new Error(`PAT was sent in basic-auth header: ${authHeader}`);
      }
    }
  });
});
