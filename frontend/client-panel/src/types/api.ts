// Re-export shared contract types (single source of truth)
export type {
  DomainResponse as Domain,
  DomainListResponse,
  BackupResponse as Backup,
  BackupListResponse,
  CronJobResponse as CronJob,
  CronJobListResponse,
  DeploymentResponse as Deployment,
  DeploymentListResponse,
  PaginationMeta,
  DnsRecordResponse,
  HostingSettingsResponse,
  ProtectedDirectoryResponse,
  ProtectedDirectoryUserResponse,
  CatalogEntryResponse as CatalogEntry,
  CatalogEntryVersionResponse,
  DeploymentUpgradeResponse,
  Parameter,
} from '@k8s-hosting/api-contracts';

export { MAX_PAGE_LIMIT } from '@k8s-hosting/api-contracts';

// Generic paginated response wrapper
export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly total_count: number;
    readonly cursor: string | null;
    readonly has_more: boolean;
    readonly page_size: number;
  };
}
