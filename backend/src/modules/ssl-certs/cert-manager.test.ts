import { describe, it, expect } from 'vitest';
import { domainToSecretName } from './cert-manager.js';

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

  // `determineChallengeType` was removed in Phase 3 T4.3. The
  // certificates module's `selectIssuerForDomain` replaces it with
  // richer logic (environment + provider + wildcard support).
  // See backend/src/modules/certificates/issuer-selector.ts.
});
