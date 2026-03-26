// Re-export shared contract types (single source of truth)
export type {
  DomainResponse as Domain,
  DomainListResponse,
  DatabaseResponse as Database,
  DatabaseListResponse,
  BackupResponse as Backup,
  BackupListResponse,
  CronJobResponse as CronJob,
  WorkloadResponse as Workload,
  PaginationMeta,
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
