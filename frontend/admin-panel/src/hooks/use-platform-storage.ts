import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface StorageInventory {
  readonly available: boolean;
  readonly message?: string;
  readonly nodes: {
    readonly total: number;
    readonly ready: number;
    readonly schedulable: number;
  };
  readonly volumes: {
    readonly total: number;
    readonly attached: number;
    readonly degraded: number;
    readonly capacityBytes: number;
    readonly allocatedBytes: number;
  };
  readonly backupTarget: {
    readonly url: string;
    readonly available: boolean;
    readonly message: string;
  };
}

interface Envelope {
  readonly data: StorageInventory;
}

export function usePlatformStorage() {
  return useQuery({
    queryKey: ['platform-storage'],
    queryFn: async () => {
      const res = await apiFetch<Envelope>('/api/v1/admin/platform/storage');
      return res.data;
    },
    // Longhorn state doesn't change fast; 30s staleness is plenty.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 2 : 1)} ${units[i]}`;
}
