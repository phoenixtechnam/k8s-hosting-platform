# Client Panel Features

## Overview

Clients access and manage their hosting infrastructure through a control panel. This document outlines all dashboard widgets, features, and functionality available to customers.

**Note:** Subscription and billing are managed by admins via the Management API. Customers do not have self-service billing or plan upgrade/downgrade capabilities.

## Dashboard & Overview

The main dashboard provides a quick overview of account status and quick actions.

| Widget | Data Displayed |
| --- | --- |
| **Account summary** | Plan, domains, email accounts, storage usage |
| **Resource usage** | Storage (files + DB), bandwidth, email quota |
| **Quick actions** | Create domain, create email account, upload files, open webmail |
| **Recent activity** | Latest backups, deployments, certificate renewals |
| **Support widget** | Contact support, documentation links, FAQ |

## Domains & Sites

Complete domain management with DNS, SSL certificates, and deployment options.

| Feature | Description |
| --- | --- |
| **Domain list** | All domains with status, SSL cert expiry, DNS status |
| **Add domain** | Enter domain, auto-verify, provision SSL, create DNS records |
| **SSL certificates** | Per-domain SSL detail view, custom certificate CSR workflow, subdomain cert toggle — see SSL section below |
| **DNS records** | View current records (read-only), instructions for manual changes |
| **Domain transfer** | Instructions for transferring domain to client's registrar |
| **Subdomain creation** | Create subdomains (e.g., blog.example.com) |

## Hosting Settings

Configure domain behavior, redirects, forwarding, and file serving options per domain.

| Feature | Description |
| --- | --- |
| **Enable/Disable Web Hosting** | Temporarily suspend domain (return 503); files remain untouched |
| **WWW Redirection** | Redirect example.com ↔ www.example.com (or no redirect) |
| **HTTPS Redirection** | Force HTTP → HTTPS with configurable status code (301/302/307/308) |
| **External Forwarding** | Forward domain to external URL (e.g., Shopify, WordPress.com) |
| **Forward Options** | Preserve path and query string when forwarding |
| **Webroot Path** | Serve website from subdirectory (e.g., /public/, /httpdocs/) |
| **Path Validation** | Test webroot path before applying; view file count and size |
| **Redirect Preview** | See preview of redirect rules before applying changes |
| **Configuration History** | Audit trail of all hosting setting changes by user/timestamp |
| **Redirect Statistics** | View traffic breakdown by redirect type (WWW, HTTPS, external) |

**Redirect Rule Priority:**
```
IF hosting disabled → return 503
ELSE IF external forward → 301/302 to external URL
ELSE IF HTTPS redirect enabled → 301/302 http → https
ELSE IF WWW redirect → 301 between www/non-www
ELSE → serve from webroot
```

**Use Cases:**
- **Domain normalization** — Force www.example.com or example.com consistently
- **Security** — Enforce HTTPS for all traffic
- **Domain parking** — Forward unused domain to main domain
- **External forwarding** — Point to Shopify store, WordPress.com, etc.
- **Subdomain routing** — blog.example.com serves from /blog/ directory
- **Maintenance mode** — Temporarily disable without losing files
- **Migration** — Forward old domain to new domain during transition
- **Multi-site setup** — Different webroots for different subdomains

**Security & Validation:**
- Path traversal prevention (normalize paths, prevent `../`)
- Symlink escape detection (cannot escape storage root)
- Redirect loop prevention (detect conflicting rules)
- Directory existence and permission checks

**Plan Availability:**
| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| Domain redirects (WWW/HTTPS) | ✅ Yes | ✅ Yes | ✅ Yes |
| External forwarding | ✅ Yes | ✅ Yes | ✅ Yes |
| Webroot path configuration | ✅ Yes | ✅ Yes | ✅ Yes |
| Disable hosting (temp suspend) | ✅ Yes | ✅ Yes | ✅ Yes |
| Redirect statistics | Limited | ✅ Full | ✅ Full |

## SSL Certificates

Per-domain TLS certificate management. Customers can view certificate status, run the custom certificate CSR workflow, and control per-subdomain cert assignment. See `03-security/TLS_CERTIFICATE_MANAGEMENT.md` for full platform cert strategy.

### Certificate Detail View

**Client Panel → Domains → {domain} → SSL Certificate**

| Field | Visible to customer |
|-------|-------------------|
| Certificate type | Yes — `Wildcard` / `Single-domain` / `Custom` |
| Valid until | Yes — date + days remaining (colour-coded: green >30, amber 8–30, red ≤7) |
| Covered hostnames | Yes — full list of SANs |
| Auto-renewal status | Yes — `Automatic` / `Manual renewal required` |
| Renewal history | Last 5 renewals — date, success/failure |
| Subdomains using this cert | Yes — lists subdomains sharing the wildcard |

### Customer Actions

| Action | Description |
|--------|-------------|
| **Request custom certificate** | Initiates CSR workflow — customer selects key type (RSA 2048 / RSA 4096 / ECDSA P-256) and SANs; platform generates keypair + CSR |
| **Download CSR** | Re-download pending CSR as `.csr` file if not yet submitted to CA |
| **Install certificate** | Paste or upload signed cert + intermediate chain after receiving it from CA; platform validates cert matches stored private key |
| **Manage API tokens** | Create and revoke scoped `cert:read` tokens for automated certificate download via API (CI/CD, deploy scripts, external servers) |
| **Regenerate keypair** | Generate a new keypair + new CSR — invalidates any previously pending CSR |
| **Switch subdomain cert** | Per-subdomain toggle: `Use parent wildcard` / `Use own certificate` (only available for subdomains on authoritative/Primary or Secondary DNS mode domains) |

