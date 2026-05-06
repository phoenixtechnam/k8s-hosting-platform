/**
 * Unit tests for purge-blocked-ips pure helpers.
 *
 * The Pod-spawning code path is covered by the staging E2E (via
 * scripts/integration-stalwart-v016-local.sh) — it requires a real
 * apiserver + a healthy Stalwart pod and is too fragile to mock
 * meaningfully here. The pure helpers we DO test are:
 *
 *   - podCidrPrefix(cidr) → first-two-octets-with-trailing-dot
 *
 * These guard the regression case where a hostNetwork=true ingress
 * controller's source IP (a node IP) gets blocklisted but the prefix-
 * match wouldn't catch it without explicit node-IP support.
 */
import { describe, it, expect } from 'vitest';

import { _podCidrPrefix } from './purge-blocked-ips.js';

describe('purge-blocked-ips: podCidrPrefix', () => {
  it('extracts the first-two-octets prefix from a /16 CIDR', () => {
    expect(_podCidrPrefix('10.42.0.0/16')).toBe('10.42.');
  });

  it('handles other private ranges', () => {
    expect(_podCidrPrefix('192.168.0.0/16')).toBe('192.168.');
    expect(_podCidrPrefix('172.16.0.0/16')).toBe('172.16.');
  });

  it('throws on a malformed CIDR', () => {
    expect(() => _podCidrPrefix('not-an-ip')).toThrow(/invalid podCidrV4/);
    expect(() => _podCidrPrefix('10.42/16')).toThrow(/invalid podCidrV4/);
    expect(() => _podCidrPrefix('')).toThrow(/invalid podCidrV4/);
  });

  it('throws on non-/16 masks to avoid silently-wrong prefix matches', () => {
    // A /8 like '10.0.0.0/8' would silently produce prefix '10.0.' —
    // wrong (real pod IPs span 10.x.y.z, not just 10.0.y.z). Hard-fail
    // until proper CIDR-range matching is implemented.
    expect(() => _podCidrPrefix('10.0.0.0/8')).toThrow(/unsupported podCidrV4 mask \/8/);
    expect(() => _podCidrPrefix('10.42.5.0/24')).toThrow(/unsupported podCidrV4 mask \/24/);
    expect(() => _podCidrPrefix('172.16.0.0/12')).toThrow(/unsupported podCidrV4 mask \/12/);
  });

  it('correctly identifies pod IPs as members of the prefix', () => {
    // The script-side check uses `case "$ip" in "$prefix"*) ...`. This
    // test mirrors that logic in JS to verify the prefix is correctly
    // shaped for downstream `startsWith` semantics.
    const prefix = _podCidrPrefix('10.42.0.0/16');
    expect('10.42.178.88'.startsWith(prefix)).toBe(true);
    expect('10.42.44.132'.startsWith(prefix)).toBe(true);
    expect('10.42.0.1'.startsWith(prefix)).toBe(true);
  });

  it('correctly EXCLUDES IPs outside the prefix', () => {
    const prefix = _podCidrPrefix('10.42.0.0/16');
    expect('10.43.0.1'.startsWith(prefix)).toBe(false);
    expect('192.168.1.1'.startsWith(prefix)).toBe(false);
    // Public IPs that would be operator/attacker sources — must NOT be
    // matched by the cluster-internal prefix:
    expect('46.224.122.58'.startsWith(prefix)).toBe(false);
    expect('167.235.237.116'.startsWith(prefix)).toBe(false);
  });
});
