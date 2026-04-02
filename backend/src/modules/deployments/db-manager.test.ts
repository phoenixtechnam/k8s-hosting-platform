import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock exec function accessible by both mock and test code
const mockExecFn = vi.fn();

// Mock @kubernetes/client-node before importing db-manager
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromFile: vi.fn(),
    loadFromCluster: vi.fn(),
  })),
  Exec: vi.fn().mockImplementation(() => ({
    exec: mockExecFn,
  })),
}));

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  buildDbContext,
  listDatabases,
  createDatabase,
  listUsers,
  createUser,
  dropUser,
  setUserPassword,
} from './db-manager.js';

function createMockK8s(pods: Array<{ name: string; phase: string }>): K8sClients {
  return {
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: pods.map((p) => ({
          metadata: { name: p.name },
          status: { phase: p.phase },
        })),
      }),
    },
    apps: {} as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
    custom: {} as K8sClients['custom'],
  } as unknown as K8sClients;
}

function setupExecSuccess(stdout: string, stderr = '') {
  mockExecFn.mockImplementation(
    (
      _ns: string,
      _pod: string,
      _container: string,
      _command: string[],
      stdoutStream: NodeJS.WritableStream,
      stderrStream: NodeJS.WritableStream,
      _stdin: null,
      _tty: boolean,
      callback: (status: Record<string, unknown>) => void,
    ) => {
      if (stdout) stdoutStream.write(Buffer.from(stdout));
      if (stderr) stderrStream.write(Buffer.from(stderr));
      setTimeout(() => callback({ status: 'Success' }), 0);
      return Promise.resolve({} as unknown);
    },
  );
}

function setupExecFailure(stderr: string) {
  mockExecFn.mockImplementation(
    (
      _ns: string,
      _pod: string,
      _container: string,
      _command: string[],
      _stdoutStream: NodeJS.WritableStream,
      stderrStream: NodeJS.WritableStream,
      _stdin: null,
      _tty: boolean,
      callback: (status: Record<string, unknown>) => void,
    ) => {
      stderrStream.write(Buffer.from(stderr));
      setTimeout(() => callback({ status: 'Failure' }), 0);
      return Promise.resolve({} as unknown);
    },
  );
}

