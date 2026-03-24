# Application Catalog

## Overview

The Application Catalog handles **complex, multi-container workloads** (Nextcloud, BigBlueButton, Jitsi, etc.) that go beyond simple website hosting. This is **separate from the Workload Container Catalog** (covered in WORKLOAD_DEPLOYMENT.md), which handles client web runtimes.

While the Workload Catalog provides standardized runtime environments for client files, the Application Catalog provides complete pre-configured software stacks with their own databases, caches, volumes, and ingress rules.

## Two Distinct Catalogs

The platform maintains **two different catalogs**:

| Catalog | Purpose | Deployed By | Example |
| --- | --- | --- | --- |
| **Workload Container Catalog** | Standardized web runtimes for client sites | Admin (manages images), Client (selects) | `apache-php84`, `node22`, `wordpress-php84` |
| **Application Catalog** (this section) | Complex multi-container applications | Admin (defines apps), Admin or Client (deploys instances) | Nextcloud, BigBlueButton, Jitsi, Gitea, Matomo, Moodle, Gibbon, Keycloak |

### Key Difference

**Workload Container:** A single runtime image that serves client-provided files. Clients upload/deploy their own code.

**Application:** A **complete stack** — often multiple containers, its own database, configuration, volumes, and ingress — deployed as a unit. The software is pre-configured and managed by the platform.

## How Applications Are Defined

Each application in the catalog is defined as a **Helm chart** (or Kustomize overlay) with admin-configurable parameters. The Management API stores the catalog; the admin panel provides the UI.

**Application definition structure:**

- **Helm chart** or Kustomize manifests (version-controlled in platform repo)
- **Parameters** for CPU, memory, storage, replicas, features
- **Database templates** (if needed)
- **Ingress configuration** (domain, TLS, auth)
- **Resource defaults** (minimums for smooth operation)
- **Backup configuration** (schedule, retention)

## Application Catalog — Entries

| App ID | Name | Components | Tenancy Options | Default Resources |
| --- | --- | --- | --- | --- |
| `nextcloud` | Nextcloud | App pod + DB + Redis + CronJob | Multi or Single | 500m CPU, 1Gi RAM, 10Gi storage |
| `bigbluebutton` | BigBlueButton | bbb-web + TURN server + recordings + MongoDB + Redis | Single only | 4 CPU, 8Gi RAM, 50Gi storage |
| `jitsi` | Jitsi Meet | web + prosody + jicofo + jvb (video bridge) | Single or Shared | 2 CPU, 4Gi RAM, 5Gi storage |
| `gitea` | Gitea | App pod + DB (PostgreSQL) | Multi or Single | 250m CPU, 512Mi RAM, 5Gi |
| `matomo` | Matomo Analytics | App pod + DB (MariaDB) | Multi or Single | 250m CPU, 512Mi RAM, 5Gi |
| `vaultwarden` | Vaultwarden | App pod + SQLite/PG | Multi or Single | 100m CPU, 256Mi RAM, 1Gi |
| `wordpress` | WordPress (managed) | App pod + DB + Redis + WP-CLI CronJob | Single only | 250m CPU, 512Mi RAM, 5Gi |
| `mattermost` | Mattermost | App pod + DB (PostgreSQL) + file storage | Multi or Single | 500m CPU, 1Gi RAM, 10Gi |
| `moodle` | Moodle LMS | App pod + DB (MariaDB/PostgreSQL) + file storage | Single only | 1 CPU, 2Gi RAM, 20Gi storage |
| `gibbon` | Gibbon LMS | App pod + DB (MariaDB) | Single only | 500m CPU, 1Gi RAM, 10Gi storage |
| `keycloak` | Keycloak | App pod + DB (PostgreSQL) + Cache (Redis) | Single only | 500m CPU, 1Gi RAM, 5Gi storage |

### Resource Defaults & Customization

- The "Default Resources" column shows the **global default allocation** when an application is added to the catalog
- These defaults apply to all new deployments of the application unless overridden
- When deploying an instance for a specific customer, the **admin can customize** CPU, memory, and storage allocations to meet that customer's needs
- Customizations are **tracked per deployment** for billing and resource allocation purposes
- Admin can **add new applications** to the catalog at any time by adding a Helm chart definition via the management panel or API

## Tenancy Models

Applications can be deployed in different tenancy modes, configurable per application.

### Single-Tenant (Dedicated Instance)

Each deployment gets its own full stack in a dedicated namespace.

**Pros:**
- Full isolation
- Independent scaling
- Client can customize freely
- Privacy-sensitive workloads

**Cons:**
- Higher resource usage — each instance runs its own pods
- More maintenance overhead

**Best for:**
- BigBlueButton (video conferencing — needs high performance)
- Jitsi (video conferencing)
- Moodle LMS (large educational platform)
- Gibbon LMS (educational platform)
- Keycloak (identity provider — sensitive data)

### Multi-Tenant (Shared Instance)

One application instance serves multiple users/clients with account-level separation.

**Pros:**
- Very resource-efficient
- Single instance to maintain
- Cost-effective

**Cons:**
- Less isolation
- Shared resource contention
- Single point of failure for all users

**Best for:**
- Nextcloud (built-in user/organization management)
- Gitea (built-in user/organization management)
- Matomo (built-in site/account separation)
- Vaultwarden (built-in user accounts)

### Admin Configures Per Application

The admin decides the tenancy model when adding an app to the catalog:

| Setting | Options |
| --- | --- |
| `tenancy` | `single-tenant` / `multi-tenant` / `configurable` |
| `default_tenancy` | Which mode is used when deploying |
| If `configurable` | Admin/client chooses per deployment |

