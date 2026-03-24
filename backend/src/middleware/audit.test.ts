import { describe, it, expect } from 'vitest';
import { shouldAudit, extractResourceInfo } from './audit.js';

describe('shouldAudit', () => {
  it('should skip GET requests', () => {
    expect(shouldAudit('GET', '/api/v1/clients')).toBe(false);
  });

  it('should skip HEAD requests', () => {
    expect(shouldAudit('HEAD', '/api/v1/clients')).toBe(false);
  });

  it('should skip OPTIONS requests', () => {
    expect(shouldAudit('OPTIONS', '/api/v1/clients')).toBe(false);
  });

  it('should skip health check', () => {
    expect(shouldAudit('GET', '/api/v1/admin/status')).toBe(false);
    expect(shouldAudit('POST', '/api/v1/admin/status')).toBe(false);
  });

  it('should audit POST requests', () => {
    expect(shouldAudit('POST', '/api/v1/clients')).toBe(true);
  });

  it('should audit PATCH requests', () => {
    expect(shouldAudit('PATCH', '/api/v1/clients/123')).toBe(true);
  });

  it('should audit DELETE requests', () => {
    expect(shouldAudit('DELETE', '/api/v1/clients/123')).toBe(true);
  });
});

describe('extractResourceInfo', () => {
  it('should extract client resource from /api/v1/clients/123', () => {
    const info = extractResourceInfo('/api/v1/clients/123');
    expect(info.resourceType).toBe('client');
    expect(info.resourceId).toBe('123');
  });

  it('should extract domain resource from nested path', () => {
    const info = extractResourceInfo('/api/v1/clients/c1/domains/d1');
    expect(info.resourceType).toBe('domain');
    expect(info.resourceId).toBe('d1');
    expect(info.clientId).toBe('c1');
  });

  it('should extract cron-job resource', () => {
    const info = extractResourceInfo('/api/v1/clients/c1/cron-jobs/j1');
    expect(info.resourceType).toBe('cron-job');
    expect(info.resourceId).toBe('j1');
    expect(info.clientId).toBe('c1');
  });

  it('should handle collection-level POST (no resource ID)', () => {
    const info = extractResourceInfo('/api/v1/clients');
    expect(info.resourceType).toBe('client');
    expect(info.resourceId).toBeUndefined();
  });

  it('should extract client subscription', () => {
    const info = extractResourceInfo('/api/v1/clients/c1/subscription');
    expect(info.resourceType).toBe('subscription');
    expect(info.clientId).toBe('c1');
  });
});
