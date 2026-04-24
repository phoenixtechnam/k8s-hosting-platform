import { describe, it, expect } from 'vitest';
import {
  NullProvider,
  HetznerProvider,
  AWSProvider,
  MetalLBProvider,
  pickProvider,
} from './provider.js';

describe('NullProvider', () => {
  it('returns a no-op handle using the first backend IP', async () => {
    const p = new NullProvider();
    const handle = await p.ensure({
      name: 'admin-panel-lb',
      hostname: 'admin.phoenix-host.net',
      ports: [{ src: 443, dst: 443, proto: 'tcp' }],
      backendIps: ['1.2.3.4', '5.6.7.8'],
    });
    expect(handle.providerId).toBe('null-admin-panel-lb');
    expect(handle.publicIp).toBe('1.2.3.4');
    expect(handle.hostname).toBe('admin.phoenix-host.net');
  });

  it('status reports healthy', async () => {
    const p = new NullProvider();
    const s = await p.status('anything');
    expect(s.healthy).toBe(true);
  });

  it('remove is a no-op', async () => {
    const p = new NullProvider();
    await expect(p.remove('x')).resolves.toBeUndefined();
  });

  it('ensure with empty backendIps falls back to 0.0.0.0', async () => {
    const p = new NullProvider();
    const handle = await p.ensure({
      name: 'lb', hostname: 'h', ports: [], backendIps: [],
    });
    expect(handle.publicIp).toBe('0.0.0.0');
  });
});

describe('stub providers', () => {
  it.each([
    ['Hetzner', new HetznerProvider()],
    ['AWS', new AWSProvider()],
    ['MetalLB', new MetalLBProvider()],
  ])('%s throws not-implemented on ensure', async (_label, provider) => {
    await expect(provider.ensure({
      name: 'x', hostname: 'h', ports: [], backendIps: [],
    })).rejects.toThrow(/not yet implemented/i);
  });

  it.each([
    ['Hetzner', new HetznerProvider()],
    ['AWS', new AWSProvider()],
    ['MetalLB', new MetalLBProvider()],
  ])('%s status reports unhealthy with not-implemented message', async (_label, provider) => {
    const s = await provider.status('x');
    expect(s.healthy).toBe(false);
    expect(s.message).toMatch(/not yet implemented/i);
  });
});

describe('pickProvider', () => {
  it('returns the right instance per name', () => {
    expect(pickProvider('null').name).toBe('null');
    expect(pickProvider('hetzner').name).toBe('hetzner');
    expect(pickProvider('aws').name).toBe('aws');
    expect(pickProvider('metallb').name).toBe('metallb');
  });
});
