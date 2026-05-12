import { describe, it, expect } from 'vitest';
import {
  parseSemver,
  compareSemver,
  classifyBump,
  pickLatestStable,
} from './semver-compare.js';

describe('parseSemver', () => {
  it('parses plain 1.2.3', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
  });
  it('parses v-prefixed', () => {
    expect(parseSemver('v1.2.3')?.major).toBe(1);
  });
  it('parses pre-release', () => {
    expect(parseSemver('1.0.0-rc1')?.pre).toBe('rc1');
  });
  it('returns null for non-semver', () => {
    expect(parseSemver('latest')).toBe(null);
    expect(parseSemver('1.2')).toBe(null);
    expect(parseSemver('a.b.c')).toBe(null);
    expect(parseSemver('')).toBe(null);
  });
});

describe('compareSemver', () => {
  const v = (s: string) => parseSemver(s)!;
  it('orders by major, minor, patch', () => {
    expect(compareSemver(v('1.0.0'), v('2.0.0'))).toBeLessThan(0);
    expect(compareSemver(v('1.5.0'), v('1.4.9'))).toBeGreaterThan(0);
    expect(compareSemver(v('1.0.5'), v('1.0.3'))).toBeGreaterThan(0);
  });
  it('treats pre-release as lower than the same M.m.p without one', () => {
    expect(compareSemver(v('1.0.0-rc1'), v('1.0.0'))).toBeLessThan(0);
  });
  it('returns 0 for identical versions', () => {
    expect(compareSemver(v('1.0.0'), v('1.0.0'))).toBe(0);
  });
});

describe('classifyBump', () => {
  const v = (s: string) => parseSemver(s)!;
  it('reports patch', () => {
    expect(classifyBump(v('1.0.0'), v('1.0.5'))).toBe('patch');
  });
  it('reports minor', () => {
    expect(classifyBump(v('1.0.0'), v('1.3.0'))).toBe('minor');
  });
  it('reports major', () => {
    expect(classifyBump(v('1.0.0'), v('2.0.0'))).toBe('major');
  });
  it('reports no-update when latest == current', () => {
    expect(classifyBump(v('1.0.0'), v('1.0.0'))).toBe('no-update');
  });
});

describe('pickLatestStable', () => {
  const v = (s: string) => parseSemver(s)!;
  it('picks the highest stable tag greater than current', () => {
    const result = pickLatestStable(
      ['1.0.0', '1.0.5', '1.1.0', '2.0.0-rc1', 'latest'],
      v('1.0.0'),
    );
    expect(result?.tag).toBe('1.1.0'); // 2.0.0-rc1 excluded as pre-release
  });
  it('returns null when no tag is parseable as semver', () => {
    expect(pickLatestStable(['latest', 'edge', 'main'], v('1.0.0'))).toBe(null);
  });
  it('returns null when no parseable tag is higher than current', () => {
    expect(pickLatestStable(['0.9.0', '1.0.0'], v('1.0.0'))).toBe(null);
  });
  it('ignores pre-releases', () => {
    const result = pickLatestStable(
      ['1.0.0', '1.1.0-rc1', '1.1.0-rc2'],
      v('1.0.0'),
    );
    expect(result).toBe(null); // all candidates are pre-release
  });
});
