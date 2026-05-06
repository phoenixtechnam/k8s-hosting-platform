/**
 * Per-listener SSL/TLS handshake status for the platform mail server.
 *
 * Lazy-loaded: the probe runs 6 TCP+TLS handshakes, ~150ms each in
 * parallel. We don't auto-fire on page mount — operator clicks
 * "Check now" once they're looking at the card. Subsequent renders
 * within 30s read the backend's in-memory cache.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react';
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
  listener: 'smtp' | 'submissions' | 'submission' | 'imap' | 'imaps' | 'managesieve';
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
};

export default function MailSslStatusCard() {
  const [enabled, setEnabled] = useState(false);

  const { data, isFetching, refetch, error } = useQuery<{ data: SslStatusResponse }>({
    queryKey: ['email-ssl-status'],
    queryFn: () => apiFetch<{ data: SslStatusResponse }>('/api/v1/admin/email-settings/ssl-status'),
    enabled,
    // Backend caches 30s in-process. Front-end re-fetches on
    // explicit refetch() (the "Check now" button bypasses with
    // ?refresh=1 — see refresh()).
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const refresh = async (): Promise<void> => {
    if (!enabled) {
      setEnabled(true);
      return;
    }
    await apiFetch('/api/v1/admin/email-settings/ssl-status?refresh=1');
    await refetch();
  };

  const statuses = data?.data?.listeners ?? [];
  const probedHost = data?.data?.host;

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4"
      data-testid="mail-ssl-status-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck size={20} className="text-gray-700 dark:text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Mail server SSL status
          </h2>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="mail-ssl-status-refresh"
        >
          {isFetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {enabled ? 'Refresh' : 'Check now'}
        </button>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Per-listener TLS handshake against {probedHost ? <code>{probedHost}</code> : 'the configured mail-server hostname'}.
        Reports cert subject + issuer + SAN + expiry on connect, or an error message on
        failure. Lazy-loaded — click <strong>{enabled ? 'Refresh' : 'Check now'}</strong> to probe.
      </p>

      {!enabled && !isFetching && (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic">
          Click "Check now" to run the probe. Each probe opens a real TCP+TLS
          connection; cached for 30s.
        </p>
      )}

      {error instanceof Error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
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
                <th className="px-2 py-1.5 text-left font-medium">Cipher</th>
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
  );
}

function ListenerRow({ status }: { status: ListenerStatus }) {
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
        {status.cipher ?? '—'}
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
