import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useClientContext } from '@/hooks/use-client-context';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FileEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly modifiedAt: string | null;
  readonly permissions: string;
}

interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
}

interface FileContent {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly modifiedAt: string;
}

interface FileManagerStatus {
  readonly ready: boolean;
  readonly phase: 'not_deployed' | 'starting' | 'ready' | 'failed';
  readonly message?: string;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useFileManagerStatus() {
  const { clientId } = useClientContext();
  return useQuery({
    queryKey: ['file-manager-status', clientId],
    queryFn: () => apiFetch<{ data: FileManagerStatus }>(`/api/v1/clients/${clientId}/files/status`),
    select: (res) => res.data,
    refetchInterval: (query) => {
      // query.state.data is pre-select: { data: FileManagerStatus }
      const raw = query.state.data as { data: FileManagerStatus } | undefined;
      const phase = raw?.data?.phase;
      // Poll every 2s while starting, stop once ready or failed
      if (!phase || phase === 'starting' || phase === 'not_deployed') return 2000;
      return false;
    },
  });
}

export function useStartFileManager() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ data: FileManagerStatus }>(`/api/v1/clients/${clientId}/files/start`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['file-manager-status', clientId] });
    },
  });
}

export function useDirectoryListing(path: string, enabled = true) {
  const { clientId } = useClientContext();
  return useQuery({
    queryKey: ['files', clientId, path],
    queryFn: () => apiFetch<{ data: DirectoryListing }>(`/api/v1/clients/${clientId}/files?path=${encodeURIComponent(path)}`),
    select: (res) => res.data,
    enabled,
  });
}

export function useFileContent(path: string, enabled = true) {
  const { clientId } = useClientContext();
  return useQuery({
    queryKey: ['file-content', clientId, path],
    queryFn: () => apiFetch<{ data: FileContent }>(`/api/v1/clients/${clientId}/files/read?path=${encodeURIComponent(path)}`),
    select: (res) => res.data,
    enabled,
  });
}

export function useCreateDirectory() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) =>
      apiFetch(`/api/v1/clients/${clientId}/files/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

export function useWriteFile() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/write`, {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files', clientId] });
      qc.invalidateQueries({ queryKey: ['file-content', clientId] });
    },
  });
}

/** Upload a file by reading it as text and writing via the write endpoint */
export function useUploadFile() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, targetDir }: { file: File; targetDir: string }) => {
      const content = await file.text();
      const path = targetDir === '/' ? `/${file.name}` : `${targetDir}/${file.name}`;
      return apiFetch(`/api/v1/clients/${clientId}/files/write`, {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files', clientId] });
    },
  });
}

export function useRenameFile() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ oldPath, newPath }: { oldPath: string; newPath: string }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/rename`, {
        method: 'POST',
        body: JSON.stringify({ oldPath, newPath }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

export function useDeleteFile() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) =>
      apiFetch(`/api/v1/clients/${clientId}/files/delete`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

export function useDownloadUrl(path: string): string {
  const { clientId } = useClientContext();
  const apiUrl = import.meta.env.VITE_API_URL ?? '';
  return `${apiUrl}/api/v1/clients/${clientId}/files/download?path=${encodeURIComponent(path)}`;
}

export type { FileEntry, DirectoryListing, FileContent, FileManagerStatus };
