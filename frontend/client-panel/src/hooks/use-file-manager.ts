import { useState, useCallback } from 'react';
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

// ─── Helpers ────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useFileManagerStatus() {
  const { clientId } = useClientContext();
  return useQuery({
    queryKey: ['file-manager-status', clientId],
    queryFn: () => apiFetch<{ data: FileManagerStatus }>(`/api/v1/clients/${clientId}/files/status`),
    select: (res) => res.data,
    refetchInterval: (query) => {
      const raw = query.state.data as { data: FileManagerStatus } | undefined;
      const phase = raw?.data?.phase;
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

export function useCopyFile() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourcePath, destPath }: { sourcePath: string; destPath: string }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/copy`, {
        method: 'POST',
        body: JSON.stringify({ sourcePath, destPath }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

export function useArchiveFiles() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paths, destPath, format }: { paths: string[]; destPath: string; format: 'zip' | 'tar.gz' | 'tar' }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/archive`, {
        method: 'POST',
        body: JSON.stringify({ paths, destPath, format }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

export function useExtractArchive() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, destPath }: { path: string; destPath: string }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/extract`, {
        method: 'POST',
        body: JSON.stringify({ path, destPath }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

export function useGitClone() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ url, destPath }: { url: string; destPath: string }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/git-clone`, {
        method: 'POST',
        body: JSON.stringify({ url, destPath }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

/** Fetch a file as a blob URL (authenticated) for image preview / download */
export function useAuthenticatedBlobUrl(path: string, enabled = true) {
  const { clientId } = useClientContext();
  return useQuery({
    queryKey: ['file-blob', clientId, path],
    queryFn: async () => {
      const url = `${API_BASE}/api/v1/clients/${clientId}/files/download?path=${encodeURIComponent(path)}`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error('Failed to fetch file');
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },
    enabled,
    staleTime: 60_000,
  });
}

/** Trigger an authenticated file download */
export function useDownloadFile() {
  const { clientId } = useClientContext();
  return useCallback(async (path: string) => {
    const url = `${API_BASE}/api/v1/clients/${clientId}/files/download?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Failed to download file');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const filename = path.split('/').pop() || 'download';
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }, [clientId]);
}

/** Upload files with XHR progress tracking */
export interface UploadProgress {
  readonly filename: string;
  readonly loaded: number;
  readonly total: number;
  readonly percent: number;
  readonly status: 'uploading' | 'done' | 'error';
  readonly error?: string;
}

export function useUploadFiles() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [visible, setVisible] = useState(false);

  const uploadFile = useCallback((file: File, targetDir: string) => {
    const filePath = targetDir === '/' ? `/${file.name}` : `${targetDir}/${file.name}`;
    const url = `${API_BASE}/api/v1/clients/${clientId}/files/upload-raw?path=${encodeURIComponent(filePath)}`;

    setUploads(prev => [...prev, { filename: file.name, loaded: 0, total: file.size, percent: 0, status: 'uploading' }]);
    setVisible(true);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);

    const token = localStorage.getItem('auth_token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUploads(prev => prev.map(u =>
          u.filename === file.name ? { ...u, loaded: e.loaded, total: e.total, percent: Math.round((e.loaded / e.total) * 100) } : u,
        ));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploads(prev => prev.map(u =>
          u.filename === file.name ? { ...u, status: 'done', percent: 100, loaded: u.total } : u,
        ));
        qc.invalidateQueries({ queryKey: ['files', clientId] });
      } else {
        const errMsg = (() => { try { return JSON.parse(xhr.responseText)?.error?.message; } catch { return xhr.statusText; } })();
        setUploads(prev => prev.map(u =>
          u.filename === file.name ? { ...u, status: 'error', error: errMsg || 'Upload failed' } : u,
        ));
      }
    };

    xhr.onerror = () => {
      setUploads(prev => prev.map(u =>
        u.filename === file.name ? { ...u, status: 'error', error: 'Network error' } : u,
      ));
    };

    xhr.send(file);
  }, [clientId, qc]);

  const uploadFiles = useCallback((files: FileList | File[], targetDir: string) => {
    for (const file of Array.from(files)) {
      uploadFile(file, targetDir);
    }
  }, [uploadFile]);

  const clearUploads = useCallback(() => {
    setUploads([]);
    setVisible(false);
  }, []);

  return { uploads, uploadFiles, clearUploads, visible, setVisible };
}

export type { FileEntry, DirectoryListing, FileContent, FileManagerStatus };
