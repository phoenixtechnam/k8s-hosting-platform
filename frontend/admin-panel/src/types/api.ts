// Re-export shared contract types (single source of truth)
export type {
  ClientResponse as Client,
  ClientListResponse,
  DomainResponse as Domain,
  DomainListResponse,
  PaginationMeta,
  CronJobResponse as CronJob,
  CronJobListResponse,
  BackupResponse as Backup,
  BackupListResponse,
  DashboardResponse as DashboardMetrics,
  MetricsResponse,
  SubscriptionResponse,
  HostingPlan,
  DnsRecordResponse,
  HostingSettingsResponse,
  ProtectedDirectoryResponse,
  ProtectedDirectoryUserResponse,
  TlsSettingsResponse,
} from '@k8s-hosting/api-contracts';

export { MAX_PAGE_LIMIT } from '@k8s-hosting/api-contracts';

// Generic paginated response for hooks — also from contracts
export type { PaginationMeta as PaginationInfo } from '@k8s-hosting/api-contracts';

// Re-export deployment type from the new hook
export type { Deployment } from '@/hooks/use-deployments';

// Re-export catalog entry type from the new hook
export type { CatalogEntry } from '@/hooks/use-catalog';

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
