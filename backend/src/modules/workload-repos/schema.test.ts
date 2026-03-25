import { describe, it, expect } from 'vitest';
import { addRepoInputSchema } from './schema.js';

describe('addRepoInputSchema', () => {
  const validInput = {
    name: 'my-catalog',
    url: 'https://github.com/acme/workloads',
  };

  it('should accept valid input with defaults', () => {
    const result = addRepoInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch).toBe('main');
      expect(result.data.sync_interval_minutes).toBe(60);
    }
  });

  it('should accept custom branch', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, branch: 'develop' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch).toBe('develop');
    }
  });

  it('should accept custom sync_interval_minutes', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, sync_interval_minutes: 30 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sync_interval_minutes).toBe(30);
    }
  });

  it('should accept optional auth_token', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, auth_token: 'ghp_abc123' });
    expect(result.success).toBe(true);
  });

  it('should reject missing name', () => {
    const result = addRepoInputSchema.safeParse({ url: validInput.url });
    expect(result.success).toBe(false);
  });

  it('should reject empty name', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, name: '' });
    expect(result.success).toBe(false);
  });

  it('should reject name longer than 255 characters', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, name: 'a'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('should reject missing url', () => {
    const result = addRepoInputSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(false);
  });

  it('should reject non-GitHub URL', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, url: 'https://gitlab.com/acme/repo' });
    expect(result.success).toBe(false);
  });

  it('should reject non-HTTPS GitHub URL', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, url: 'http://github.com/acme/repo' });
    expect(result.success).toBe(false);
  });

  it('should reject GitHub URL without owner/repo', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, url: 'https://github.com/' });
    expect(result.success).toBe(false);
  });

  it('should reject sync_interval_minutes less than 1', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, sync_interval_minutes: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject sync_interval_minutes greater than 1440', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, sync_interval_minutes: 1441 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer sync_interval_minutes', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, sync_interval_minutes: 30.5 });
    expect(result.success).toBe(false);
  });

  it('should accept auth_token up to 500 characters', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, auth_token: 'a'.repeat(500) });
    expect(result.success).toBe(true);
  });

  it('should reject auth_token longer than 500 characters', () => {
    const result = addRepoInputSchema.safeParse({ ...validInput, auth_token: 'a'.repeat(501) });
    expect(result.success).toBe(false);
  });
});
