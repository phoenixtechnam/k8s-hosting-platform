import { describe, it, expect } from 'vitest';
import { sanitizeRedirect } from '../sanitize-redirect.js';

// The sanitizer backs the `rd=` query parameter on the Login page. nginx
// sends operators here when they hit a gated subdomain (longhorn.*,
// mail-admin.*, etc) without a valid platform_session. After login the
// page uses the sanitized result to send the browser back. An attacker
// could poison rd= to trick a freshly-logged-in admin into landing on an
// evil host — hence the strict allow-list.

describe('sanitizeRedirect', () => {
  const ADMIN_ORIGIN = 'https://admin.staging.phoenix-host.net';
  const APEX = 'staging.phoenix-host.net';

  it('returns the fallback when rd is null', () => {
    expect(sanitizeRedirect(null, ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('returns the fallback when rd is empty', () => {
    expect(sanitizeRedirect('', ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('passes through a relative same-origin path unchanged', () => {
    expect(sanitizeRedirect('/dashboard', ADMIN_ORIGIN, APEX)).toBe('/dashboard');
  });

  it('passes through a relative path with a query string', () => {
    expect(sanitizeRedirect('/clients?tab=active', ADMIN_ORIGIN, APEX)).toBe('/clients?tab=active');
  });

  it('passes through an absolute URL on the same admin origin', () => {
    const rd = 'https://admin.staging.phoenix-host.net/settings/storage';
    expect(sanitizeRedirect(rd, ADMIN_ORIGIN, APEX)).toBe(rd);
  });

  it('passes through an absolute URL on a sibling admin-only subdomain', () => {
    // longhorn.staging.phoenix-host.net shares the apex — trust it.
    const rd = 'https://longhorn.staging.phoenix-host.net/';
    expect(sanitizeRedirect(rd, ADMIN_ORIGIN, APEX)).toBe(rd);
  });

  it('rejects protocol-relative URLs (//evil.com)', () => {
    expect(sanitizeRedirect('//evil.example.com/phish', ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('rejects absolute URLs pointing at a different apex', () => {
    expect(sanitizeRedirect('https://evil.example.com/', ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('rejects absolute URLs that spoof the apex as a subpath', () => {
    // https://evil.com/staging.phoenix-host.net/ — host is evil.com.
    expect(sanitizeRedirect('https://evil.com/staging.phoenix-host.net/', ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('rejects absolute URLs that embed the apex as a sub-domain suffix', () => {
    // staging.phoenix-host.net.evil.com — attacker-controlled host that
    // ends in ".evil.com", and happens to start with the apex. Must not
    // match the `endsWith('.' + apex)` predicate naively.
    expect(sanitizeRedirect('https://staging.phoenix-host.net.evil.com/', ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('rejects non-http(s) schemes', () => {
    expect(sanitizeRedirect('javascript:alert(1)', ADMIN_ORIGIN, APEX)).toBe('/');
    expect(sanitizeRedirect('data:text/html,<script>alert(1)</script>', ADMIN_ORIGIN, APEX)).toBe('/');
    expect(sanitizeRedirect('file:///etc/passwd', ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('rejects malformed URLs', () => {
    expect(sanitizeRedirect('https://[not-a-url', ADMIN_ORIGIN, APEX)).toBe('/');
  });

  it('preserves hash and query on a same-apex absolute URL', () => {
    const rd = 'https://longhorn.staging.phoenix-host.net/#/backup?env=staging';
    expect(sanitizeRedirect(rd, ADMIN_ORIGIN, APEX)).toBe(rd);
  });

  it('accepts the apex itself (e.g. a root-apex portal) — treated as same-apex', () => {
    const rd = 'https://staging.phoenix-host.net/';
    expect(sanitizeRedirect(rd, ADMIN_ORIGIN, APEX)).toBe(rd);
  });

  it('uses a custom fallback when one is supplied', () => {
    expect(sanitizeRedirect('https://evil.com/', ADMIN_ORIGIN, APEX, '/login-failed')).toBe('/login-failed');
  });

  it('resolves a bare path ("dashboard") against the admin origin — same-apex, safe', () => {
    // WHATWG URL resolution gives https://admin.staging.phoenix-host.net/dashboard
    // which passes the apex gate. Accepted.
    expect(sanitizeRedirect('dashboard', ADMIN_ORIGIN, APEX)).toBe(
      'https://admin.staging.phoenix-host.net/dashboard',
    );
  });

  it('rejects backslash-prefixed paths that some browsers treat as protocol-relative', () => {
    expect(sanitizeRedirect('\\\\evil.com', ADMIN_ORIGIN, APEX)).toBe('/');
  });
});
