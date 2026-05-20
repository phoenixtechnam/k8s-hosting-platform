import { describe, expect, it } from 'vitest';
import {
  buildTraefikPatchOps,
  renderHash,
  renderNginxSnippet,
  renderTraefikCsv,
} from './reconciler.js';

describe('renderNginxSnippet', () => {
  it('produces empty-marker comment when no CIDRs', () => {
    const out = renderNginxSnippet([]);
    expect(out).toMatch(/^# \(no operator-managed/);
    expect(out).not.toMatch(/set_real_ip_from/);
  });

  it('emits one set_real_ip_from per CIDR', () => {
    const out = renderNginxSnippet(['10.42.0.0/16', '203.0.113.0/24']);
    expect(out.match(/set_real_ip_from/g)?.length).toBe(2);
    expect(out).toContain('set_real_ip_from 10.42.0.0/16;');
    expect(out).toContain('set_real_ip_from 203.0.113.0/24;');
  });

  it('sorts CIDRs deterministically (stable hash across reconcile ticks)', () => {
    const a = renderNginxSnippet(['203.0.113.0/24', '10.42.0.0/16']);
    const b = renderNginxSnippet(['10.42.0.0/16', '203.0.113.0/24']);
    expect(a).toBe(b);
  });
});

describe('renderTraefikCsv', () => {
  it('always includes loopback baseline at the front', () => {
    expect(renderTraefikCsv([])).toBe('127.0.0.1/32');
  });

  it('appends operator CIDRs in sorted order after baseline', () => {
    const csv = renderTraefikCsv(['203.0.113.0/24', '10.42.0.0/16']);
    expect(csv).toBe('127.0.0.1/32,10.42.0.0/16,203.0.113.0/24');
  });

  it('matches between identical inputs in different order', () => {
    const a = renderTraefikCsv(['a', 'b']);
    const b = renderTraefikCsv(['b', 'a']);
    expect(a).toBe(b);
  });
});

describe('renderHash', () => {
  it('returns a 16-char hex slug', () => {
    expect(renderHash('hello')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when input changes', () => {
    expect(renderHash('a')).not.toBe(renderHash('b'));
  });
});

describe('buildTraefikPatchOps', () => {
  it('returns no-op when args already match', () => {
    const args = [
      '--entryPoints.web.address=:8000/tcp',
      '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
      '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32',
    ];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32');
    expect(ops).toEqual([]);
  });

  it('emits replace ops at the right index when args differ', () => {
    const args = [
      '--entryPoints.web.address=:8000/tcp',
      '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
      '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32',
    ];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32,1.2.3.4/32');
    expect(ops).toEqual([
      {
        op: 'replace',
        path: '/spec/template/spec/containers/0/args/1',
        value: '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32,1.2.3.4/32',
      },
      {
        op: 'replace',
        path: '/spec/template/spec/containers/0/args/2',
        value:
          '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32,1.2.3.4/32',
      },
    ]);
  });

  it('appends with `-` path when arg missing entirely', () => {
    const args = ['--entryPoints.web.address=:8000/tcp'];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32');
    expect(ops).toEqual([
      {
        op: 'add',
        path: '/spec/template/spec/containers/0/args/-',
        value: '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
      },
      {
        op: 'add',
        path: '/spec/template/spec/containers/0/args/-',
        value: '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32',
      },
    ]);
  });

  it('orders all replaces BEFORE appends (replace indices stable mid-batch)', () => {
    // web arg present at index 1, websecure missing — replace first,
    // append second. Otherwise the append's `-` would push the array
    // length and any subsequent index-based replace would be off-by-one.
    const args = [
      '--entryPoints.web.address=:8000/tcp',
      '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
    ];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32,1.2.3.4/32');
    expect(ops[0]?.op).toBe('replace');
    expect(ops[0]?.path).toBe('/spec/template/spec/containers/0/args/1');
    expect(ops[1]?.op).toBe('add');
    expect(ops[1]?.path).toBe('/spec/template/spec/containers/0/args/-');
  });
});
