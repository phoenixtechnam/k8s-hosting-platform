# Hosting Plans & Pricing

## Overview

The platform supports a **flexible, fully customizable hosting plan system** with three default tiers (Starter, Business, Premium) and the ability to create unlimited custom plans. Every parameter can be overridden on a per-client basis, allowing both standardized offerings and fine-tuned configurations.

## Business Model & Positioning

| Decision | Choice | Rationale |
| --- | --- | --- |
| **Target Revenue** | **$0-5k/month** (initial phase) | Small but sustainable platform; can scale to higher revenue |
| **Positioning** | **Premium** | Focus on quality/features over low-cost competition; higher margins |
| **Pricing Model** | **NOT in scope for this project** | Focus on technical infrastructure; business team will define pricing strategy |
| **Starter Plan** | **Business decision (out of scope)** | Dedicated pod, lower resource limits; pricing TBD by business |
| **Business Plan** | **Business decision (out of scope)** | Dedicated pod, higher limits, more features; pricing TBD by business |
| **Premium Plan** | **Business decision (out of scope)** | Dedicated pod, highest limits, database included; pricing TBD by business |

## Workload Model (ADR-024)

### Dedicated Pod for All Plans

Every client gets their own dedicated pod in a `client-{id}` namespace with full Kubernetes-native isolation, regardless of plan tier. Plan differentiation is based on resource limits and features, not isolation model.

**Characteristics:**
- One pod per client running selected catalog image (default: `nginx-php84`)
- NGINX+PHP-FPM default; Apache+PHP-FPM available per domain (ADR-023)
- Guaranteed CPU/memory limits per plan
- Scale-to-zero capability (optional, via KEDA)
- Custom PHP configuration per client
- Database available as premium add-on (not included in base plans)

**Isolation:**
- Full pod-level isolation with namespace-per-client
- ResourceQuota limits per plan
- NetworkPolicy enforcement (default-deny + allow ingress controller)
- No shared resources between clients

### How Provisioning Works

1. Management API creates `client-{id}` namespace with ResourceQuota, NetworkPolicy, RBAC
2. Dedicated pod provisioned with selected catalog image
3. PVC created and mounted at `/var/www/html`
4. Ingress rule created for client's domain
5. Secrets created for SFTP credentials
6. If database add-on enabled: dedicated MariaDB StatefulSet provisioned in same namespace

### Plan Upgrades

Plan changes are **ResourceQuota edits** — no pod migration required:
1. Admin updates plan via Management API
2. ResourceQuota updated with new CPU/memory/storage limits
3. Pod restarts with new limits; PVC and Ingress remain unchanged
4. Database add-on can be enabled/disabled at any time

## Default Plan Templates

These are the **starting templates with recommended pricing** for premium positioning. Every value is fully editable by administrators. Plans are **default templates** — admins can add, remove, and modify plans freely. Individual values can be overridden on a per-customer basis, and customers can be re-synced with their plan's current defaults at any time.

### Resource & Feature Defaults

| Parameter | Starter | Business | Premium |
| --- | --- | --- | --- |
| **Web Mode** | Dedicated pod | Dedicated pod | Dedicated pod |
| **CPU Req/Limit** | 50m / 500m | 100m / 1000m | 200m / 2000m |
| **Mem Req/Limit** | 64Mi / 256Mi | 256Mi / 1Gi | 512Mi / 4Gi |
| **Storage** | 5Gi | 20Gi | 50Gi |
| **DB Mode** | Add-on ($) | Add-on ($) | Included (dedicated) |
| **Max Databases** | 1 (if add-on) | 3 (if add-on) | 10 |
| **Cache** | None | Add-on ($) | Dedicated |
| **Max Domains** | 1 | 5 | Unlimited |
| **Email Accounts** | 5 | 25 | Unlimited |
| **Bandwidth** | 50GB/mo | 500GB/mo | Unlimited |
| **WAF** | Available (off by default) | Available (off by default) | Enabled |
| **Cron Jobs** | Unlimited | Unlimited | Unlimited |
| **Backup Retention** | Per global backup strategy | Per global backup strategy | Per global backup strategy |
| **AI Website Editor** | ✅ (50k tokens/mo) | ✅ (200k tokens/mo) | ✅ (500k tokens/mo) |
| **AI Default Model** | `gemini-2.0-flash` | `claude-haiku-3-5` | `claude-haiku-3-5` |
| **AI Editor Max Pages** | 5 per domain | 15 per domain | Unlimited |
| **AI Contact Forms** | 1 per domain | 3 per domain | Unlimited |
| **Price (USD)** | **$5.99/mo** | **$19.99/mo** | **$49.99/mo** |

