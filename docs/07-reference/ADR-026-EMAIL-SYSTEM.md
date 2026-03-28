# ADR-026: Email System Architecture

**Status:** Accepted
**Date:** 2026-03-28
**Deciders:** Platform team

## Context

The hosting platform needs full email functionality (mailboxes, aliases, webmail, spam filtering) for client domains. Clients currently use `mail.clientdomain.com` for IMAP/SMTP. The platform must be IAM-agnostic — OIDC/SSO is optional.

## Decision

### Mail Server: Stalwart Mail Server

**Why Stalwart:**
- Full REST API for programmatic domain/mailbox management
- SQL directory: authenticates against platform's MariaDB directly (shared DB, no sync)
- OIDC + XOAUTH2 support for optional SSO
- ~100MB RAM (vs 6GB for Mailcow)
- Single binary, Kubernetes-native
- Built-in ACME, DKIM, SPF/DMARC, Bayesian spam filter
- JMAP support (modern protocol)
- AGPL-3.0 (commercial use OK without modification)

### Architecture: Shared Mail Cluster

One Stalwart instance serves all client domains via virtual mailboxes. Per ADR-024, dedicated pods are for web workloads — email is platform infrastructure.

```
                    INBOUND                              OUTBOUND

Internet ──► MX ──► Stalwart (k3s pod)          Stalwart ──► SMTP Relay (optional)
                         │                                      │ (Mailgun/Postmark/direct)
                    Rspamd-like                                 ▼
                    built-in filter                   Gmail, Outlook, Yahoo...
                         │
                    ┌────┴────┐
                    │ MariaDB │ ◄── SQL directory (platform's DB)
                    └────┬────┘
                         │
                    Roundcube ◄── Webmail (SSO via platform token)
```

### Identity Mapping: Platform-Owned

The platform DB is the authority for mailbox ownership. No IAM dependency.

- `email_domains` — email enabled per domain, DKIM keys
- `mailboxes` — accounts with bcrypt passwords, Stalwart reads directly
- `mailbox_access` — maps platform users to mailboxes
- `email_aliases` — forwarding rules

Client admins get implicit access to all mailboxes under their client.
Sub-users get explicitly assigned mailboxes via `mailbox_access`.

### Webmail Access: Three Paths

1. **Direct password login** — user visits Roundcube, types mailbox + password
2. **Platform SSO button** — Roundcube redirects to platform, platform authenticates (local or OIDC), picks mailbox, returns JWT
3. **"Open Webmail" from client panel** — already authenticated, JWT auto-login

All three use Stalwart master user for Roundcube-to-IMAP connection (SSO paths).

### SMTP Relay: Adapter Pattern (Optional)

Outbound relay is optional. Adapters: direct (no relay), Mailgun, Postmark.
- Solves IP reputation cold start
- Transparent to clients (mail.clientdomain.com unchanged)
- Configured per-platform with per-domain override

### Spam & Virus Filtering

Stalwart built-in: DNSBL, SPF/DKIM/DMARC verification, Bayesian classifier, greylisting, URL/phishing detection, rate limiting, header analysis. No ClamAV initially (Phase 3).

Per-domain spam sensitivity configurable (Low/Normal/Aggressive).

### DNS Auto-Provisioning

When email is enabled for a domain, auto-create via existing DNS provider adapters:
- MX record → `mail.clientdomain.com`
- A record → `mail.clientdomain.com` → Stalwart IP
- SPF TXT → `v=spf1 mx ~all` (+ relay include if configured)
- DKIM TXT → per-domain 2048-bit RSA public key
- DMARC TXT → `v=DMARC1; p=quarantine`

## Consequences

- Email storage grows with client count (~5GB per domain default)
- Single IP for all outbound — relay recommended for production
- No virus scanning initially (add ClamAV sidecar in Phase 3)
- Stalwart Enterprise license (~EUR 2/mailbox/yr) needed for multi-tenancy admin isolation (not required for MVP — platform API handles tenant boundaries)
