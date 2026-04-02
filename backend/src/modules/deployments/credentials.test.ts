import { describe, it, expect } from 'vitest';
import { generateSecurePassword } from './service.js';

describe('generateSecurePassword', () => {
  const validChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';

  it('should return a string of the requested length', () => {
    expect(generateSecurePassword(16)).toHaveLength(16);
    expect(generateSecurePassword(32)).toHaveLength(32);
    expect(generateSecurePassword(64)).toHaveLength(64);
    expect(generateSecurePassword(1)).toHaveLength(1);
  });

  it('should only contain valid characters', () => {
    const password = generateSecurePassword(256);
    for (const char of password) {
      expect(validChars).toContain(char);
    }
  });

  it('should generate unique passwords across 100 invocations', () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 100; i++) {
      passwords.add(generateSecurePassword(32));
    }
    expect(passwords.size).toBe(100);
  });

  it('should return an empty string for length 0', () => {
    expect(generateSecurePassword(0)).toBe('');
  });
});
