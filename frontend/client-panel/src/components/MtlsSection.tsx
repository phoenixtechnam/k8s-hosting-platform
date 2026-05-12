import { useState, useEffect, type FormEvent } from 'react';
import { Shield, Loader2, Trash2, AlertCircle, CheckCircle, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import {
  useIngressMtls,
  useUpsertIngressMtls,
  useDeleteIngressMtls,
} from '@/hooks/use-ingress-mtls';
import { useMtlsProviders } from '@/hooks/use-mtls-providers';
import type { IngressMtlsConfigInput } from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300';

interface Props {
  readonly clientId: string;
  readonly routeId: string;
}

function Toggle({
  checked,
  onChange,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
      )}
      data-testid={testId}
    >
      <span
        className={clsx(
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

export default function MtlsSection({ clientId, routeId }: Props) {
  const { data: existing, isLoading } = useIngressMtls(clientId, routeId);
  const { data: providers } = useMtlsProviders(clientId);
  const upsert = useUpsertIngressMtls(clientId, routeId);
  const remove = useDeleteIngressMtls(clientId, routeId);

  const [isOpen, setIsOpen] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [providerMode, setProviderMode] = useState<'provider' | 'inline'>('provider');
  const [providerId, setProviderId] = useState<string>('');
  const [caCertPem, setCaCertPem] = useState('');
  const [verifyMode, setVerifyMode] = useState<'on' | 'optional' | 'optional_no_ca'>('on');
  const [subjectRegex, setSubjectRegex] = useState('');
  const [passCertToUpstream, setPassCertToUpstream] = useState(false);
  const [passDnToUpstream, setPassDnToUpstream] = useState(true);

  useEffect(() => {
    if (!existing) return;
    setEnabled(existing.enabled);
    setVerifyMode(existing.verifyMode);
    setSubjectRegex(existing.subjectRegex ?? '');
    setPassCertToUpstream(existing.passCertToUpstream);
    setPassDnToUpstream(existing.passDnToUpstream);
    if (existing.providerId) {
      setProviderMode('provider');
      setProviderId(existing.providerId);
    } else if (existing.caCertSet) {
      setProviderMode('inline');
    }
    setCaCertPem('');
  }, [existing]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input: IngressMtlsConfigInput = {
      enabled,
      ...(providerMode === 'provider'
        ? { providerId: providerId || null, caCertPem: undefined }
        : { providerId: null, ...(caCertPem ? { caCertPem } : {}) }),
      verifyMode,
      subjectRegex: subjectRegex || null,
      passCertToUpstream,
      passDnToUpstream,
    };
    await upsert.mutateAsync(input);
  }

  async function onDelete() {
    if (!confirm('Disable mTLS and clear the CA bundle from the server?')) return;
    await remove.mutateAsync();
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <Loader2 size={14} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden" data-testid="mtls-section">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Shield size={18} className="text-gray-600 dark:text-gray-400" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Client Certificate (mTLS)</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className={clsx(
            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
            enabled
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
          )}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
          {isOpen ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
        </div>
      </button>

      {isOpen && (
        <form onSubmit={onSubmit} className="border-t border-gray-200 dark:border-gray-700 p-5 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Require incoming HTTPS clients to present a valid certificate signed by your trusted CA.
            Layers with OIDC — when both are enabled, NGINX runs auth_request AND verifies the cert.
            Upload any PEM-encoded CA bundle (Ziti intermediate, internal corporate CA, HSM chain).
          </p>

          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable mTLS on this ingress</span>
            <Toggle checked={enabled} onChange={setEnabled} testId="mtls-enabled" />
          </label>

          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
            <legend className="px-1 text-xs font-medium text-gray-700 dark:text-gray-300">CA Source</legend>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Pick a reusable provider, or paste a CA bundle inline (legacy).
              </p>
              <Link
                to="/settings/mtls-providers"
                className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                data-testid="mtls-manage-providers-link"
              >
                Manage providers <ExternalLink size={12} />
              </Link>
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="inline-flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  checked={providerMode === 'provider'}
                  onChange={() => setProviderMode('provider')}
                  disabled={!providers || providers.length === 0}
                  data-testid="mtls-mode-provider"
                />
                Use provider {providers && providers.length > 0 && (<span className="text-xs text-gray-500 dark:text-gray-400">({providers.length} available)</span>)}
              </label>
              <label className="inline-flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  checked={providerMode === 'inline'}
                  onChange={() => setProviderMode('inline')}
                  data-testid="mtls-mode-inline"
                />
                Paste inline (legacy)
              </label>
            </div>

            {providerMode === 'provider' ? (
              <div>
                <label className={LABEL_CLASS} htmlFor="mtls-provider-select">Provider</label>
                <select
                  id="mtls-provider-select"
                  className={INPUT_CLASS}
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  required={enabled && providerMode === 'provider'}
                  data-testid="mtls-provider-select"
                >
                  <option value="">— pick a provider —</option>
                  {(providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.caCertSubject}{p.canIssue ? ' · can issue' : ''}
                    </option>
                  ))}
                </select>
                {(!providers || providers.length === 0) && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    No providers yet. <Link to="/settings/mtls-providers" className="text-blue-600 hover:underline dark:text-blue-400">Create one →</Link>
                  </p>
                )}
              </div>
            ) : (
              <>
                {existing?.caCertSet && !existing.providerId && (
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 text-xs">
                    <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                      <CheckCircle size={14} className="text-green-600" />
                      <span className="font-medium">Inline CA on file</span>
                    </div>
                    <div className="mt-1 text-gray-500 dark:text-gray-400">
                      <div>Subject: {existing.caCertSubject ?? '—'}</div>
                      <div>SHA-256: {existing.caCertFingerprint?.slice(0, 32) ?? '—'}…</div>
                      <div>Expires: {existing.caCertExpiresAt ? new Date(existing.caCertExpiresAt).toLocaleDateString() : '—'}</div>
                    </div>
                  </div>
                )}
                <div>
                  <label className={LABEL_CLASS} htmlFor="mtls-ca-pem">
                    CA Bundle (PEM){existing?.caCertSet && !existing.providerId && <span className="ml-2 text-xs text-gray-400">leave empty to keep current</span>}
                  </label>
                  <textarea
                    id="mtls-ca-pem"
                    className={`${INPUT_CLASS} font-mono text-xs`}
                    rows={6}
                    value={caCertPem}
                    onChange={(e) => setCaCertPem(e.target.value)}
                    placeholder={'-----BEGIN CERTIFICATE-----\nMIIDxzCCAq+gAwIBAgIUW…\n-----END CERTIFICATE-----'}
                    data-testid="mtls-ca-pem"
                  />
                </div>
              </>
            )}
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor="mtls-verify-mode">Verify Mode</label>
              <select
                id="mtls-verify-mode"
                className={`${INPUT_CLASS} mt-1`}
                value={verifyMode}
                onChange={(e) => setVerifyMode(e.target.value as 'on' | 'optional' | 'optional_no_ca')}
                data-testid="mtls-verify-mode"
              >
                <option value="on">on (require cert)</option>
                <option value="optional">optional (verify when supplied)</option>
                <option value="optional_no_ca">optional_no_ca (don't advertise CA list)</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Use <code>optional</code> with OIDC for cert-or-OIDC fallback.
              </p>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="mtls-subject-regex">Subject Regex (optional)</label>
              <input
                id="mtls-subject-regex"
                className={`${INPUT_CLASS} mt-1`}
                value={subjectRegex}
                onChange={(e) => setSubjectRegex(e.target.value)}
                placeholder="^CN=.+,OU=internal-apps$"
                data-testid="mtls-subject-regex"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Restrict to certs matching this Subject DN pattern.
              </p>
            </div>
          </div>

          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
            <legend className="px-1 text-xs font-medium text-gray-700 dark:text-gray-300">Forward to Upstream</legend>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-900 dark:text-gray-100">
                Subject DN as <code>X-SSL-Client-DN</code>
              </span>
              <Toggle checked={passDnToUpstream} onChange={setPassDnToUpstream} />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-900 dark:text-gray-100">
                Full cert PEM as <code>ssl-client-cert</code> (URL-encoded)
              </span>
              <Toggle checked={passCertToUpstream} onChange={setPassCertToUpstream} />
            </label>
          </fieldset>

          {upsert.error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{upsert.error instanceof Error ? upsert.error.message : String(upsert.error)}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onDelete}
              disabled={remove.isPending || !existing}
              className="inline-flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-700 px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
              data-testid="mtls-delete"
            >
              {remove.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Disable & clear
            </button>
            <button
              type="submit"
              disabled={upsert.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="mtls-save"
            >
              {upsert.isPending && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
