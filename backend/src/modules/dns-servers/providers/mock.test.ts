import { describe, it, expect } from 'vitest';
import { MockDnsProvider } from './mock.js';

describe('MockDnsProvider', () => {
  it('should report ok on testConnection', async () => {
    const provider = new MockDnsProvider();
    const result = await provider.testConnection();
    expect(result.status).toBe('ok');
    expect(result.version).toBe('mock-1.0');
  });

  it('should create and list zones', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('example.com', 'Native');
    const zones = await provider.listZones();
    expect(zones).toHaveLength(1);
    expect(zones[0].name).toBe('example.com.');
    expect(zones[0].kind).toBe('Native');
  });

  it('should not duplicate zones', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('example.com', 'Native');
    await provider.createZone('example.com', 'Master');
    const zones = await provider.listZones();
    expect(zones).toHaveLength(1);
  });

  it('should get zone by name', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('example.com', 'Native');
    const zone = await provider.getZone('example.com');
    expect(zone).not.toBeNull();
    expect(zone!.name).toBe('example.com.');
  });

  it('should return null for non-existent zone', async () => {
    const provider = new MockDnsProvider();
    const zone = await provider.getZone('missing.com');
    expect(zone).toBeNull();
  });

  it('should delete zone', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('example.com', 'Native');
    await provider.deleteZone('example.com');
    const zones = await provider.listZones();
    expect(zones).toHaveLength(0);
  });

  it('should create and list records', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('example.com', 'Native');
    const record = await provider.createRecord('example.com', { type: 'A', name: '@', content: '1.2.3.4', ttl: 3600 });
    expect(record.id).toBeTruthy();
    expect(record.type).toBe('A');
    expect(record.content).toBe('1.2.3.4');

    const records = await provider.listRecords('example.com');
    expect(records).toHaveLength(1);
  });

  it('should update records', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('example.com', 'Native');
    const record = await provider.createRecord('example.com', { type: 'A', name: '@', content: '1.2.3.4' });
    const updated = await provider.updateRecord('example.com', record.id, { content: '5.6.7.8' });
    expect(updated.content).toBe('5.6.7.8');
  });

  it('should delete records', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('example.com', 'Native');
    const record = await provider.createRecord('example.com', { type: 'A', name: '@', content: '1.2.3.4' });
    await provider.deleteRecord('example.com', record.id);
    const records = await provider.listRecords('example.com');
    expect(records).toHaveLength(0);
  });

  it('should throw when creating record in non-existent zone', async () => {
    const provider = new MockDnsProvider();
    await expect(provider.createRecord('missing.com', { type: 'A', name: '@', content: '1.2.3.4' }))
      .rejects.toThrow("Zone 'missing.com' not found");
  });

  it('should handle multiple zones independently', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone('a.com', 'Native');
    await provider.createZone('b.com', 'Master');
    await provider.createRecord('a.com', { type: 'A', name: '@', content: '1.1.1.1' });
    await provider.createRecord('b.com', { type: 'A', name: '@', content: '2.2.2.2' });

    expect(await provider.listRecords('a.com')).toHaveLength(1);
    expect(await provider.listRecords('b.com')).toHaveLength(1);
    expect((await provider.listRecords('a.com'))[0].content).toBe('1.1.1.1');
  });
});
