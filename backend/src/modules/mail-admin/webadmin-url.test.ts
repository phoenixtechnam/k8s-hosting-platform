import { describe, expect, it } from 'vitest';
import { buildWebadminUrl } from './webadmin-url.js';

describe('buildWebadminUrl', () => {
  it('returns https://mail.<domain>/ when a base domain is configured', () => {
    const result = buildWebadminUrl({
      ingressBaseDomain: 'example.com',
      platformEnv: 'production',
    });
    expect(result).toEqual({
      url: 'https://mail.example.com/',
      username: 'admin',
    });
  });

  it('uses http for dev environments (no TLS on ingress :2010)', () => {
    const result = buildWebadminUrl({
      ingressBaseDomain: 'k8s-platform.test',
      platformEnv: 'dev',
      devIngressPort: 2010,
    });
    expect(result).toEqual({
      url: 'http://mail.k8s-platform.test:2010/',
      username: 'admin',
    });
  });

  it('honours an explicit STALWART_WEBADMIN_URL override', () => {
    const result = buildWebadminUrl({
      ingressBaseDomain: 'example.com',
      platformEnv: 'production',
      explicitUrl: 'https://custom-mail-admin.example.net/',
    });
    expect(result.url).toBe('https://custom-mail-admin.example.net/');
  });

  it('honours an explicit STALWART_WEBADMIN_USERNAME override', () => {
    const result = buildWebadminUrl({
      ingressBaseDomain: 'example.com',
      platformEnv: 'production',
      explicitUsername: 'postmaster',
    });
    expect(result.username).toBe('postmaster');
  });

  it('throws when neither explicit URL nor base domain is configured', () => {
    expect(() =>
      buildWebadminUrl({
        ingressBaseDomain: undefined,
        platformEnv: 'production',
      }),
    ).toThrow(/INGRESS_BASE_DOMAIN|STALWART_WEBADMIN_URL/);
  });

  it('rejects an explicit URL with a dangerous scheme (javascript:)', () => {
    expect(() =>
      buildWebadminUrl({
        ingressBaseDomain: 'example.com',
        platformEnv: 'production',
        // eslint-disable-next-line no-script-url
        explicitUrl: 'javascript:alert(1)',
      }),
    ).toThrow();
  });

  it('rejects an explicit URL that is not a URL at all', () => {
    expect(() =>
      buildWebadminUrl({
        ingressBaseDomain: 'example.com',
        platformEnv: 'production',
        explicitUrl: 'not-a-url',
      }),
    ).toThrow();
  });
});
