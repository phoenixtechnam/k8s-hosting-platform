/**
 * Mail SSL status modal — opened from the TLS/SSL cell in
 * MailServerStatusTile. Replaces the old inline MailSslStatusCard.
 *
 * Behaviour mirrors the old card:
 *   - Lazy: the probe doesn't run on mount. The modal opens with a
 *     "Check now" button; first click fires the probe.
 *   - Cached: subsequent renders within 30s read the backend's
 *     in-process cache.
 *   - "Refresh" button bypasses the cache with ?refresh=1.
 *
 * Differences from the old card:
 *   - Cipher column dropped (operator feedback: noisy + low signal —
 *     TLS protocol + cert dates + handshake-OK are enough for a
 *     daily-driver dashboard. Cipher details remain in backend logs
 *     for forensic work).
 *   - Lives inside a modal so it doesn't take up vertical space on
 *     the page when not needed.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, RefreshCw, AlertTriangle, Loader2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

interface CertInfo {
  subject: string;
  issuer: string;
  subjectAlternativeNames: string[];
  notBefore: string;
  notAfter: string;
  daysUntilExpiry: number;
  serialNumber: string;
  fingerprintSha256: string;
}

interface ListenerStatus {
  listener: 'smtp' | 'submissions' | 'submission' | 'imap' | 'imaps' | 'managesieve' | 'webmail-https';
  port: number;
  host: string;
  tlsMode: 'implicit' | 'starttls';
  connected: boolean;
  tlsProtocol: string | null;
  cipher: string | null;
  cert: CertInfo | null;
  error: string | null;
  durationMs: number;
}

interface SslStatusResponse {
  host: string;
  webmailHost: string | null;
  listeners: ListenerStatus[];
  cachedTtlMs: number;
}

const LISTENER_LABELS: Record<ListenerStatus['listener'], string> = {
  smtp: 'SMTP (incoming MX)',
  submissions: 'SMTPS (port 465)',
  submission: 'Submission (port 587 STARTTLS)',
  imap: 'IMAP (port 143 STARTTLS)',
  imaps: 'IMAPS (port 993)',
  managesieve: 'ManageSieve (port 4190 STARTTLS)',
  'webmail-https': 'Webmail (HTTPS port 443)',
};

export default function MailSslStatusModal({ onClose }: { readonly onClose: () => void }) {
  const [probeEnabled, setProbeEnabled] = useState(false);

  const { data, isFetching, refetch, error } = useQuery<{ data: SslStatusResponse }>({
    queryKey: ['email-ssl-status'],
    queryFn: () => apiFetch<{ data: SslStatusResponse }>('/api/v1/admin/email-settings/ssl-status'),
    enabled: probeEnabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const refresh = async (): Promise<void> => {
    if (!probeEnabled) {
      setProbeEnabled(true);
      return;
    }
    await apiFetch('/api/v1/admin/email-settings/ssl-status?refresh=1');
    await refetch();
  };

  const statuses = data?.data?.listeners ?? [];
  const probedHost = data?.data?.host;

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="mail-ssl-status-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-4xl rounded-xl bg-white dark:bg-gray-800 shadow-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <ShieldCheck size={16} /> Mail server SSL status
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              disabled={isFetching}
              data-testid="mail-ssl-status-refresh"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {isFetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {probeEnabled ? 'Refresh' : 'Check now'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              data-testid="mail-ssl-status-close"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            TLS handshake against{' '}
            {probedHost ? <code>{probedHost}</code> : 'the configured mail-server hostname'}{' '}
            on every mail port (25 / 465 / 587 / 143 / 993 / 4190) plus the webmail HTTPS
            endpoint
            {data?.data?.webmailHost ? <> at <code>{data.data.webmailHost}:443</code></> : ''}.
            Reports cert subject + issuer + SAN + expiry, or an error on failure.
            Each probe opens a real TCP+TLS connection; results cached for 30s.
          </p>

          {!probeEnabled && !isFetching && (
            <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 px-3 py-6 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Click <strong>Check now</strong> above to run the probe.
              </p>
            </div>
          )}

          {error instanceof Error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error.message}</span>
            </div>
          )}

          {statuses.length > 0 && (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm border-collapse"
                data-testid="mail-ssl-status-table"
              >
                <thead className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">Listener</th>
                    <th className="px-2 py-1.5 text-left font-medium">TLS</th>
                    <th className="px-2 py-1.5 text-left font-medium">Issuer</th>
                    <th className="px-2 py-1.5 text-left font-medium">Expires</th>
                    <th className="px-2 py-1.5 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {statuses.map((s) => (
                    <ListenerRow key={s.port} status={s} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ListenerRow({ status }: { readonly status: ListenerStatus }) {
  const expiryColor =
    status.cert && status.cert.daysUntilExpiry < 7
      ? 'text-red-600 dark:text-red-400'
      : status.cert && status.cert.daysUntilExpiry < 30
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-gray-700 dark:text-gray-300';

  return (
    <tr data-testid={`mail-ssl-row-${status.listener}`}>
      <td className="px-2 py-2 align-top">
        <div className="font-medium text-gray-900 dark:text-gray-100">
          {LISTENER_LABELS[status.listener]}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          port {status.port} ({status.tlsMode})
        </div>
      </td>
      <td className="px-2 py-2 align-top text-gray-700 dark:text-gray-300 whitespace-nowrap">
        {status.tlsProtocol ?? '—'}
      </td>
      <td className="px-2 py-2 align-top text-gray-700 dark:text-gray-300 text-xs">
        {status.cert?.issuer ?? '—'}
      </td>
      <td className={`px-2 py-2 align-top text-xs whitespace-nowrap ${expiryColor}`}>
        {status.cert
          ? `${new Date(status.cert.notAfter).toISOString().slice(0, 10)} (${status.cert.daysUntilExpiry}d)`
          : '—'}
      </td>
      <td className="px-2 py-2 align-top">
        {status.connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            OK
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300"
            title={status.error ?? 'unknown error'}
          >
            FAIL
          </span>
        )}
      </td>
    </tr>
  );
}
