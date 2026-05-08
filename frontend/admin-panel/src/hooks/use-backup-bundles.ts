import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BundleSummary,
  BundleDetail,
  CreateBundleInput,
  VerifyBundleResponse,
} from '@k8s-hosting/api-contracts';

/**
 * apiFetch returns raw wire JSON (no envelope unwrap), and the
 * routes wrap their payload with `success(...)` which adds an outer
 * `{ data: ... }`. So a list response on the wire is
 * `{ data: { data: BundleSummary[], pagination: {...} } }`.
 * Mirroring the convention in use-backup-config.ts.
 */
interface ListResponse {
  data: {
    data: BundleSummary[];
    pagination: { total_count: number; cursor: string | null; has_more: boolean; page_size: number };
  };
}

interface SingleResponse<T> { data: T }

/**
 * List bundles. Optionally filter by clientId. Refetches every 30s
 * so a freshly-created bundle shows up without manual refresh.
 */
export function useBundles(clientId?: string) {
  const path = clientId
    ? `/api/v1/admin/tenant-bundles?clientId=${encodeURIComponent(clientId)}`
    : '/api/v1/admin/tenant-bundles';
  return useQuery({
    queryKey: ['backup-bundles', clientId ?? 'all'],
    queryFn: () => apiFetch<ListResponse>(path),
    refetchInterval: 30_000,
  });
}

export function useBundleDetail(bundleId: string | null) {
  return useQuery({
    queryKey: ['backup-bundle', bundleId],
    queryFn: () => apiFetch<SingleResponse<BundleDetail>>(`/api/v1/admin/tenant-bundles/${bundleId}`),
    enabled: !!bundleId,
  });
}

/**
 * Poll a bundle's detail every 2s while it's still in flight
 * (status='pending' or 'running'). Once a terminal status lands the
 * polling stops automatically — TanStack Query reads the next
 * `refetchInterval` from the latest data and an `undefined` return
 * disables further intervals. Used by the create-bundle progress
 * modal to render per-component live status.
 */
export function useBundleDetailLive(bundleId: string | null) {
  return useQuery({
    queryKey: ['backup-bundle', 'live', bundleId],
    queryFn: () => apiFetch<SingleResponse<BundleDetail>>(`/api/v1/admin/tenant-bundles/${bundleId}`),
    enabled: !!bundleId,
    // Poll every 2s while the bundle is still in flight; stop once
    // it reaches a terminal status.
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status;
      const inFlight = status === 'pending' || status === 'running';
      return inFlight ? 2000 : false;
    },
    refetchIntervalInBackground: true,
    // No cache hold: the modal needs the FRESHEST row each refetch.
    staleTime: 0,
  });
}

export function useCreateBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBundleInput) =>
      apiFetch<SingleResponse<{ bundleId: string; status: string }>>('/api/v1/admin/tenant-bundles', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
    },
  });
}

/**
 * Trigger a browser download of the encrypted GDPR data-export
 * tarball. Uses fetch + Blob + URL.createObjectURL because <a
 * href> cannot carry the Authorization Bearer header. The blob
 * stays opaque ciphertext — the client decrypts locally with their
 * passphrase.
 */
