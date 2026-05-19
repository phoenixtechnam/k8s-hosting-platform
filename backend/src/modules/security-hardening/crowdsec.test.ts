import { describe, it, expect } from 'vitest';
import { __test } from './crowdsec.js';

const { parseLapiDecision, parseDurationToAbsolute, MANUAL_BAN_REASON_PREFIX } = __test;

describe('parseDurationToAbsolute', () => {
  it('returns null for empty / unparseable inputs', () => {
    expect(parseDurationToAbsolute('')).toBeNull();
    expect(parseDurationToAbsolute('soon')).toBeNull();
  });
  it('parses simple unit durations', () => {
    const before = Date.now();
    const result = parseDurationToAbsolute('5m');
    const after = Date.now();
    expect(result).not.toBeNull();
    const ts = new Date(result as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
    expect(ts).toBeLessThanOrEqual(after + 5 * 60_000 + 50);
  });
  it('sums compound durations like CrowdSec emits', () => {
    const ts = new Date(parseDurationToAbsolute('1h30m12s') as string).getTime();
    const expected = Date.now() + (1 * 3_600_000 + 30 * 60_000 + 12 * 1000);
    expect(Math.abs(ts - expected)).toBeLessThan(100);
  });
  it('handles day units', () => {
    const ts = new Date(parseDurationToAbsolute('7d') as string).getTime();
    expect(Math.abs(ts - (Date.now() + 7 * 86_400_000))).toBeLessThan(100);
  });
});

describe('parseLapiDecision', () => {
  it('maps a valid LAPI decision to the contract shape', () => {
    const d = parseLapiDecision({
      id: 42,
      origin: 'crowdsecurity/http-bf',
      type: 'ban',
      scope: 'Ip',
      value: '1.2.3.4',
      scenario: 'crowdsecurity/http-bf',
      duration: '4h',
      simulated: false,
    });
    expect(d).not.toBeNull();
    expect(d!.id).toBe(42);
    expect(d!.scope).toBe('Ip');
    expect(d!.value).toBe('1.2.3.4');
    expect(d!.manualByOperator).toBe(false);
    expect(d!.simulated).toBe(false);
    expect(d!.expiresAt).not.toBeNull();
  });

  it('flags admin-panel-prefixed bans as manualByOperator', () => {
    const d = parseLapiDecision({
      id: 1,
      origin: 'cscli',
      type: 'ban',
      scope: 'Ip',
      value: '198.51.100.5',
      scenario: `${MANUAL_BAN_REASON_PREFIX}user-123:probing /.env`,
      duration: '4h',
    });
    expect(d!.manualByOperator).toBe(true);
    expect(d!.origin).toBe('cscli');
  });

  it('does NOT flag cscli bans without the admin-panel prefix (operator used CLI directly)', () => {
    const d = parseLapiDecision({
      id: 1,
      origin: 'cscli',
      type: 'ban',
      scope: 'Ip',
      value: '198.51.100.5',
      scenario: 'manual scenario name',
      duration: '4h',
    });
    expect(d!.manualByOperator).toBe(false);
  });

  it('drops decisions with unknown type (forward-compat safety)', () => {
    expect(parseLapiDecision({
      id: 1, type: 'mfa-step-up' as unknown as string,
      scope: 'Ip', value: '1.2.3.4', scenario: '', duration: '1h',
    } as unknown as { id: number; type: string; scope: string; value: string; scenario: string; duration: string })).toBeNull();
  });

  it('drops decisions with unknown scope', () => {
    expect(parseLapiDecision({
      id: 1, type: 'ban', scope: 'Region' as unknown as string,
      value: 'XX', scenario: '', duration: '1h',
    } as unknown as { id: number; type: string; scope: string; value: string; scenario: string; duration: string })).toBeNull();
  });

  it('drops decisions missing required fields', () => {
    expect(parseLapiDecision({ id: 1, type: 'ban', scope: 'Ip', value: '', scenario: '', duration: '1h' })).toBeNull();
    expect(parseLapiDecision({ id: NaN, type: 'ban', scope: 'Ip', value: '1.2.3.4', scenario: '', duration: '1h' })).toBeNull();
  });

  it('coerces non-string id to number when valid', () => {
    const d = parseLapiDecision({
      id: '42' as unknown as number,
      type: 'ban',
      scope: 'Ip',
      value: '1.2.3.4',
      scenario: 'cscli',
      duration: '4h',
    });
    expect(d!.id).toBe(42);
  });

  it('passes through simulated flag', () => {
    const d = parseLapiDecision({
      id: 1, origin: 'cscli', type: 'ban', scope: 'Ip',
      value: '1.2.3.4', scenario: 'test', duration: '1h', simulated: true,
    });
    expect(d!.simulated).toBe(true);
  });
});
