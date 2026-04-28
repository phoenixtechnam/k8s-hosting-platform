import { useState, useEffect, type FormEvent } from 'react';
import { Shield, Loader2, Trash2, AlertCircle, CheckCircle } from 'lucide-react';
import {
  useIngressMtls,
  useUpsertIngressMtls,
  useDeleteIngressMtls,
} from '@/hooks/use-ingress-mtls';
import type { IngressMtlsConfigInput } from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300';

interface Props {
  readonly clientId: string;
  readonly routeId: string;
}

/**
 * mTLS subsection of the Access Control tab. Layers with OIDC — when
 * both are configured NGINX runs auth_request AND requires a valid
 * client cert. The CA bundle is uploaded as PEM (root + intermediates
 * concatenated); the platform never returns it on read, only a
 * fingerprint + Subject + expiry.
 */
export default function MtlsSection({ clientId, routeId }: Props) {
  const { data: existing, isLoading } = useIngressMtls(clientId, routeId);
  const upsert = useUpsertIngressMtls(clientId, routeId);
  const remove = useDeleteIngressMtls(clientId, routeId);

  const [enabled, setEnabled] = useState(false);
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
    // Never prefill the cert field — uploads are write-only.
    setCaCertPem('');
  }, [existing]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input: IngressMtlsConfigInput = {
      enabled,
      ...(caCertPem ? { caCertPem } : {}),
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
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <Loader2 size={14} className="animate-spin" />
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="mtls-section">
      <div className="mb-4 flex items-center gap-2">
        <Shield size={18} className="text-gray-600 dark:text-gray-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Client Certificate (mTLS)</h2>
      </div>

      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Require incoming HTTPS clients to present a valid certificate signed by your trusted CA.
        Layers with OIDC — when both are enabled, NGINX runs auth_request AND verifies the cert.
        Upload any PEM-encoded CA bundle (Ziti intermediate, internal corporate CA, HSM chain).
      </p>

      <form onSubmit={onSubmit} className="space-y-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            data-testid="mtls-enabled"
          />
          <span className="text-sm text-gray-900 dark:text-gray-100">Enable mTLS on this ingress</span>
        </label>

        {existing?.caCertSet && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 text-xs">
            <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
              <CheckCircle size={14} className="text-green-600" />
              <span className="font-medium">CA on file</span>
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
            CA Bundle (PEM){existing?.caCertSet && <span className="ml-2 text-xs text-gray-400">leave empty to keep current</span>}
          </label>
          <textarea
            id="mtls-ca-pem"
            className={`${INPUT_CLASS} mt-1 font-mono text-xs`}
            rows={6}
            value={caCertPem}
            onChange={(e) => setCaCertPem(e.target.value)}
            placeholder={'-----BEGIN CERTIFICATE-----\nMIIDxzCCAq+gAwIBAgIUW…\n-----END CERTIFICATE-----'}
            data-testid="mtls-ca-pem"
          />
        </div>

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

        <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
          <legend className="px-1 text-xs font-medium text-gray-700 dark:text-gray-300">Forward to Upstream</legend>
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={passDnToUpstream}
                onChange={(e) => setPassDnToUpstream(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm text-gray-900 dark:text-gray-100">
                Subject DN as <code>X-SSL-Client-DN</code>
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={passCertToUpstream}
                onChange={(e) => setPassCertToUpstream(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm text-gray-900 dark:text-gray-100">
                Full cert PEM as <code>ssl-client-cert</code> (URL-encoded)
              </span>
            </label>
          </div>
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
    </section>
  );
}
