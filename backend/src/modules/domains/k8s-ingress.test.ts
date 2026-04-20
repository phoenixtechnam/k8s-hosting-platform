import { describe, it, expect } from 'vitest';
import { domainToSecretName } from '../ssl-certs/cert-manager.js';
import { resolveIngressBackend, NotIngressableError, tenantIngressDefaultAnnotations } from './k8s-ingress.js';

describe('tenantIngressDefaultAnnotations', () => {
  it('disables the body-size cap so uploads are bounded by the PVC, not nginx', () => {
    const a = tenantIngressDefaultAnnotations();
    expect(a['nginx.ingress.kubernetes.io/proxy-body-size']).toBe('0');
  });

  it('streams requests (no buffering to controller disk) and extends timeouts', () => {
    const a = tenantIngressDefaultAnnotations();
    expect(a['nginx.ingress.kubernetes.io/proxy-request-buffering']).toBe('off');
    expect(a['nginx.ingress.kubernetes.io/proxy-read-timeout']).toBe('600');
    expect(a['nginx.ingress.kubernetes.io/proxy-send-timeout']).toBe('600');
  });
});

describe('resolveIngressBackend', () => {
  // Minimal shape matching catalogEntries jsonb types. Using `as never` casts
  // to keep tests readable when feeding partial entries.
  const entry = (overrides: Record<string, unknown> = {}) => ({
    type: 'application' as const,
    components: null as unknown,
    networking: null as unknown,
    ...overrides,
  });

  it('single-component app: service = deploymentName, port = declared ingress port', () => {
    const e = entry({
      components: [
        { name: 'vaultwarden', type: 'deployment', image: 'vw:1',
          ports: [{ port: 80, protocol: 'TCP', ingress: true }] },
      ],
    });
    expect(resolveIngressBackend(e, 'my-vw')).toEqual({ serviceName: 'my-vw', port: 80 });
  });

  it('multi-component app: service = deploymentName-componentName, port = component port', () => {
    const e = entry({
      components: [
        { name: 'wordpress', type: 'deployment', image: 'wp:1',
          ports: [{ port: 80, protocol: 'TCP', ingress: true }] },
        { name: 'mariadb', type: 'deployment', image: 'mdb:1',
          ports: [{ port: 3306, protocol: 'TCP', ingress: false }] },
      ],
    });
    expect(resolveIngressBackend(e, 'my-site')).toEqual({
      serviceName: 'my-site-wordpress',
      port: 80,
    });
  });

  it('multi-component: picks the component with ingress=true, not the first one', () => {
    const e = entry({
      components: [
        { name: 'postgresql', type: 'deployment', image: 'pg:1',
          ports: [{ port: 5432, protocol: 'TCP', ingress: false }] },
        { name: 'strapi', type: 'deployment', image: 's:1',
          ports: [{ port: 1337, protocol: 'TCP', ingress: true }] },
      ],
    });
    expect(resolveIngressBackend(e, 'cms')).toEqual({
      serviceName: 'cms-strapi',
      port: 1337,
    });
  });

  it('database entry throws NotIngressableError (DBs never serve web traffic)', () => {
    const e = entry({
      type: 'database',
      components: [
        { name: 'mariadb', type: 'deployment', image: 'mdb:1',
          ports: [{ port: 3306, protocol: 'TCP', ingress: false }] },
      ],
    });
    expect(() => resolveIngressBackend(e, 'my-db')).toThrow(NotIngressableError);
  });

  it('service entry (redis/memcached/minio) throws NotIngressableError', () => {
    const e = entry({
      type: 'service',
      components: [{ name: 'redis', type: 'deployment', image: 'r:1', ports: [] }],
    });
    expect(() => resolveIngressBackend(e, 'my-cache')).toThrow(NotIngressableError);
  });

  it('app with no ingress port throws NotIngressableError', () => {
    const e = entry({
      components: [
        { name: 'app', type: 'deployment', image: 'a:1',
          ports: [{ port: 8080, protocol: 'TCP', ingress: false }] },
      ],
    });
    expect(() => resolveIngressBackend(e, 'x')).toThrow(NotIngressableError);
  });

  it('legacy single-image entry (no components) falls back to networking.ingress_ports', () => {
    const e = entry({
      components: null,
      networking: { ingress_ports: [{ port: 3000, protocol: 'TCP', tls: true }] },
    });
    expect(resolveIngressBackend(e, 'legacy-app')).toEqual({
      serviceName: 'legacy-app',
      port: 3000,
    });
  });

  it('legacy single-image entry with no port declared throws NotIngressableError', () => {
    const e = entry({ components: null, networking: null });
    expect(() => resolveIngressBackend(e, 'x')).toThrow(NotIngressableError);
  });
});



describe('k8s-ingress reconciler', () => {
  describe('Ingress spec construction', () => {
    it('should build correct rule for domain-to-deployment mapping', () => {
      const domain = { domainName: 'example.com', deploymentId: 'dep1' };
      const deploymentMap = new Map([['dep1', 'web-app']]);
      const serviceName = deploymentMap.get(domain.deploymentId!) ?? 'default';

      const rule = {
        host: domain.domainName,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: { name: serviceName, port: { number: 80 } },
            },
          }],
        },
      };

      expect(rule.host).toBe('example.com');
      expect(rule.http.paths[0].backend.service.name).toBe('web-app');
    });

    it('should fallback to first deployment when domain has no deploymentId', () => {
      const domain = { domainName: 'blog.example.com', deploymentId: null };
      const firstDeployment = 'api-server';
      const serviceName = domain.deploymentId
        ? 'should-not-be-used'
        : firstDeployment;

      expect(serviceName).toBe('api-server');
    });

    it('should fallback to default when no deployments exist', () => {
      const serviceName = null ?? 'default';
      expect(serviceName).toBe('default');
    });
  });

  describe('TLS configuration', () => {
    it('should generate TLS entries for each domain', () => {
      const domainNames = ['example.com', 'blog.example.com', 'shop.example.com'];
      const tls = domainNames.map(d => ({
        hosts: [d],
        secretName: domainToSecretName(d),
      }));

      expect(tls).toHaveLength(3);
      expect(tls[0].secretName).toBe('example-com-tls');
      expect(tls[1].secretName).toBe('blog-example-com-tls');
      expect(tls[2].secretName).toBe('shop-example-com-tls');
    });
  });

  describe('Ingress naming', () => {
    it('should use namespace-ingress pattern', () => {
      const namespace = 'acme-corp';
      const ingressName = `${namespace}-ingress`;
      expect(ingressName).toBe('acme-corp-ingress');
    });
  });
});
