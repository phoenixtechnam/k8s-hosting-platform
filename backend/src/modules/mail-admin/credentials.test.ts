import { describe, expect, it } from 'vitest';
import { readStalwartCredentials } from './credentials.js';

describe('readStalwartCredentials', () => {
  it('returns STALWART_ADMIN_USER + STALWART_ADMIN_PASSWORD when both set', () => {
    expect(readStalwartCredentials({
      STALWART_ADMIN_USER: 'svc-admin',
      STALWART_ADMIN_PASSWORD: 'hunter2',
    })).toEqual({ username: 'svc-admin', password: 'hunter2' });
  });

  it('falls back to ADMIN_SECRET_PLAIN when STALWART_ADMIN_PASSWORD is not set', () => {
    expect(readStalwartCredentials({
      ADMIN_SECRET_PLAIN: 'legacy-password',
    })).toEqual({ username: 'admin', password: 'legacy-password' });
  });

  it('prefers STALWART_ADMIN_PASSWORD over legacy env names', () => {
    expect(readStalwartCredentials({
      STALWART_ADMIN_PASSWORD: 'new-env-password',
      STALWART_ADMIN_SECRET_PLAIN: 'old-env-1',
      ADMIN_SECRET_PLAIN: 'old-env-2',
    })).toEqual({ username: 'admin', password: 'new-env-password' });
  });

  it('defaults username to "admin" when STALWART_ADMIN_USER is empty/missing', () => {
    expect(readStalwartCredentials({ STALWART_ADMIN_PASSWORD: 'pw' })).toEqual({
      username: 'admin',
      password: 'pw',
    });
    expect(readStalwartCredentials({
      STALWART_ADMIN_USER: '',
      STALWART_ADMIN_PASSWORD: 'pw',
    })).toEqual({ username: 'admin', password: 'pw' });
  });

  it('throws when no password-like env var is set', () => {
    expect(() => readStalwartCredentials({})).toThrow(/STALWART_ADMIN_PASSWORD/);
  });

  it('throws when password env var is whitespace only', () => {
    expect(() => readStalwartCredentials({ STALWART_ADMIN_PASSWORD: '   ' })).toThrow();
  });
});
