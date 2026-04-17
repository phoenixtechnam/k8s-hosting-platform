import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStalwartCredentials } from './credentials.js';

describe('readStalwartCredentials', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stalwart-creds-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers the mounted Secret file over env vars (live rotation support)', () => {
    writeFileSync(join(tmp, 'ADMIN_SECRET_PLAIN'), 'rotated-from-secret\n');
    expect(readStalwartCredentials({
      STALWART_ADMIN_CREDS_DIR: tmp,
      STALWART_ADMIN_PASSWORD: 'stale-from-env',
    })).toEqual({ username: 'admin', password: 'rotated-from-secret' });
  });

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

  it('ignores an empty/whitespace-only secret file and falls through to env', () => {
    writeFileSync(join(tmp, 'ADMIN_SECRET_PLAIN'), '\n  \n');
    expect(readStalwartCredentials({
      STALWART_ADMIN_CREDS_DIR: tmp,
      STALWART_ADMIN_PASSWORD: 'env-win',
    })).toEqual({ username: 'admin', password: 'env-win' });
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

  it('throws when no password-like source is configured', () => {
    expect(() => readStalwartCredentials({})).toThrow(/Stalwart admin password/i);
  });

  it('throws when password env var is whitespace only', () => {
    expect(() => readStalwartCredentials({ STALWART_ADMIN_PASSWORD: '   ' })).toThrow();
  });
});
