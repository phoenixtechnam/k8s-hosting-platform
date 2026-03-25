import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ContainerImage {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly imageType: string;
  readonly registryUrl: string | null;
  readonly status: string;
  readonly createdAt: string;
}

interface ContainerImagesResponse {
  readonly data: readonly ContainerImage[];
}

export function useContainerImages() {
  return useQuery({
    queryKey: ['container-images'],
    queryFn: () => apiFetch<ContainerImagesResponse>('/api/v1/container-images'),
    staleTime: 300_000,
  });
}
