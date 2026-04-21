import { describe, it, expect } from 'vitest';
import { isValidIpv4, isValidIpv6 } from '@/lib/ip-validation';

describe('isValidIpv4', () => {
  it.each([
    '0.0.0.0',
    '1.2.3.4',
    '127.0.0.1',
    '192.168.1.1',
    '255.255.255.255',
    '89.167.3.56',
  ])('accepts %s', (ip) => {
    expect(isValidIpv4(ip)).toBe(true);
  });

  it.each([
    '',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.256',
    '1.2.3.-1',
    'abc.def.ghi.jkl',
    '01.2.3.4', // leading zero
    '1.2.3.4/24',
    '1. 2.3.4',
  ])('rejects %s', (ip) => {
    expect(isValidIpv4(ip)).toBe(false);
  });
});

describe('isValidIpv6', () => {
  it.each([
    '::1',
    '::',
    '2001:db8::1',
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    'fe80::1',
    '::ffff:192.168.1.1',
    '2a01:4f9:c013:8f2a::1',
  ])('accepts %s', (ip) => {
    expect(isValidIpv6(ip)).toBe(true);
  });

  it.each([
    '',
    'not-an-ip',
    '1.2.3.4',
    '2001:db8::1::2', // two :: is illegal
    'gggg::1',
    '12345::1', // group > 4 hex
  ])('rejects %s', (ip) => {
    expect(isValidIpv6(ip)).toBe(false);
  });
});
