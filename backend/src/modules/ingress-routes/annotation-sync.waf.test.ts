import { describe, it, expect } from 'vitest';
import { buildMiddlewaresForRoute, type RouteSettingsLike } from './annotation-sync.js';

const baseRoute: RouteSettingsLike = {
  forceHttps: 0,
  wwwRedirect: 'none',
  redirectUrl: null,
  ipAllowlist: null,
  rateLimitRps: null,
  rateLimitConnections: null,
  rateLimitBurstMultiplier: null,
  wafEnabled: 0,
  wafOwaspCrs: 0,
  wafAnomalyThreshold: 10,
  wafExcludedRules: null,
  customErrorCodes: null,
  customErrorPath: null,
};

describe('buildMiddlewaresForRoute — WAF (ModSecurity-CRS shared sidecar)', () => {
  it('emits NO WAF ref when wafEnabled=0', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wafEnabled: 0 },
      'route-12345678',
      'client-ns',
    );
    // No per-route WAF Middleware emitted, no reference to the shared sidecar.
    expect(middlewares.find((m) => m.metadata.name.endsWith('-waf'))).toBeUndefined();
    expect(referenceList.find((r) => r.name === 'modsecurity-crs')).toBeUndefined();
    expect(referenceList.find((r) => r.name === 'coraza-base')).toBeUndefined();
  });

  it('attaches the shared modsecurity-crs@traefik Middleware ref when wafEnabled=1', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wafEnabled: 1, wafOwaspCrs: 1 },
      'route-12345678',
      'client-ns',
    );
    // No per-route WAF Middleware emitted — single shared sidecar.
    expect(middlewares.find((m) => m.metadata.name.endsWith('-waf'))).toBeUndefined();
    const wafRef = referenceList.find((r) => r.name === 'modsecurity-crs');
    expect(wafRef).toEqual({ name: 'modsecurity-crs', namespace: 'traefik' });
  });

  it('attaches modsecurity-crs even when route would have had per-route overrides (madebymode does not support them)', () => {
    // wafExcludedRules / wafAnomalyThreshold / wafOwaspCrs=0 are read
    // for forwards-compat but have no runtime effect under the current
    // ModSecurity sidecar architecture. The shared sidecar honours its
    // own image config; the schema fields stay so the panel UI keeps
    // working and a future in-process Coraza plugin can read them again
    // without a migration.
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      {
        ...baseRoute,
        wafEnabled: 1,
        wafOwaspCrs: 1,
        wafExcludedRules: '911100,920420',
        wafAnomalyThreshold: 5,
      },
      'route-12345678',
      'client-ns',
    );
    expect(middlewares.find((m) => m.metadata.name.endsWith('-waf'))).toBeUndefined();
    expect(referenceList.find((r) => r.name === 'modsecurity-crs')).toBeDefined();
    // Coraza scaffold is dead code; nothing referencing it should leak through.
    expect(referenceList.find((r) => r.name === 'coraza-base')).toBeUndefined();
    expect(referenceList.find((r) => /^r-.*-waf$/.test(r.name))).toBeUndefined();
  });
});

describe('buildMiddlewaresForRoute — concurrent-connection cap (rateLimitConnections)', () => {
  it('emits an inFlightReq Middleware when rateLimitConnections is set', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, rateLimitConnections: 50 },
      'route-12345678',
      'client-ns',
    );
    const mw = middlewares.find((m) => m.metadata.name === 'r-route-12-inflight');
    expect(mw).toBeDefined();
    expect((mw!.spec as { inFlightReq: { amount: number } }).inFlightReq.amount).toBe(50);
    expect(referenceList).toContainEqual({ name: 'r-route-12-inflight', namespace: 'client-ns' });
  });

  it('emits NO inFlightReq Middleware when rateLimitConnections is null or 0', () => {
    for (const value of [null, 0]) {
      const { middlewares } = buildMiddlewaresForRoute(
        { ...baseRoute, rateLimitConnections: value as number | null },
        'route-12345678',
        'client-ns',
      );
      expect(middlewares.find((m) => m.metadata.name.endsWith('-inflight'))).toBeUndefined();
    }
  });

  it('rateLimitRps and rateLimitConnections both emit independently', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, rateLimitRps: 10, rateLimitConnections: 50 },
      'route-12345678',
      'client-ns',
    );
    expect(middlewares.find((m) => m.metadata.name.endsWith('-ratelimit'))).toBeDefined();
    expect(middlewares.find((m) => m.metadata.name.endsWith('-inflight'))).toBeDefined();
  });
});

describe('buildMiddlewaresForRoute — custom error pages (customErrorCodes)', () => {
  it('emits an errors Middleware pointing at tenant-errors when customErrorCodes is set', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, customErrorCodes: '404,503', customErrorPath: '/errors/{status}.html' },
      'route-12345678',
      'client-ns',
    );
    const mw = middlewares.find((m) => m.metadata.name === 'r-route-12-errors');
    expect(mw).toBeDefined();
    const spec = mw!.spec as { errors: { status: string[]; service: { name: string; port: number }; query: string } };
    expect(spec.errors.status).toEqual(['404', '503']);
    expect(spec.errors.service).toEqual({ name: 'tenant-errors', port: 80 });
    expect(spec.errors.query).toBe('/errors/{status}.html');
    expect(referenceList).toContainEqual({ name: 'r-route-12-errors', namespace: 'client-ns' });
  });

  it('does NOT emit the errors Middleware when customErrorPath is unset (avoids 500 from unresolvable backend)', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, customErrorCodes: '500-599', customErrorPath: null },
      'route-12345678',
      'client-ns',
    );
    expect(middlewares.find((m) => m.metadata.name === 'r-route-12-errors')).toBeUndefined();
  });

  it('drops malformed status codes from customErrorCodes (defence against injection + admission rejection)', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      {
        ...baseRoute,
        customErrorCodes: '404, not-a-code, 503-200, 500-599, 503',
        customErrorPath: '/errors/{status}.html',
      },
      'route-12345678',
      'client-ns',
    );
    const mw = middlewares.find((m) => m.metadata.name === 'r-route-12-errors');
    expect(mw).toBeDefined();
    const spec = mw!.spec as { errors: { status: string[] } };
    // "not-a-code" rejected by the regex.
    // "503-200" rejected because low > high (would crash Traefik
    //   admission webhook and take the whole IngressRoute down).
    // "500-599" kept (valid range).
    // "404" + "503" kept (single codes).
    expect(spec.errors.status).toEqual(['404', '500-599', '503']);
  });

  it('emits NO errors Middleware when customErrorCodes is null', () => {
    const { middlewares } = buildMiddlewaresForRoute(
      { ...baseRoute, customErrorCodes: null },
      'route-12345678',
      'client-ns',
    );
    expect(middlewares.find((m) => m.metadata.name.endsWith('-errors'))).toBeUndefined();
  });
});
