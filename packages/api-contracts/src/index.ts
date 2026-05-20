// Shared API contracts for the K8s Hosting Platform
//
// This package is the SINGLE SOURCE OF TRUTH for all API types.
// Both backend and frontend import from here.
//
// Usage:
//   import { createTenantSchema, type TenantResponse } from '@k8s-hosting/api-contracts';
//
// Rules:
//   1. ALL API input/output types MUST be defined here
//   2. Backend validates with Zod schemas from this package
//   3. Frontend uses inferred TypeScript types from this package
//   4. NEVER define API types locally in backend or frontend
//   5. PaginationParams enforces limit <= MAX_PAGE_LIMIT (100)

export * from './shared.js';
export * from './cluster-network.js';
export * from './operator-error.js';
export * from './auth.js';
export * from './step-up.js';
export * from './node-terminal.js';
export * from './tenants.js';
export * from './domains.js';
export * from './backups.js';
export * from './backup-schedules.js';
export * from './backups-overview.js';
export * from './tenant-bundles.js';
export * from './restore.js';
export * from './backup-health.js';
export * from './cnpg-backup-health.js';
export * from './node-health.js';
export * from './cron-jobs.js';
export * from './metrics.js';
export * from './subscriptions.js';
export * from './catalog.js';
export * from './dashboard.js';
export * from './dns-records.js';
export * from './protected-directories.js';
export * from './hosting-settings.js';
export * from './notifications.js';
export * from './backup-config.js';
export * from './k8s-manifests.js';
export * from './admin-users.js';
export * from './health.js';
export * from './export-import.js';
export * from './email-domains.js';
export * from './mailboxes.js';
export * from './email-aliases.js';
export * from './mail-admin.js';
export * from './mail-storage.js';
export * from './system-pvc.js';
export * from './mail-blob-store.js';
export * from './smtp-relay.js';
export * from './webmail-settings.js';
export * from './platform-updates.js';
export * from './platform-urls.js';
export * from './ssl-certs.js';
export * from './storage-settings.js';
export * from './eol-settings.js';
export * from './provisioning.js';
export * from './files.js';
export * from './tls-settings.js';
export * from './ingress-routes.js';
export * from './ingress-auth.js';
export * from './ingress-mtls.js';
export * from './mtls-providers.js';
export * from './ziti-providers.js';
export * from './zrok-providers.js';
export * from './deployment-network-access.js';
export * from './ssh-keys.js';
export * from './sftp-users.js';
export * from './private-workers.js';
export * from './storage.js';
export * from './mail-imapsync.js';
export * from './sub-users.js';
export * from './plans.js';
export * from './ai-editor.js';
export * from './oidc-settings.js';
export * from './cluster-nodes.js';
export * from './load-balancer.js';
export * from './platform-storage-policy.js';
export * from './system-settings.js';
export * from './orphaned-volumes.js';
export * from './system-snapshots.js';
export * from './snapshot-accounting.js';
export * from './snapshot-classes.js';
export * from './lifecycle-hooks.js';
export * from './postgres-restore.js';
export * from './system-backup.js';
export * from './system-wal-archive.js';
export * from './task-center.js';
export * from './custom-deployments.js';
export * from './compose.js';
export * from './mail-snapshot.js';
export * from './mail-archive.js';
export * from './mail-placement.js';
export * from './mail-health.js';
export * from './security-hardening.js';
export * from './secrets-audit.js';
export * from './secrets-bundle.js';
export * from './dr-drill.js';
export * from './waf-events.js';
export * from './crowdsec.js';
export * from './crowdsec-autoban.js';
export * from './waf-rule-exclusions.js';
