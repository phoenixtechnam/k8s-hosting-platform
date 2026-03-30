import { describe, it, expect } from 'vitest';
import { domainToSecretName, determineChallengeType } from './cert-manager.js';

describe('cert-manager utilities', () => {
  describe('domainToSecretName', () => {
    it('should convert simple domain to secret name', () => {
      expect(domainToSecretName('example.com')).toBe('example-com-tls');
    });

    it('should convert subdomain to secret name', () => {
      expect(domainToSecretName('blog.example.com')).toBe('blog-example-com-tls');
    });

    it('should handle wildcard domains', () => {
      expect(domainToSecretName('*.example.com')).toBe('example-com-tls');
    });

    it('should handle deeply nested subdomains', () => {
      expect(domainToSecretName('a.b.c.example.com')).toBe('a-b-c-example-com-tls');
    });

    it('should truncate long domain names to 50 chars + -tls', () => {
      const longDomain = 'a'.repeat(60) + '.example.com';
      const result = domainToSecretName(longDomain);
      expect(result.length).toBeLessThanOrEqual(54); // 50 + '-tls'
      expect(result).toMatch(/-tls$/);
    });

    it('should lowercase the domain', () => {
      expect(domainToSecretName('Example.COM')).toBe('example-com-tls');
    });

    it('should collapse consecutive hyphens', () => {
      expect(domainToSecretName('my--domain..com')).toBe('my-domain-com-tls');
    });
  });

  describe('determineChallengeType', () => {
    it('should use dns01 for primary DNS mode with DNS server', () => {
      expect(determineChallengeType('primary', true)).toBe('dns01');
    });

    it('should use dns01 for secondary DNS mode with DNS server', () => {
      expect(determineChallengeType('secondary', true)).toBe('dns01');
    });

    it('should use http01 for primary DNS mode without DNS server', () => {
      expect(determineChallengeType('primary', false)).toBe('http01');
    });

    it('should use http01 for cname DNS mode', () => {
      expect(determineChallengeType('cname', true)).toBe('http01');
    });

    it('should use http01 for external DNS mode', () => {
      expect(determineChallengeType('external', true)).toBe('http01');
    });

    it('should use http01 when no DNS server configured', () => {
      expect(determineChallengeType('primary', false)).toBe('http01');
    });
  });
});
