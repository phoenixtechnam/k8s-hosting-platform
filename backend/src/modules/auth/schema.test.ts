import { describe, it, expect } from 'vitest';
import { loginSchema } from './schema.js';

describe('loginSchema', () => {
  it('should accept valid input', () => {
    const result = loginSchema.safeParse({ email: 'admin@example.com', password: 'secret123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('admin@example.com');
      expect(result.data.password).toBe('secret123');
    }
  });

  it('should reject missing email', () => {
    const result = loginSchema.safeParse({ password: 'secret123' });
    expect(result.success).toBe(false);
  });

  it('should reject invalid email format', () => {
    const result = loginSchema.safeParse({ email: 'not-an-email', password: 'secret123' });
    expect(result.success).toBe(false);
  });

  it('should reject empty password', () => {
    const result = loginSchema.safeParse({ email: 'admin@example.com', password: '' });
    expect(result.success).toBe(false);
  });

  it('should reject missing password', () => {
    const result = loginSchema.safeParse({ email: 'admin@example.com' });
    expect(result.success).toBe(false);
  });

  it('should reject empty object', () => {
    const result = loginSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject email without domain', () => {
    const result = loginSchema.safeParse({ email: 'admin@', password: 'secret123' });
    expect(result.success).toBe(false);
  });
});
