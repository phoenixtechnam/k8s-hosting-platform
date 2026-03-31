import { describe, it, expect } from 'vitest';
import { hostnameToSlug, isApexHostname } from './service.js';
import { createIngressRouteSchema, updateIngressRouteSchema, ingressSettingsResponseSchema } from '@k8s-hosting/api-contracts';

describe('ingress-routes service', () => {
  describe('hostnameToSlug', () => {
    it('should convert simple domain to slug', () => {
      expect(hostnameToSlug('example.com')).toBe('example-com');
    });

    it('should convert subdomain to slug', () => {
      expect(hostnameToSlug('blog.example.com')).toBe('blog-example-com');
    });

    it('should handle deeply nested subdomains', () => {
      expect(hostnameToSlug('a.b.c.example.com')).toBe('a-b-c-example-com');
    });

    it('should lowercase', () => {
      expect(hostnameToSlug('Blog.Example.COM')).toBe('blog-example-com');
    });

    it('should collapse consecutive hyphens', () => {
      expect(hostnameToSlug('my--site..com')).toBe('my-site-com');
    });

    it('should truncate to 63 chars (DNS label max)', () => {
      const long = 'a'.repeat(70) + '.example.com';
      expect(hostnameToSlug(long).length).toBeLessThanOrEqual(63);
    });

    it('should strip leading/trailing hyphens', () => {
      expect(hostnameToSlug('.example.com.')).toBe('example-com');
    });
  });

  describe('isApexHostname', () => {
    it('should return true for exact match', () => {
      expect(isApexHostname('example.com', 'example.com')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isApexHostname('Example.COM', 'example.com')).toBe(true);
    });

    it('should return false for subdomain', () => {
      expect(isApexHostname('blog.example.com', 'example.com')).toBe(false);
    });

    it('should return false for different domain', () => {
      expect(isApexHostname('other.com', 'example.com')).toBe(false);
    });
  });

  describe('API schemas', () => {
    it('should validate create input with hostname only', () => {
      const result = createIngressRouteSchema.safeParse({ hostname: 'blog.example.com' });
      expect(result.success).toBe(true);
    });

    it('should validate create input with workload_id', () => {
      const result = createIngressRouteSchema.safeParse({
        hostname: 'blog.example.com',
        workload_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty hostname', () => {
      const result = createIngressRouteSchema.safeParse({ hostname: '' });
      expect(result.success).toBe(false);
    });

    it('should validate update input with workload_id null (unassign)', () => {
      const result = updateIngressRouteSchema.safeParse({ workload_id: null });
      expect(result.success).toBe(true);
    });

    it('should validate ingress settings response', () => {
      const result = ingressSettingsResponseSchema.safeParse({
        ingressBaseDomain: 'ingress.platform.example.net',
        ingressDefaultIpv4: '1.2.3.4',
        ingressDefaultIpv6: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('DNS record type for route creation', () => {
    it('should use A record for apex hostname', () => {
      const hostname = 'example.com';
      const domainName = 'example.com';
      const isApex = isApexHostname(hostname, domainName);
      expect(isApex).toBe(true);
      // Apex domains get A/AAAA records (CNAME not allowed at apex)
      const recordType = isApex ? 'A' : 'CNAME';
      expect(recordType).toBe('A');
    });

    it('should use CNAME record for subdomain', () => {
      const hostname = 'blog.example.com';
      const domainName = 'example.com';
      const isApex = isApexHostname(hostname, domainName);
      expect(isApex).toBe(false);
      const recordType = isApex ? 'A' : 'CNAME';
      expect(recordType).toBe('CNAME');
    });

    it('should extract subdomain from hostname', () => {
      const hostname = 'blog.example.com';
      const domainName = 'example.com';
      const subdomain = hostname.replace(`.${domainName}`, '');
      expect(subdomain).toBe('blog');
    });

    it('should handle nested subdomain extraction', () => {
      const hostname = 'api.v2.example.com';
      const domainName = 'example.com';
      const subdomain = hostname.replace(`.${domainName}`, '');
      expect(subdomain).toBe('api.v2');
    });
  });

  describe('CNAME chain construction', () => {
    it('should build full CNAME target from slug + base domain', () => {
      const slug = hostnameToSlug('blog.example.com');
      const baseDomain = 'ingress.platform.example.net';
      const target = `${slug}.${baseDomain}`;
      expect(target).toBe('blog-example-com.ingress.platform.example.net');
    });

    it('should build apex CNAME target', () => {
      const slug = hostnameToSlug('example.com');
      const baseDomain = 'ingress.platform.example.net';
      const target = `${slug}.${baseDomain}`;
      expect(target).toBe('example-com.ingress.platform.example.net');
    });
  });
});