**Customers cannot:**
- Revoke a certificate (admin-only action)
- Disable auto-renewal for Let's Encrypt-managed certificates (auto-renewal is always on for LE certs)

### Certificate Download

Certificate files are available via API only — there is no panel download button. Customers create a scoped token in the panel and use it to fetch the PEM bundle from a script or deploy pipeline.

#### API Token

For CI/CD pipelines, deploy scripts, and external servers that need to fetch the certificate automatically — especially when it renews every 90 days.

**Client Panel → Domains → {domain} → SSL Certificate → API Access**

| Field | Notes |
|-------|-------|
| Token name | Label for the token (e.g. `"staging-server"`, `"deploy-pipeline"`) |
| Scope | `cert:read` — certificate download for this domain only; no other access |
| Expiry | Never / 30 days / 90 days / 1 year |
| Last used | Updated on each API call |

Tokens are shown once at creation. If lost, revoke and create a new one. Multiple tokens per domain are allowed.

**Usage:**

```bash
# Download certificate (curl)
curl -H "Authorization: Bearer <token>" \
     https://api.platform.com/api/v1/certs/example.com/download \
     -o example.com-cert.pem

# Daily renewal check (cron job on external server)
NEW=$(curl -sf -H "Authorization: Bearer ${CERT_TOKEN}" \
           https://api.platform.com/api/v1/certs/example.com/download)
CURRENT=$(cat /etc/nginx/certs/example.com.pem 2>/dev/null)
if [ "$NEW" != "$CURRENT" ]; then
  echo "$NEW" > /etc/nginx/certs/example.com.pem
  nginx -s reload
fi
```

The endpoint always returns the **currently active certificate**. When Let's Encrypt renews automatically, the next API call returns the new cert — no token or URL change required.

### Custom Certificate CSR Workflow

```
1. Customer: SSL → "Request Custom Certificate"
   └── Selects: key type, SANs to include

2. Platform: Generates keypair + CSR
   └── Private key stored securely — never displayed
   └── CSR displayed in panel + available for download as .csr

3. Customer: Takes CSR to their chosen CA (DigiCert, Sectigo, etc.)
   └── Submits CSR, completes CA validation (DV/OV/EV)
   └── Downloads signed certificate chain (.crt / .pem)

4. Customer: SSL → "Install Certificate"
   └── Pastes or uploads: signed cert + intermediate chain (or full bundle)
   └── Platform validates: cert matches stored private key, not expired

5. Platform: Installs custom cert — auto-renewal is disabled for this cert
   └── Customer receives reminder alerts at 30 days and 7 days before expiry
   └── To renew: repeat from step 3 (same keypair, or regenerate first)
```

### Certificate Status Badge (Domain List)

| Badge | Meaning |
|-------|---------|
| `✓ Valid (87d)` | Certificate valid — days remaining shown |
| `⚠ Expiring (12d)` | Within 30-day renewal window |
| `✗ Expired` | Certificate expired — action required |
| `↻ Renewing` | Renewal in progress |
| `! Error` | Renewal failed — click for details |
| `Custom` | Custom certificate installed — manual renewal required |

**Plan Availability:**

| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| View SSL certificate detail | ✅ Yes | ✅ Yes | ✅ Yes |
| Certificate download via API token | ✅ Yes | ✅ Yes | ✅ Yes |
| Custom certificate CSR workflow | ✅ Yes | ✅ Yes | ✅ Yes |
| Per-subdomain cert toggle | ✅ Yes | ✅ Yes | ✅ Yes |

---

## Web Server & PHP Version Switching

Switch between web servers (Apache ↔ NGINX) and PHP versions (8.3 ↔ 8.4) with zero downtime.

| Feature | Description |
| --- | --- |
| **Current configuration** | Display current web server, PHP version, deployment date |
| **Available options** | List supported catalog images (filtered by plan) |
| **Compatibility check** | Auto-scan .htaccess and codebase for compatibility issues |
| **Compatibility report** | Show issues with severity (critical, warning, info) and suggested fixes |
| **Switch dialog** | Confirm switch with warnings and estimated timeline |
| **Progress indicator** | Real-time progress during switch with step-by-step timeline |
| **Performance estimate** | Show predicted improvements (throughput, memory, latency) |
| **Rollback** | Automatic rollback on health check failure or manual rollback after switch |
| **Switch history** | Timeline of all switches with outcomes and performance impact |
| **Configuration preview** | Side-by-side comparison of NGINX vs Apache config |

**Key Features:**
- ✅ Zero downtime — automatic ingress routing during switch
- ✅ Automatic rollback — if health checks fail, revert to previous version
- ✅ Config migration — automatically convert .htaccess to NGINX or vice versa
- ✅ Plan-aware — Starter clients limited to Apache; Business/Premium can switch freely
- ⚠️ Requires approval — if compatibility issues detected

**Plan Availability:**
| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| PHP version switching | ✅ Yes (Apache only) | ✅ Yes | ✅ Yes |
| Web server switching | ❌ No (Apache only) | ✅ Yes | ✅ Yes |
| Auto-rollback | ✅ Yes | ✅ Yes | ✅ Yes |

