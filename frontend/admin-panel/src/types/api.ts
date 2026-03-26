// Re-export shared contract types
export type {
  ClientResponse as Client,
  ClientListResponse,
  DomainResponse as Domain,
  DomainListResponse,
  DatabaseResponse,
  DatabaseListResponse,
  PaginationMeta,
} from '@k8s-hosting/api-contracts';

export { MAX_PAGE_LIMIT } from '@k8s-hosting/api-contracts';

// Generic paginated response for hooks that don't have a specific contract yet
export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly total_count: number;
    readonly cursor: string | null;
    readonly has_more: boolean;
    readonly page_size: number;
  };
}

// Types not yet in shared contracts (will migrate incrementally)
export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly lastRunAt: string | null;
  readonly lastRunStatus: 'success' | 'failed' | 'running' | null;
  readonly createdAt: string;
}

export interface Workload {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly imageId: string;
  readonly status: 'running' | 'stopped' | 'pending' | 'error';
  readonly replicas: number;
  readonly cpu: string;
  readonly memory: string;
  readonly createdAt: string;
}

export interface DashboardMetrics {
  readonly total_clients: number;
  readonly active_clients: number;
  readonly total_domains: number;
  readonly storage_used_gb: number;
  readonly storage_total_gb: number;
  readonly alerts_count: number;
}
