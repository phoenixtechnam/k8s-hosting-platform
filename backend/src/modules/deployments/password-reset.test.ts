import { describe, it, expect } from 'vitest';
import { buildPasswordResetInitContainer } from './password-reset.js';

describe('buildPasswordResetInitContainer', () => {
  const baseArgs = {
    storagePath: 'database/mariadb/my-db',
    volumeMountName: 'client-storage',
  };

  describe('MariaDB', () => {
    it('returns init container for mariadb with correct image and ALTER USER', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('reset-root-password');
      expect(result!.image).toBe('mariadb:11');
      expect(result!.command[0]).toBe('sh');
      expect(result!.command[2]).toContain('mariadbd');
      expect(result!.command[2]).toContain('--skip-networking');
      expect(result!.command[2]).toContain('--skip-grant-tables');
      expect(result!.command[2]).toContain('ALTER USER');
      expect(result!.command[2]).toContain('MARIADB_ROOT_PASSWORD');
    });

    it('mounts the PVC at the correct path', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
      });

      const mount = result!.volumeMounts.find((m: { mountPath: string }) => m.mountPath === '/var/lib/mysql');
      expect(mount).toBeDefined();
      expect(mount!.subPath).toBe('database/mariadb/my-db');
    });

    it('skips if data directory marker is absent', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
      });

      expect(result!.command[2]).toContain('if [ ! -d');
    });
  });

  describe('MySQL', () => {
    it('returns init container for mysql with mysqld --skip-grant-tables', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/mysql/my-db',
        catalogCode: 'mysql',
        image: 'mysql:8.4',
        passwordEnvVar: 'MYSQL_ROOT_PASSWORD',
      });

      expect(result).not.toBeNull();
      expect(result!.image).toBe('mysql:8.4');
      expect(result!.command[2]).toContain('mysqld');
      expect(result!.command[2]).toContain('--skip-networking');
      expect(result!.command[2]).toContain('--skip-grant-tables');
      expect(result!.command[2]).toContain('MYSQL_ROOT_PASSWORD');
    });
  });

  describe('PostgreSQL', () => {
    it('returns init container for postgresql with pg_hba.conf trust method', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/postgresql/my-db',
        catalogCode: 'postgresql',
        image: 'postgres:18',
        passwordEnvVar: 'POSTGRES_PASSWORD',
      });

      expect(result).not.toBeNull();
      expect(result!.image).toBe('postgres:18');
      expect(result!.command[2]).toContain('pg_hba.conf');
      expect(result!.command[2]).toContain('trust');
      expect(result!.command[2]).toContain('ALTER USER');
      expect(result!.command[2]).toContain('pg_ctl');
    });

    it('detects existing data via PG_VERSION file', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/postgresql/my-db',
        catalogCode: 'postgresql',
        image: 'postgres:18',
        passwordEnvVar: 'POSTGRES_PASSWORD',
      });

      expect(result!.command[2]).toContain('PG_VERSION');
    });
  });

  describe('MongoDB', () => {
    it('returns init container for mongodb with no-auth mode', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/mongodb-7/my-db',
        catalogCode: 'mongodb-7',
        image: 'mongo:7',
        passwordEnvVar: 'MONGO_INITDB_ROOT_PASSWORD',
        passwordEnvVarUser: 'MONGO_INITDB_ROOT_USERNAME',
      });

      expect(result).not.toBeNull();
      expect(result!.image).toBe('mongo:7');
      expect(result!.command[2]).toContain('mongod');
      expect(result!.command[2]).toContain('--bind_ip 127.0.0.1');
      expect(result!.command[2]).toContain('changeUserPassword');
    });

    it('detects existing data via WiredTiger file', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/mongodb-7/my-db',
        catalogCode: 'mongodb-7',
        image: 'mongo:7',
        passwordEnvVar: 'MONGO_INITDB_ROOT_PASSWORD',
        passwordEnvVarUser: 'MONGO_INITDB_ROOT_USERNAME',
      });

      expect(result!.command[2]).toContain('WiredTiger');
    });
  });

  describe('non-database entries', () => {
    it('returns null for non-database catalog codes', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'nginx-php',
        image: 'nginx:latest',
        passwordEnvVar: '',
      });

      expect(result).toBeNull();
    });

    it('returns null for empty passwordEnvVar', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: '',
      });

      expect(result).toBeNull();
    });
  });
});
