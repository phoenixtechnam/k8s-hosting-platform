/**
 * Unit tests for proxy-networks-reconciler.
 *
 * Covers the pure helper (proxyNetworksMatches), the cluster-node
 * enumeration (listServerNodeIps), and the tick orchestration (mocked
 * fetch + stub CoreV1Api) so we exercise the security-critical branches
 * where the reconciler refuses to push an empty trust set and surfaces
 * JMAP /set partial-failures.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  listServerNodeIps,
  proxyNetworksMatches,
  runProxyNetworksReconcilerTick,
} from './proxy-networks-reconciler.js';

describe('proxyNetworksMatches', () => {
  it('returns true when both sets are empty', () => {
    expect(proxyNetworksMatches({}, {})).toBe(true);
    expect(proxyNetworksMatches(null, {})).toBe(true);
    expect(proxyNetworksMatches(undefined, {})).toBe(true);
  });
  it('returns true for the same set regardless of insertion order', () => {
    expect(
      proxyNetworksMatches(
        { '10.0.0.1': true, '10.0.0.2': true },
        { '10.0.0.2': true, '10.0.0.1': true },
      ),
    ).toBe(true);
  });
  it('canonicalises /32 to bare IP — Stalwart strips /32 on storage so the comparison must not flap', () => {
    expect(
      proxyNetworksMatches({ '10.0.0.1': true }, { '10.0.0.1/32': true }),
    ).toBe(true);
    expect(
      proxyNetworksMatches({ '10.0.0.1/32': true }, { '10.0.0.1': true }),
    ).toBe(true);
  });
  it('preserves wider CIDR prefixes (only /32 is normalised)', () => {
    expect(
      proxyNetworksMatches({ '10.42.0.0/16': true }, { '10.42.0.0/16': true }),
    ).toBe(true);
    expect(
      proxyNetworksMatches({ '10.42.0.0/16': true }, { '10.42.0.0': true }),
    ).toBe(false);
  });
  it('returns false when sizes differ', () => {
    expect(
      proxyNetworksMatches({ '10.0.0.1': true }, { '10.0.0.1': true, '10.0.0.2': true }),
    ).toBe(false);
  });
  it('returns false when keys differ', () => {
    expect(
      proxyNetworksMatches({ '10.0.0.1': true }, { '10.0.0.2': true }),
    ).toBe(false);
  });
  it('ignores keys whose value is not exactly true (defensive)', () => {
    expect(
      proxyNetworksMatches(
        // Cast through `as unknown` because we're testing defensive narrowing
        // of the wire shape where a buggy peer could send `false`.
        { '10.0.0.1': false as unknown as true, '10.0.0.2': true },
        { '10.0.0.2': true },
      ),
    ).toBe(true);
  });
});

describe('listServerNodeIps', () => {
  function makeCore(items: unknown[]) {
    return { listNode: async () => ({ items }) } as unknown as Parameters<typeof listServerNodeIps>[0];
  }

  it('returns InternalIP for nodes labeled node-role=server', async () => {
    const core = makeCore([
      {
        metadata: {
          name: 's1',
          labels: {
            'platform.phoenix-host.net/node-role': 'server',
            'kubernetes.io/hostname': 's1',
          },
        },
        status: {
          addresses: [
            { type: 'ExternalIP', address: '203.0.113.10' },
            { type: 'InternalIP', address: '10.10.0.10' },
          ],
        },
      },
    ]);
    const out = await listServerNodeIps(core);
    expect(out).toEqual([{ hostname: 's1', ip: '10.10.0.10' }]);
  });

  it('skips non-server-role nodes', async () => {
    const core = makeCore([
      {
        metadata: {
          name: 'w1',
          labels: { 'platform.phoenix-host.net/node-role': 'worker' },
        },
        status: { addresses: [{ type: 'InternalIP', address: '10.10.0.20' }] },
      },
    ]);
    expect(await listServerNodeIps(core)).toEqual([]);
  });

  it('returns sorted-by-hostname order (stable diffs)', async () => {
    const core = makeCore([
      {
        metadata: {
          name: 's3',
          labels: { 'platform.phoenix-host.net/node-role': 'server', 'kubernetes.io/hostname': 's3' },
        },
        status: { addresses: [{ type: 'InternalIP', address: '10.0.0.3' }] },
      },
      {
        metadata: {
          name: 's1',
          labels: { 'platform.phoenix-host.net/node-role': 'server', 'kubernetes.io/hostname': 's1' },
        },
        status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
      },
    ]);
    const ips = (await listServerNodeIps(core)).map((n) => n.hostname);
    expect(ips).toEqual(['s1', 's3']);
  });

  it('skips nodes without an InternalIP', async () => {
    const core = makeCore([
      {
        metadata: { name: 's1', labels: { 'platform.phoenix-host.net/node-role': 'server' } },
        status: { addresses: [{ type: 'ExternalIP', address: '203.0.113.1' }] },
      },
    ]);
    expect(await listServerNodeIps(core)).toEqual([]);
  });

  it('rejects bogus loopback/unspecified InternalIPs (defense vs misconfigured kubelet)', async () => {
    const core = makeCore(
      ['127.0.0.1', '0.0.0.0', '::1'].map((ip, i) => ({
        metadata: {
          name: `n${i}`,
          labels: { 'platform.phoenix-host.net/node-role': 'server', 'kubernetes.io/hostname': `n${i}` },
        },
        status: { addresses: [{ type: 'InternalIP', address: ip }] },
      })),
    );
    expect(await listServerNodeIps(core)).toEqual([]);
  });

  it('drops duplicate hostnames rather than silently overwriting', async () => {
    const core = makeCore([
      {
        metadata: {
          name: 'duplicate',
          labels: { 'platform.phoenix-host.net/node-role': 'server', 'kubernetes.io/hostname': 'dup' },
        },
        status: { addresses: [{ type: 'InternalIP', address: '10.0.0.5' }] },
      },
      {
        metadata: {
          name: 'duplicate2',
          labels: { 'platform.phoenix-host.net/node-role': 'server', 'kubernetes.io/hostname': 'dup' },
        },
        status: { addresses: [{ type: 'InternalIP', address: '10.0.0.6' }] },
      },
    ]);
    const out = await listServerNodeIps(core);
    expect(out).toHaveLength(1);
    expect(out[0].ip).toBe('10.0.0.5');
  });

  it('passes server-role labelSelector to the k8s API (push-down filter)', async () => {
    let receivedOpts: unknown = null;
    const core = {
      listNode: async (opts: unknown) => {
        receivedOpts = opts;
        return { items: [] };
      },
    } as unknown as Parameters<typeof listServerNodeIps>[0];
    await listServerNodeIps(core);
    expect((receivedOpts as { labelSelector?: string }).labelSelector).toBe(
      'platform.phoenix-host.net/node-role=server',
    );
  });
});

describe('runProxyNetworksReconcilerTick', () => {
  const env = {
    STALWART_ADMIN_USER: 'admin',
    STALWART_ADMIN_PASSWORD: 'pw',
  } as NodeJS.ProcessEnv;

  let calls: Array<{ url: string; body: unknown }> = [];

  /**
   * Pre-streamline tests intercepted `globalThis.fetch`. The reconciler
   * now runs JMAP calls via `kubectl exec curl` inside the Stalwart pod
   * (Stalwart 0.16's HTTP listener PROXY-v2-sniffs every non-loopback
   * connection — see jmapPost() in the reconciler). For tests we inject
   * a stub transport via `deps.jmapTransport`, which bypasses pod-
   * discovery + exec entirely. We keep the `mockFetch(handler)` shape
   * + a `tick()` helper to minimise the per-test diff.
   */
  type JmapHandler = (req: { url: string; body: unknown }) => unknown;
  let currentHandler: JmapHandler | null = null;
  function mockFetch(handler: JmapHandler) {
    currentHandler = handler;
  }
  function buildTransport():
    (auth: string, body: unknown) => Promise<{
      methodResponses: ReadonlyArray<[string, Record<string, unknown>, string]>;
    }>
  {
    return async (_auth, body) => {
      const url = 'mock://stalwart-mgmt:8080/jmap/';
      calls.push({ url, body });
      if (!currentHandler) throw new Error('test forgot to call mockFetch() before tick()');
      const result = currentHandler({ url, body }) as {
        methodResponses: ReadonlyArray<[string, Record<string, unknown>, string]>;
      };
      return result;
    };
  }

  beforeEach(() => {
    calls = [];
    currentHandler = null;
  });

  function makeCore(items: unknown[]) {
    return {
      listNode: async () => ({ items }),
    } as unknown as Parameters<typeof runProxyNetworksReconcilerTick>[0]['core'];
  }

  it('skips the tick when the cluster has zero server-role nodes (never push empty)', async () => {
    let stalwartCalled = false;
    mockFetch(() => {
      stalwartCalled = true;
      return { methodResponses: [['error', { type: 'serverFail' }, 'c0']] };
    });

    const warns: unknown[] = [];
    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([]),
      env,
      logger: {
        warn: (...a: unknown[]) => warns.push(a),
        info: () => undefined,
      },
    });

    expect(stalwartCalled).toBe(false);
    expect(JSON.stringify(warns)).toMatch(/No server-role nodes/);
  });

  it('skips x:SystemSettings/set when proxyTrustedNetworks already empty (Phase 11 streamline: global trust IS empty)', async () => {
    let setCalled = false;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              {
                // Phase 11 streamline (2026-05-15): global trust is now
                // empty; per-listener overrides own the trust. The
                // reconciler should NOT call SystemSettings/set when
                // current already matches the empty expected.
                list: [{
                  id: 'singleton',
                  proxyTrustedNetworks: {},
                }],
              },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:SystemSettings/set') {
        setCalled = true;
        return { methodResponses: [['x:SystemSettings/set', { updated: { singleton: {} } }, 'c0']] };
      }
      if (method === 'x:NetworkListener/get') {
        return {
          methodResponses: [['x:NetworkListener/get', {
            list: [
              { id: 'l-smtp', name: 'smtp', protocol: 'smtp', overrideProxyTrustedNetworks: { '10.0.0.1': true, '10.42.0.0/16': true, '10.43.0.0/16': true } },
              { id: 'l-http', name: 'http', protocol: 'http', overrideProxyTrustedNetworks: {} },
            ],
          }, 'c0']],
        };
      }
      // AllowedIp paths
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env,
      logger: { warn: () => undefined, info: () => undefined },
    });

    expect(setCalled).toBe(false);
  });

  it('pushes empty proxyTrustedNetworks on global when stale entries exist (Phase 11 streamline)', async () => {
    let updatedBody: Record<string, unknown> | null = null;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              {
                // Pre-streamline state: cluster CIDRs in global trust.
                // Phase 11 expects the reconciler to CLEAR them.
                list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1': true, '10.42.0.0/16': true } }],
              },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:SystemSettings/set') {
        const call = (req.body as { methodCalls: unknown[][] }).methodCalls[0];
        updatedBody = (call[1] as { update: Record<string, unknown> }).update;
        return { methodResponses: [['x:SystemSettings/set', { updated: { singleton: {} } }, 'c0']] };
      }
      if (method === 'x:NetworkListener/get') {
        return { methodResponses: [['x:NetworkListener/get', { list: [] }, 'c0']] };
      }
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
        {
          metadata: {
            name: 's2',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's2',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.2' }] },
        },
      ]),
      env,
      logger: { warn: () => undefined, info: () => undefined },
    });

    expect(updatedBody).toEqual({
      singleton: {
        proxyTrustedNetworks: {},
      },
    });
  });

  it('sets per-listener override on mail listeners only (http stays empty)', async () => {
    let listenerUpdates: Record<string, unknown> | null = null;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return { methodResponses: [['x:SystemSettings/get', { list: [{ id: 'singleton', proxyTrustedNetworks: {} }] }, 'c0']] };
      }
      if (method === 'x:NetworkListener/get') {
        return {
          methodResponses: [['x:NetworkListener/get', {
            list: [
              { id: 'l-smtp', name: 'smtp', protocol: 'smtp', overrideProxyTrustedNetworks: {} },
              { id: 'l-imap', name: 'imap', protocol: 'imap', overrideProxyTrustedNetworks: {} },
              { id: 'l-sieve', name: 'sieve', protocol: 'manageSieve', overrideProxyTrustedNetworks: {} },
              { id: 'l-pop3', name: 'pop3s', protocol: 'pop3', overrideProxyTrustedNetworks: {} },
              { id: 'l-http', name: 'http', protocol: 'http', overrideProxyTrustedNetworks: {} },
              { id: 'l-http-acme', name: 'http-acme', protocol: 'http', overrideProxyTrustedNetworks: {} },
            ],
          }, 'c0']],
        };
      }
      if (method === 'x:NetworkListener/set') {
        const call = (req.body as { methodCalls: unknown[][] }).methodCalls[0];
        listenerUpdates = (call[1] as { update: Record<string, unknown> }).update;
        return { methodResponses: [['x:NetworkListener/set', { updated: { 'l-smtp': {}, 'l-imap': {}, 'l-sieve': {}, 'l-pop3': {} } }, 'c0']] };
      }
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: { 'platform.phoenix-host.net/node-role': 'server', 'kubernetes.io/hostname': 's1' },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env,
      logger: { warn: () => undefined, info: () => undefined },
    });

    // 4 mail listeners updated with cluster CIDRs + node IPs. 2 http
    // listeners already had empty override → no update needed → not in
    // the set call.
    expect(listenerUpdates).not.toBeNull();
    const updates = listenerUpdates! as Record<string, { overrideProxyTrustedNetworks: Record<string, boolean> }>;
    expect(Object.keys(updates).sort()).toEqual(['l-imap', 'l-pop3', 'l-sieve', 'l-smtp']);
    for (const id of Object.keys(updates)) {
      expect(updates[id].overrideProxyTrustedNetworks).toEqual({
        '10.0.0.1': true,
        '10.42.0.0/16': true,
        '10.43.0.0/16': true,
      });
    }
  });

  it('creates AllowedIp entries for cluster IPs that are not already allowlisted', async () => {
    let allowedSetBody: Record<string, unknown> | null = null;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              {
                list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1': true } }],
              },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:AllowedIp/get') {
        return {
          methodResponses: [
            ['x:AllowedIp/get', { list: [] }, 'c0'],
          ],
        };
      }
      if (method === 'x:AllowedIp/set') {
        const call = (req.body as { methodCalls: unknown[][] }).methodCalls[0];
        allowedSetBody = call[1] as Record<string, unknown>;
        return { methodResponses: [['x:AllowedIp/set', { created: {} }, 'c0']] };
      }
      return { methodResponses: [[method as string, { updated: { singleton: {} } }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env,
      logger: { warn: () => undefined, info: () => undefined },
    });

    expect(allowedSetBody?.create).toEqual({
      'mail-haproxy-s1': {
        address: '10.0.0.1',
        reason: 'Cluster server node s1 (haproxy source) — exempt from rate-limit',
      },
    });
  });

  it('does NOT touch existing AllowedIp entries — ownership by address means we never destroy', async () => {
    let allowedSetCalled = false;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              { list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1': true } }] },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:AllowedIp/get') {
        return {
          methodResponses: [
            [
              'x:AllowedIp/get',
              {
                list: [
                  // An operator-added entry. Same address as our node — we
                  // should detect the match and skip creation, not destroy
                  // or update someone else's record.
                  { id: 'opaqueserverId', address: '10.0.0.1', reason: 'operator-added' },
                  // Unrelated entry — also must remain untouched.
                  { id: 'cluster-pod', address: '10.42.0.0/16', reason: 'k8s pod CIDR' },
                ],
              },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:AllowedIp/set') {
        allowedSetCalled = true;
        return { methodResponses: [['x:AllowedIp/set', {}, 'c0']] };
      }
      return { methodResponses: [[method as string, { updated: { singleton: {} } }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env,
      logger: { warn: () => undefined, info: () => undefined },
    });

    expect(allowedSetCalled).toBe(false);
  });

  it('canonicalises /32 addresses on existing AllowedIp entries (no duplicate create)', async () => {
    let allowedSetCalled = false;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              { list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1': true } }] },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:AllowedIp/get') {
        return {
          methodResponses: [
            [
              'x:AllowedIp/get',
              {
                // Existing entry stored with /32 (legacy / hand-curated).
                list: [{ id: 'X', address: '10.0.0.1/32', reason: 'legacy' }],
              },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:AllowedIp/set') {
        allowedSetCalled = true;
        return { methodResponses: [['x:AllowedIp/set', {}, 'c0']] };
      }
      return { methodResponses: [[method as string, { updated: { singleton: {} } }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env,
      logger: { warn: () => undefined, info: () => undefined },
    });

    expect(allowedSetCalled).toBe(false);
  });

  it('skips the tick when admin credentials are not configured', async () => {
    let fetchCalled = false;
    mockFetch(() => {
      fetchCalled = true;
      return {};
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env: {} as NodeJS.ProcessEnv, // no creds
      logger: { warn: () => undefined, info: () => undefined },
    });

    expect(fetchCalled).toBe(false);
  });

  it('surfaces method-level JMAP errors on SystemSettings/set (no silent drift)', async () => {
    const warns: unknown[] = [];
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        // Non-empty current → forces SystemSettings/set call because the
        // reconciler expects empty global (Phase 11 streamline).
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              { list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.99': true } }] },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:SystemSettings/set') {
        // Method-level error: Stalwart rejected the call (e.g. invalid auth scope).
        return {
          methodResponses: [['error', { type: 'forbidden', description: 'auth scope' }, 'c0']],
        };
      }
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env,
      logger: {
        warn: (...a: unknown[]) => warns.push(a),
        info: () => undefined,
      },
    });

    // The warning should propagate out so the operator can see the failure
    // — the reconciler must NOT silently log "Updated N listener(s)".
    // Error objects don't serialize via JSON, so check the message directly.
    const errStrings = warns.map((w) =>
      (w as unknown[]).map((arg) => arg instanceof Error ? arg.message : JSON.stringify(arg)).join(' '),
    );
    const joined = errStrings.join('\n');
    expect(joined).toMatch(/SystemSettings.proxyTrustedNetworks reconcile failed/);
    expect(joined).toMatch(/forbidden|auth scope/);
  });

  it('surfaces partial-failure (notUpdated) on SystemSettings/set', async () => {
    const warns: unknown[] = [];
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        // Non-empty current → forces SystemSettings/set (Phase 11 expects empty).
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              { list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.99': true } }] },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:SystemSettings/set') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/set',
              { notUpdated: { singleton: { type: 'invalidPatch', description: 'bad shape' } } },
              'c0',
            ],
          ],
        };
      }
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
      jmapTransport: buildTransport(),
      core: makeCore([
        {
          metadata: {
            name: 's1',
            labels: {
              'platform.phoenix-host.net/node-role': 'server',
              'kubernetes.io/hostname': 's1',
            },
          },
          status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] },
        },
      ]),
      env,
      logger: {
        warn: (...a: unknown[]) => warns.push(a),
        info: () => undefined,
      },
    });

    const joined = warns
      .map((w) => (w as unknown[]).map((arg) => arg instanceof Error ? arg.message : JSON.stringify(arg)).join(' '))
      .join('\n');
    expect(joined).toMatch(/notUpdated/);
  });

  it('logs and continues when listNode rejects (transient API error)', async () => {
    const warns: unknown[] = [];
    let fetchCalled = false;
    mockFetch(() => {
      fetchCalled = true;
      return {};
    });

    const brokenCore = {
      listNode: async () => {
        throw new Error('k8s api boom');
      },
    } as unknown as Parameters<typeof runProxyNetworksReconcilerTick>[0]['core'];

    await runProxyNetworksReconcilerTick({
      core: brokenCore,
      env,
      logger: {
        warn: (...a: unknown[]) => warns.push(a),
        info: () => undefined,
      },
    });

    expect(fetchCalled).toBe(false);
    expect(JSON.stringify(warns)).toMatch(/Failed to list server-role nodes/);
  });
});