> **Note on backup retention:** Automated cluster backups follow the global backup strategy (see `BACKUP_STRATEGY.md`). Retention is not restricted by plan — all customers benefit from the same backup schedule and retention policy. Customer-created on-demand backups count against storage quota.

> **Note on WAF:** The Web Application Firewall (ModSecurity + OWASP CRS v4) is **available on all plans**. It is off by default on Starter and Business (can be enabled per-customer) and enabled by default on Premium. See `WEB_APPLICATION_FIREWALL_SPECIFICATION.md`.

> **Note on cron jobs:** Cron jobs are **unlimited on all plans**. Resource limits per job execution (CPU, memory, timeout) are configurable per-customer. See `CUSTOMER_CRON_JOBS.md`.

> **Note on AI Website Editor:** Available on all plans. Produces static HTML/CSS + vanilla JavaScript websites with contact-form-to-email. No frameworks, databases, or server-side applications in customer mode. Each plan has a default AI model; admins can override the model and token budget per customer, or disable the feature entirely per customer. Token budgets reset monthly. Admins can grant one-time top-ups. Admins editing customer sites via the Admin Panel have no restrictions and no token budget. See `../06-features/AI_WEBSITE_EDITOR.md`.

### Pricing Rationale

- **Starter ($5.99/mo)**: Entry-level, dedicated pod with lower resource limits, no database — highest margin per client but requires volume
- **Business ($19.99/mo)**: Mid-tier, higher limits, database available as add-on, standard support — balanced revenue
- **Premium ($49.99/mo)**: High-value, highest limits, database included, WAF enabled, priority support — premium positioning for serious clients

> **This file is the single source of truth for plan defaults.** All other documents should reference this file for plan limits. If a discrepancy is found, this file takes precedence.

## Key Differences by Default Plan

| Feature | Starter | Business | Premium |
| --- | --- | --- | --- |
| Web pod | Dedicated pod | Dedicated pod | Dedicated pod |
| Namespace isolation | Full (`client-{id}`) | Full (`client-{id}`) | Full (`client-{id}`) |
| CPU/Memory | 50m-500m / 64Mi-256Mi | 100m-1000m / 256Mi-1Gi | 200m-2000m / 512Mi-4Gi |
| Database | Add-on ($) | Add-on ($) | Included (dedicated MariaDB) |
| Redis cache | None | Add-on ($) | Dedicated pod |
| Scale-to-zero | Optional | Optional | No (always on) |
| Custom PHP config | Full control | Full control | Full control |

> **Any of the above can be changed per-client.** For example, a Starter client could be given a database add-on, or a Business client could be given higher resource limits — all via per-client overrides without changing their plan.

## Configurable Plan Parameters

Every parameter below is set at the **plan level** (global default) and can be **overridden per-client** by the admin via the management panel.

