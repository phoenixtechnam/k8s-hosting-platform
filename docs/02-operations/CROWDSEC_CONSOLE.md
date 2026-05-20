# CrowdSec Console Enrollment

> Operator runbook for F5 — opt-in CrowdSec Console enrollment.
> Surfaces in `/settings/security-hardening` → **Banned IPs** tab as
> the "CrowdSec Console" card.

## What is the CrowdSec Console?

[app.crowdsec.net](https://app.crowdsec.net) is CrowdSec's hosted dashboard:

- **Cross-cluster scenario stats** — graphs of scenarios that fired across
  every machine you enroll.
- **Premium "Console blocklists"** — curated IP feeds that complement the
  free community blocklist (typically: targeted at specific vertical
  attacks like brute-force, e-commerce credential stuffing).
- **Alert push notifications** — email/Slack/webhook when a scenario fires.
- **Console-managed decisions** — push manual bans from the Console UI to
  every enrolled machine.

Enrollment is **opt-in per platform installation**. The platform default
ships with no enrollment configured; many operators run airgapped or
have policy restrictions against outbound to `crowdsec.net`.

## Enrolling

1. Sign in at <https://app.crowdsec.net> → **Add Machine** → copy the
   enroll key (a 32–64 char alphanumeric string).
2. In the admin panel, open `/settings/security-hardening` → **Banned IPs**
   tab → **CrowdSec Console** card.
3. Paste the key into the "Enroll key" field. Optionally set a machine
   name that will appear on the Console dashboard.
4. Click **Enroll with CrowdSec Console**.

Within ~5 seconds the card refreshes to show **enrolled** + the active
features. The platform's LAPI starts pushing alerts upstream
immediately.

## Disenrolling

Click **Disenroll** in the card. Confirms with a `window.confirm` since
this stops upstream visibility. The local CrowdSec instance keeps
running normally — only the upstream connection is removed.

## Airgapped operators: hiding the surface

The card is rendered only when the platform meta-flag is enabled.
To hide the surface entirely (so super_admin can't accidentally reach
upstream):

```sql
INSERT INTO platform_settings (key, value, updated_at)
VALUES ('security.crowdsec.console_visible', 'false', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
```

Or use the in-UI **Hide surface** button at the bottom of the card.
When the meta-flag is false:

- The card still renders, but in a collapsed "meta disabled" state with
  a button to re-enable.
- `POST /admin/security/crowdsec/console/enroll` returns 403.
- `POST /admin/security/crowdsec/console/disenroll` returns 403.

## API endpoints

All super_admin only.

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/v1/admin/security/crowdsec/console` | Status (enrolled, console URL, features, meta-flag) |
| POST   | `/api/v1/admin/security/crowdsec/console/enroll` | Enroll with `{enrollKey, name?, overwrite?}` |
| POST   | `/api/v1/admin/security/crowdsec/console/disenroll` | Disenroll |
| PATCH  | `/api/v1/admin/security/crowdsec/console/meta` | Toggle visibility flag with `{visible: boolean}` |

## Security notes

- The enroll key is **never persisted** — `cscli console enroll` exchanges
  it for a machine identity stored in
  `/etc/crowdsec/online_api_credentials.yaml` on the CrowdSec pod.
- Audit logs record `{actor, name}` for every enroll/disenroll call but
  **redact the enroll key** itself.
- The Zod schema refuses keys outside `[A-Za-z0-9_-]{16,128}` to prevent
  shell injection into the `cscli console enroll <key>` argv.

## Troubleshooting

**"console status failed" toast:** likely the CrowdSec pod is not Running,
or `cscli console status` returned an unexpected shape. Check the platform-api
logs for the specific error; check the CrowdSec pod logs for upstream
connectivity issues.

**Enrollment fails with `console enroll failed: timeout`:** the platform
can't reach `api.crowdsec.net`. Check egress NetworkPolicy or the
cluster's outbound firewall.

**Card hidden but Console says we're still enrolled:** the meta-flag
hides the UI but doesn't auto-disenroll. SSH to a node, exec into the
CrowdSec pod, run `cscli console disenroll -y` to break the upstream
link.