## Files & Deployment

Multiple ways to deploy code and manage files. All methods access the **same underlying PersistentVolume** per customer. See ADR-016 for full deployment workflow architecture.

**Canonical file layout** (what the customer sees in FileBrowser / SFTP):
```
/                                      ← customer root (/storage/customers/{id}/)
├── domains/
│   ├── example.com/
│   │   ├── public_html/               ← document root for www.example.com
│   │   └── private/                   ← above webroot, not web-accessible
│   ├── dev.example.com/
│   │   ├── public_html/               ← document root for dev subdomain
│   │   └── private/
│   └── blog.example.com/
│       └── public_html/
├── shared/                            ← files shared across all domains
├── tmp/                               ← temporary files (PHP sessions, uploads)
└── backups/                           ← customer-created backup downloads
```

### Method 1: Web File Manager (FileBrowser)

| Feature | Description |
| --- | --- |
| **Access** | "File Manager" button in client panel; opens FileBrowser in new tab |
| **Root directory** | Customer's full PV — **all domains and subdomains visible** |
| **Browse** | Navigate all `domains/`, `shared/`, `tmp/`, `backups/` directories |
| **Upload** | Drag-and-drop or file picker; bulk upload supported |
| **Edit** | Code editor with syntax highlighting (PHP, HTML, CSS, JS, JSON, YAML, etc.) |
| **Copy / Move** | Select files → copy or move to any directory (this is how dev → production promotion works) |
| **Download** | Single file or zip folder download |
| **Create** | New file, new folder |
| **Delete** | Delete files/folders with confirmation |
| **Zip / Unzip** | Archive operations within the file manager |
| **Authentication** | Platform OIDC (Dex) — single sign-on from client panel |
| **Lifecycle** | Starts on-demand; auto-terminates after 30 min idle |

**Staging-to-production workflow via FileBrowser:**
1. Customer develops on `dev.example.com` (files in `domains/dev.example.com/public_html/`)
2. Customer opens File Manager → selects files in `domains/dev.example.com/public_html/`
3. Customer copies them to `domains/example.com/public_html/`
4. Files are immediately live on `www.example.com`

### Method 2: SFTP Upload

| Feature | Description |
| --- | --- |
| **SFTP credentials** | Display SFTP server, port, username, password (copyable) |
| **Root directory** | Chroot to customer's full PV — same layout as FileBrowser |
| **All domains visible** | Customer can navigate to any `domains/{domain}/` directory |
| **SSH keys** | Upload SSH public keys for key-based authentication (no password) |

### Method 3: Git Pull (Git Deploy)

| Feature | Description |
| --- | --- |
| **Per-domain config** | Each domain can have its own Git repo + branch + deploy path |
| **Setup** | Customer enters: repo URL, branch, authentication method (SSH key or access token) |
| **Webhook URL** | Auto-generated webhook URL to add to GitHub/GitLab/Gitea/Bitbucket |
| **Auto-deploy** | When webhook fires (push to configured branch), files are pulled and synced to domain webroot |
| **Manual deploy** | "Deploy Now" button in client panel triggers immediate pull |
| **API trigger** | `POST /api/v1/domains/{domain_id}/deploy` — for custom automation |
| **Post-deploy hooks** | Optional: `composer install`, `npm install` (configurable per domain) |
| **Deployment history** | Table of all deployments: timestamp, commit SHA, status, duration, files changed |
| **Rollback** | Click any previous deployment → "Re-deploy this commit" |

**Git-based staging-to-production workflow:**
1. `dev.example.com` configured to pull from `develop` branch
2. `example.com` configured to pull from `main` branch
3. Customer pushes to `develop` → dev site auto-deploys
4. Customer merges `develop` → `main` in Git → production site auto-deploys

### Deployment Log

| Feature | Description |
| --- | --- |
| **Deployment log** | Real-time deployment status, error messages, rollback option |
| **History** | Filterable by domain, method (SFTP/Git/FileBrowser), status, date range |
| **Details** | Per-deployment: files changed, duration, commit SHA (Git), error output |

---

## AI Website Editor

A no-code website creation and editing tool for customers who are not comfortable working with HTML or files directly. Accessed via Client Panel → AI Website Editor. Operates on the same `public_html/` directory as FileBrowser and SFTP — both paths can be used for the same domain.

**What it produces:** Static HTML/CSS websites with optional contact-form-to-email. No frameworks, no databases, no server-side logic beyond a fixed contact form handler.

### First-Time Setup Wizard

Runs once per domain. Collects structured information and generates a complete initial website in one step — no content writing required by the customer.

| Step | Fields Collected |
| --- | --- |
| **About Your Business** | Business name, tagline, business type / industry |
| **Your Pages** | Select pages to create: Home, About, Services, Gallery, Contact, Testimonials, FAQ |
| **Look & Feel** | Choose colour palette (4 presets) or enter a brand hex colour |
| **Contact Details** | Phone, email, address, WhatsApp, business hours |
| **Logo & Social** | Logo upload, Facebook, Instagram, LinkedIn, X/Twitter URLs |

After completing the wizard, all selected pages are generated and immediately live on the domain.

### Chat Editor + Live Preview

