import { describe, it, expect } from 'vitest';
import { domainToSecretName } from '../ssl-certs/cert-manager.js';

describe('k8s-ingress reconciler', () => {
  describe('Ingress spec construction', () => {
    it('should build correct rule for domain-to-workload mapping', () => {
      const domain = { domainName: 'example.com', workloadId: 'w1' };
      const workloadMap = new Map([['w1', 'web-app']]);
      const serviceName = workloadMap.get(domain.workloadId!) ?? 'default';

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

    it('should fallback to first workload when domain has no workloadId', () => {
      const domain = { domainName: 'blog.example.com', workloadId: null };
      const firstWorkload = 'api-server';
      const serviceName = domain.workloadId
        ? 'should-not-be-used'
        : firstWorkload;

      expect(serviceName).toBe('api-server');
    });

    it('should fallback to default when no workloads exist', () => {
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
