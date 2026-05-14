import { describe, it, expect } from 'vitest';
import {
  buildIngressRoute,
  buildMiddleware,
  hostMatch,
  hostAndPathMatch,
  encodeMatchLiteral,
  errorsSpec,
  forwardAuthSpec,
} from './traefik-types.js';

describe('buildIngressRoute — cross-namespace Service guard', () => {
  it('accepts a route with same-namespace Services (omitted namespace)', () => {
    const body = buildIngressRoute({
      name: 'r-tenant',
      namespace: 'client-abc',
      routes: [
        {
          match: hostMatch('app.example.com'),
          kind: 'Rule',
          services: [{ name: 'app', port: 80 }],
        },
      ],
    });
    expect(body.spec.routes[0].services[0]).toEqual({ name: 'app', port: 80 });
  });

  it('accepts a route with explicit same-namespace ref (echoes args.namespace)', () => {
    const body = buildIngressRoute({
      name: 'r-tenant',
      namespace: 'client-abc',
      routes: [
        {
          match: hostMatch('app.example.com'),
          kind: 'Rule',
          services: [{ name: 'app', port: 80, namespace: 'client-abc' }],
        },
      ],
    });
    expect(body.spec.routes[0].services[0].namespace).toBe('client-abc');
  });

  it('THROWS when a route declares a Service in a DIFFERENT namespace', () => {
    // Defence-in-depth: traefik allowCrossNamespace=true would otherwise
    // accept this, letting a tenant route point at platform-api or
    // another tenant's Service. We refuse at build time.
    expect(() =>
      buildIngressRoute({
        name: 'r-tenant',
        namespace: 'client-abc',
        routes: [
          {
            match: hostMatch('app.example.com'),
            kind: 'Rule',
            services: [{ name: 'platform-api', port: 3000, namespace: 'platform' }],
          },
        ],
      }),
    ).toThrow(/cross-namespace ref/);
  });
});

describe('encodeMatchLiteral / hostMatch / hostAndPathMatch — backtick guards', () => {
  it('encodeMatchLiteral passes through plain strings unchanged', () => {
    expect(encodeMatchLiteral('app.example.com')).toBe('app.example.com');
    expect(encodeMatchLiteral('/oauth2')).toBe('/oauth2');
  });

  it('encodeMatchLiteral throws when input contains a backtick', () => {
    expect(() => encodeMatchLiteral('app.example.com`)`')).toThrow(/backticks/);
  });

  it('hostMatch wraps the hostname in Host(`...`) and guards backticks', () => {
    expect(hostMatch('app.example.com')).toBe('Host(`app.example.com`)');
    expect(() => hostMatch('evil`).PathPrefix(`/'.toString())).toThrow();
  });

  it('hostAndPathMatch composes Host + PathPrefix and guards both', () => {
    expect(hostAndPathMatch('app.example.com', '/oauth2')).toBe(
      'Host(`app.example.com`) && PathPrefix(`/oauth2`)',
    );
    expect(() => hostAndPathMatch('app.example.com', '/oauth2`')).toThrow();
  });
});

describe('errorsSpec — serviceNamespace pinning', () => {
  it('emits the namespace key when serviceNamespace is set (cross-namespace ref)', () => {
    const spec = errorsSpec({
      status: ['404'],
      serviceName: 'tenant-errors',
      serviceNamespace: 'platform-system',
      servicePort: 80,
      query: '/errors/{status}.html',
    });
    // Critical: the namespace field MUST be present and equal to the
    // explicit platform-system value, not the tenant's namespace.
    expect((spec.errors as { service: { namespace: string } }).service.namespace).toBe('platform-system');
  });

  it('omits the namespace key when serviceNamespace is undefined (same-namespace default)', () => {
    const spec = errorsSpec({
      status: ['404'],
      serviceName: 'tenant-errors',
      servicePort: 80,
    });
    expect((spec.errors as { service: Record<string, unknown> }).service.namespace).toBeUndefined();
  });
});

describe('forwardAuthSpec — trustForwardHeader default', () => {
  it('defaults trustForwardHeader to false (safe default after the XFF-spoof finding)', () => {
    const spec = forwardAuthSpec({ address: 'http://oauth2-proxy:4180/oauth2/auth' });
    expect((spec.forwardAuth as { trustForwardHeader: boolean }).trustForwardHeader).toBe(false);
  });

  it('allows explicit trustForwardHeader: true when an internal-only caller opts in', () => {
    const spec = forwardAuthSpec({
      address: 'http://oauth2-proxy:4180/oauth2/auth',
      trustForwardHeader: true,
    });
    expect((spec.forwardAuth as { trustForwardHeader: boolean }).trustForwardHeader).toBe(true);
  });
});

describe('buildMiddleware', () => {
  it('stamps default labels + caller labels on every Middleware', () => {
    const mw = buildMiddleware({
      name: 'r-12345678-waf',
      namespace: 'client-abc',
      spec: { rateLimit: { average: 10, burst: 50 } },
      labels: { 'hosting-platform/route-id': '12345678', 'hosting-platform/middleware-kind': 'waf' },
    });
    expect(mw.metadata.labels).toEqual(expect.objectContaining({
      'app.kubernetes.io/part-of': 'hosting-platform',
      'app.kubernetes.io/managed-by': 'platform-api',
      'hosting-platform/route-id': '12345678',
      'hosting-platform/middleware-kind': 'waf',
    }));
  });
});
