import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';

export interface SystemInfo {
  readonly platformName: string;
  readonly supportEmail: string | null;
  readonly supportUrl: string | null;
  readonly adminPanelUrl: string | null;
  readonly clientPanelUrl: string | null;
}

interface SystemInfoResponse {
  readonly data: SystemInfo;
}

/**
 * Fetches public platform branding from /api/v1/system-info (no auth).
 * Cached ~5 min — the values change rarely and the admin panel is usually
 * open for long sessions.
 */
export function useSystemInfo() {
  return useQuery({
    queryKey: ['system-info'],
    queryFn: () => apiFetch<SystemInfoResponse>('/api/v1/system-info'),
    staleTime: 5 * 60_000,
    // `/system-info` is public — skip the auth header and let the browser
    // cache respect the long staleTime.
    retry: 1,
    select: (res) => res.data,
  });
}

/**
 * Sets `document.title` to `<pageTitle> · <platformName>` (or just the
 * platformName on routes that don't set their own title). Keeps the tab
 * label in sync with the admin-chosen platform name.
 */
export function useDocumentTitle(pageTitle?: string): void {
  const { data: info } = useSystemInfo();
  useEffect(() => {
    const name = info?.platformName ?? 'Hosting Platform';
    document.title = pageTitle ? `${pageTitle} · ${name}` : name;
  }, [info?.platformName, pageTitle]);
}
