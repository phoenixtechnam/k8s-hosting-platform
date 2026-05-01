import { describe, it, expect } from 'vitest';
import { validateIngressRules, validateLocalPaths } from './service.js';

describe('validateIngressRules', () => {
  it('accepts an app with one ingressable component', () => {
    expect(validateIngressRules({
      type: 'application',
      components: [
        { name: 'wordpress', ports: [{ port: 80, ingress: true }] },
        { name: 'mariadb', ports: [{ port: 3306, ingress: false }] },
      ],
    })).toBeNull();
  });

  it('accepts a runtime with one ingressable component', () => {
    expect(validateIngressRules({
      type: 'runtime',
      components: [{ name: 'php', ports: [{ port: 8080, ingress: true }] }],
    })).toBeNull();
  });

  it('rejects a database with an ingress port — DBs must stay cluster-only', () => {
    const err = validateIngressRules({
      type: 'database',
      components: [{ name: 'mariadb', ports: [{ port: 3306, ingress: true }] }],
    });
    expect(err).toMatch(/type 'database' must not declare ingress ports/);
  });

  it('rejects a service tier with an ingress port — internal caches only', () => {
    const err = validateIngressRules({
      type: 'service',
      components: [{ name: 'redis', ports: [{ port: 6379, ingress: true }] }],
    });
    expect(err).toMatch(/type 'service' must not declare ingress ports/);
  });

  it('rejects multi-component apps with TWO ingress components (nextcloud/collabora shape)', () => {
    const err = validateIngressRules({
      type: 'application',
      components: [
        { name: 'nextcloud', ports: [{ port: 80, ingress: true }] },
        { name: 'collabora', ports: [{ port: 9980, ingress: true }] },
      ],
    });
    expect(err).toMatch(/at most one component with ingress: true, got 2/);
  });

  it('rejects a single component with two ingress ports', () => {
    const err = validateIngressRules({
      type: 'application',
      components: [{ name: 'app', ports: [
        { port: 80, ingress: true },
        { port: 443, ingress: true },
      ] }],
    });
    expect(err).toMatch(/component "app" declares 2 ingress ports/);
  });

  it('accepts a database with internal-only ports', () => {
    expect(validateIngressRules({
      type: 'database',
      components: [{ name: 'mariadb', ports: [{ port: 3306, ingress: false }] }],
    })).toBeNull();
  });

  it('accepts an entry with no components (legacy single-image runtime)', () => {
    expect(validateIngressRules({ type: 'runtime' })).toBeNull();
  });
});

// ─── validateLocalPaths ──────────────────────────────────────────────────────

describe('validateLocalPaths', () => {
  it('accepts "." for a single-volume app (PVC-root)', () => {
    expect(validateLocalPaths([{ local_path: '.', container_path: '/var/www/html' }])).toBeNull();
  });

  it('accepts valid single-segment names', () => {
    expect(validateLocalPaths([
      { local_path: 'content', container_path: '/var/www/html/wp-content' },
      { local_path: 'database', container_path: '/var/lib/mysql' },
    ])).toBeNull();
    expect(validateLocalPaths([{ local_path: 'ml-cache', container_path: '/cache' }])).toBeNull();
    expect(validateLocalPaths([{ local_path: 'data_v2', container_path: '/data' }])).toBeNull();
  });

  it('rejects a multi-segment path like "applications/wordpress/content"', () => {
    const err = validateLocalPaths([{ local_path: 'applications/wordpress/content', container_path: '/data' }]);
    expect(err).toMatch(/invalid local_path/);
  });

  it('rejects an absolute path', () => {
    expect(validateLocalPaths([{ local_path: '/data', container_path: '/data' }])).toMatch(/invalid local_path/);
  });

  it('rejects ".." path traversal', () => {
    expect(validateLocalPaths([{ local_path: '..', container_path: '/data' }])).toMatch(/invalid local_path/);
  });

  it('rejects an empty string', () => {
    expect(validateLocalPaths([{ local_path: '', container_path: '/data' }])).toMatch(/invalid local_path/);
  });

  it('rejects undefined / missing local_path', () => {
    const err = validateLocalPaths([{ container_path: '/var/lib/mysql' }]);
    expect(err).toMatch(/missing local_path/);
  });

  it('rejects more than one volume with local_path "."', () => {
    const err = validateLocalPaths([
      { local_path: '.', container_path: '/data' },
      { local_path: '.', container_path: '/other' },
    ]);
    expect(err).toMatch(/at most one PVC-root mount/);
  });

  it('returns null for empty volumes array', () => {
    expect(validateLocalPaths([])).toBeNull();
  });
});
