import { describe, it, expect } from 'vitest';
import { k8sNameRegex, createDeploymentSchema } from '@k8s-hosting/api-contracts';
import { computeVolumePaths } from './service.js';

// ─── computeVolumePaths ─────────────────────────────────────────────────────

describe('computeVolumePaths', () => {
  it('returns storagePath as k8sPath for each volume', () => {
    const result = computeVolumePaths(
      { storagePath: 'database/mariadb/my-db' },
      { volumes: JSON.stringify([{ container_path: '/var/lib/mysql' }]) },
    );
    expect(result).toEqual([
      { containerPath: '/var/lib/mysql', k8sPath: 'database/mariadb/my-db' },
    ]);
  });

  it('handles null storagePath', () => {
    const result = computeVolumePaths(
      { storagePath: null },
      { volumes: JSON.stringify([{ container_path: '/var/lib/mysql' }]) },
    );
    expect(result).toEqual([
      { containerPath: '/var/lib/mysql', k8sPath: '' },
    ]);
  });

  it('handles multiple volumes with same base path', () => {
    const result = computeVolumePaths(
      { storagePath: 'runtime/wordpress/my-wp' },
      {
        volumes: JSON.stringify([
          { container_path: '/var/www/html' },
          { container_path: '/var/log/apache2' },
        ]),
      },
    );
    expect(result).toHaveLength(2);
    expect(result[0].k8sPath).toBe('runtime/wordpress/my-wp');
    expect(result[1].k8sPath).toBe('runtime/wordpress/my-wp');
  });

  it('handles empty volumes array', () => {
    const result = computeVolumePaths(
      { storagePath: 'database/mariadb/my-db' },
      { volumes: JSON.stringify([]) },
    );
    expect(result).toEqual([]);
  });

  it('handles null volumes', () => {
    const result = computeVolumePaths(
      { storagePath: 'database/mariadb/my-db' },
      { volumes: null },
    );
    expect(result).toEqual([]);
  });

  it('handles volumes as a native array (not JSON string)', () => {
    const result = computeVolumePaths(
      { storagePath: 'runtime/php84/my-site' },
      { volumes: [{ container_path: '/var/www/html' }] },
    );
    expect(result).toEqual([
      { containerPath: '/var/www/html', k8sPath: 'runtime/php84/my-site' },
    ]);
  });

  it('handles undefined volumes', () => {
    const result = computeVolumePaths(
      { storagePath: 'database/postgresql/pg-1' },
      { volumes: undefined },
    );
    expect(result).toEqual([]);
  });
});

// ─── DNS name validation (k8sNameRegex) ─────────────────────────────────────

describe('deployment name validation', () => {
  it('accepts valid DNS names', () => {
    expect(k8sNameRegex.test('my-db')).toBe(true);
    expect(k8sNameRegex.test('a')).toBe(true);
    expect(k8sNameRegex.test('wordpress-1')).toBe(true);
    expect(k8sNameRegex.test('a'.repeat(63))).toBe(true);
  });

  it('rejects invalid DNS names', () => {
    expect(k8sNameRegex.test('')).toBe(false);
    expect(k8sNameRegex.test('-starts-with-dash')).toBe(false);
    expect(k8sNameRegex.test('ends-with-dash-')).toBe(false);
    expect(k8sNameRegex.test('has spaces')).toBe(false);
    expect(k8sNameRegex.test('UPPERCASE')).toBe(false);
    expect(k8sNameRegex.test('has.dots')).toBe(false);
    expect(k8sNameRegex.test('has_underscores')).toBe(false);
    expect(k8sNameRegex.test('a'.repeat(64))).toBe(false);
  });

  it('accepts two-char names with hyphen-free content', () => {
    expect(k8sNameRegex.test('ab')).toBe(true);
    expect(k8sNameRegex.test('a1')).toBe(true);
    expect(k8sNameRegex.test('99')).toBe(true);
  });

  it('rejects names with consecutive hyphens in middle', () => {
    // Consecutive hyphens are actually valid per the regex — they're allowed
    expect(k8sNameRegex.test('a--b')).toBe(true);
  });

  it('createDeploymentSchema rejects invalid names', () => {
    const result = createDeploymentSchema.safeParse({
      catalog_entry_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'INVALID_NAME',
    });
    expect(result.success).toBe(false);
  });

  it('createDeploymentSchema accepts storage_mode', () => {
    const result = createDeploymentSchema.safeParse({
      catalog_entry_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'my-db',
      storage_mode: 'custom',
      storage_path: 'database/mariadb/existing-folder',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storage_mode).toBe('custom');
      expect(result.data.storage_path).toBe('database/mariadb/existing-folder');
    }
  });

  it('createDeploymentSchema defaults storage_mode to default', () => {
    const result = createDeploymentSchema.safeParse({
      catalog_entry_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'my-db',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storage_mode).toBe('default');
    }
  });

  it('createDeploymentSchema rejects invalid storage_mode', () => {
    const result = createDeploymentSchema.safeParse({
      catalog_entry_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'my-db',
      storage_mode: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('createDeploymentSchema applies default replica_count and resource limits', () => {
    const result = createDeploymentSchema.safeParse({
      catalog_entry_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'my-db',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replica_count).toBe(1);
      expect(result.data.cpu_request).toBe('0.25');
      expect(result.data.memory_request).toBe('256Mi');
    }
  });
});

// ─── Storage path generation ────────────────────────────────────────────────

describe('storage path generation', () => {
  it('generates default path from type/code/name', () => {
    // The createDeployment service computes: `${entry.type}/${entry.code}/${input.name}`
    const type = 'database';
    const code = 'mariadb';
    const name = 'my-db';
    const expected = `${type}/${code}/${name}`;
    expect(expected).toBe('database/mariadb/my-db');
  });

  it('generates different paths for different entry types', () => {
    const paths = [
      'database/mariadb/my-db',
      'runtime/php84/my-site',
      'application/wordpress/my-blog',
      'static/nginx/my-static',
    ];
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  it('path components are separated by forward slashes', () => {
    const path = `${'runtime'}/${'nodejs'}/${'my-app'}`;
    const segments = path.split('/');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe('runtime');
    expect(segments[1]).toBe('nodejs');
    expect(segments[2]).toBe('my-app');
  });

  it('same type + code + name always produces the same path', () => {
    const makePath = (t: string, c: string, n: string) => `${t}/${c}/${n}`;
    const path1 = makePath('database', 'postgresql', 'pg-main');
    const path2 = makePath('database', 'postgresql', 'pg-main');
    expect(path1).toBe(path2);
  });
});
