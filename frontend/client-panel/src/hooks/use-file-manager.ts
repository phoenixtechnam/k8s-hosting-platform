import { useState, useCallback } from 'react';
import type * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, API_BASE } from '@/lib/api-client';
import { useClientContext } from '@/hooks/use-client-context';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FileEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly modifiedAt: string | null;
  readonly permissions: string;
  readonly uid: number;
  readonly gid: number;
  readonly owner?: string;
  readonly group?: string;
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

export function useChmod() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, mode, recursive }: { path: string; mode: string; recursive?: boolean }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/chmod`, {
        method: 'POST',
        body: JSON.stringify({ path, mode, recursive }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', clientId] }); },
  });
}

export function useChown() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, uid, gid, owner, group, recursive }: { path: string; uid?: number; gid?: number; owner?: string; group?: string; recursive?: boolean }) =>
      apiFetch(`/api/v1/clients/${clientId}/files/chown`, {
        method: 'POST',
        body: JSON.stringify({ path, uid, gid, owner, group, recursive }),
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

/** Trigger an authenticated file download.
 *
 * Uses a native <a href> click with the JWT in a `token=` query param
 * (the FM routes' onRequest hook reads it when no Authorization header
 * is present). This makes the browser stream the response straight to
 * disk: the save dialog appears AS SOON AS the response head arrives
 * (fast — sub-second after our probe-first cold path), and the body is
 * written to the chosen file as it flows from the server. No memory
 * buffer, no spinner-only-then-pop UX.
 *
 * The previous fetch + blob() approach buffered the entire response
 * in browser memory before triggering the download — which is why the
 * save dialog only appeared after the full transfer completed.
 */
export function useDownloadFile() {
  const { clientId } = useClientContext();
  return useCallback((path: string) => {
    const token = localStorage.getItem('auth_token') ?? '';
    const url = `${API_BASE}/api/v1/clients/${clientId}/files/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`;
    const filename = path.split('/').pop() || 'download';
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // The anchor must be in the DOM for some browsers to honour click().
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [clientId]);
}

/** Upload files with XHR progress tracking */
export interface UploadChunkProgress {
  readonly idx: number;
  readonly offset: number;
  readonly size: number;
  readonly loaded: number;
  readonly status: 'pending' | 'uploading' | 'done' | 'error';
}

export interface UploadProgress {
  readonly filename: string;
  readonly loaded: number;
  readonly total: number;
  readonly percent: number;
  readonly status: 'uploading' | 'done' | 'error' | 'cancelled';
  readonly error?: string;
  readonly abort?: () => void;
  /** Per-chunk progress when the upload is split into parallel chunks
   *  (files larger than CHUNK_THRESHOLD). Empty/undefined for small
   *  files that go single-stream. */
  readonly chunks?: readonly UploadChunkProgress[];
}

// Files larger than this are split into chunks and uploaded in parallel.
// 8 MiB is the breakeven: smaller files don't benefit from parallelism
// (cold-start overhead dominates) but larger files saturate residential
// uplinks better with multiple TCP flows.
const CHUNK_THRESHOLD = 8 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const PARALLEL_CHUNKS = 4;

export function useUploadFiles() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [visible, setVisible] = useState(false);

  const uploadFile = useCallback((file: File, targetDir: string) => {
    const filePath = targetDir === '/' ? `/${file.name}` : `${targetDir}/${file.name}`;

    // Files above the threshold use parallel chunked upload — each
    // chunk is its own POST with ?offset=N. The sidecar pwrites at
    // that offset (no truncation) so concurrent chunks land in the
    // correct slots and the file is whole when all chunks complete.
    if (file.size > CHUNK_THRESHOLD) {
      uploadFileChunked(clientId!, qc, file, filePath, setUploads, setVisible);
      return;
    }

    const url = `${API_BASE}/api/v1/clients/${clientId}/files/upload-raw?path=${encodeURIComponent(filePath)}`;

    const xhr = new XMLHttpRequest();

    // Create abort function that cancels the XHR and updates status
    const abortFn = () => {
      xhr.abort();
      setUploads(prev => prev.map(u =>
        u.filename === file.name && u.status === 'uploading'
          ? { ...u, status: 'cancelled' as const, error: 'Upload cancelled', abort: undefined }
          : u,
      ));
    };

    setUploads(prev => [...prev, {
      filename: file.name, loaded: 0, total: file.size, percent: 0,
      status: 'uploading', abort: abortFn,
    }]);
    setVisible(true);

    xhr.open('POST', url);

    const token = localStorage.getItem('auth_token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUploads(prev => prev.map(u =>
          u.filename === file.name && u.status === 'uploading'
            ? { ...u, loaded: e.loaded, total: e.total, percent: Math.round((e.loaded / e.total) * 100) }
            : u,
        ));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploads(prev => prev.map(u =>
          u.filename === file.name && u.status === 'uploading'
            ? { ...u, status: 'done', percent: 100, loaded: u.total, abort: undefined }
            : u,
        ));
        qc.invalidateQueries({ queryKey: ['files', clientId] });
      } else {
        const errMsg = (() => { try { return JSON.parse(xhr.responseText)?.error?.message; } catch { return xhr.statusText; } })();
        setUploads(prev => prev.map(u =>
          u.filename === file.name && u.status === 'uploading'
            ? { ...u, status: 'error', error: errMsg || 'Upload failed', abort: undefined }
            : u,
        ));
      }
    };

    xhr.onerror = () => {
      setUploads(prev => prev.map(u =>
        u.filename === file.name && u.status === 'uploading'
          ? { ...u, status: 'error', error: 'Network error', abort: undefined }
          : u,
      ));
    };

    xhr.onabort = () => {
      setUploads(prev => prev.map(u =>
        u.filename === file.name && u.status === 'uploading'
          ? { ...u, status: 'cancelled' as const, error: 'Upload cancelled', abort: undefined }
          : u,
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

/**
 * Parallel chunked upload. Splits the file into CHUNK_SIZE-byte slices
 * and POSTs them concurrently (PARALLEL_CHUNKS at a time) to
 * /upload-raw?path=…&offset=<absolute offset>. The sidecar pwrites at
 * each offset without truncating so concurrent chunks don't conflict.
 *
 * Per-flow uplinks (residential ISPs especially) cap a single TCP flow
 * regardless of available bandwidth. PARALLEL_CHUNKS=4 typically
 * delivers 3-4x aggregate throughput on those connections.
 */
function uploadFileChunked(
  clientId: string,
  qc: ReturnType<typeof useQueryClient>,
  file: File,
  filePath: string,
  setUploads: React.Dispatch<React.SetStateAction<UploadProgress[]>>,
  setVisible: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  const total = file.size;
  const chunkCount = Math.ceil(total / CHUNK_SIZE);
  const chunks: UploadChunkProgress[] = Array.from({ length: chunkCount }, (_, idx) => ({
    idx,
    offset: idx * CHUNK_SIZE,
    size: idx === chunkCount - 1 ? total - idx * CHUNK_SIZE : CHUNK_SIZE,
    loaded: 0,
    status: 'pending',
  }));

  const inFlight = new Set<XMLHttpRequest>();
  let cancelled = false;
  const abortFn = () => {
    cancelled = true;
    for (const xhr of inFlight) try { xhr.abort(); } catch { /* ignore */ }
    setUploads(prev => prev.map(u =>
      u.filename === file.name && u.status === 'uploading'
        ? { ...u, status: 'cancelled' as const, error: 'Upload cancelled', abort: undefined }
        : u,
    ));
  };

  setUploads(prev => [...prev, {
    filename: file.name,
    loaded: 0,
    total,
    percent: 0,
    status: 'uploading',
    abort: abortFn,
    chunks,
  }]);
  setVisible(true);

  // Mutable progress state shared across chunk callbacks. We update
  // the React state from one consolidated setState call per progress
  // event to avoid N concurrent setState rerenders.
  const chunkLoaded = new Array<number>(chunkCount).fill(0);
  const chunkStatus = new Array<UploadChunkProgress['status']>(chunkCount).fill('pending');

  const pushUpdate = () => {
    const totalLoaded = chunkLoaded.reduce((a, b) => a + b, 0);
    const percent = Math.round((totalLoaded / total) * 100);
    const next: UploadChunkProgress[] = chunks.map((c, i) => ({
      ...c,
      loaded: chunkLoaded[i],
      status: chunkStatus[i],
    }));
    setUploads(prev => prev.map(u =>
      u.filename === file.name && u.status === 'uploading'
        ? { ...u, loaded: totalLoaded, percent, chunks: next }
        : u,
    ));
  };

  const uploadOne = (idx: number): Promise<void> => new Promise((resolve, reject) => {
    if (cancelled) { resolve(); return; }
    const c = chunks[idx];
    const slice = file.slice(c.offset, c.offset + c.size);
    const url = `${API_BASE}/api/v1/clients/${clientId}/files/upload-raw?path=${encodeURIComponent(filePath)}&offset=${c.offset}`;
    const xhr = new XMLHttpRequest();
    inFlight.add(xhr);
    xhr.open('POST', url);
    const token = localStorage.getItem('auth_token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    chunkStatus[idx] = 'uploading';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        chunkLoaded[idx] = e.loaded;
        pushUpdate();
      }
    };
    xhr.onload = () => {
      inFlight.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        chunkLoaded[idx] = c.size;
        chunkStatus[idx] = 'done';
        pushUpdate();
        resolve();
      } else {
        chunkStatus[idx] = 'error';
        pushUpdate();
        reject(new Error(`chunk ${idx}: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => {
      inFlight.delete(xhr);
      chunkStatus[idx] = 'error';
      pushUpdate();
      reject(new Error(`chunk ${idx}: network error`));
    };
    xhr.onabort = () => {
      inFlight.delete(xhr);
      resolve(); // cancellation is not a per-chunk error
    };
    xhr.send(slice);
  });

  // Run a sliding window of PARALLEL_CHUNKS uploads. We don't await
  // here so the caller (uploadFile) returns immediately — the React
  // state updates drive the UI.
  void (async () => {
    try {
      let next = 0;
      const workers: Promise<void>[] = [];
      const launchNext = (): Promise<void> => {
        if (next >= chunkCount || cancelled) return Promise.resolve();
        const idx = next++;
        return uploadOne(idx).then(launchNext);
      };
      for (let i = 0; i < Math.min(PARALLEL_CHUNKS, chunkCount); i++) workers.push(launchNext());
      await Promise.all(workers);
      if (cancelled) return;
      // Verify all chunks succeeded — any error short-circuits.
      if (chunkStatus.some(s => s === 'error')) {
        setUploads(prev => prev.map(u =>
          u.filename === file.name && u.status === 'uploading'
            ? { ...u, status: 'error', error: 'One or more chunks failed', abort: undefined }
            : u,
        ));
        return;
      }
      setUploads(prev => prev.map(u =>
        u.filename === file.name && u.status === 'uploading'
          ? { ...u, status: 'done', percent: 100, loaded: total, abort: undefined }
          : u,
      ));
      qc.invalidateQueries({ queryKey: ['files', clientId] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploads(prev => prev.map(u =>
        u.filename === file.name && u.status === 'uploading'
          ? { ...u, status: 'error', error: msg, abort: undefined }
          : u,
      ));
    }
  })();
}

export interface DiskUsage {
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedFormatted: string;
  readonly totalFormatted: string;
  readonly availableFormatted: string;
}

export function useDiskUsage() {
  const { clientId } = useClientContext();
  return useQuery({
    queryKey: ['disk-usage', clientId],
    queryFn: () => apiFetch<{ data: DiskUsage }>(
      `/api/v1/clients/${clientId}/files/disk-usage`
    ),
    enabled: Boolean(clientId),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function useFolderSize() {
  const { clientId } = useClientContext();

  return useMutation({
    mutationFn: (path: string) =>
      apiFetch<{ data: { path: string; sizeBytes: number; sizeFormatted: string } }>(
        `/api/v1/clients/${clientId}/files/folder-size?path=${encodeURIComponent(path)}`
      ),
  });
}

export type { FileEntry, DirectoryListing, FileContent, FileManagerStatus };
