import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isHookAuthoritative,
  _setHookFlagForTests,
} from './feature-flags.js';

describe('feature-flags', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.LIFECYCLE_HOOK_PV_CLEANUP;
    delete process.env.LIFECYCLE_HOOK_PV_CLEANUP;
    _setHookFlagForTests('pv-cleanup-released', undefined);
  });
  afterEach(() => {
    if (originalEnv == null) delete process.env.LIFECYCLE_HOOK_PV_CLEANUP;
    else process.env.LIFECYCLE_HOOK_PV_CLEANUP = originalEnv;
    _setHookFlagForTests('pv-cleanup-released', undefined);
  });

  it('returns false (legacy) when env unset and default is legacy', () => {
    expect(isHookAuthoritative('pv-cleanup-released')).toBe(false);
  });

  it('returns true (hook) when env=hook', () => {
    process.env.LIFECYCLE_HOOK_PV_CLEANUP = 'hook';
    expect(isHookAuthoritative('pv-cleanup-released')).toBe(true);
  });

  it('returns false when env=legacy explicitly', () => {
    process.env.LIFECYCLE_HOOK_PV_CLEANUP = 'legacy';
    expect(isHookAuthoritative('pv-cleanup-released')).toBe(false);
  });

  it('test override beats env', () => {
    process.env.LIFECYCLE_HOOK_PV_CLEANUP = 'legacy';
    _setHookFlagForTests('pv-cleanup-released', 'hook');
    expect(isHookAuthoritative('pv-cleanup-released')).toBe(true);
  });

  it('returns false for unknown flag names', () => {
    expect(isHookAuthoritative('unknown-flag')).toBe(false);
  });

  it('handles empty/whitespace env value as default', () => {
    process.env.LIFECYCLE_HOOK_PV_CLEANUP = '   ';
    expect(isHookAuthoritative('pv-cleanup-released')).toBe(false);
  });

  it('is case-insensitive on env value', () => {
    process.env.LIFECYCLE_HOOK_PV_CLEANUP = 'HOOK';
    expect(isHookAuthoritative('pv-cleanup-released')).toBe(true);
  });

  it('respects "disable" as an explicit kill-switch (returns false)', () => {
    process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP = 'disable';
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(false);
    delete process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP;
  });

  it('Phase 4 hooks default to authoritative when env unset', () => {
    delete process.env.LIFECYCLE_HOOK_DNS_ZONE_CLEANUP;
    delete process.env.LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP;
    expect(isHookAuthoritative('dns-zone-cleanup')).toBe(true);
    expect(isHookAuthoritative('backups-v2-bundle-cleanup')).toBe(true);
  });
});
