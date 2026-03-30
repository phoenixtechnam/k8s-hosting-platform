// Re-export shared contract types (single source of truth)
export type {
  ClientResponse as Client,
  ClientListResponse,
  DomainResponse as Domain,
  DomainListResponse,
  PaginationMeta,
  WorkloadResponse as Workload,
  WorkloadListResponse,
  CronJobResponse as CronJob,
  CronJobListResponse,
  BackupResponse as Backup,
  BackupListResponse,
  ContainerImageResponse as ContainerImage,
  WorkloadRepoResponse as WorkloadRepo,
  DashboardResponse as DashboardMetrics,
  MetricsResponse,
  SubscriptionResponse,
  HostingPlan,
  DnsRecordResponse,
  HostingSettingsResponse,
  ProtectedDirectoryResponse,
  ProtectedDirectoryUserResponse,
  ApplicationUpgradeResponse,
  AvailableUpgrade,
  ApplicationInstanceResponse,
  ApplicationVersionResponse,
  UpgradeStatus,
} from '@k8s-hosting/api-contracts';

export { MAX_PAGE_LIMIT } from '@k8s-hosting/api-contracts';

// Generic paginated response for hooks — also from contracts
export type { PaginationMeta as PaginationInfo } from '@k8s-hosting/api-contracts';

// Generic paginated response wrapper for hooks that need it
export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly total_count: number;
    readonly cursor: string | null;
    readonly has_more: boolean;
    readonly page_size: number;
  };
}
