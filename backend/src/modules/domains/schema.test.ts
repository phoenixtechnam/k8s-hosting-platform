import { describe, it, expect } from 'vitest';
import { createDomainSchema, updateDomainSchema } from './schema.js';

describe('createDomainSchema', () => {
  it('should accept valid domain', () => {
    const result = createDomainSchema.safeParse({ domain_name: 'example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dns_mode).toBe('cname'); // default
    }
  });

  it('should accept subdomain', () => {
    const result = createDomainSchema.safeParse({ domain_name: 'www.example.com' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid domain names', () => {
    expect(createDomainSchema.safeParse({ domain_name: '' }).success).toBe(false);
    expect(createDomainSchema.safeParse({ domain_name: 'not a domain' }).success).toBe(false);
    expect(createDomainSchema.safeParse({ domain_name: '-invalid.com' }).success).toBe(false);
  });

  it('should accept dns_mode options', () => {
    expect(createDomainSchema.safeParse({ domain_name: 'a.com', dns_mode: 'primary' }).success).toBe(true);
    expect(createDomainSchema.safeParse({ domain_name: 'a.com', dns_mode: 'cname' }).success).toBe(true);
    expect(createDomainSchema.safeParse({ domain_name: 'a.com', dns_mode: 'secondary' }).success).toBe(true);
    expect(createDomainSchema.safeParse({ domain_name: 'a.com', dns_mode: 'invalid' }).success).toBe(false);
  });

  it('should accept optional deployment_id', () => {
    const result = createDomainSchema.safeParse({
      domain_name: 'example.com',
      deployment_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });
});

describe('updateDomainSchema', () => {
  it('should accept empty object', () => {
    expect(updateDomainSchema.safeParse({}).success).toBe(true);
  });

  it('should accept ssl_auto_renew boolean', () => {
    expect(updateDomainSchema.safeParse({ ssl_auto_renew: true }).success).toBe(true);
    expect(updateDomainSchema.safeParse({ ssl_auto_renew: false }).success).toBe(true);
  });

  it('should accept nullable deployment_id', () => {
    expect(updateDomainSchema.safeParse({ deployment_id: null }).success).toBe(true);
    expect(updateDomainSchema.safeParse({ deployment_id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true);
  });
});