| Feature | Description |
| --- | --- |
| **Page list** | Left sidebar listing pages by friendly name (Home, About, etc.) — no filenames shown |
| **Live preview** | Full-width rendered preview of the current page, updated after each accepted change |
| **Chat input** | Customer types plain-language instructions — no HTML or code required |
| **New page via chat** | Customer can ask the AI to create a new page at any time after setup — no separate dialog required |
| **Change summary** | AI responds with a human-readable description of what changed — never raw code |
| **Accept / Reject** | Changes are staged until explicitly accepted; Reject All discards pending changes |
| **Undo** | Reverts the last accepted change |
| **Publish** | Writes all accepted changes to `public_html/` and makes them live |
| **Guided suggestions** | Context-aware prompt chips below the chat input (e.g. "Add a testimonials section", "Add an image gallery") |
| **JavaScript content** | AI can generate vanilla JavaScript for interactive content: galleries, lightboxes, animations, counters, tabs, accordions, mobile navigation |

### Page Management

| Feature | Description |
| --- | --- |
| **Add page** | Enter page name and one-sentence description — AI generates page and updates navigation on all existing pages |
| **Delete page** | Removes page file and removes it from navigation on all other pages |
| **Reorder pages** | Drag pages in the sidebar to reorder — navigation bar updates across all pages |

### Contact Form

| Feature | Description |
| --- | --- |
| **Add via chat** | Customer asks for a contact form; AI generates the form fields |
| **Field customisation** | Name, email, phone, message, subject — customer specifies which fields to include |
| **Email delivery** | Submissions sent via platform SMTP relay to customer's account email |
| **Security** | CSRF protection, honeypot field, rate limiting (5 per hour per IP) — all platform-managed |
| **No code shown** | PHP handler is generated from a fixed platform template — customer never sees it |

### Image Handling

| Feature | Description |
| --- | --- |
| **Logo upload** | Upload logo from wizard or editor sidebar; placed in header/footer automatically |
| **Image uploader** | Upload images in the editor sidebar; AI can reference uploaded images by name |
| **Placeholders** | CSS colour blocks used until real images are uploaded — no external image services |

### Admin Mode Editor

Admins can open the AI editor for any customer domain directly from the Admin Panel. In admin mode:

| Aspect | Admin Mode |
| --- | --- |
| **Access** | Admin Panel → Client → Domains → AI Editor |
| **Model** | Admin selects from any configured model at the top of the editor |
| **Restrictions** | None — any code, content, or file type |
| **Token budget** | No limit — admin usage logged separately |
| **Output scanner** | Bypassed — admin is fully trusted |

### Scope Limits (Customer Mode Only, Enforced Server-Side)

The following are not supported in customer mode and are rejected at the server — not just by the AI prompt:

- Server-side applications, CMS, databases, or user login systems
- JavaScript frameworks (React, Vue, Angular, etc.) or build tools
- External scripts beyond the platform allowlist (Google Fonts permitted)
- Free-form PHP generation (only the fixed contact form template is permitted)
- E-commerce, booking systems, or payment processing
- `fetch()` / AJAX calls to arbitrary external URLs

Out-of-scope requests receive a graceful decline with an in-scope alternative suggestion.

### Plan Availability

| Feature | Starter | Business | Premium |
| --- | --- | --- | --- |
| AI Website Editor | ✅ Yes | ✅ Yes | ✅ Yes |
| Default AI model | `gemini-2.0-flash` | `claude-haiku-3-5` | `claude-haiku-3-5` |
| Monthly token budget | 50,000 | 200,000 | 500,000 |
| Max pages per domain | 5 | 15 | Unlimited |
| Contact forms per domain | 1 | 3 | Unlimited |
| Admin model/budget override | ✅ Admin only | ✅ Admin only | ✅ Admin only |
| Admin can disable per customer | ✅ Yes | ✅ Yes | ✅ Yes |
| Admin token top-up | ❌ No | ✅ Yes | ✅ Yes |

**Reference:** See `../06-features/AI_WEBSITE_EDITOR.md` for full specification.

---

## Protected Directories (Password Protection)

Restrict access to specific directories using HTTP Basic Authentication (username/password).

| Feature | Description |
| --- | --- |
| **Protected directory list** | All protected directories with path, realm, user count, status |
| **Create protected directory** | Specify path (e.g., `/admin/`, `/staging/`), realm name (display in browser login) |
| **Edit realm** | Change the display name shown in browser login dialog |
| **Disable/Enable** | Toggle protection on/off without deleting directory |
| **Delete** | Remove protection entirely |
| **View users** | List users with username, description, expiration date, last used timestamp |
| **Create user** | Add new username/password, optional description and expiration date |
| **Generate password** | Auto-generate strong random password (copy to clipboard) |
| **Change password** | Update user password, invalidates browser cache |
| **Disable user** | Temporarily revoke access without deleting |
| **Delete user** | Permanently remove user access |
| **Copy credentials** | Copy username:password for sharing with team members |
| **User expiration** | Set expiry date; user auto-disabled on date |
| **Last used tracking** | See when user last accessed protected directory |
| **Activity log** | View recent user access/failures (if enabled) |

## Cron Jobs (Scheduled Tasks)

Schedule recurring tasks (cron jobs) to execute scripts on a defined schedule. Common use cases include automated backups, daily reports, cache clearing, and periodic maintenance tasks. See **CUSTOMER_CRON_JOBS.md** for detailed architecture and implementation guide.

### Cron Jobs Management Dashboard

**Location:** Client Panel > Website & Services > Cron Jobs

#### List View

