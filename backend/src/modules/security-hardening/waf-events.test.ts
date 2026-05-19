import { describe, it, expect, vi } from 'vitest';
import {
  listWafEvents,
  normalizeSeverity,
  parseRuleIds,
  scopeOf,
} from './waf-events.js';

describe('parseRuleIds', () => {
  it('returns empty for undefined or empty', () => {
    expect(parseRuleIds(undefined)).toEqual([]);
    expect(parseRuleIds('')).toEqual([]);
  });
  it('splits comma list and trims', () => {
    expect(parseRuleIds(' 930120 , 931100 ')).toEqual(['930120', '931100']);
  });
  it('drops non-numeric ids (no injection vector)', () => {
    expect(parseRuleIds('930120,DROP TABLE,931100')).toEqual(['930120', '931100']);
  });
  it('caps at 50 ids to bound query size', () => {
    const long = Array.from({ length: 60 }, (_, i) => String(900000 + i)).join(',');
    expect(parseRuleIds(long)).toHaveLength(50);
  });
});

describe('normalizeSeverity', () => {
  it('passes known severities through', () => {
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity('warning')).toBe('warning');
    expect(normalizeSeverity('info')).toBe('info');
  });
  it('falls back to info for unknown', () => {
    expect(normalizeSeverity('emergency')).toBe('info');
    expect(normalizeSeverity('')).toBe('info');
  });
});

describe('scopeOf', () => {
  it('null route_id is admin-host', () => {
    expect(scopeOf(null)).toBe('admin-host');
  });
  it('non-null route_id is tenant-route', () => {
    expect(scopeOf('some-uuid')).toBe('tenant-route');
  });
});

// ─── listWafEvents end-to-end (mocked DB) ──────────────────────────────────

interface FakeRow {
  id: string;
  routeId: string | null;
  tenantId: string | null;
  hostname: string;
  ruleId: string;
  severity: string;
  message: string;
  requestUri: string | null;
  requestMethod: string | null;
  sourceIp: string | null;
  createdAt: Date;
}

const baseRow: FakeRow = {
  id: 'evt-1',
  routeId: null,
  tenantId: null,
  hostname: 'admin.example.test',
  ruleId: '930120',
  severity: 'critical',
  message: 'OS File Access Attempt',
  requestUri: '/api/v1/admin/system-backup/dr-drill/runs',
  requestMethod: 'POST',
  sourceIp: '10.0.0.5',
  createdAt: new Date('2026-05-19T10:00:00Z'),
};

function buildMockDb(opts: {
  listRows?: FakeRow[];
  totalsRow?: { total: number; tenant_route: number; admin_host: number; most_recent: Date | null };
  topRulesRows?: Array<{ rule_id: string; cnt: number; message: string; severity: string }>;
  topHostsRows?: Array<{ hostname: string; is_admin_host: boolean; cnt: number }>;
  topIpsRows?: Array<{ sourceIp: string; count: number }>;
}) {
  const listChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(opts.listRows ?? []),
  };
  const topIpsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(opts.topIpsRows ?? []),
  };
  // First .select() = list; second = top IPs.
  const select = vi.fn()
    .mockReturnValueOnce(listChain)
    .mockReturnValueOnce(topIpsChain);

  // db.execute() is called 3 times: totals, top rules, top hosts.
  const execute = vi.fn()
    .mockResolvedValueOnce({ rows: opts.totalsRow ? [opts.totalsRow] : [] })
    .mockResolvedValueOnce({ rows: opts.topRulesRows ?? [] })
    .mockResolvedValueOnce({ rows: opts.topHostsRows ?? [] });

  return { select, execute } as unknown as Parameters<typeof listWafEvents>[0];
}

