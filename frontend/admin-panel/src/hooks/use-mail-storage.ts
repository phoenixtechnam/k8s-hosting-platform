import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { MailPvcStorageResponse } from '@k8s-hosting/api-contracts';

interface StorageEnvelope {
  readonly data: MailPvcStorageResponse;
}

const STORAGE_KEY = ['mail', 'pvc', 'storage'] as const;

/**
 * Read live Stalwart RocksDB PVC state. Read-only since the
 * 2026-05-14 streamline removed the resize endpoint — mail is
 * local-path only and local-path does not enforce/quota
 * `requests.storage`, so resize was never a meaningful operation
 * post-migration anyway.
 */
export function useMailPvcStorage() {
  return useQuery({
    queryKey: STORAGE_KEY,
    queryFn: () => apiFetch<StorageEnvelope>('/api/v1/admin/mail/pvc/storage'),
    staleTime: 5_000,
    retry: false,
  });
}