describe('db-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildDbContext', () => {
    it('should detect mariadb engine from catalog entry runtime', async () => {
      const k8s = createMockK8s([{ name: 'mydb-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        '/tmp/kubeconfig',
        'client-abc',
        'mydb',
        { runtime: 'mariadb', code: 'mariadb' },
        { MARIADB_ROOT_PASSWORD: 'secret123' },
      );

      expect(ctx.engine).toBe('mariadb');
      expect(ctx.rootPassword).toBe('secret123');
      expect(ctx.podName).toBe('mydb-0');
      expect(ctx.containerName).toBe('mariadb');
      expect(ctx.namespace).toBe('client-abc');
    });

    it('should detect postgresql engine', async () => {
      const k8s = createMockK8s([{ name: 'pgdb-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        undefined,
        'client-abc',
        'pgdb',
        { runtime: 'postgresql', code: 'postgresql' },
        {},
      );

      expect(ctx.engine).toBe('postgresql');
      expect(ctx.rootPassword).toBe('');
    });

    it('should detect postgres alias', async () => {
      const k8s = createMockK8s([{ name: 'pgdb-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        undefined,
        'client-abc',
        'pgdb',
        { runtime: 'postgres', code: 'postgres' },
        {},
      );

      expect(ctx.engine).toBe('postgresql');
    });

    it('should detect mysql engine', async () => {
      const k8s = createMockK8s([{ name: 'mysql-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        undefined,
        'client-abc',
        'mysql-inst',
        { runtime: 'mysql', code: 'mysql' },
        { MYSQL_ROOT_PASSWORD: 'mysecret' },
      );

      expect(ctx.engine).toBe('mysql');
      expect(ctx.rootPassword).toBe('mysecret');
    });

    it('should throw for unsupported engine', async () => {
      const k8s = createMockK8s([{ name: 'redis-0', phase: 'Running' }]);

      await expect(
        buildDbContext(k8s, undefined, 'client-abc', 'redis', { runtime: 'redis', code: 'redis' }, {}),
      ).rejects.toThrow('not supported for management');
    });

    it('should throw when no running pod found', async () => {
      const k8s = createMockK8s([{ name: 'mydb-0', phase: 'Pending' }]);

      await expect(
        buildDbContext(k8s, undefined, 'client-abc', 'mydb', { runtime: 'mariadb', code: 'mariadb' }, {}),
      ).rejects.toThrow('No running pod found');
    });

    it('should throw when no pods at all', async () => {
      const k8s = createMockK8s([]);

      await expect(
        buildDbContext(k8s, undefined, 'client-abc', 'mydb', { runtime: 'mariadb', code: 'mariadb' }, {}),
      ).rejects.toThrow('No running pod found');
    });
  });

  describe('listDatabases', () => {
    it('should list mysql databases excluding system databases', async () => {
      setupExecSuccess('information_schema\nmysql\nperformance_schema\nsys\nmyapp_db\ntest_db');

      const ctx = {
        kubeconfigPath: '/tmp/kubeconfig',
        namespace: 'client-abc',
        podName: 'mydb-0',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'secret',
      };

      const dbs = await listDatabases(ctx);
      expect(dbs).toEqual([{ name: 'myapp_db' }, { name: 'test_db' }]);
    });

    it('should list postgresql databases excluding postgres', async () => {
      setupExecSuccess('myapp_db\ntest_db');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'client-abc',
        podName: 'pgdb-0',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const dbs = await listDatabases(ctx);
      expect(dbs).toEqual([{ name: 'myapp_db' }, { name: 'test_db' }]);
    });

    it('should return empty array when no user databases exist', async () => {
      setupExecSuccess('information_schema\nmysql\nperformance_schema\nsys');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const dbs = await listDatabases(ctx);
      expect(dbs).toEqual([]);
    });
  });

  describe('createDatabase', () => {
    it('should reject invalid database names', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createDatabase(ctx, 'my-db')).rejects.toThrow('Invalid database name');
      await expect(createDatabase(ctx, '123abc')).rejects.toThrow('Invalid database name');
      await expect(createDatabase(ctx, 'a'.repeat(65))).rejects.toThrow('Invalid database name');
      await expect(createDatabase(ctx, '')).rejects.toThrow('Invalid database name');
    });

    it('should accept valid database names for mariadb', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createDatabase(ctx, 'my_database')).resolves.toBeUndefined();
    });

    it('should accept valid database names for postgresql', async () => {
      // PG needs two exec calls: SELECT check + CREATE
      let callCount = 0;
      mockExecFn.mockImplementation(
        (
          _ns: string,
          _pod: string,
          _container: string,
          _command: string[],
          stdoutStream: NodeJS.WritableStream,
          _stderrStream: NodeJS.WritableStream,
          _stdin: null,
          _tty: boolean,
          callback: (status: Record<string, unknown>) => void,
        ) => {
          // First call: check if db exists (return empty = doesn't exist)
          // Second call: create db
          if (callCount === 0) {
            // empty stdout means db doesn't exist
          }
          callCount++;
          setTimeout(() => callback({ status: 'Success' }), 0);
          return Promise.resolve({} as unknown);
        },
      );

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      await expect(createDatabase(ctx, 'new_db')).resolves.toBeUndefined();
    });
  });

  describe('listUsers', () => {
    it('should list mysql users excluding system users', async () => {
      setupExecSuccess('root\t%\nmariadb.sys\tlocalhost\napp_user\t%\nreader\t%');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const users = await listUsers(ctx);
      expect(users).toEqual([
        { username: 'app_user', host: '%' },
        { username: 'reader', host: '%' },
      ]);
    });

    it('should list postgresql users', async () => {
      setupExecSuccess('app_user\nreader');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const users = await listUsers(ctx);
      expect(users).toEqual([
        { username: 'app_user', host: '*' },
        { username: 'reader', host: '*' },
      ]);
    });
  });

  describe('createUser', () => {
    it('should reject invalid usernames', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createUser(ctx, 'user-name', 'pass')).rejects.toThrow('Invalid username');
      await expect(createUser(ctx, '', 'pass')).rejects.toThrow('Invalid username');
    });

    it('should reject invalid database names in grant', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createUser(ctx, 'good_user', 'pass', 'bad-db')).rejects.toThrow('Invalid database name');
    });

    it('should create user with database grant for mysql', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createUser(ctx, 'new_user', 'pass123', 'mydb')).resolves.toBeUndefined();
      // Should have called exec 3 times: CREATE USER, GRANT, FLUSH
      expect(mockExecFn).toHaveBeenCalledTimes(3);
    });
  });

  describe('dropUser', () => {
    it('should validate username before dropping', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(dropUser(ctx, 'invalid-user')).rejects.toThrow('Invalid username');
    });

    it('should drop valid user for mysql', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(dropUser(ctx, 'old_user')).resolves.toBeUndefined();
    });
  });

  describe('setUserPassword', () => {
    it('should execute password change for mysql', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(setUserPassword(ctx, 'app_user', 'new_pass')).resolves.toBeUndefined();
      // ALTER USER + FLUSH PRIVILEGES
      expect(mockExecFn).toHaveBeenCalledTimes(2);
    });

    it('should execute password change for postgresql', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      await expect(setUserPassword(ctx, 'app_user', 'new_pass')).resolves.toBeUndefined();
      expect(mockExecFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('exec error handling', () => {
    it('should throw when pod exec fails', async () => {
      setupExecFailure('ERROR 1045 (28000): Access denied');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'wrong',
      };

      await expect(listDatabases(ctx)).rejects.toThrow();
    });
  });
});
