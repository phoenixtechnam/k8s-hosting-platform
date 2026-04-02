import { describe, it, expect } from 'vitest';
import { getNextRunTime } from './scheduler.js';

describe('getNextRunTime', () => {
  it('should return epoch when schedule has wrong number of fields', () => {
    const result = getNextRunTime('bad schedule', null);
    expect(result.getTime()).toBe(0);
  });

  it('should return epoch+1m when lastRunAt is null and schedule is standard', () => {
    const result = getNextRunTime('0 * * * *', null);
    // base = epoch (0), so next = 0 + 60_000
    expect(result.getTime()).toBe(60_000);
  });

  it('should parse */N minute interval', () => {
    const lastRun = new Date('2026-04-01T12:00:00Z');
    const result = getNextRunTime('*/5 * * * *', lastRun);
    // 5 minutes after last run
    expect(result.getTime()).toBe(lastRun.getTime() + 5 * 60_000);
  });

  it('should parse */1 minute interval', () => {
    const lastRun = new Date('2026-04-01T12:00:00Z');
    const result = getNextRunTime('*/1 * * * *', lastRun);
    expect(result.getTime()).toBe(lastRun.getTime() + 60_000);
  });

  it('should parse */15 minute interval', () => {
    const lastRun = new Date('2026-04-01T12:00:00Z');
    const result = getNextRunTime('*/15 * * * *', lastRun);
    expect(result.getTime()).toBe(lastRun.getTime() + 15 * 60_000);
  });

  it('should default to 1 minute for specific minute fields', () => {
    const lastRun = new Date('2026-04-01T12:00:00Z');
    const result = getNextRunTime('30 * * * *', lastRun);
    // Not a */N pattern, so defaults to 1 minute
    expect(result.getTime()).toBe(lastRun.getTime() + 60_000);
  });

  it('should default to 1 minute for wildcard minute field', () => {
    const lastRun = new Date('2026-04-01T12:00:00Z');
    const result = getNextRunTime('* * * * *', lastRun);
    expect(result.getTime()).toBe(lastRun.getTime() + 60_000);
  });

  it('should handle */0 gracefully (treat as */1)', () => {
    const lastRun = new Date('2026-04-01T12:00:00Z');
    // parseInt('0') = 0, which is falsy, so || 1 kicks in
    const result = getNextRunTime('*/0 * * * *', lastRun);
    expect(result.getTime()).toBe(lastRun.getTime() + 60_000);
  });

  it('should be in the past when job has never run', () => {
    // lastRunAt = null => base = epoch => nextRun is epoch + interval
    // which is always in the past, meaning the job is due to run
    const now = new Date();
    const result = getNextRunTime('*/5 * * * *', null);
    expect(result.getTime()).toBeLessThan(now.getTime());
  });

  it('should be in the future when job just ran', () => {
    const now = new Date();
    const result = getNextRunTime('*/5 * * * *', now);
    expect(result.getTime()).toBeGreaterThan(now.getTime());
  });
});
