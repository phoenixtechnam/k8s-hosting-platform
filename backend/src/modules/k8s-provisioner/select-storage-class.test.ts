import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectTenantStorageClass } from './service.js';

describe('selectTenantStorageClass', () => {
  const originalEnv = process.env.TENANT_STORAGE_CLASS;

  beforeEach(() => {
    delete process.env.TENANT_STORAGE_CLASS;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.TENANT_STORAGE_CLASS;
    else process.env.TENANT_STORAGE_CLASS = originalEnv;
  });

  describe('production tenant namespaces', () => {
    it('returns longhorn-tenant for typical customer slug', () => {
      expect(selectTenantStorageClass('tenant-acme-corp-9655dbf4')).toBe('longhorn-tenant');
    });

    it('returns longhorn-tenant for slug containing the word "test" (not the pattern)', () => {
      // Defensive: a customer named "testing" or "fast" must not flip to Delete-reclaim
      expect(selectTenantStorageClass('tenant-testing-123')).toBe('longhorn-tenant');
      expect(selectTenantStorageClass('tenant-best-foo-456')).toBe('longhorn-tenant');
      expect(selectTenantStorageClass('tenant-pvc-789')).toBe('longhorn-tenant');
    });

    it('returns longhorn-tenant for plain slug with trailing hex', () => {
      expect(selectTenantStorageClass('tenant-prod-customer-abc12345')).toBe('longhorn-tenant');
    });
  });

  describe('test tenant namespaces', () => {
    it.each([
      ['tenant-integration-test-1779025267-e63cacc3'],
      ['tenant-lifecycle-e2e-1779026778-73c63aa4'],
      ['tenant-passkey-e2e-1779034740-5239417a'],
      ['tenant-pvc-test-l-1779026179-9655dbf4'],
      ['tenant-reaper-test-1779025276-1c1adcdf'],
      ['tenant-bundle-test-1779099999-aaaa'],
      ['tenant-ingress-test-1779099999-bbbb'],
      ['tenant-drain-test-1779099999-cccc'],
      ['tenant-tier-test-1779099999-dddd'],
      ['tenant-grow-test-1779099999-eeee'],
      ['tenant-mail-test-1779099999-ffff'],
      ['tenant-mtls-test-1779099999-1111'],
      ['tenant-firewall-test-1779099999-2222'],
      ['tenant-provision-test-1779099999-3333'],
    ])('returns longhorn-tenant-test for %s', (ns) => {
      expect(selectTenantStorageClass(ns)).toBe('longhorn-tenant-test');
    });

    it('is case-insensitive (defensive — slugs are lowercased today but cheap to be safe)', () => {
      expect(selectTenantStorageClass('tenant-LIFECYCLE-E2E-123-abc')).toBe('longhorn-tenant-test');
    });
  });

  describe('TENANT_STORAGE_CLASS env override', () => {
    it('beats the test pattern (dev cluster uses local-path for everything)', () => {
      process.env.TENANT_STORAGE_CLASS = 'local-path';
      expect(selectTenantStorageClass('tenant-passkey-e2e-1779034740-5239417a')).toBe('local-path');
    });

    it('beats production default too', () => {
      process.env.TENANT_STORAGE_CLASS = 'local-path';
      expect(selectTenantStorageClass('tenant-acme-corp-9655dbf4')).toBe('local-path');
    });

    it('empty string is treated as unset (falls through to default)', () => {
      process.env.TENANT_STORAGE_CLASS = '';
      expect(selectTenantStorageClass('tenant-acme-corp-9655dbf4')).toBe('longhorn-tenant');
    });
  });
});
