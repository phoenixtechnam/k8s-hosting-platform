import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isHookAuthoritative,
  _setHookFlagForTests,
} from './feature-flags.js';

/**
 * Phase 6 left only the dns-zone-cleanup and backups-v2-bundle-
 * cleanup hooks behind feature flags (both default `hook`). These
 * tests exercise the same resolver logic the retired Phase 2/3 flags
 * used; the flag map shape is unchanged so the contract is stable.
 */
describe('feature-flags', () => {
  let savedDns: string | undefined;
  let savedS3: string | undefined;

  beforeEach(() => {
    savedDns = process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP;
    savedS3 = process.env.LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP;
    delete process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP;
    delete process.env.LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP;
    _setHookFlagForTests('dns-zone-cleanup', undefined);
    _setHookFlagForTests('backups-v2-bundle-cleanup', undefined);
  });
  afterEach(() => {
    if (savedDns == null) delete process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP;
    else process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = savedDns;
    if (savedS3 == null) delete process.env.LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP;
    else process.env.LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP = savedS3;
    _setHookFlagForTests('dns-zone-cleanup', undefined);
    _setHookFlagForTests('backups-v2-bundle-cleanup', undefined);
  });

  it('returns true (default hook) when env unset', () => {
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(true);
    expect(isHookAuthoritative('backups-v2-bundle-cleanup')).toBe(true);
  });

  it('returns true when env=hook', () => {
    process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = 'hook';
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(true);
  });

  it('returns false when env=disable (kill-switch)', () => {
    process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = 'disable';
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(false);
  });

  it('returns false when env=legacy', () => {
    process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = 'legacy';
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(false);
  });

  it('test override beats env', () => {
    process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = 'disable';
    _setHookFlagForTests('dns-zone-cleanup', 'hook');
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(true);
  });

  it('returns false for unknown flag names (e.g. retired Phase 2/3 names)', () => {
    expect(isHookAuthoritative('pv-cleanup-released')).toBe(false);
    expect(isHookAuthoritative('db-cascades')).toBe(false);
    expect(isHookAuthoritative('unknown-flag')).toBe(false);
  });

  it('handles empty/whitespace env value as default', () => {
    process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = '   ';
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(true);
  });

  it('is case-insensitive on env value', () => {
    process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = 'DISABLE';
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(false);
  });
});