describe('listWafEvents', () => {
  it('maps admin-host row (null routeId) to scope=admin-host', async () => {
    const db = buildMockDb({
      listRows: [baseRow],
      totalsRow: { total: 1, tenant_route: 0, admin_host: 1, most_recent: baseRow.createdAt },
    });
    const res = await listWafEvents(db, {});
    expect(res.events).toHaveLength(1);
    expect(res.events[0].scope).toBe('admin-host');
    expect(res.events[0].routeId).toBeNull();
    expect(res.events[0].hostname).toBe('admin.example.test');
    expect(res.events[0].ruleId).toBe('930120');
    expect(res.events[0].severity).toBe('critical');
    expect(res.events[0].occurredAt).toBe('2026-05-19T10:00:00.000Z');
  });

  it('maps tenant-route row (set routeId) to scope=tenant-route', async () => {
    const tenantRow = { ...baseRow, id: 'evt-2', routeId: 'route-abc', tenantId: 'tenant-xyz' };
    const db = buildMockDb({
      listRows: [tenantRow],
      totalsRow: { total: 1, tenant_route: 1, admin_host: 0, most_recent: tenantRow.createdAt },
    });
    const res = await listWafEvents(db, {});
    expect(res.events[0].scope).toBe('tenant-route');
    expect(res.events[0].routeId).toBe('route-abc');
  });

  it('reports truncated=true when fetched rows exceed limit (limit+1 trick)', async () => {
    // limit=2 → service fetches 3, slices to 2, marks truncated.
    const rows = [
      { ...baseRow, id: 'a' },
      { ...baseRow, id: 'b' },
      { ...baseRow, id: 'c' },
    ];
    const db = buildMockDb({
      listRows: rows,
      totalsRow: { total: 3, tenant_route: 0, admin_host: 3, most_recent: baseRow.createdAt },
    });
    const res = await listWafEvents(db, { limit: 2 });
    expect(res.events).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('reports truncated=false when result fits under limit', async () => {
    const db = buildMockDb({
      listRows: [baseRow],
      totalsRow: { total: 1, tenant_route: 0, admin_host: 1, most_recent: baseRow.createdAt },
    });
    const res = await listWafEvents(db, { limit: 100 });
    expect(res.truncated).toBe(false);
  });

  it('populates stats: totals + top rules + top hosts + most-recent', async () => {
    const db = buildMockDb({
      listRows: [baseRow],
      totalsRow: {
        total: 42,
        tenant_route: 30,
        admin_host: 12,
        most_recent: new Date('2026-05-19T11:00:00Z'),
      },
      topRulesRows: [
        { rule_id: '930120', cnt: 15, message: 'OS File Access', severity: 'critical' },
        { rule_id: '949110', cnt: 10, message: 'Anomaly Score Exceeded', severity: 'warning' },
      ],
      topHostsRows: [
        { hostname: 'admin.example.test', is_admin_host: true, cnt: 12 },
        { hostname: 'client.example.test', is_admin_host: false, cnt: 8 },
      ],
      topIpsRows: [{ sourceIp: '10.0.0.5', count: 20 }],
    });
    const res = await listWafEvents(db, {});
    expect(res.stats.totalEvents).toBe(42);
    expect(res.stats.totalEventsAdminHost).toBe(12);
    expect(res.stats.totalEventsTenantRoute).toBe(30);
    expect(res.stats.topRules).toHaveLength(2);
    expect(res.stats.topRules[0].ruleId).toBe('930120');
    expect(res.stats.topRules[0].count).toBe(15);
    expect(res.stats.topRules[0].sampleSeverity).toBe('critical');
    expect(res.stats.topHosts).toHaveLength(2);
    expect(res.stats.topHosts[0].scope).toBe('admin-host');
    expect(res.stats.topHosts[1].scope).toBe('tenant-route');
    expect(res.stats.topSourceIps).toEqual([{ sourceIp: '10.0.0.5', count: 20 }]);
    expect(res.stats.mostRecentAt).toBe('2026-05-19T11:00:00.000Z');
  });

  it('returns mostRecentAt=null when table is empty', async () => {
    const db = buildMockDb({
      listRows: [],
      totalsRow: { total: 0, tenant_route: 0, admin_host: 0, most_recent: null },
    });
    const res = await listWafEvents(db, {});
    expect(res.stats.mostRecentAt).toBeNull();
    expect(res.stats.totalEvents).toBe(0);
  });

  it('normalizes unknown severity values to info', async () => {
    const oddRow = { ...baseRow, severity: 'emergency' };
    const db = buildMockDb({
      listRows: [oddRow],
      totalsRow: { total: 1, tenant_route: 0, admin_host: 1, most_recent: baseRow.createdAt },
    });
    const res = await listWafEvents(db, {});
    expect(res.events[0].severity).toBe('info');
  });
});
