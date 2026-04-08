/**
 * Stalwart [queue.outbound] + [queue.throttle] TOML renderer.
 *
 * Pure function — takes DB-derived inputs, returns a TOML fragment
 * string that gets written into the Stalwart ConfigMap via a
 * `[queue.outbound]` + `[queue.throttle]` section. The reconciler
 * in service.ts then calls kubectl patch + stalwart-cli reload.
 *
 * Separated from the reconciler so the pure rendering logic has
 * golden-file unit tests without k8s / DB mocks.
 *
 * References:
 *   - docs/06-features/EMAIL_SERVICES.md (decision D10 — relay-by-default)
 *   - Stalwart docs on queue outbound routing:
 *     https://stalw.art/docs/configuration/queue/outbound/
 */

export interface OutboundRelay {
  readonly id: string;
  readonly name: string;
  readonly providerType: 'direct' | 'mailgun' | 'postmark' | string;
  readonly isDefault: number;
  readonly enabled: number;
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly authUsername: string | null;
  readonly authPassword: string | null;
}

export interface RenderQueueOutboundInput {
  readonly relays: readonly OutboundRelay[];
}

export interface ClientThrottleOverride {
  readonly clientId: string;
  readonly rateLimit: number | null; // messages / hour; null = inherit default
  readonly suspended: boolean;
}

export interface RenderQueueThrottleInput {
  readonly defaultRateLimit: number | null;
  readonly clientOverrides: readonly ClientThrottleOverride[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function tomlSingleQuotedString(value: string): string {
  // TOML literal strings use single quotes. They don't support any
  // escapes, so we can't include single quotes inside. Rare for a
  // password but if it happens we fall back to a basic double-quoted
  // string with backslash escapes.
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function sanitizeKey(raw: string): string {
  // Stalwart TOML keys are lowercase alphanumeric + hyphens; used as
  // stable identifiers for next-hop references.
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

// ─── Outbound queue renderer ──────────────────────────────────────────────

export function renderQueueOutboundToml(input: RenderQueueOutboundInput): string {
  const enabled = input.relays.filter((r) => r.enabled === 1);
  const lines: string[] = [];

  lines.push('# ─── Outbound queue (Phase 3.B.1) ──────────────────────────────────');
  lines.push('# Rendered by backend/src/modules/email-outbound/renderer.ts');
  lines.push('# from the smtp_relay_configs table. Do not edit by hand — the');
  lines.push('# reconciler will overwrite it.');
  lines.push('');

  if (enabled.length === 0) {
    lines.push('[queue.outbound]');
    lines.push('# No relays configured — Stalwart falls back to direct MX delivery.');
    lines.push('# Configure an SMTP relay via the admin panel to route outbound mail.');
    lines.push('next-hop = "direct"');
    lines.push('');
    return lines.join('\n');
  }

  // Pick the default relay (the one flagged isDefault=1, or the first
  // enabled relay if no default is set).
  const defaultRelay =
    enabled.find((r) => r.isDefault === 1) ?? enabled[0];
  const defaultKey = sanitizeKey(defaultRelay.name);

  lines.push('[queue.outbound]');
  if (defaultRelay.providerType === 'direct') {
    lines.push('# Default relay is direct delivery — Stalwart does its own MX lookup.');
    lines.push('next-hop = "direct"');
  } else {
    lines.push(`next-hop = "${defaultKey}"`);
  }
  lines.push('');

  // Emit a [remote.<key>] block for each non-direct relay
  for (const relay of enabled) {
    if (relay.providerType === 'direct') continue;
    if (!relay.smtpHost) continue;
    const key = sanitizeKey(relay.name);

    lines.push(`[remote.${key}]`);
    lines.push('type = "smtp"');
    lines.push(`address = '${relay.smtpHost}'`);
    lines.push(`port = ${relay.smtpPort ?? 587}`);
    lines.push('protocol = "smtp"');
    lines.push('tls.implicit = false'); // STARTTLS on submission port
    lines.push('tls.allow-invalid-certs = false');

    if (relay.authUsername && relay.authPassword) {
      lines.push(`auth.username = ${tomlSingleQuotedString(relay.authUsername)}`);
      lines.push(`auth.secret = ${tomlSingleQuotedString(relay.authPassword)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Throttle renderer ────────────────────────────────────────────────────

export function renderQueueThrottleToml(input: RenderQueueThrottleInput): string {
  const lines: string[] = [];

  lines.push('# ─── Outbound throttle (Phase 3.B.3) ───────────────────────────────');
  lines.push('# Per-customer send rate limits rendered from:');
  lines.push('#   - platform_settings.email_send_rate_limit_default (global default)');
  lines.push('#   - clients.email_send_rate_limit (per-customer override)');
  lines.push('#   - clients.status (suspended → rate = 0)');
  lines.push('');

  lines.push('[queue.throttle]');
  lines.push('');

  // Global default rule (applies to any sender that doesn't match a
  // more specific rule below).
  if (input.defaultRateLimit !== null && input.defaultRateLimit > 0) {
    lines.push('[queue.throttle.default]');
    lines.push('key = ["sender-domain"]');
    lines.push(`rate = "${input.defaultRateLimit}/1h"`);
    lines.push('');
  } else {
    lines.push('# No global default rate limit configured.');
    lines.push('');
  }

  // Per-customer overrides
  for (const override of input.clientOverrides) {
    const key = sanitizeKey(`client-${override.clientId}`);
    lines.push(`[queue.throttle.${key}]`);
    lines.push(`key = ["sender-domain"]`);
    lines.push(`match = "authenticated-as = '${override.clientId}'"`);

    if (override.suspended) {
      // Suspended clients get rate=0 — blocks all outbound.
      lines.push('rate = 0');
      lines.push('enable = true');
    } else if (override.rateLimit !== null && override.rateLimit > 0) {
      lines.push(`rate = "${override.rateLimit}/1h"`);
      lines.push('enable = true');
    } else {
      // Inherit the default — don't emit a rule, Stalwart's default
      // rule applies.
      lines.push('enable = false');
    }
    lines.push('');
  }

  return lines.join('\n');
}
