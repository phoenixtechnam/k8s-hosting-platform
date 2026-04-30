import { describe, it, expect, vi, beforeEach } from 'vitest';

// We import the module under test dynamically AFTER mocks are wired so
// the mock for ../system-settings/service.js is honoured.
const mockGetSettings = vi.fn();

vi.mock('../system-settings/service.js', () => ({
  getSettings: mockGetSettings,
}));

const { readEntryFirewall, enforceHostPortGate } = await import('./service.js');

type CatalogEntry = Parameters<typeof readEntryFirewall>[0];
type ComponentInput = Parameters<typeof enforceHostPortGate>[2][number];

function entry(networking: unknown): CatalogEntry {
  return {
    id: 'cat-1',
    code: 'coturn',
    networking: networking as never,
  } as CatalogEntry;
}

function makeDb(role: 'server' | 'worker' | null) {
  // Drizzle's chainable .select().from().where() — we only need the
  // terminal `.where()` to return the rows, so chain returns itself
  // and .where() returns the rows array.
  const rows = role === null ? [] : [{ role }];
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return {
    select: () => chain,
  } as unknown as Parameters<typeof enforceHostPortGate>[0];
}

describe('readEntryFirewall', () => {
  it('returns null when networking is null', () => {
    expect(readEntryFirewall(entry(null))).toBeNull();
  });

  it('returns null when networking has no firewall block', () => {
    expect(readEntryFirewall(entry({ ingress_ports: [] }))).toBeNull();
  });

  it('returns null when both arrays are empty', () => {
    expect(readEntryFirewall(entry({ firewall: { tcp: [], udp: [] } }))).toBeNull();
  });

  it('extracts the firewall block when ports are declared', () => {
    expect(readEntryFirewall(entry({ firewall: { tcp: [3478, 5349], udp: ['16384-32768'] } })))
      .toEqual({ tcp: [3478, 5349], udp: ['16384-32768'] });
  });

  it('parses a stringified networking blob (legacy DB rows)', () => {
    // Some Drizzle JSONB rows come back as strings — readEntryFirewall
    // delegates to parseJsonField which handles both shapes.
    const stringified = JSON.stringify({ firewall: { tcp: [80], udp: [] } });
    expect(readEntryFirewall(entry(stringified))).toEqual({ tcp: [80], udp: [] });
  });
});

describe('enforceHostPortGate', () => {
  beforeEach(() => { mockGetSettings.mockReset(); });

  it('returns null + does not call settings when manifest has no host ports', async () => {
    const db = makeDb('worker');
    const components: ComponentInput[] = [{ name: 'wp', type: 'deployment', image: 'w:1', ports: [{ port: 80, protocol: 'TCP' }] }];
    const result = await enforceHostPortGate(db, entry(null), components, 'node-1');
    expect(result).toBeNull();
    expect(mockGetSettings).not.toHaveBeenCalled();
  });

  it('throws HOST_PORTS_DISABLED on worker role when toggle is off', async () => {
    mockGetSettings.mockResolvedValue({ allowHostPortsServer: false, allowHostPortsWorker: false });
    const db = makeDb('worker');
    const components: ComponentInput[] = [{ name: 'coturn', type: 'deployment', image: 'c:1', ports: [] }];
    await expect(
      enforceHostPortGate(
        db,
        entry({ firewall: { tcp: [3478], udp: [3478] } }),
        components,
        'worker-1',
      ),
    ).rejects.toMatchObject({
      code: 'HOST_PORTS_DISABLED',
      status: 403,
    });
  });

  it('passes through when worker toggle is on', async () => {
    mockGetSettings.mockResolvedValue({ allowHostPortsServer: false, allowHostPortsWorker: true });
    const db = makeDb('worker');
    const components: ComponentInput[] = [{ name: 'coturn', type: 'deployment', image: 'c:1', ports: [] }];
    const fw = await enforceHostPortGate(
      db,
      entry({ firewall: { tcp: [3478], udp: [3478] } }),
      components,
      'worker-1',
    );
    expect(fw).toEqual({ tcp: [3478], udp: [3478] });
  });

  it('uses server toggle when target node has role=server', async () => {
    mockGetSettings.mockResolvedValue({ allowHostPortsServer: true, allowHostPortsWorker: false });
    const db = makeDb('server');
    const components: ComponentInput[] = [{ name: 'coturn', type: 'deployment', image: 'c:1', ports: [] }];
    const fw = await enforceHostPortGate(
      db,
      entry({ firewall: { tcp: [3478] } }),
      components,
      'server-1',
    );
    // server toggle is on → passes through
    expect(fw).toEqual({ tcp: [3478], udp: [] });
  });

  it('defaults to worker role when no clusterNodes row exists for the pin', async () => {
    mockGetSettings.mockResolvedValue({ allowHostPortsServer: false, allowHostPortsWorker: false });
    const db = makeDb(null);
    const components: ComponentInput[] = [{ name: 'coturn', type: 'deployment', image: 'c:1', ports: [] }];
    await expect(
      enforceHostPortGate(
        db,
        entry({ firewall: { tcp: [3478] } }),
        components,
        'unknown-node',
      ),
    ).rejects.toMatchObject({
      code: 'HOST_PORTS_DISABLED',
      details: expect.objectContaining({ target_role: 'worker' }),
    });
  });

  it('defaults to worker role when workerNodeName is null/undefined', async () => {
    mockGetSettings.mockResolvedValue({ allowHostPortsServer: true, allowHostPortsWorker: false });
    const db = makeDb('worker');
    const components: ComponentInput[] = [{ name: 'coturn', type: 'deployment', image: 'c:1', ports: [] }];
    // server is on, worker is off; null pin → worker → reject.
    await expect(
      enforceHostPortGate(
        db,
        entry({ firewall: { tcp: [3478] } }),
        components,
        null,
      ),
    ).rejects.toMatchObject({
      code: 'HOST_PORTS_DISABLED',
    });
  });
});