| Feature | Description |
| --- | --- |
| **Job name** | User-friendly name and description |
| **Schedule** | Human-readable schedule (e.g., "Daily at 2:00 AM") |
| **Last run** | Date, time, and status icon (✅ success, ❌ failed, ⏱️ timeout) |
| **Next run** | Scheduled next execution time with countdown timer |
| **Status** | Enabled/Disabled badge; quick toggle |
| **Actions** | Run now, Edit, View runs, Delete (dropdown menu) |
| **Plan usage** | Display (e.g., "Using 2 of 2 allowed jobs") |

**Features:**
- Create new cron job button (top of page)
- Search by name
- Filter by status (enabled, disabled)
- Sort by name, schedule, last run date
- Bulk enable/disable with multi-select
- Bulk delete with confirmation

#### Create/Edit Cron Job Form

| Field | Type | Notes |
| --- | --- | --- |
| **Job Name** | Text input (required) | 1-255 characters, must be unique |
| **Description** | Text area (optional) | 0-500 characters |
| **Schedule** | Crontab builder (required) | Presets (hourly, daily, weekly, monthly) + manual entry |
| **Timezone** | Dropdown (optional) | Defaults to UTC; common timezones listed |
| **Script Type** | Radio buttons (required) | PHP, Shell, Python, Node.js, Inline command |
| **Script Path** | File picker or text (conditional) | Auto-populated with common paths; validates file exists |
| **Inline Command** | Text area (conditional) | Only visible if "Inline command" selected |
| **Timeout** | Slider (optional) | 60-300+ seconds (plan-dependent) |
| **Max Retries** | Slider (optional) | 0-5 retries on failure |
| **Webhook Integration** | Expandable section (optional) | Enable webhook, enter URL, generate secret, test |

**Actions:** Save, Cancel, Delete (if existing job)

#### Cron Job Details & History

**Configuration Tab (read-only):**
- All job settings displayed
- Edit button (modal or new page)
- Delete button (with confirmation)

**Execution History Tab:**
- Table of last 20 runs (paginated)
- Columns: Date, Time, Duration, Status, Exit Code, Output preview
- Status icons: ✅ Success, ❌ Failed, ⏱️ Timeout, ⏳ Running
- Click row to view full output (stdout/stderr)
- Download as JSON/CSV button
- Search/filter by status, date range

**Last Run Details Card:**
- Started at, Completed at, Duration
- Exit code and status with message
- Stdout/Stderr (truncated; scroll to expand)
- Rerun this job button

**Webhook Status Tab (if enabled):**
- Last webhook delivery: timestamp, HTTP status
- Webhook URL, secret (masked)
- Test webhook button

#### Quick Actions

| Action | Behavior |
| --- | --- |
| **Run Now** | Manual trigger with confirmation; redirects to last run details with live progress |
| **Edit** | Opens create/edit form in modal or new page |
| **View Runs** | Jump to Execution History tab |
| **Enable/Disable** | Quick toggle; confirmation required for disable |
| **Delete** | Permanent delete with confirmation; shows last 3 runs for reference |

#### Notifications & Alerts

- Email alerts on job failures (configurable)
- In-app notifications for failed runs
- Weekly summary of job execution (if any failed)

#### Plan-Based Limits

| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| **Max jobs** | Unlimited | Unlimited | Unlimited |
| **Max timeout** | 5 min | 15 min | 30 min |
| **Execution history** | Last 30 days | Last 90 days | Last 365 days |
| **Webhook support** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Manual trigger** | ✅ Yes | ✅ Yes | ✅ Yes |

---

## Databases

Full database management with backup and import/export capabilities.

| Section | Features |
| --- | --- |
| **Database list** | MariaDB and PostgreSQL databases, storage usage |
| **Database details** | Credentials, phpmyadmin/pgAdmin links, connection info |
| **Backup management** | View backups, download backup, restore to timestamp |
| **Database tools** | Run SQL query, import/export SQL dump |

## Email

Comprehensive email management including account creation, app passwords, webmail access, and mailbox import/export.

| Section | Features |
| --- | --- |
| **Email accounts** | List accounts, create new, delete, storage usage per account |
| **App passwords** | View list (labels + created date), create new, regenerate, delete, copy to clipboard |
| **Webmail access** | Links to Roundcube (default + custom domain), SSO login |
| **IMAP/SMTP settings** | Display server addresses, ports, encryption, example configs for Thunderbird/Outlook |
| **Email forwarding** | Set up forwarding rules (optional) |
| **Sending limits** | View current quota, usage, warnings |

### Email Service Configuration & Security

Advanced email features for professional deliverability and client auto-configuration.

| Feature | Description |
| --- | --- |
| **DKIM Signing** | Digitally sign outgoing emails; prevent spoofing; enabled by default |
| **DKIM Key Management** | View/rotate keys; check DNS publishing; download public key |
| **DKIM Rotation** | Annual automatic rotation (or manual); deprecation period for old keys |
| **Email Autodiscover** | Auto-configure Outlook, Apple Mail, Thunderbird, mobile clients |
| **SRV Records** | Service discovery for IMAP/SMTP/POP3 (_imap._tcp, _smtp._tcp, etc.) |
| **Autodiscover Config** | View autodiscover URL and settings; customize servers if needed |
| **Website Sendmail** | Website/WordPress can send emails from your domain |
| **Sendmail Settings** | Rate limiting, allowed sender domains, bounce handling |
| **Sendmail Statistics** | View emails sent/rejected; monitor rate limit usage |
| **Service Control** | Suspend/enable email service without deleting files; permanent deletion option |
| **Bounce Handling** | Reject invalid recipients at SMTP time (no bounce messages sent) |

