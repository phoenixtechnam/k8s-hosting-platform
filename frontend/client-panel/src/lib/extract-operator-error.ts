import type { OperatorError } from '@k8s-hosting/api-contracts';
import { ApiError } from './api-client';

/**
 * Extract a structured `OperatorError` from a thrown error, or
 * fabricate a minimal envelope so `<ErrorPanel>` can always render.
 *
 * Two paths the platform produces structured envelopes:
 *  1. The middleware error-handler attaches `details.operatorError` on
 *     translated 5xx errors (k8s ApiException patterns).
 *  2. Backend routes (e.g. capacity preflight) attach
 *     `details.operatorError` on intentional 4xx rejects.
 *
 * For everything else (raw JS Error from the network layer, generic
 * INTERNAL_SERVER_ERROR with no envelope), we wrap the message into a
 * minimal "UNKNOWN" envelope. The UI renders it the same way; raw
 * details go in the diagnostics expander.
 */
export function extractOperatorError(err: unknown): OperatorError {
  if (err instanceof ApiError) {
    const details = err.details as { operatorError?: OperatorError } | undefined;
    if (details?.operatorError) return details.operatorError;
    return {
      code: err.code || 'UNKNOWN',
      title: err.code === 'INTERNAL_SERVER_ERROR' ? 'Unexpected error' : err.code,
      detail: err.message,
      remediation: ['Retry. If it keeps failing, copy the request_id and check the platform-api logs.'],
      retryable: err.status >= 500,
      diagnostics: { status: err.status, code: err.code },
    };
  }
  if (err instanceof Error) {
    return {
      code: 'UNKNOWN',
      title: 'Unexpected error',
      detail: err.message,
      remediation: ['Retry. If it keeps failing, check the browser network tab and platform-api logs.'],
      retryable: true,
    };
  }
  return {
    code: 'UNKNOWN',
    title: 'Unexpected error',
    detail: typeof err === 'string' ? err : 'An unknown error occurred',
    remediation: ['Retry the operation.'],
    retryable: true,
  };
}
