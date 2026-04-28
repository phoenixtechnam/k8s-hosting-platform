# Backup Health Label Contract

The backup-health observability module discovers Jobs cluster-wide via
Kubernetes labels rather than a hardcoded list. Any future backup job
(client-initiated tenant backup, catalog-defined custom, third-party
operator-installed CronJob) participates simply by carrying the right
labels.

## Required label

```yaml
metadata:
  labels:
    platform.phoenix-host.net/backup-health-watch: "true"
```

When this label is set on a `batch/v1.Job` or `batch/v1.CronJob`, the
backup-health scheduler picks it up on the next 5-minute tick and
includes it in the rollup returned by `GET /admin/backup-health`.

## Required label: category

```yaml
platform.phoenix-host.net/backup-category: "dr"  # or "tenant" | "audit" | "custom"
```

Drives:

- **UI grouping** — admin Backups page renders a separate section per
  category (Disaster Recovery / Audit / Tenant Backups / Custom).
- **Banner threshold** — only `category=dr` failures trigger the
  top-of-page warning banner. Tenant failures route to the client
  panel via the notification fanout; audit/custom failures show in
  the table but don't escalate.

## Optional label: severity

```yaml
platform.phoenix-host.net/backup-severity: "critical"  # or "warning" (default) | "info"
```

Maps to the existing notification.type taxonomy:

- `critical` → `error` (red badge, page-style notification)
- `warning` → `warning` (amber badge)
- `info` → `info` (blue badge, suppressible)

## Optional label: client routing

```yaml
platform.phoenix-host.net/client-id: "<uuid>"
```

When present, failure notifications route to that client's
`client_admin` users via `getClientNotificationRecipients` instead of
the platform admin pool. Useful for tenant-initiated backup Jobs.

## Optional annotation: display name

```yaml
metadata:
  annotations:
    platform.phoenix-host.net/backup-display-name: "Postgres logical dump"
```

Human-friendly label shown in the UI table. Defaults to the parent
CronJob name (or the Job's own name for one-off Jobs).

## Separate concern: suspend-on-deactivate

```yaml
platform.phoenix-host.net/depends-on: "backup-credentials"
```

CronJobs in the `platform` namespace carrying this label are managed
by `longhorn-reconciler` — suspended when no backup target is active,
unsuspended when one becomes active. Conceptually distinct from
backup-health-watch (a tenant backup might be health-watched but
not depend on the platform's backup-credentials Secret).

## Full example

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: platform-pg-backup
  namespace: platform
  labels:
    app.kubernetes.io/part-of: hosting-platform
    app.kubernetes.io/component: dr-backup
    platform.phoenix-host.net/backup-health-watch: "true"
    platform.phoenix-host.net/backup-category: "dr"
    platform.phoenix-host.net/backup-severity: "critical"
    platform.phoenix-host.net/depends-on: "backup-credentials"
  annotations:
    platform.phoenix-host.net/backup-display-name: "Postgres logical dump"
spec:
  suspend: true     # default suspended — reconciler unsuspends on activate
  schedule: "45 2 * * *"
  ...
```

## How the labels are consumed

| Component | Reads | Effect |
|---|---|---|
| `backend/src/modules/backup-health/scheduler.ts` | `backup-health-watch=true` | Cluster-wide Job listing every 5 min; emits notifications for new failures |
| `backend/src/modules/backup-health/service.ts` | `backup-category`, `backup-severity`, `client-id`, display-name annotation | Builds `BackupHealthSummary` |
| `backend/src/modules/backup-config/longhorn-reconciler.ts` | `depends-on=backup-credentials` | `kubectl patch suspend=true/false` on activate/deactivate |
| `frontend/admin-panel/src/components/BackupHealthBanner.tsx` | `category` + `state` + `severity` | Shows banner only for failing DR jobs |
| `frontend/admin-panel/src/components/BackupHealthTable.tsx` | `category` + all summary fields | Grouped table per category |

## Adding a new backup job

1. Set `backup-health-watch: "true"` and `backup-category: <kind>` on
   the Job/CronJob in your YAML.
2. Set `backup-severity` if non-default.
3. Set `client-id: <uuid>` if it's tenant-scoped.
4. Set `depends-on: backup-credentials` if it reads the
   platform-level backup-credentials Secret.
5. Set the display-name annotation for nicer UI labels.

No code changes needed in the backend or frontend.
