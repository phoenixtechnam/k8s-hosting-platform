export interface ApiResponse<T> {
  readonly data: T;
  readonly pagination?: PaginationMeta;
}

export interface PaginationMeta {
  readonly cursor: string | null;
  readonly has_more: boolean;
  readonly page_size: number;
  readonly total_count?: number;
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly timestamp: string;
    readonly request_id: string;
    readonly details?: Record<string, unknown>;
    readonly remediation?: string;
  };
}

export function success<T>(data: T): ApiResponse<T> {
  return { data };
}

export function paginated<T>(
  data: T[],
  pagination: PaginationMeta,
): ApiResponse<T[]> {
  return { data, pagination };
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId: string,
  details?: Record<string, unknown>,
  remediation?: string,
): ApiErrorResponse {
  return {
    error: {
      code,
      message,
      status,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      ...(details && { details }),
      ...(remediation && { remediation }),
    },
  };
}
