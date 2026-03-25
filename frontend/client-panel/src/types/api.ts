export interface Domain {
  readonly id: string;
  readonly clientId: string;
  readonly domainName: string;
  readonly status: string;
  readonly dnsMode: string;
  readonly sslAutoRenew: number;
  readonly createdAt: string;
}

export interface Database {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly dbType: string;
  readonly status: string;
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
