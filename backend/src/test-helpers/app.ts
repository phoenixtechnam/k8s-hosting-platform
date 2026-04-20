import { buildApp } from '../app.js';
import { getTestDb } from './db.js';
import type { FastifyInstance } from 'fastify';

export async function buildTestApp(): Promise<FastifyInstance> {
  const db = getTestDb();
  const app = await buildApp({
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://platform:platform@localhost:5433/hosting_platform_test',
      JWT_SECRET: 'test-secret-key-for-testing-only',
      LOG_LEVEL: 'error',
      REDIS_URL: 'redis://localhost:6379',
      PLATFORM_ENV: 'development',
      PLATFORM_VERSION: '0.0.0-test',
      DEFAULT_STORAGE_CLASS: 'local-path',
      PLATFORM_NAMESPACE: 'platform',
      FILE_MANAGER_IMAGE: 'file-manager:test',
      STORAGE_SNAPSHOT_BACKEND: 'hostpath',
      STORAGE_SNAPSHOT_HOST_ROOT: '/tmp/test-snapshots',
      STORAGE_SNAPSHOT_LOCAL_ROOT: '/tmp/test-snapshots',
    },
    db,
  });
  return app;
}

export function generateToken(app: FastifyInstance, payload: {
  sub?: string;
  role?: string;
  panel?: 'admin' | 'client';
  clientId?: string;
}): string {
  return app.jwt.sign({
    sub: payload.sub ?? 'test-user-1',
    role: payload.role ?? 'super_admin',
    panel: payload.panel ?? 'admin',
    clientId: payload.clientId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}