| Parameter | Description | Example Values |
| --- | --- | --- |
| `web_mode` | Deployment mode (dedicated only since ADR-024) | `dedicated` |
| `catalog_image` | Workload container from catalog (see note below) | `apache-php84` / `wordpress-php84` / `node22` |
| `allow_web_server_switch` | Enable switching between web servers | `true` / `false` |
| `allowed_catalog_images` | Whitelist of allowed catalog images for switching | Array of image IDs |
| `cpu_request` | CPU request (dedicated pods only) | `50m` / `100m` / `200m` |
| `cpu_limit` | CPU limit (dedicated pods only) | `500m` / `1000m` / `2000m` |
| `memory_request` | Memory request (dedicated pods only) | `128Mi` / `256Mi` / `512Mi` |
| `memory_limit` | Memory limit (dedicated pods only) | `512Mi` / `1Gi` / `4Gi` |
| `storage` | PersistentVolume size | `5Gi` / `20Gi` / `50Gi` |
| `database_mode` | Database add-on (dedicated per-client StatefulSet) | `none` / `dedicated` |
| `database_engine` | MariaDB or PostgreSQL | `mysql` / `postgresql` |
| `database_storage` | DB storage (dedicated only) | `5Gi` / `20Gi` |
| `cache_mode` | Redis add-on (dedicated per-client pod) or none | `dedicated` / `none` |
| `cache_memory` | Redis memory (dedicated only) | `64Mi` / `256Mi` / `1Gi` |
| `scale_to_zero` | Enable scale-to-zero (dedicated only) | `true` / `false` |
| `backup_retention_days` | How many days to retain backups | `7` / `14` / `30` / `90` |
| `backup_frequency` | How often to run backups | `daily` / `twice_daily` / `hourly` |
| `waf_enabled` | Enable WAF for this client | `true` / `false` |
| `max_domains` | Maximum number of domains allowed | `1` / `5` / `10` / `unlimited` |
| `max_email_accounts` | Email accounts (if self-hosted) | `0` / `5` / `10` / `unlimited` |
| `email_sending_limit` | Max emails per hour per account | `50` / `200` / `500` / `unlimited` |
| `webmail_enabled` | Enable Roundcube webmail access | `true` / `false` |
| `webmail_domain` | Custom webmail domain (e.g., `webmail.client.com`) | Domain string or `null` (use platform default) |
| `email_oidc_enabled` | Allow OIDC (Google/Apple) login for email | `true` / `false` |
| `sftp_enabled` | Enable SFTP access | `true` / `false` |
| `git_deploy_enabled` | Enable Git-based deployments | `true` / `false` |
| `file_manager_enabled` | Enable web file manager | `true` / `false` |
| `ai_editor_enabled` | Enable AI Website Editor (null = inherit from plan) | `true` / `false` / `null` |
| `ai_editor_model_id` | AI model to use for this customer (null = use plan default) | e.g. `"gemini-flash"` / `null` |
| `ai_editor_token_budget` | Monthly AI token budget (null = use plan default) | `50000` / `200000` / `null` |
| `ai_editor_max_pages` | Max pages per domain in AI editor | `5` / `15` / `0` (unlimited) |
| `ai_editor_max_contact_forms` | Max contact forms per domain | `1` / `3` / `0` (unlimited) |
| `php_version` | PHP version override (if applicable) | `8.3` / `8.4` |
| `php_memory_limit` | PHP memory_limit ini setting | `128M` / `256M` / `512M` |
| `php_max_upload` | PHP upload_max_filesize | `64M` / `128M` / `256M` |
| `custom_php_ini` | Additional php.ini overrides | Key-value pairs |
| `egress_internet` | Allow outbound internet from client pod | `true` / `false` |
| `price_monthly` | Monthly price for this plan/client | Decimal value |

## How Plan Customization Works

**Design Principle:** All hosting plans are **fully customizable templates**. Admin defines global plan defaults, but **every setting can be overridden on a per-client basis** via the management panel. This allows maximum flexibility — standard plans for most clients, fine-tuned settings for specific clients when needed.

### Management API Logic

- Each plan defines a complete set of default values for all configurable parameters
- Each client record stores a `plan_id` plus an optional `overrides` object
- The effective configuration is: `plan_defaults MERGED WITH client_overrides`
- Any parameter not in overrides inherits the plan default
- Admin can override any client setting without changing their plan
- Client plan changes apply all new defaults, but preserve explicit per-client overrides

### Example Scenario