**DKIM Details:**
- Automatically enabled for all domains
- Annual key rotation (configurable)
- Improves email deliverability (Gmail, Outlook favor signed emails)
- Prevents email spoofing
- Keys encrypted in Vault (never exposed to customers)

**Autodiscover Benefits:**
- Users enter email → client auto-configures IMAP/SMTP
- Works with: Outlook, Apple Mail, Thunderbird, Android, iOS
- No need for manual server address entry
- SRV records published automatically

**Website Sendmail (WordPress, Custom PHP):**
- PHP mail() function sends from your domain
- WordPress notifications appear from your email
- DKIM-signed (maintains deliverability)
- Rate limiting prevents abuse
- Audit log tracks all website emails

**Service Suspension:**
- Temporarily disable email (keep files)
- Restore full service with one click
- Or permanently delete (irreversible)
- Useful for account suspension/non-payment

### Mailbox Import/Export (IMAP Migration)

Import emails from external IMAP servers (Gmail, Outlook, cPanel, Plesk, etc.) or export to external services for backup and consolidation.

| Feature | Description |
| --- | --- |
| **Import from external IMAP** | Create import job from any IMAP server (with OAuth2 support for Gmail/Outlook) |
| **Export to external IMAP** | Create export job to backup mailbox to external service or another server |
| **Workflows** | Create new account, merge to existing, one-time import, scheduled recurring sync |
| **Folder mapping** | Smart auto-mapping of folders (Inbox→Inbox, [Gmail]/All Mail→Archive, etc.) with manual override |
| **Folder filtering** | Choose specific folders to import/export, exclude sensitive folders (Spam, Trash) |
| **Progress tracking** | Real-time progress bar, per-folder breakdown, email statistics (transferred, skipped, failed) |
| **Pause/Resume** | Pause long-running jobs and resume later from same position |
| **Deduplication** | Automatic duplicate detection (by Message-ID and content hash) to prevent double imports |
| **Options** | Preserve email flags (Seen, Flagged, etc.), preserve original timestamps, skip duplicates |
| **Scheduling** | One-time import or recurring (daily, weekly, monthly) exports |
| **Job history** | View all import/export jobs (active, completed, failed) with details |
| **Audit log** | View detailed event log for each job (started, progress updates, completed, errors) |
| **Test connection** | Validate external IMAP server before creating job (discover folders, verify credentials) |

**Use Cases:**
- Migrate from legacy hosting (cPanel, Plesk, Virtualmin) to platform
- Consolidate multiple email accounts into one
- Switch email providers while keeping all historical emails
- Backup mailbox to external service for disaster recovery
- Archive old emails to personal IMAP server

## Security & Web Application Firewall

Protect web applications from common attacks using ModSecurity with optional per-customer configuration.

### Web Application Firewall (WAF)

Optional security feature (included in Business/Premium plans) that inspects all web traffic and blocks attacks.

| Feature | Description |
| --- | --- |
| **Enable/Disable** | Toggle WAF on/off for entire domain (requires plan upgrade for Starter) |
| **Operational Mode** | OFF (no protection), DETECTION_ONLY (log attacks, allow), ON (block attacks) |
| **Mode Selection** | Recommended workflow: DETECTION_ONLY for 1 week to tune, then switch to ON |
| **Sensitivity Level** | Paranoia level 1-4 (1=default, 4=paranoid; higher = more rules, more false positives) |
| **Rule Exclusions** | Disable specific rules, rule categories (tags), or apply to specific URL patterns |
| **Add Exclusion** | Reason field (required), optional auto-expire date (for temporary disabling) |
| **View Available Rules** | Browse all 247+ OWASP CRS rules by category (SQLi, XSS, RFI, LFI, scanner) |
| **Rule Details** | Name, description, false positive rate estimate, category, documentation links |
| **WAF Dashboard** | Status, mode, quick stats (blocked today, processing time), recent blocks |
| **WAF Logs** | View all WAF events: blocked/logged requests, triggered rules, client IPs, timestamps |
| **Log Filtering** | Filter by action (blocked/logged), severity (LOW/MEDIUM/HIGH/CRITICAL), rule ID, date range |
| **Attack Analytics** | Top triggered rules, top attacking IPs, geographic distribution, attack trends |
| **Performance Monitoring** | Average WAF processing time per request, alerts if > 10ms |

**Protection Categories (OWASP CRS):**
- SQL injection (rules 941xxx): Detect database query manipulation
- XSS (Cross-site scripting, rules 941xxx subset): Prevent JavaScript injection
- RFI/LFI (Remote/local file inclusion, rules 942xxx): Block file disclosure attacks
- Session fixation (rules 943xxx): Prevent session manipulation
- Scanner/bot detection (rules 944xxx): Identify and block automated attacks
- Protocol violations (rules 920xxx): Reject malformed requests
- Data leakage (rules 949xxx): Prevent sensitive data exposure

**Recommended Rollout (Before Enabling in Production):**
1. Enable WAF in DETECTION_ONLY mode (Week 1)
2. Review WAF logs daily; identify any legitimate requests being logged as attacks
3. Add exclusions for false positives (by rule ID or tag)
4. After 7 days, switch to ON mode
5. Monitor for 7 days; adjust paranoia level if needed