## Resource Allocation & Customization

Each application has **global default resource allocations** defined in the catalog, but these are **fully customizable per deployment**.

### Customization Options

| Resource Setting | Definition |
| --- | --- |
| **Catalog defaults** | CPU, memory, and storage minimums set when app is added to catalog |
| **Per-deployment override** | Admin can increase/decrease resources for specific customer instances |
| **CPU customization** | Scale up for high-traffic or compute-intensive workloads |
| **Memory customization** | Increase for applications with large datasets or caches |
| **Storage customization** | Adjust based on customer's expected file storage needs |
| **Tracking** | Resource allocations tracked per instance for billing |

### Example: Moodle LMS

Moodle LMS has a catalog default of **1 CPU / 2Gi RAM / 20Gi storage**, but:

- **Customer A (small course):** Deploy with 500m CPU / 1Gi RAM / 10Gi storage
- **Customer B (large course):** Deploy with 2 CPU / 4Gi RAM / 50Gi storage

## Deployment Workflow

### Admin Deploys an Application

1. Admin selects application from catalog
2. Chooses tenancy model (if `configurable`)
3. Customizes resources (CPU, memory, storage) if needed
4. Configures domain and ingress settings
5. Sets up TLS certificate (via cert-manager)
6. Creates admin user and initial configuration
7. Assigns to customer account
8. Send customer credentials and access instructions

### Client Requests an Application

1. Client requests application via control panel
2. Admin reviews request
3. Admin deploys instance (see above)
4. Admin sends credentials and instructions

(Future: Auto-approval for certain app + plan combinations)

## Application Lifecycle Management

| Action | Description |
| --- | --- |
| **Deploy instance** | Create a new application instance (admin or client); customize resources per deployment |
| **Upgrade version** | Update Helm chart version — rolling update of all components |
| **Configure** | Change parameters (storage, features, domain, CPU/memory allocations) |
| **Scale** | Adjust replicas, resources (for single-tenant instances); customize per customer needs |
| **Backup** (Cluster) | Application data included in daily platform-managed backup pipeline (free, not counted in quota) |
| **Backup** (Customer) | Manual backups and custom schedules with customer-defined retention (counts toward disk quota) |
| **Suspend** | Stop all pods but preserve data (for non-paying clients) |
| **Delete** | Remove instance, optionally export data first |
| **View logs / metrics** | Application logs in Loki, metrics in Grafana |

## Application Resource & Cost Tracking

Each application instance is tracked separately for resource usage and billing:

| Metric | Tracked Per Instance |
| --- | --- |
| CPU / Memory usage | Prometheus metrics per namespace |
| Storage usage | PVC utilization |
| Bandwidth | Ingress controller metrics per host |
| Active users | Application-specific (if exposed via API) |
| Monthly cost | Base price + resource usage surcharges |

## Integration with Hosting Plans

Applications can be offered as **add-ons** to hosting plans:

| Plan Parameter | Description |
| --- | --- |
| `available_applications` | List of app IDs this plan can access (or `all`) |
| `application_instances_max` | Max simultaneous app instances per client |
| `application_auto_approve` | Whether client requests are auto-approved |

### Example Plan Configurations

| Plan | Available Apps | Max Instances | Auto-Approve |
| --- | --- | --- | --- |
| **Starter** | None (or limited) | 0 | N/A |
| **Business** | Nextcloud, Gitea | 2 | No |
| **Premium** | All | Unlimited | Yes |

> **Note:** Like all plan parameters, these can be **overridden per-client**.

## Admin Application Management UI

The admin panel provides full CRUD for applications:

| Action | Description |
| --- | --- |
| **Add to catalog** | Add a new Helm chart as an available application |
| **Edit defaults** | Modify resource defaults or parameters for an app |
| **Enable / Disable** | Control which applications are available for deployment |
| **View deployments** | See all instances of an application across all customers |
| **Upgrade all instances** | Rolling update all deployments of an application |
| **Version control** | Track different Helm chart versions in the catalog |

## Backup & Restore

### Cluster-Level Backups

- **Frequency:** Daily
- **Retention:** Automatic (platform-managed)
- **Cost:** Included in all plans (not counted against customer quota)
- **Scope:** Entire application stack (pods, databases, volumes)
- **Recovery:** Admin initiates restore via control panel

### Customer-Initiated Backups

- **Frequency:** On-demand or custom schedule
- **Retention:** Customer-defined
- **Cost:** Counts toward customer's storage quota
- **Scope:** Full application export (data only, not configuration)
- **Recovery:** Customer can restore to a point-in-time

## Multi-Application Stacks

Some customers may deploy multiple applications:

- **Nextcloud** for file sharing + **Matomo** for analytics
- **Moodle LMS** for education + **Jitsi** for video classes + **Nextcloud** for file collaboration
- **Gitea** for code hosting + **Vaultwarden** for password management + **Mattermost** for team chat

Each instance:
- Runs in its own namespace (if single-tenant)
- Has its own database and storage
- Is tracked separately for resources and billing
- Can be managed independently

## Related Documentation

- **WORKLOAD_DEPLOYMENT.md**: Workload container catalog and deployment
- **HOSTING_PLANS.md**: How applications integrate with hosting plans
- **STORAGE_DATABASES.md**: Database allocation for applications
- **BACKUP_STRATEGY.md**: Backup procedures for applications
- **MONITORING_OBSERVABILITY.md**: Monitoring and logging for applications
