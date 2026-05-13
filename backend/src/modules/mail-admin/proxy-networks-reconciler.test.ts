/**
 * Unit tests for proxy-networks-reconciler.
 *
 * Covers the pure helper (proxyNetworksMatches), the cluster-node
 * enumeration (listServerNodeIps), and the tick orchestration (mocked
 * fetch + stub CoreV1Api) so we exercise the security-critical branches
 * where the reconciler refuses to push an empty trust set and surfaces
 * JMAP /set partial-failures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
        { '10.0.0.1/32': true, '10.0.0.2/32': true },
        { '10.0.0.2/32': true, '10.0.0.1/32': true },
      ),
    ).toBe(true);
  });
  it('returns false when sizes differ', () => {
    expect(
      proxyNetworksMatches({ '10.0.0.1/32': true }, { '10.0.0.1/32': true, '10.0.0.2/32': true }),
    ).toBe(false);
  });
  it('returns false when keys differ', () => {
    expect(
      proxyNetworksMatches({ '10.0.0.1/32': true }, { '10.0.0.2/32': true }),
    ).toBe(false);
  });
  it('ignores keys whose value is not exactly true (defensive)', () => {
    expect(
      proxyNetworksMatches(
        // Cast through `as unknown` because we're testing defensive narrowing
        // of the wire shape where a buggy peer could send `false`.
        { '10.0.0.1/32': false as unknown as true, '10.0.0.2/32': true },
        { '10.0.0.2/32': true },
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
  const originalFetch = globalThis.fetch;
  const env = {
    STALWART_ADMIN_USER: 'admin',
    STALWART_ADMIN_PASSWORD: 'pw',
  } as NodeJS.ProcessEnv;

  let calls: Array<{ url: string; body: unknown }> = [];

  function mockFetch(handler: (req: { url: string; body: unknown }) => unknown) {
    globalThis.fetch = (async (input: unknown, init: unknown) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      const body = init && (init as { body?: string }).body
        ? JSON.parse((init as { body: string }).body)
        : null;
      calls.push({ url, body });
      const result = handler({ url, body });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => result,
        text: async () => JSON.stringify(result),
      } as unknown as Response;
    }) as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

  it('skips x:SystemSettings/set when proxyTrustedNetworks already matches', async () => {
    let setCalled = false;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              {
                list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1/32': true } }],
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
      // AllowedIp paths
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
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

  it('pushes the new IP set on the singleton SystemSettings record when nodes change', async () => {
    let updatedBody: Record<string, unknown> | null = null;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              {
                list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1/32': true } }],
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
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
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
        proxyTrustedNetworks: { '10.0.0.1/32': true, '10.0.0.2/32': true },
      },
    });
  });

  it('creates AllowedIp entries for new server nodes (mail-haproxy-<hostname>)', async () => {
    let allowedSetBody: Record<string, unknown> | null = null;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              {
                list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1/32': true } }],
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
        address: '10.0.0.1/32',
        reason: 'Cluster server node s1 (haproxy source) — exempt from rate-limit',
      },
    });
  });

  it('destroys AllowedIp entries for removed server nodes (only ones we own)', async () => {
    let allowedSetBody: Record<string, unknown> | null = null;
    mockFetch((req) => {
      const method = (req.body as { methodCalls?: unknown[][] }).methodCalls?.[0]?.[0];
      if (method === 'x:SystemSettings/get') {
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              {
                list: [{ id: 'singleton', proxyTrustedNetworks: { '10.0.0.1/32': true } }],
              },
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
                  // We own this entry — node is gone, should be destroyed.
                  { id: 'mail-haproxy-old', address: '10.0.0.99/32' },
                  // We do NOT own this entry — must NOT be touched.
                  { id: 'cluster-pod', address: '10.42.0.0/16' },
                ],
              },
              'c0',
            ],
          ],
        };
      }
      if (method === 'x:AllowedIp/set') {
        const call = (req.body as { methodCalls: unknown[][] }).methodCalls[0];
        allowedSetBody = call[1] as Record<string, unknown>;
        return { methodResponses: [['x:AllowedIp/set', { destroyed: ['mail-haproxy-old'] }, 'c0']] };
      }
      return { methodResponses: [[method as string, { list: [] }, 'c0']] };
    });

    await runProxyNetworksReconcilerTick({
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

    expect(allowedSetBody?.destroy).toEqual(['mail-haproxy-old']);
    // Must include create for the new node but never touch cluster-pod.
    expect(JSON.stringify(allowedSetBody)).not.toContain('cluster-pod');
  });

  it('skips the tick when admin credentials are not configured', async () => {
    let fetchCalled = false;
    mockFetch(() => {
      fetchCalled = true;
      return {};
    });

    await runProxyNetworksReconcilerTick({
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
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              { list: [{ id: 'singleton', proxyTrustedNetworks: {} }] }, // forces an update
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
        return {
          methodResponses: [
            [
              'x:SystemSettings/get',
              { list: [{ id: 'singleton', proxyTrustedNetworks: {} }] },
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
