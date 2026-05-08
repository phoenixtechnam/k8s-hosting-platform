import { describe, it, expect } from 'vitest';
import { redactCredentialsForUi, clientRowToBundleStatus } from './routes.js';

describe('redactCredentialsForUi', () => {
  it('masks the password in a postgres connection string', () => {
    const msg = 'failed to connect: postgresql://platform:Gu5laahImT1qoZN5GVIHigETQsEuZ3@system-db-rw.platform:5432/hosting_platform';
    const out = redactCredentialsForUi(msg);
    expect(out).toContain('postgresql://platform:***@system-db-rw.platform:5432/hosting_platform');
    expect(out).not.toContain('Gu5laahImT1qoZN5GVIHigETQsEuZ3');
  });

  it('masks credentials in a redis URL', () => {
    const msg = 'redis pool error: redis://default:secret123@valkey-headless.platform:6379';
    expect(redactCredentialsForUi(msg)).toContain('redis://default:***@valkey-headless.platform:6379');
  });

  it('masks password=... query strings (incl. PGPASSWORD env-style)', () => {
    expect(redactCredentialsForUi('PGPASSWORD=hunter2 psql ... password=hunter2'))
      .toBe('PGPASSWORD=*** psql ... password=***');
  });

  it('masks AWS access keys', () => {
    expect(redactCredentialsForUi('upload failed: AKIAIOSFODNN7EXAMPLE rejected'))
      .toContain('AKIA***');
  });

  it('masks 32+ char hex blobs (raw key material)', () => {
    expect(redactCredentialsForUi('OIDC_ENCRYPTION_KEY=abcdef0123456789abcdef0123456789abcdef0123456789'))
      .toContain('OIDC_ENCRYPTION_KEY=***');
  });

  it('leaves harmless messages alone', () => {
    expect(redactCredentialsForUi('Job timed out after 1800s'))
      .toBe('Job timed out after 1800s');
  });

  it('redacts multiple secrets in one message', () => {
    const msg = 'connect failed: postgresql://u:p@h:5432/db; cleanup failed: AKIAIOSFODNN7EXAMPLE';
    const out = redactCredentialsForUi(msg);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain(':p@');
    expect(out).toContain('postgresql://u:***@');
  });
});

describe('clientRowToBundleStatus', () => {
  // Bundles for deleted clients lose the LEFT JOIN row → status is
  // null/undefined. The UI surfaces `missing` so the operator knows
  // the source tenant is gone (and a Restore From Bundle dialog is
  // the only path back).
  it('null/undefined → missing', () => {
    expect(clientRowToBundleStatus(null)).toBe('missing');
    expect(clientRowToBundleStatus(undefined)).toBe('missing');
  });

  it('archived → archived', () => {
    expect(clientRowToBundleStatus('archived')).toBe('archived');
  });

  it('suspended → suspended', () => {
    expect(clientRowToBundleStatus('suspended')).toBe('suspended');
  });

  it('active → active', () => {
    expect(clientRowToBundleStatus('active')).toBe('active');
  });

  it('any unknown clients.status maps to active (defensive)', () => {
    // Future clients.status values default to active so the bundle
    // list never breaks on an enum drift; the dedicated values for
    // suspended/archived are explicit.
    expect(clientRowToBundleStatus('pending')).toBe('active');
    expect(clientRowToBundleStatus('migrating')).toBe('active');
  });
});
