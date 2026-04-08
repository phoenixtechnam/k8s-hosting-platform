import { describe, it, expect } from 'vitest';
import {
  renderQueueOutboundToml,
  renderQueueThrottleToml,
  type RenderQueueOutboundInput,
  type RenderQueueThrottleInput,
} from './renderer.js';

describe('renderQueueOutboundToml', () => {
  it('returns a direct delivery config when no relay is configured', () => {
    const input: RenderQueueOutboundInput = { relays: [] };
    const toml = renderQueueOutboundToml(input);
    // Must contain a fallback direct route so Stalwart boots even
    // without any relay configured.
    expect(toml).toContain('[queue.outbound]');
    expect(toml).toContain('next-hop');
    expect(toml).toMatch(/# No relays configured|direct/);
  });

  it('renders a single Mailgun relay with auth credentials', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun EU',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 1,
          smtpHost: 'smtp.eu.mailgun.org',
          smtpPort: 587,
          authUsername: 'postmaster@mg.example.com',
          authPassword: 'secret-password',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).toContain('[queue.outbound]');
    expect(toml).toContain('smtp.eu.mailgun.org');
    expect(toml).toContain('587');
    expect(toml).toContain('postmaster@mg.example.com');
    // Password must be on a line, not injected as a literal
    expect(toml).toContain('secret-password');
    // Should reference the relay by a stable key
    expect(toml).toContain('mailgun-eu');
  });

  it('renders multiple enabled relays as distinct next-hop sources', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 1,
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          authUsername: 'user',
          authPassword: 'pw',
        },
        {
          id: 'r2',
          name: 'Postmark',
          providerType: 'postmark',
          isDefault: 0,
          enabled: 1,
          smtpHost: 'smtp.postmarkapp.com',
          smtpPort: 587,
          authUsername: 'apikey',
          authPassword: 'postmark-token',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).toContain('smtp.mailgun.org');
    expect(toml).toContain('smtp.postmarkapp.com');
    // Default relay wins for the top-level next-hop
    expect(toml).toContain('mailgun');
  });

  it('omits disabled relays', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 0, // disabled
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          authUsername: 'user',
          authPassword: 'pw',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).not.toContain('smtp.mailgun.org');
  });

  it('handles direct provider type (no external relay)', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Direct',
          providerType: 'direct',
          isDefault: 1,
          enabled: 1,
          smtpHost: null,
          smtpPort: null,
          authUsername: null,
          authPassword: null,
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).toContain('[queue.outbound]');
    // Direct delivery = no SMTP relay, Stalwart does its own MX lookup
    expect(toml).toMatch(/direct|mx/);
  });

  it('escapes special TOML characters in relay names', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun "prod"',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 1,
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          authUsername: 'user',
          authPassword: 'p"w',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    // Password with embedded quotes must be escaped or single-quoted
    expect(toml).not.toMatch(/password = "p"w"/);
  });
});

describe('renderQueueThrottleToml', () => {
  it('returns empty when no clients have limits set', () => {
    const input: RenderQueueThrottleInput = {
      defaultRateLimit: null,
      clientOverrides: [],
    };
    const toml = renderQueueThrottleToml(input);
    // Still emits a [queue.throttle] block header for stability
    expect(toml).toContain('[queue.throttle]');
  });

  it('renders the global default throttle rule', () => {
    const input: RenderQueueThrottleInput = {
      defaultRateLimit: 100, // 100/hour global default
      clientOverrides: [],
    };
    const toml = renderQueueThrottleToml(input);
    expect(toml).toContain('100');
    expect(toml).toContain('1h');
  });

  it('renders per-customer overrides alongside the default', () => {
    const input: RenderQueueThrottleInput = {
      defaultRateLimit: 100,
      clientOverrides: [
        { clientId: 'c1', rateLimit: 500, suspended: false },
        { clientId: 'c2', rateLimit: 50, suspended: false },
      ],
    };
    const toml = renderQueueThrottleToml(input);
    expect(toml).toContain('c1');
    expect(toml).toContain('500');
    expect(toml).toContain('c2');
    expect(toml).toContain('50');
  });

  it('sets rate=0 for suspended clients (blocks sending)', () => {
    const input: RenderQueueThrottleInput = {
      defaultRateLimit: 100,
      clientOverrides: [
        { clientId: 'suspended-client', rateLimit: null, suspended: true },
      ],
    };
    const toml = renderQueueThrottleToml(input);
    expect(toml).toContain('suspended-client');
    expect(toml).toMatch(/rate = 0\b|rate\s*=\s*"0/);
  });

  it('suspended override beats any explicit rate_limit', () => {
    const input: RenderQueueThrottleInput = {
      defaultRateLimit: 100,
      clientOverrides: [
        { clientId: 'c1', rateLimit: 500, suspended: true },
      ],
    };
    const toml = renderQueueThrottleToml(input);
    // When suspended, rate must be 0 not 500
    expect(toml).toMatch(/rate = 0/);
  });
});