export async function downloadDataExport(bundleId: string): Promise<void> {
  const token = localStorage.getItem('auth_token');
  const r = await fetch(`/api/v1/admin/tenant-bundles/${bundleId}/data-export`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`download failed (${r.status}): ${detail.slice(0, 200)}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `data-export-${bundleId}.tar.gz.enc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Hold onto the blob URL just long enough for the click to take
  // effect, then revoke. Some browsers cancel the download if the
  // URL is revoked synchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Streaming bundle download via a signed URL.
 *
 * Flow:
 *   1. POST `/admin/tenant-bundles/:id/export-token` with
 *      `{ format, password? }`. Server returns `{ downloadUrl,
 *      expiresInSec }` where `downloadUrl` is a single-bundle
 *      HMAC-signed URL valid for 5 min. The password (when set) is
 *      AES-256-GCM-encrypted into the URL — plaintext never appears
 *      in the URL or browser history.
 *   2. Click a hidden `<a download rel="noreferrer">` pointing at
 *      `downloadUrl`. The browser issues a GET, the server validates
 *      the token, and streams the bundle straight back. The native
 *      save-file dialog opens at byte 0 — no Blob() buffering, no
 *      RAM cap on the bundle size.
 *
 * Why an `<a>` click instead of `window.location`:
 *   `<a download rel="noreferrer">` suppresses the Referer header,
 *   so any third-party request the download page subsequently makes
 *   (analytics, CDN, browser extension) can't see the signed token.
 *
 * Formats:
 *   - 'tar' → `tar.gz` (plain) or `tar.gz.enc` (OpenSSL Salted__
 *             AES-256-CBC envelope, 100k-iter PBKDF2-SHA256;
 *             decryptable with `openssl enc -d -aes-256-cbc
 *             -pbkdf2 -iter 100000`). Password is optional.
 *   - 'zip' → plaintext `.zip` only. Password is ignored on the
 *             ZIP path (architecturally — see backend rationale).
 */
export async function downloadBundleExport(
  bundleId: string,
  format: 'tar' | 'zip',
  password: string | null,
): Promise<void> {
  const body: { format: 'tar' | 'zip'; password?: string } = { format };
  // Only the tar path consumes a password; ZIP ignores it.
  if (format === 'tar' && password && password.length > 0) {
    body.password = password;
  }
  const r = await apiFetch<{ data: { downloadUrl: string; expiresInSec: number } }>(
    `/api/v1/admin/tenant-bundles/${bundleId}/export-token`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  const downloadUrl = r.data.downloadUrl;
  if (!downloadUrl) throw new Error('server returned no downloadUrl');

  // Click a hidden <a> with `rel="noreferrer"` so the signed token
  // is not leaked in Referer headers from any cross-origin requests
  // the page makes after the click (analytics, CDN, extensions).
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.rel = 'noreferrer noopener';
  // The download attribute is ignored on cross-origin URLs but our
  // URL is same-origin, so the filename is set server-side via the
  // Content-Disposition header — a.download is just a fallback.
  if (format === 'zip') {
    a.download = `bundle-${bundleId}.zip`;
  } else if (password && password.length > 0) {
    a.download = `bundle-${bundleId}.tar.gz.enc`;
  } else {
    a.download = `bundle-${bundleId}.tar.gz`;
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface ImportBundleResult {
  readonly bundleId: string;
  readonly sizeBytes: number;
  readonly componentCount: number;
}

/**
 * Multi-region import — multipart POST with the encrypted tarball
 * + passphrase + target clientId/targetConfigId. Server decrypts,
 * uploads each component to the local off-site target, registers a
 * fresh backup_jobs row.
 */
export async function importBundle(args: {
  file: File;
  passphrase: string;
  clientId: string;
  targetConfigId: string;
}): Promise<ImportBundleResult> {
  const fd = new FormData();
  fd.append('bundle', args.file);
  fd.append('passphrase', args.passphrase);
  fd.append('clientId', args.clientId);
  fd.append('targetConfigId', args.targetConfigId);
  const token = localStorage.getItem('auth_token');
  const r = await fetch('/api/v1/admin/tenant-bundles/import', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`import failed (${r.status}): ${detail.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.data as ImportBundleResult;
}

export interface VerifyAllResult {
  readonly summary: { readonly total: number; readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly results: ReadonlyArray<{
    readonly bundleId: string;
    readonly status: 'passed' | 'failed' | 'skipped';
    readonly reason?: string;
    readonly durationMs: number;
  }>;
}

/**
 * Batch-verify every bundle. Single-shot mutation; auto-invalidates
 * the bundles list so the UI re-fetches.
 */
export function useVerifyAllBundles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ data: VerifyAllResult }>('/api/v1/admin/tenant-bundles/verify-all', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    onSuccess: () => {
      // Invalidate both list (status display) and any open detail
      // panels so a verify-all run reflects in the UI immediately.
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
      qc.invalidateQueries({ queryKey: ['backup-bundle'] });
    },
  });
}

interface CoverageEnvelope { readonly data: import('@k8s-hosting/api-contracts').BundleCoverageResponse }

/**
 * Bundle coverage report — declared component registry + runtime
 * drift against the live DB schema. Powers the Coverage tab on the
 * Tenant Backup admin page.
 */
export function useBundleCoverage() {
  return useQuery({
    queryKey: ['tenant-bundles', 'coverage'],
    queryFn: () => apiFetch<CoverageEnvelope>('/api/v1/admin/tenant-bundles/coverage'),
    staleTime: 60_000,
  });
}

export function useDeleteBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bundleId: string) =>
      apiFetch<void>(`/api/v1/admin/tenant-bundles/${bundleId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
      // Also invalidate any open detail panels (different key prefix);
      // see use-backup-bundles.ts useBundleDetail.
      qc.invalidateQueries({ queryKey: ['backup-bundle'] });
    },
  });
}

/**
 * Run the round-trip integrity check for a bundle. The endpoint reads
 * every component back from the off-site target, decrypts + parses
 * each, and returns per-component sizes / SHA-256 / row counts.
 * No DB writes — safe to run repeatedly.
 */
export function useVerifyBundle() {
  return useMutation({
    mutationFn: (bundleId: string) =>
      apiFetch<SingleResponse<VerifyBundleResponse>>(`/api/v1/admin/tenant-bundles/${bundleId}/verify`, {
        method: 'POST',
      }),
  });
}
