/**
 * Label & annotation contract for backup-health discovery.
 *
 * The reconciler watches Jobs cluster-wide using these labels rather
 * than hardcoded names, so future backup jobs (client-initiated tenant
 * backups, catalog-defined customs, Longhorn recurring jobs via
 * Kustomize patches) participate automatically.
 */

/** Required: opt into backup-health discovery. Value must be "true". */
export const LABEL_HEALTH_WATCH = 'platform.phoenix-host.net/backup-health-watch';

/** Required: drives UI grouping + notification routing. */
export const LABEL_CATEGORY = 'platform.phoenix-host.net/backup-category';

/** Optional: drives notification severity. Default 'warning'. */
export const LABEL_SEVERITY = 'platform.phoenix-host.net/backup-severity';

/** Optional: route notifications to that client's recipients. */
export const LABEL_CLIENT_ID = 'platform.phoenix-host.net/client-id';

/** Optional: human-friendly UI label (annotation, not a label). */
export const ANNOTATION_DISPLAY_NAME = 'platform.phoenix-host.net/backup-display-name';

export type BackupCategory = 'dr' | 'tenant' | 'audit' | 'custom';
export type BackupSeverity = 'critical' | 'warning' | 'info';

const CATEGORIES: ReadonlyArray<BackupCategory> = ['dr', 'tenant', 'audit', 'custom'];
const SEVERITIES: ReadonlyArray<BackupSeverity> = ['critical', 'warning', 'info'];

export function parseCategory(raw: string | undefined): BackupCategory {
  if (raw && (CATEGORIES as ReadonlyArray<string>).includes(raw)) {
    return raw as BackupCategory;
  }
  return 'custom';
}

export function parseSeverity(raw: string | undefined): BackupSeverity {
  if (raw && (SEVERITIES as ReadonlyArray<string>).includes(raw)) {
    return raw as BackupSeverity;
  }
  return 'warning';
}

/** Map label severity to the existing notification.type taxonomy. */
export function severityToNotificationType(
  severity: BackupSeverity,
): 'info' | 'warning' | 'error' {
  switch (severity) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
  }
}
