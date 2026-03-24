export interface Client {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly plan: 'starter' | 'business' | 'premium';
  readonly status: 'active' | 'suspended' | 'pending';
  readonly created_at: string;
  readonly updated_at: string;
  readonly subscription: {
    readonly plan: string;
    readonly expiry_date: string;
    readonly status: string;
  };
  readonly quota: ResourceQuota;
  readonly usage: ResourceUsage;
}

export interface ResourceQuota {
  readonly domains: number;
  readonly databases: number;
  readonly storage_gb: number;
  readonly monthly_bandwidth_gb: number;
}

export interface ResourceUsage {
  readonly domains: number;
  readonly databases: number;
  readonly storage_gb: number;
  readonly monthly_bandwidth_gb: number;
}

export interface Domain {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly status: 'active' | 'pending' | 'error';
  readonly ssl_status: 'valid' | 'pending' | 'expired';
  readonly created_at: string;
}

export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly total: number;
    readonly cursor: string | null;
    readonly has_more: boolean;
  };
}

export interface DashboardMetrics {
  readonly total_clients: number;
  readonly active_clients: number;
  readonly total_domains: number;
  readonly storage_used_gb: number;
  readonly storage_total_gb: number;
  readonly alerts_count: number;
}
