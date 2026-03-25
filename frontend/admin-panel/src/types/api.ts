export interface Client {
  readonly id: string;
  // API returns camelCase from Drizzle
  readonly companyName?: string;
  readonly companyEmail?: string;
  readonly contactEmail?: string | null;
  readonly kubernetesNamespace?: string;
  readonly planId?: string;
  readonly regionId?: string;
  readonly createdBy?: string;
  readonly subscriptionExpiresAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  // Legacy/mock fields (snake_case)
  readonly name?: string;
  readonly email?: string;
  readonly plan?: string;
  readonly status: 'active' | 'suspended' | 'pending' | 'cancelled';
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface Domain {
  readonly id: string;
  readonly clientId: string;
  readonly domainName: string;
  readonly status: 'active' | 'pending' | 'error';
  readonly sslAutoRenew: number;
  readonly dnsMode: string;
  readonly createdAt: string;
}

export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly total_count: number;
    readonly cursor: string | null;
    readonly has_more: boolean;
    readonly page_size: number;
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
