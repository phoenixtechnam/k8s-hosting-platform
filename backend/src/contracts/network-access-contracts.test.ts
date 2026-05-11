import { describe, it, expect } from 'vitest';
import {
  ingressMtlsConfigSchema,
  zitiProviderInputSchema,
  zrokProviderInputSchema,
  ZROK_DEFAULT_CONTROLLER_URL,
  deploymentNetworkAccessInputSchema,
  networkAccessModeSchema,
  certificateRevocationReasonSchema,
  certificateStatusSchema,
  certificateResponseSchema,
  listCertificatesQuerySchema,
  revokeCertificateInputSchema,
  mtlsIssueCertResponseSchema,
} from '@k8s-hosting/api-contracts';

describe('ingressMtlsConfigSchema', () => {
  it('accepts a minimal enabled config with a CA bundle', () => {
    const parsed = ingressMtlsConfigSchema.parse({
      enabled: true,
      caCertPem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
    });
    expect(parsed.verifyMode).toBe('on');
    expect(parsed.passDnToUpstream).toBe(true);
    expect(parsed.passCertToUpstream).toBe(false);
  });

  it('allows update without re-uploading the CA cert', () => {
    const parsed = ingressMtlsConfigSchema.parse({
      enabled: false,
      verifyMode: 'optional',
    });
    expect(parsed.caCertPem).toBeUndefined();
  });

  it('rejects an unknown verifyMode value', () => {
    expect(() =>
      ingressMtlsConfigSchema.parse({ enabled: true, verifyMode: 'whatever' }),
    ).toThrow();
  });
});

describe('zitiProviderInputSchema', () => {
  it('accepts a controller URL and enrollment JWT', () => {
    const parsed = zitiProviderInputSchema.parse({
      name: 'Production Ziti',
      controllerUrl: 'https://ziti.example.com',
      enrollmentJwt: 'eyJ...fake.jwt',
    });
    expect(parsed.name).toBe('Production Ziti');
  });

  it('rejects a non-URL controller', () => {
    expect(() =>
      zitiProviderInputSchema.parse({
        name: 'broken',
        controllerUrl: 'not-a-url',
      }),
    ).toThrow();
  });
});

describe('zrokProviderInputSchema', () => {
  it('accepts the public default controller URL', () => {
    const parsed = zrokProviderInputSchema.parse({
      name: 'Hosted zrok',
      controllerUrl: ZROK_DEFAULT_CONTROLLER_URL,
      accountEmail: 'ops@example.com',
      accountToken: 'tok-abcd',
    });
    expect(parsed.controllerUrl).toBe('https://api.zrok.io');
  });

  it('accepts a self-hosted controller URL', () => {
    const parsed = zrokProviderInputSchema.parse({
      name: 'Self-hosted',
      controllerUrl: 'https://zrok.internal.example.com:8080',
      accountEmail: 'admin@example.com',
      accountToken: 'tok-self',
    });
    expect(parsed.controllerUrl).toBe('https://zrok.internal.example.com:8080');
  });

  it('rejects a missing email', () => {
    expect(() =>
      zrokProviderInputSchema.parse({
        name: 'broken',
        controllerUrl: 'https://api.zrok.io',
        accountToken: 'tok',
      }),
    ).toThrow();
  });
});

