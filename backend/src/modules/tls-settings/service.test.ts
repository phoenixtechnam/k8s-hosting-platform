import { describe, it, expect } from 'vitest';
import { tlsSettingsResponseSchema, updateTlsSettingsSchema } from '@k8s-hosting/api-contracts';

describe('tls-settings schemas', () => {
  it('should validate TLS settings response', () => {
    const result = tlsSettingsResponseSchema.safeParse({
      clusterIssuerName: 'letsencrypt-production',
      autoTlsEnabled: true,
    });
    expect(result.success).toBe(true);
  });

  it('should validate update input with partial fields', () => {
    const onlyIssuer = updateTlsSettingsSchema.safeParse({ clusterIssuerName: 'local-ca-issuer' });
    expect(onlyIssuer.success).toBe(true);

    const onlyAuto = updateTlsSettingsSchema.safeParse({ autoTlsEnabled: false });
    expect(onlyAuto.success).toBe(true);

    const empty = updateTlsSettingsSchema.safeParse({});
    expect(empty.success).toBe(true);
  });

  it('should reject empty issuer name', () => {
    const result = updateTlsSettingsSchema.safeParse({ clusterIssuerName: '' });
    expect(result.success).toBe(false);
  });

  it('should validate local CA issuer name', () => {
    const result = updateTlsSettingsSchema.safeParse({ clusterIssuerName: 'local-ca-issuer' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clusterIssuerName).toBe('local-ca-issuer');
    }
  });

  it('should default autoTlsEnabled response to boolean', () => {
    const result = tlsSettingsResponseSchema.safeParse({
      clusterIssuerName: 'test',
      autoTlsEnabled: false,
    });
    expect(result.success).toBe(true);
  });
});
