import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = 'mysql://user:pass@localhost:3306/db';
    process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should load valid config with defaults', () => {
    const config = loadConfig();
    expect(config.PORT).toBe(0); // PORT=0 from test-setup.ts
    expect(config.NODE_ENV).toBe('test'); // set in test-setup.ts
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DATABASE_URL).toBe('mysql://user:pass@localhost:3306/db');
  });

  it('should accept custom PORT', () => {
    process.env.PORT = '8080';
    const config = loadConfig();
    expect(config.PORT).toBe(8080);
  });

  it('should reject missing JWT_SECRET', () => {
    delete process.env.JWT_SECRET;
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('should reject JWT_SECRET shorter than 16 chars', () => {
    process.env.JWT_SECRET = 'short';
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('should reject missing DATABASE_URL', () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('should accept valid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'debug';
    const config = loadConfig();
    expect(config.LOG_LEVEL).toBe('debug');
  });
});
