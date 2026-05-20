import { describe, it, expect } from 'vitest';
import { computeBanDuration, evaluateWafBatch, type WafLogRow } from './evaluator.js';
import type { CrowdsecAutobanConfig } from '@k8s-hosting/api-contracts';

const baseConfig: CrowdsecAutobanConfig = {
  enabled: true,
  windowSeconds: 300,
  eventThreshold: 5,
  minSeverity: 'critical',
  initialBanDuration: '1h',
  repeatBackoffMultiplier: 4,
  maxBanDuration: '7d',
  excludedRuleIds: ['949110', '913100'],
  includeTenantRoutes: false,
};

function makeEvent(overrides: Partial<WafLogRow> = {}): WafLogRow {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    createdAt: new Date('2026-05-20T10:00:00Z'),
    sourceIp: '203.0.113.50',
    hostname: 'admin.example.test',
    ruleId: '930120',
    severity: 'critical',
    tenantId: null,
    ...overrides,
  };
}

describe('evaluateWafBatch', () => {
  const emptyLru = new Set<string>();
  const noPastBans = new Map<string, number>();

  it('returns [] when disabled', () => {
    expect(evaluateWafBatch([makeEvent()], { ...baseConfig, enabled: false }, emptyLru, noPastBans)).toEqual([]);
  });

  it('returns [] when no events', () => {
    expect(evaluateWafBatch([], baseConfig, emptyLru, noPastBans)).toEqual([]);
  });

  it('bans an IP when threshold met with all-critical events', () => {
    const events = Array.from({ length: 5 }, () => makeEvent());
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('banned');
    expect(out[0].sourceIp).toBe('203.0.113.50');
    expect(out[0].proposedDuration).toBe('1h');
    expect(out[0].eventCount).toBe(5);
    expect(out[0].ruleIds).toEqual(['930120']);
  });

  it('records skipped_below_threshold for IPs under the threshold', () => {
    const events = Array.from({ length: 3 }, () => makeEvent());
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('skipped_below_threshold');
    expect(out[0].outcomeDetail).toContain('3/5');
  });

  it('skips when LRU contains the IP (thundering-herd protection)', () => {
    const events = Array.from({ length: 10 }, () => makeEvent());
    const out = evaluateWafBatch(events, baseConfig, new Set(['203.0.113.50']), noPastBans);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('skipped_already_banned');
  });

  it('skips when all events are excluded rules', () => {
    const events = Array.from({ length: 10 }, () => makeEvent({ ruleId: '949110' }));
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('skipped_excluded_rule');
    expect(out[0].outcomeDetail).toContain('949110');
  });

  it('filters by minSeverity (warning when set to critical)', () => {
    const events = Array.from({ length: 10 }, () => makeEvent({ severity: 'warning' }));
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('skipped_below_threshold');
  });

  it('counts warning events when minSeverity=warning', () => {
    const events = Array.from({ length: 5 }, () => makeEvent({ severity: 'warning' }));
    const out = evaluateWafBatch(events, { ...baseConfig, minSeverity: 'warning' }, emptyLru, noPastBans);
    expect(out[0].outcome).toBe('banned');
  });

  it('default scope (includeTenantRoutes=false) skips tenant-route-only events', () => {
    const events = Array.from({ length: 5 }, () => makeEvent({ tenantId: 'tenant-abc' }));
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    // Should not appear as a banned decision — skipped silently.
    expect(out).toEqual([]);
  });

  it('includeTenantRoutes=true bans for tenant-route events too', () => {
    const events = Array.from({ length: 5 }, () => makeEvent({ tenantId: 'tenant-abc' }));
    const out = evaluateWafBatch(events, { ...baseConfig, includeTenantRoutes: true }, emptyLru, noPastBans);
    expect(out[0].outcome).toBe('banned');
  });

  it('mixed admin+tenant events still ban when admin events reach threshold', () => {
    const events = [
      ...Array.from({ length: 5 }, () => makeEvent({ tenantId: null })),
      ...Array.from({ length: 3 }, () => makeEvent({ tenantId: 'tenant-abc' })),
    ];
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    expect(out[0].outcome).toBe('banned');
    expect(out[0].eventCount).toBe(8);
  });

  it('groups multiple distinct source IPs into independent decisions', () => {
    const events = [
      ...Array.from({ length: 5 }, () => makeEvent({ sourceIp: '10.0.0.1' })),
      ...Array.from({ length: 6 }, () => makeEvent({ sourceIp: '10.0.0.2' })),
    ];
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.outcome === 'banned')).toBe(true);
  });

  it('aggregates distinct ruleIds in the audit record', () => {
    const events = [
      ...Array.from({ length: 3 }, () => makeEvent({ ruleId: '930120' })),
      ...Array.from({ length: 3 }, () => makeEvent({ ruleId: '942100' })),
    ];
    const out = evaluateWafBatch(events, baseConfig, emptyLru, noPastBans);
    expect(out[0].outcome).toBe('banned');
    expect(out[0].ruleIds).toEqual(['930120', '942100']);
  });
});

describe('computeBanDuration', () => {
  const cfg = { initialBanDuration: '1h', repeatBackoffMultiplier: 4, maxBanDuration: '7d' };

  it('first ban uses initial duration', () => {
    expect(computeBanDuration(cfg, 0)).toBe('1h');
  });

  it('second ban multiplies by backoff', () => {
    expect(computeBanDuration(cfg, 1)).toBe('4h');
  });

  it('third ban multiplies twice', () => {
    expect(computeBanDuration(cfg, 2)).toBe('16h');
  });

  it('caps at max duration', () => {
    // 1h * 4^5 = 1024h > 7d (168h) → capped to 168h = 7d
    expect(computeBanDuration(cfg, 5)).toBe('7d');
  });

  it('handles fractional multipliers (2.25h → 135m)', () => {
    // 1h * 1.5^2 = 2.25h = 8_100_000ms = 135m → minutes is the
    // finest evenly-divisible unit, so formatter returns "135m".
    const d = computeBanDuration({ ...cfg, repeatBackoffMultiplier: 1.5 }, 2);
    expect(d).toBe('135m');
  });
});