describe('deploymentNetworkAccessInputSchema', () => {
  it('accepts mode=public with no provider fields', () => {
    const parsed = deploymentNetworkAccessInputSchema.parse({
      mode: 'public',
    });
    expect(parsed.passIdentityHeaders).toBe(true);
  });

  it('accepts mode=tunneler with required provider + service name', () => {
    const parsed = deploymentNetworkAccessInputSchema.parse({
      mode: 'tunneler',
      zitiProviderId: 'p-1',
      zitiServiceName: 'my-internal-app',
    });
    expect(parsed.zitiServiceName).toBe('my-internal-app');
  });

  it('rejects mode=tunneler missing zitiProviderId', () => {
    const result = deploymentNetworkAccessInputSchema.safeParse({
      mode: 'tunneler',
      zitiServiceName: 'my-app',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('zitiProviderId'))).toBe(true);
    }
  });

  it('rejects mode=tunneler missing zitiServiceName', () => {
    const result = deploymentNetworkAccessInputSchema.safeParse({
      mode: 'tunneler',
      zitiProviderId: 'p-1',
    });
    expect(result.success).toBe(false);
  });

  it('accepts mode=zrok with both share token + provider', () => {
    const parsed = deploymentNetworkAccessInputSchema.parse({
      mode: 'zrok',
      zrokProviderId: 'p-2',
      zrokShareToken: 'abc12345',
    });
    expect(parsed.mode).toBe('zrok');
  });

  it('rejects mode=zrok missing share token', () => {
    const result = deploymentNetworkAccessInputSchema.safeParse({
      mode: 'zrok',
      zrokProviderId: 'p-2',
    });
    expect(result.success).toBe(false);
  });
});

describe('networkAccessModeSchema', () => {
  it('enumerates exactly the three modes', () => {
    expect(networkAccessModeSchema.options).toEqual(['public', 'tunneler', 'zrok']);
  });
});

describe('certificate lifecycle schemas (v2)', () => {
  it('certificateRevocationReasonSchema enumerates RFC 5280 reasons we support', () => {
    const values = certificateRevocationReasonSchema.options;
    expect(values).toContain('unspecified');
    expect(values).toContain('keyCompromise');
    expect(values).toContain('caCompromise');
    expect(values).toContain('superseded');
    expect(values).toContain('cessationOfOperation');
    expect(values).toContain('privilegeWithdrawn');
    // certificateHold / removeFromCRL are intentionally excluded —
    // the platform doesn't support unhold.
    expect(values).not.toContain('certificateHold');
    expect(values).not.toContain('removeFromCRL');
  });

  it('certificateStatusSchema enumerates the three derived states', () => {
    expect(certificateStatusSchema.options).toEqual(['active', 'revoked', 'expired']);
  });

  it('certificateResponseSchema requires all identity fields and nullable revocation fields', () => {
    const parsed = certificateResponseSchema.parse({
      id: 'cert-1',
      providerId: 'prov-1',
      serialHex: '7abc1234567890ab',
      fingerprintSha256: 'a'.repeat(64),
      subjectCn: 'alice@example.com',
      subjectFull: '/CN=alice@example.com',
      issuedAt: '2026-05-11T12:00:00Z',
      expiresAt: '2027-05-11T12:00:00Z',
      revokedAt: null,
      revocationReason: null,
      revokedByUserId: null,
      status: 'active',
    });
    expect(parsed.subjectCn).toBe('alice@example.com');
    expect(parsed.status).toBe('active');
  });

  it('listCertificatesQuerySchema clamps limit and rejects bad status', () => {
    const ok = listCertificatesQuerySchema.parse({ status: 'revoked', limit: '50' });
    expect(ok.limit).toBe(50);
    expect(() => listCertificatesQuerySchema.parse({ status: 'cosmic-rays' })).toThrow();
    expect(() => listCertificatesQuerySchema.parse({ limit: 9999 })).toThrow();
  });

  it('revokeCertificateInputSchema defaults reason to unspecified', () => {
    const parsed = revokeCertificateInputSchema.parse({});
    expect(parsed.reason).toBe('unspecified');
  });

  it('mtlsIssueCertResponseSchema requires the new id + serialHex fields', () => {
    expect(() => mtlsIssueCertResponseSchema.parse({
      // Missing id + serialHex (added in v2). Pre-v2 payloads were
      // valid; this assertion guards against accidental rollback.
      certPem: 'x',
      keyPem: 'x',
      caCertPem: 'x',
      subject: '/CN=x',
      expiresAt: '2027-01-01',
      pkcs12Base64: null,
    })).toThrow();
  });
});
