import { describe, it, expect } from 'vitest';
import {
  ingressMtlsConfigSchema,
  zitiProviderInputSchema,
  zrokProviderInputSchema,
  ZROK_DEFAULT_CONTROLLER_URL,
  deploymentNetworkAccessInputSchema,
  networkAccessModeSchema,
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
