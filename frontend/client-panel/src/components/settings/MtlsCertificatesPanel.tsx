import { useMemo, useState, type FormEvent } from 'react';
import {
  Loader2,
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  Ban,
  Download,
  Copy,
  CheckCircle,
  Link as LinkIcon,
  Trash2,
  RotateCcw,
  HelpCircle,
} from 'lucide-react';
import { API_BASE } from '@/lib/api-client';
import {
  useMtlsCertificates,
  useMtlsCrlMetadata,
  useRevokeMtlsCertificate,
  useUnrevokeMtlsCertificate,
  useDeleteMtlsCertificate,
} from '@/hooks/use-mtls-providers';
import HowToUseCertificatesModal from './HowToUseCertificatesModal';
import type {
  CertificateResponse,
  CertificateStatus,
  CertificateRevocationReason,
  MtlsProviderResponse,
} from '@k8s-hosting/api-contracts';

// RFC 5280 reason codes — keep aligned with backend
// revokeCertificateInputSchema. Order matters for UX (most common first).
const REVOCATION_REASONS: ReadonlyArray<{
  value: CertificateRevocationReason;
  label: string;
  description: string;
}> = [
  { value: 'unspecified', label: 'Unspecified', description: 'No specific reason given' },
  { value: 'keyCompromise', label: 'Key Compromise', description: 'Private key may have been disclosed or stolen' },
  { value: 'superseded', label: 'Superseded', description: 'Replaced by a newly issued cert' },
  { value: 'cessationOfOperation', label: 'Cessation of Operation', description: 'Subject no longer needs the cert (employee left, service decommissioned)' },
  { value: 'affiliationChanged', label: 'Affiliation Changed', description: 'Subject moved to a different organisation' },
  { value: 'privilegeWithdrawn', label: 'Privilege Withdrawn', description: 'Subject no longer authorised' },
  { value: 'caCompromise', label: 'CA Compromise', description: 'The signing CA itself is compromised — rotate it' },
  { value: 'aaCompromise', label: 'AA Compromise', description: 'Attribute authority compromise (rare)' },
];

const STATUS_FILTERS: ReadonlyArray<{ value: CertificateStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'expired', label: 'Expired' },
];

interface MtlsCertificatesPanelProps {
  readonly clientId: string;
  readonly provider: MtlsProviderResponse;
}

