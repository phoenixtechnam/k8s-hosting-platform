import { describe, it, expect } from 'vitest';
import {
  resolveBaseDomain,
  adminHost,
  clientHost,
  mailHost,
  mailAdminHost,
  dexHost,
  webmailHost,
  DEV_DEFAULT_BASE_DOMAIN,
} from './domains.js';

/**
 * Every platform service in dev and prod derives its hostname from a single
 * PLATFORM_BASE_DOMAIN. Tests lock that derivation down so a subdomain never
 * drifts by accident — renaming `admin.` → `console.` should touch one
 * constant here plus the test, not 15 YAML files.
 */

describe('resolveBaseDomain', () => {
  it('prefers PLATFORM_BASE_DOMAIN from config', () => {
    expect(resolveBaseDomain({ PLATFORM_BASE_DOMAIN: 'example.com' })).toBe('example.com');
  });

  it('falls back to INGRESS_BASE_DOMAIN when PLATFORM_BASE_DOMAIN is unset', () => {
    // INGRESS_BASE_DOMAIN pre-existed; PLATFORM_BASE_DOMAIN is the rename.
    expect(resolveBaseDomain({ INGRESS_BASE_DOMAIN: 'legacy.com' })).toBe('legacy.com');
  });

  it('falls back to the dev default when nothing is set', () => {
    expect(resolveBaseDomain({})).toBe(DEV_DEFAULT_BASE_DOMAIN);
    expect(DEV_DEFAULT_BASE_DOMAIN).toBe('k8s-platform.test');
  });

  it('trims whitespace and strips leading dots', () => {
    expect(resolveBaseDomain({ PLATFORM_BASE_DOMAIN: ' .example.com ' })).toBe('example.com');
  });
});

describe('subdomain helpers', () => {
  const cfg = { PLATFORM_BASE_DOMAIN: 'acme.example' };

  it('adminHost → admin.<base>', () => {
    expect(adminHost(cfg)).toBe('admin.acme.example');
  });

  it('clientHost → client.<base>', () => {
    expect(clientHost(cfg)).toBe('client.acme.example');
  });

  it('mailHost → mail.<base>', () => {
    expect(mailHost(cfg)).toBe('mail.acme.example');
  });

  it('mailAdminHost → mail-admin.<base>', () => {
    expect(mailAdminHost(cfg)).toBe('mail-admin.acme.example');
  });

  it('dexHost → dex.<base>', () => {
    expect(dexHost(cfg)).toBe('dex.acme.example');
  });

  it('webmailHost → webmail.<base>', () => {
    expect(webmailHost(cfg)).toBe('webmail.acme.example');
  });

  it('all helpers use the dev default when no override is set', () => {
    expect(adminHost({})).toBe('admin.k8s-platform.test');
    expect(dexHost({})).toBe('dex.k8s-platform.test');
    expect(webmailHost({})).toBe('webmail.k8s-platform.test');
  });

  it('all helpers respect PLATFORM_BASE_DOMAIN over INGRESS_BASE_DOMAIN', () => {
    const cfgBoth = { PLATFORM_BASE_DOMAIN: 'new.com', INGRESS_BASE_DOMAIN: 'old.com' };
    expect(adminHost(cfgBoth)).toBe('admin.new.com');
    expect(dexHost(cfgBoth)).toBe('dex.new.com');
  });
});