**Plan Availability:**
| Feature | Starter | Business | Premium |
|---------|---------|----------|---------|
| WAF Available | ❌ No | ✅ Yes | ✅ Yes |
| Operational Modes | N/A | 2 (OFF, DETECTION_ONLY, ON) | 3 (all) |
| Rule Exclusions | N/A | 5 max | Unlimited |
| Paranoia Levels | N/A | Level 1 only | Levels 1-4 |
| Logs Retention | N/A | 7 days | 90 days |

## Applications

Browse and deploy complex multi-container applications from the application catalog.

| Feature | Description |
| --- | --- |
| **Browse catalog** | View available applications (Nextcloud, Gitea, Mattermost, etc.) |
| **Request app** | Click "Request Nextcloud" → configure params (domain, storage) → submit for approval (if required) |
| **View instances** | List deployed apps with status, URL, created date |
| **App management** | Access app, view logs, scale resources, update version, backup, delete |

## Backups & Granular Restore

Clients can restore from **platform-managed global cluster backups** or create and manage **their own independent backups** with custom schedules.

### Global Cluster Backups (Platform-Managed)

Automated daily backups included in all plans, free to customers.

| Feature | Description |
| --- | --- |
| **Backup list** | All cluster-managed backups (daily/weekly), size, timestamp, type (full/incremental/differential) |
| **Backup details** | What's included, storage location, retention policy (admin-configured) |
| **Restore from backup** | **Granular restore**: Select individual objects (websites, databases, mail accounts) and specific files/folders from any cluster backup version |
| **Backup schedule** (View-only) | Display current cluster backup schedule and frequency; customers can request admin to adjust retention/frequency per plan tier |

**Cluster Backup Characteristics:**
- Managed by platform admin (schedule, retention, type all configured globally)
- Free to all customers (included with all plan tiers)
- Stored on offsite backup server (SSHFS mount via NetBird mesh)
- **NOT counted against customer disk quota**
- Admin-controlled retention (e.g., 30 days default)

### Customer-Created Independent Backups

Optional additional backups created and managed by customers for compliance or custom retention.

| Feature | Description |
| --- | --- |
| **Create manual backup** | Trigger immediate backup of selected objects: specific domains, databases, email accounts, or entire account |
| **Backup schedule** | Create custom backup schedules independent of cluster defaults; configure frequency (hourly/daily/weekly/monthly), type (full/incremental/differential), retention |
| **Manage schedules** | View all customer-created schedules, edit, pause, resume, delete |
| **Backup list** | List all customer backups (manual triggers + scheduled), size, timestamp, type, source |
| **Download backup** | Direct download of gzipped backup |
| **Restore from backup** | **Granular restore**: Select individual objects and files/folders from customer-created backups |
| **Delete backup** | Manual deletion of backup (frees up quota) |

**Customer Backup Characteristics:**
- Created and managed by customers
- **Stored in customer's disk quota** (included in overall storage limit)
- Customers pay for additional storage if backup exceeds quota
- Customers control retention (can set 7/14/30/90/365+ days)
- Customers can trigger manual backups anytime
- Cost-transparent: storage usage shown in backup details

### Storage Accounting

| Component | Quota Impact |
| --- | --- |
| **Cluster backups** | NOT counted in quota (platform operational cost) |
| **Customer backups** | **FULLY counted** in quota |

**Quota Display:**
- "You are using 45 GB of 100 GB (includes 15 GB in customer backups)"
- Warning threshold: Alert when customer backups exceed 50% of remaining quota
- Quota enforcement: Cannot create new backups if quota exceeded; must delete old backups or upgrade plan

### Granular Restore Features

All backup versions are browsable and restorable at a fine-grained level.

| Restore Type | Objects | UI Features |
| --- | --- | --- |
| **Website** | Individual domain/installation | Select backup version → preview files/DB → choose restore target (overwrite/new domain) → confirm |
| **Database** | Single MariaDB/PostgreSQL database | Choose backup version → select tables or full DB → scope (full/data-only) → target (overwrite/new DB) |
| **Mail Account** | Individual email account | Choose backup version → select scope (full/content-only/date-range) → merge or overwrite → target account |
| **Files & Folders** | Specific files or directory trees | Browse file tree OR search → select files/folders → exclude patterns → target path (original/alternate) → conflict resolution |

**Key Restore Capabilities:**

- **All Backup Versions Visible:** Users see complete history (hourly/daily snapshots)
- **Non-Destructive by Default:** Restored items renamed or placed in alternate location unless user explicitly confirms overwrite
- **Preview Before Restore:** View file list, database tables, email metadata before executing
- **Async Restores:** Background jobs with real-time progress tracking (WebSocket)
- **Admin + Client Access:** Both can initiate restores with appropriate RBAC controls
- **Automatic Rollback:** Failed restores roll back automatically; no partial restorations
- **Audit Trail:** Every restore logged (who, what, when, result)

## Account Settings

Personal account configuration and security settings.

| Section | Features |
| --- | --- |
| **Profile** | Name, email, contact info, language preference |
| **Security** | Password change (via OIDC), API tokens, session management |
| **Notifications** | Email notification preferences (which events trigger emails) |
| **Plan info** | Current plan details (read-only), usage vs quota, storage breakdown |
| **Support** | Contact support, view ticket history, documentation |

