import { describe, it, expect } from 'vitest';
import { buildCallbackUrl } from './service.js';

// The provider-split refactor moved most of the surface to
// providers-service.ts. This file now covers the pure helper(s)
// owned by service.ts. The DB-touching upsert flow is exercised
// end-to-end via scripts/ingress-auth-e2e.sh against a real
// staging cluster + a real OIDC provider.

describe('buildCallbackUrl', () => {
  it('builds the standard /oauth2/callback URL on the ingress hostname', () => {
    expect(buildCallbackUrl('app.example.com')).toBe(
      'https://app.example.com/oauth2/callback',
    );
  });

  it('handles subdomain hostnames', () => {
    expect(buildCallbackUrl('admin.staging.example.com')).toBe(
      'https://admin.staging.example.com/oauth2/callback',
    );
  });
});
