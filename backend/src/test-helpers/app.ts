import { buildApp } from '../app.js';
import { getTestDb } from './db.js';
import type { FastifyInstance } from 'fastify';

export async function buildTestApp(): Promise<FastifyInstance> {
  const db = getTestDb();
  const app = await buildApp({
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://platform:platform@localhost:3307/hosting_platform_test',
      JWT_SECRET: 'test-secret-key-for-testing-only',
      LOG_LEVEL: 'error',
    },
    db,
  });
  return app;
}

export function generateToken(app: FastifyInstance, payload: {
  sub?: string;
  role?: 'admin' | 'billing' | 'support' | 'read-only';
}): string {
  return app.jwt.sign({
    sub: payload.sub ?? 'test-user-1',
    role: payload.role ?? 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}