## API-Driven Architecture

The client panel is driven by a **REST API** (or GraphQL alternative) that serves as the single source of truth.

### API Layers

| API Layer | Responsibility |
| --- | --- |
| **Management API** | Core business logic: client CRUD, plan management, email/DNS |
| **Data API** | Metrics, logs, backups, resources (read-heavy, cached) |
| **Auth API** | JWT issuance, token refresh, OIDC integration |
| **Webhook API** | Git deploy hooks, monitoring alerts → Notification Service |

### API Design Principles

- RESTful endpoints with clear resource hierarchies
- Consistent error responses (JSON with code + message)
- Pagination, filtering, sorting on list endpoints
- Request/response compression (gzip)
- API versioning (v1, v2, etc.) for backwards compatibility
- Rate limiting (configurable per role)
- Request tracing (X-Request-ID header)
- Comprehensive API documentation (OpenAPI/Swagger)

## Authentication & Authorization

| Aspect | Implementation |
| --- | --- |
| **Login method** | OIDC (Google/Apple) via Dex + email/password fallback |
| **Session management** | JWT tokens (access + refresh), httpOnly cookies |
| **Logout** | Clear session, revoke refresh token |
| **Role-based access** | Admin role (full access), Client role (scoped to client namespace) |
| **MFA** | Delegated to OIDC provider (Google Authenticator, Face ID, etc.) |
| **Session timeout** | Configurable (default 4 hours); refresh token valid for 30 days |
| **Remember me** | Persistent login via refresh token (browser local storage) |

## Responsive Design

The panel is fully responsive across all device types.

| Breakpoint | Width | Use Case |
| --- | --- | --- |
| **Mobile** | < 640px | Phones, small devices; single-column layout |
| **Tablet** | 640-1024px | iPads, tablets; two-column layout where applicable |
| **Desktop** | 1024-1920px | Desktop browsers; full multi-column layout |
| **Ultra-wide** | > 1920px | Large monitors; extended sidebars, more info |

### Mobile-Specific Considerations

- Touch-friendly buttons (min 48px height)
- Hamburger menu for navigation
- Simplified forms (fewer fields per screen)
- Optimized modals (full-height on mobile)
- Readable font sizes (no zooming required)
- Tap-friendly link spacing

## Performance Targets

| Metric | Target |
| --- | --- |
| Page load time | < 2 seconds |
| API response time | < 500ms (p95) |
| Search/filter response | < 1 second |
| Large backup download | Streaming download (no size limit) |
| File browser with 10,000+ files | < 3 seconds initial load |

## Accessibility Standards

- **WCAG 2.1 Level AA** compliance
- Keyboard navigation support
- Screen reader compatible
- High contrast mode support
- Proper heading hierarchy
- Form labels with descriptions

## Related Documentation

- [`../02-operations/BACKUP_STRATEGY.md`](../02-operations/BACKUP_STRATEGY.md) — Complete backup procedures and restore workflows
- [`../06-features/RESTORE_SPECIFICATION.md`](../06-features/RESTORE_SPECIFICATION.md) — Detailed UI/UX flows and implementation details for granular restore
- [`../06-features/EMAIL_SERVICES.md`](../06-features/EMAIL_SERVICES.md) — Email account management and app password features
- [`../06-features/WEBMAIL_ACCESS_SPECIFICATION.md`](../06-features/WEBMAIL_ACCESS_SPECIFICATION.md) — Webmail domain setup, SSL certs, authentication, multi-domain routing
- [`../06-features/FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md`](../06-features/FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md) — FTP/FTPS/SSH/SFTP user management, quotas, security, audit logging
- [`../06-features/CUSTOMER_CRON_JOBS.md`](../06-features/CUSTOMER_CRON_JOBS.md) — Cron job scheduling, Kubernetes CronJob orchestration, migrations
- [`../06-features/PHP_COMPOSER_SUPPORT.md`](../06-features/PHP_COMPOSER_SUPPORT.md) — PHP Composer dependency management with CVE scanning
- [`../06-features/MAILBOX_IMPORT_EXPORT_SPECIFICATION.md`](../06-features/MAILBOX_IMPORT_EXPORT_SPECIFICATION.md) — IMAP import/export for migration, consolidation, backup; deduplication and conflict resolution
- [`../06-features/EMAIL_ENHANCEMENTS_SPECIFICATION.md`](../06-features/EMAIL_ENHANCEMENTS_SPECIFICATION.md) — DKIM signing, email autodiscover, SRV records, service management, website sendmail integration
- [`../06-features/WEB_APPLICATION_FIREWALL_SPECIFICATION.md`](../06-features/WEB_APPLICATION_FIREWALL_SPECIFICATION.md) — WAF with three modes (OFF/DETECTION_ONLY/ON), OWASP CRS ruleset, granular rule exclusions
- [`../06-features/HOSTING_SETTINGS_SPECIFICATION.md`](../06-features/HOSTING_SETTINGS_SPECIFICATION.md) — Domain redirects, external forwarding, webroot paths, temporary suspension
- [`../02-operations/MONITORING_OBSERVABILITY.md`](../02-operations/MONITORING_OBSERVABILITY.md) — Resource usage metrics and dashboards
- [`../04-deployment/MANAGEMENT_API_SPEC.md`](../04-deployment/MANAGEMENT_API_SPEC.md) — API endpoints (admin-managed customer and subscription operations)
