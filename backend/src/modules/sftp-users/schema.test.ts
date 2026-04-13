import { describe, it, expect } from 'vitest';
import { createSftpUserSchema, updateSftpUserSchema, rotateSftpPasswordSchema } from './schema.js';

describe('createSftpUserSchema', () => {
  it('should reject empty object (auth_method is required)', () => {
    const result = createSftpUserSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should accept password auth_method with minimal input', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'password' });
    expect(result.success).toBe(true);
  });

  it('should accept ssh_key auth_method with key IDs', () => {
    const result = createSftpUserSchema.safeParse({
      auth_method: 'ssh_key',
      ssh_key_ids: ['key-1', 'key-2'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept ssh_key auth_method without key IDs (validation at service layer)', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'ssh_key' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid auth_method', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'magic' });
    expect(result.success).toBe(false);
  });

  it('should accept full input with password auth and optional fields', () => {
    const result = createSftpUserSchema.safeParse({
      auth_method: 'password',
      description: 'Deploy automation user',
      home_path: '/web',
      allow_write: true,
      allow_delete: false,
      ip_whitelist: '10.0.0.0/8,192.168.1.0/24',
      max_concurrent_sessions: 5,
      expires_at: '2026-12-31T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });

  it('should reject max_concurrent_sessions above 20', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'password', max_concurrent_sessions: 25 });
    expect(result.success).toBe(false);
  });

  it('should reject max_concurrent_sessions below 1', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'password', max_concurrent_sessions: 0 });
    expect(result.success).toBe(false);
  });

  it('should accept nullable ip_whitelist', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'password', ip_whitelist: null });
    expect(result.success).toBe(true);
  });

  it('should accept nullable expires_at', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'password', expires_at: null });
    expect(result.success).toBe(true);
  });

  it('should reject invalid expires_at format', () => {
    const result = createSftpUserSchema.safeParse({ auth_method: 'password', expires_at: 'not-a-date' });
    expect(result.success).toBe(false);
  });
});

describe('updateSftpUserSchema', () => {
  it('should accept empty object (no updates)', () => {
    const result = updateSftpUserSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept partial updates', () => {
    const result = updateSftpUserSchema.safeParse({ description: 'Updated desc' });
    expect(result.success).toBe(true);
  });

  it('should accept enabled boolean', () => {
    expect(updateSftpUserSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(updateSftpUserSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('should accept allow_write and allow_delete booleans', () => {
    const result = updateSftpUserSchema.safeParse({ allow_write: true, allow_delete: false });
    expect(result.success).toBe(true);
  });

  it('should reject max_concurrent_sessions above 20', () => {
    const result = updateSftpUserSchema.safeParse({ max_concurrent_sessions: 21 });
    expect(result.success).toBe(false);
  });
});

describe('rotateSftpPasswordSchema', () => {
  it('should accept empty object (auto-generate)', () => {
    const result = rotateSftpPasswordSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept custom_password >= 12 chars', () => {
    const result = rotateSftpPasswordSchema.safeParse({ custom_password: 'my-secure-pass-123' });
    expect(result.success).toBe(true);
  });

  it('should reject custom_password < 12 chars', () => {
    const result = rotateSftpPasswordSchema.safeParse({ custom_password: 'short' });
    expect(result.success).toBe(false);
  });

  it('should reject custom_password > 128 chars', () => {
    const result = rotateSftpPasswordSchema.safeParse({ custom_password: 'x'.repeat(129) });
    expect(result.success).toBe(false);
  });
});