1. Business plan has default storage: 20Gi
2. Client A has no overrides → gets 20Gi
3. Client B has override `storage: 50Gi` → gets 50Gi (despite being on Business plan)
4. Admin changes Business plan storage to 25Gi
5. Client A now gets 25Gi (inherited new default)
6. Client B still gets 50Gi (override preserved)
7. Admin clears Client B's overrides → Client B now gets 25Gi (reverted to plan default)

## Admin Plan Management UI

The admin panel provides full CRUD for plans:

| Action | Description |
| --- | --- |
| **Create plan** | Define a new plan template with all parameters |
| **Edit plan defaults** | Modify any global default — changes apply to all clients on this plan (unless overridden) |
| **Clone plan** | Duplicate an existing plan as starting point |
| **Delete plan** | Remove plan (only if 0 clients assigned) |
| **View clients on plan** | List all clients using this plan |
| **Override client settings** | Edit any parameter for a specific client |
| **Reset client overrides** | Clear per-client overrides, revert to plan defaults |
| **Bulk update** | Change a setting across all clients on a plan |

## Cost Implications

**Per-Client Economics (ADR-024):**

Every client consumes a dedicated pod (~50m CPU request, ~64Mi memory request for Starter). At 50 Starter clients, total web pod overhead is ~2.5vCPU / 3.2Gi — fits comfortably on 2× CX31 nodes (~$20/month). Database add-on clients add ~100-150Mi per MariaDB StatefulSet.

**Key Benefits:**
- Per-client overrides allow upselling individual features (database, Redis, higher limits) without forcing a full plan upgrade
- Database add-on creates a clear revenue stream from clients who actually need databases
- Admin can offer discounts to specific clients by lowering price_monthly override
- Flexible resource allocation supports customer retention and growth
- Scale-to-zero (KEDA) reduces idle pod resource consumption during off-peak hours

## Creating Custom Plans

Admin can create additional plans beyond the three defaults:

**Examples:**
- **WordPress Optimized**: Starter plan with `catalog_image: wordpress-php84`, higher `php_memory_limit`
- **E-Commerce**: Business plan with dedicated database + higher storage quota
- **Developer**: Premium plan with `git_deploy_enabled: true`, `file_manager_enabled: true`
- **API Services**: Dedicated pod with `catalog_image: node22`, higher CPU/memory, `scale_to_zero: true`

All plans follow the same parameter structure and customization rules.

## Web Server & PHP Version Switching by Plan

Clients can switch between different catalog images (web servers and PHP versions) with zero downtime:

### All Plans (ADR-024 — Dedicated Pods for Everyone)

Since all clients now have dedicated pods, switching capabilities are uniform:

- ✅ **Can switch PHP versions**: 8.3 ↔ 8.4 for any web server
- ✅ **Can switch web servers**: NGINX ↔ Apache (ADR-023)
- ✅ **Can switch runtimes**: PHP → Node, Python, Ruby, etc.
- **Switching method**: New pod with target image created, ingress routing updated, zero downtime
- **Configuration migration**: Automatic .htaccess ↔ NGINX config conversion
- **Auto-rollback**: If health checks fail, automatically revert to previous version
- **Estimated time**: 1-3 minutes (no customer-facing downtime)

> **Note:** Admins can restrict available catalog images per plan via `allowed_catalog_images`.
> For example, Starter clients could be limited to PHP runtimes only, while Business/Premium
> clients have access to the full catalog.

**Related Document:** See [`WEB_SERVER_PHP_VERSION_SWITCHING.md`](./WEB_SERVER_PHP_VERSION_SWITCHING.md) for complete switching specifications.

## Related Documentation

- **PLATFORM_ARCHITECTURE.md**: Overall platform design and workload model
- **WORKLOAD_DEPLOYMENT.md**: Container catalog and deployment specifications
- **INFRASTRUCTURE_SIZING.md**: Resource planning by plan and client count
- **STORAGE_DATABASES.md**: Database allocation per plan
- **MONITORING_OBSERVABILITY.md**: Resource monitoring per plan