export default function MtlsCertificatesPanel({ clientId, provider }: MtlsCertificatesPanelProps) {
  const [statusFilter, setStatusFilter] = useState<CertificateStatus | 'all'>('all');
  const [revokeTarget, setRevokeTarget] = useState<CertificateResponse | null>(null);
  const [unrevokeTarget, setUnrevokeTarget] = useState<CertificateResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CertificateResponse | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [copiedCrl, setCopiedCrl] = useState(false);

  const certsQuery = useMtlsCertificates(clientId, provider.id, statusFilter);
  const crlQuery = useMtlsCrlMetadata(clientId, provider.id);

  const items = certsQuery.data?.items ?? [];
  const total = useMemo(() => items.length, [items]);

  function copyCrlUrl() {
    if (!crlQuery.data?.crlUrl) return;
    const url = crlQuery.data.crlUrl;
    const ok = () => {
      setCopiedCrl(true);
      setTimeout(() => setCopiedCrl(false), 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(ok, () => {
        window.alert(`Copy failed — manually copy: ${url}`);
      });
    } else {
      window.alert(`Manual copy required: ${url}`);
    }
  }

  async function downloadCertPem(cert: CertificateResponse) {
    // Token-authed download — apiFetch handles the auth header. We
    // request as text and trigger a browser download.
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/clients/${clientId}/mtls-providers/${provider.id}/certificates/${cert.id}/pem`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('auth_token') ?? ''}`,
          },
        },
      );
      if (!res.ok) {
        throw new Error(`download failed: ${res.status}`);
      }
      const pem = await res.text();
      const blob = new Blob([pem], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeCn = cert.subjectCn.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'client';
      a.download = `${safeCn}-${cert.serialHex.slice(0, 8)}.pem`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      // Surface the error visibly — silent failure is the worst UX
      // for a download button.
      window.alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function downloadCrl() {
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/clients/${clientId}/mtls-providers/${provider.id}/crl.pem`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('auth_token') ?? ''}`,
          },
        },
      );
      if (!res.ok) {
        throw new Error(`download failed: ${res.status}`);
      }
      const pem = await res.text();
      const blob = new Blob([pem], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${provider.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.crl.pem`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      window.alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <section
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
      data-testid={`mtls-certs-panel-${provider.id}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <ShieldCheck size={18} /> Issued certificates — {provider.name}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 max-w-2xl">
            Every cert minted from this provider's CA. Revoke a cert and the platform
            pushes the CRL into each ingress route — NGINX rejects the cert within ~10s.
            Revoked certs can also be reactivated, or deleted entirely.
          </p>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            data-testid="mtls-help-link"
          >
            <HelpCircle size={12} /> How to use certificates on Windows / macOS / Linux / mobile
          </button>
        </div>
        {provider.canIssue && (
          <CrlMetadataCard
            crlUrl={crlQuery.data?.crlUrl ?? null}
            crlNumber={crlQuery.data?.crlNumber ?? null}
            lastGeneratedAt={crlQuery.data?.lastGeneratedAt ?? null}
            revokedCount={crlQuery.data?.revokedCount ?? 0}
            copied={copiedCrl}
            onCopy={copyCrlUrl}
            onDownload={downloadCrl}
          />
        )}
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter by status">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={statusFilter === f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium border ${
              statusFilter === f.value
                ? 'border-blue-500 bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200'
                : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
            data-testid={`mtls-certs-filter-${f.value}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {certsQuery.isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading certificates…
        </div>
      ) : certsQuery.isError ? (
        <div
          className="mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          data-testid="mtls-certs-error"
        >
          Failed to load certificates: {certsQuery.error instanceof Error ? certsQuery.error.message : String(certsQuery.error)}
        </div>
      ) : total === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {statusFilter === 'all'
            ? 'No certificates have been issued from this provider yet.'
            : `No ${statusFilter} certificates.`}
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="px-2 py-2 font-medium">Subject CN</th>
                <th className="px-2 py-2 font-medium">Serial</th>
                <th className="px-2 py-2 font-medium">Issued</th>
                <th className="px-2 py-2 font-medium">Expires</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((cert) => (
                <tr
                  key={cert.id}
                  className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/40"
                  data-testid={`mtls-cert-row-${cert.id}`}
                >
                  <td className="px-2 py-2">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{cert.subjectCn}</div>
                    <div className="font-mono text-[10px] text-gray-500 dark:text-gray-400">
                      {cert.subjectFull}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <code className="font-mono text-[11px] text-gray-700 dark:text-gray-300" title={cert.serialHex}>
                      {cert.serialHex.slice(0, 16)}…
                    </code>
                  </td>
                  <td className="px-2 py-2 text-gray-700 dark:text-gray-300 text-xs">
                    {new Date(cert.issuedAt).toLocaleDateString()}
                  </td>
                  <td className="px-2 py-2 text-gray-700 dark:text-gray-300 text-xs">
                    {new Date(cert.expiresAt).toLocaleDateString()}
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge status={cert.status} revocationReason={cert.revocationReason} />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => downloadCertPem(cert)}
                        title="Download cert PEM"
                        className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                        data-testid={`mtls-cert-download-${cert.id}`}
                      >
                        <Download size={14} />
                      </button>
                      {cert.status === 'active' && (
                        <button
                          type="button"
                          onClick={() => setRevokeTarget(cert)}
                          title="Revoke this certificate"
                          className="inline-flex items-center gap-1 rounded border border-red-300 dark:border-red-700 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
                          data-testid={`mtls-cert-revoke-${cert.id}`}
                        >
                          <Ban size={12} /> Revoke
                        </button>
                      )}
                      {cert.status === 'revoked' && (
                        <button
                          type="button"
                          onClick={() => setUnrevokeTarget(cert)}
                          title="Reactivate this certificate"
                          className="inline-flex items-center gap-1 rounded border border-amber-300 dark:border-amber-700 px-2 py-1 text-xs text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30"
                          data-testid={`mtls-cert-reactivate-${cert.id}`}
                        >
                          <RotateCcw size={12} /> Reactivate
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(cert)}
                        title="Delete this certificate"
                        className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/30 dark:hover:text-red-300"
                        data-testid={`mtls-cert-delete-${cert.id}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revokeTarget && (
        <RevokeModal
          cert={revokeTarget}
          clientId={clientId}
          providerId={provider.id}
          onClose={() => setRevokeTarget(null)}
        />
      )}
      {unrevokeTarget && (
        <UnrevokeModal
          cert={unrevokeTarget}
          clientId={clientId}
          providerId={provider.id}
          onClose={() => setUnrevokeTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteCertModal
          cert={deleteTarget}
          clientId={clientId}
          providerId={provider.id}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      {helpOpen && <HowToUseCertificatesModal onClose={() => setHelpOpen(false)} />}
    </section>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────

function StatusBadge({
  status,
  revocationReason,
}: {
  status: CertificateStatus;
  revocationReason: CertificateRevocationReason | null;
}) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 px-2 py-0.5 text-xs font-medium">
        <ShieldCheck size={11} /> Active
      </span>
    );
  }
  if (status === 'revoked') {
    const reasonLabel = revocationReason
      ? REVOCATION_REASONS.find((r) => r.value === revocationReason)?.label ?? revocationReason
      : 'Revoked';
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 px-2 py-0.5 text-xs font-medium"
        title={reasonLabel}
      >
        <ShieldOff size={11} /> Revoked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-0.5 text-xs font-medium">
      <ShieldAlert size={11} /> Expired
    </span>
  );
}

// ─── CRL metadata card ────────────────────────────────────────────────

function CrlMetadataCard({
  crlUrl,
  crlNumber,
  lastGeneratedAt,
  revokedCount,
  copied,
  onCopy,
  onDownload,
}: {
  crlUrl: string | null;
  crlNumber: number | null;
  lastGeneratedAt: string | null;
  revokedCount: number;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 p-3 text-xs text-gray-700 dark:text-gray-300 max-w-xs">
      <div className="font-medium text-gray-900 dark:text-gray-100 mb-1 flex items-center gap-1">
        <LinkIcon size={12} /> CRL distribution
      </div>
      <div className="font-mono text-[10px] truncate" title={crlUrl ?? ''}>
        {crlUrl ?? '—'}
      </div>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-gray-500 dark:text-gray-400">
        <span>v{crlNumber ?? 0}</span>
        <span>{revokedCount} revoked</span>
        {lastGeneratedAt && (
          <span title={lastGeneratedAt}>
            built {new Date(lastGeneratedAt).toLocaleString()}
          </span>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded border border-gray-300 dark:border-gray-600 px-2 py-0.5 text-[10px] text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          data-testid="mtls-crl-copy"
        >
          {copied ? <CheckCircle size={10} /> : <Copy size={10} />} {copied ? 'Copied' : 'Copy URL'}
        </button>
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex items-center gap-1 rounded border border-gray-300 dark:border-gray-600 px-2 py-0.5 text-[10px] text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          data-testid="mtls-crl-download"
        >
          <Download size={10} /> Download
        </button>
      </div>
    </div>
  );
}

// ─── Revoke modal ─────────────────────────────────────────────────────

function RevokeModal({
  cert,
  clientId,
  providerId,
  onClose,
}: {
  cert: CertificateResponse;
  clientId: string;
  providerId: string;
  onClose: () => void;
}) {
  const revokeMut = useRevokeMtlsCertificate(clientId, providerId);
  const [reason, setReason] = useState<CertificateRevocationReason>('unspecified');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await revokeMut.mutateAsync({ certId: cert.id, input: { reason } });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="mtls-revoke-modal">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Ban size={18} className="text-red-600 dark:text-red-400" /> Revoke certificate?
        </h2>
        <div className="mt-3 space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <p>
            Revoking immediately invalidates the cert across every ingress route that uses this
            provider. Within ~10s, NGINX will start rejecting requests presenting this cert.
          </p>
          <p className="text-xs">
            <span className="text-gray-500 dark:text-gray-400">Subject:</span>{' '}
            <code className="font-mono">{cert.subjectFull}</code>
          </p>
          <p className="text-xs">
            <span className="text-gray-500 dark:text-gray-400">Serial:</span>{' '}
            <code className="font-mono">{cert.serialHex}</code>
          </p>
        </div>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1" htmlFor="revoke-reason">
              Reason (RFC 5280)
            </label>
            <select
              id="revoke-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as CertificateRevocationReason)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100"
              data-testid="mtls-revoke-reason"
            >
              {REVOCATION_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {REVOCATION_REASONS.find((r) => r.value === reason)?.description}
            </p>
          </div>

          {revokeMut.error != null && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {revokeMut.error instanceof Error ? revokeMut.error.message : String(revokeMut.error)}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={revokeMut.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="mtls-revoke-submit"
            >
              {revokeMut.isPending && <Loader2 size={14} className="animate-spin" />}
              Revoke
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


// ─── Unrevoke (reactivate) modal ─────────────────────────────────────

function UnrevokeModal({
  cert,
  clientId,
  providerId,
  onClose,
}: {
  cert: CertificateResponse;
  clientId: string;
  providerId: string;
  onClose: () => void;
}) {
  const unrevokeMut = useUnrevokeMtlsCertificate(clientId, providerId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await unrevokeMut.mutateAsync(cert.id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="mtls-unrevoke-modal">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <RotateCcw size={18} className="text-amber-600 dark:text-amber-400" /> Reactivate certificate?
        </h2>
        <div className="mt-3 space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <strong>Security warning:</strong> reactivating a previously-revoked certificate
            allows it to be used again. If the cert was revoked due to <em>key compromise</em>
            (stolen / leaked private key), DO NOT reactivate — issue a fresh cert instead.
            Within ~10s of confirming, NGINX will accept this cert at every ingress route
            bound to the provider.
          </div>
          <p className="text-xs">
            <span className="text-gray-500 dark:text-gray-400">Subject:</span>{' '}
            <code className="font-mono">{cert.subjectFull}</code>
          </p>
          <p className="text-xs">
            <span className="text-gray-500 dark:text-gray-400">Serial:</span>{' '}
            <code className="font-mono">{cert.serialHex}</code>
          </p>
          {cert.revocationReason && (
            <p className="text-xs">
              <span className="text-gray-500 dark:text-gray-400">Revoked as:</span>{' '}
              <code className="font-mono">{cert.revocationReason}</code>
              {cert.revokedAt && <> on {new Date(cert.revokedAt).toLocaleString()}</>}
            </p>
          )}
        </div>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          {unrevokeMut.error != null && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {unrevokeMut.error instanceof Error ? unrevokeMut.error.message : String(unrevokeMut.error)}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={unrevokeMut.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              data-testid="mtls-unrevoke-submit"
            >
              {unrevokeMut.isPending && <Loader2 size={14} className="animate-spin" />}
              Reactivate
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Delete cert modal ───────────────────────────────────────────────

function DeleteCertModal({
  cert,
  clientId,
  providerId,
  onClose,
}: {
  cert: CertificateResponse;
  clientId: string;
  providerId: string;
  onClose: () => void;
}) {
  const deleteMut = useDeleteMtlsCertificate(clientId, providerId);
  // A revoked cert's serial is on the CRL. Deletion removes it from the
  // CRL on next regeneration, so a still-extant cert+key pair in the wild
  // could regain access. The active-cert case is plain "stop tracking it"
  // and has no in-flight security implication.
  const isRevoked = cert.status === 'revoked';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await deleteMut.mutateAsync(cert.id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="mtls-delete-modal">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Trash2 size={18} className="text-red-600 dark:text-red-400" /> Delete certificate?
        </h2>
        <div className="mt-3 space-y-2 text-sm text-gray-700 dark:text-gray-300">
          {isRevoked ? (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-900 dark:text-red-200">
              <strong>Security warning:</strong> this cert is currently revoked. Deleting it
              removes its serial from the CRL on the next regeneration. If the cert + private
              key still exist anywhere (operator's laptop, browser store, etc), NGINX would
              accept it again. Only delete revoked certs once you're sure the key is destroyed
              everywhere it was used.
            </div>
          ) : (
            <p>
              This permanently removes the certificate record from the platform. The cert + key
              you handed to the end user will keep working (it's cryptographic — only revocation
              tells NGINX to refuse it). To invalidate a cert in use, <em>revoke</em> instead.
            </p>
          )}
          <p className="text-xs">
            <span className="text-gray-500 dark:text-gray-400">Subject:</span>{' '}
            <code className="font-mono">{cert.subjectFull}</code>
          </p>
          <p className="text-xs">
            <span className="text-gray-500 dark:text-gray-400">Serial:</span>{' '}
            <code className="font-mono">{cert.serialHex}</code>
          </p>
        </div>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          {deleteMut.error != null && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {deleteMut.error instanceof Error ? deleteMut.error.message : String(deleteMut.error)}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={deleteMut.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="mtls-delete-submit"
            >
              {deleteMut.isPending && <Loader2 size={14} className="animate-spin" />}
              Delete
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
