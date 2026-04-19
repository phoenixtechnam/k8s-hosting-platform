import { useState, useEffect } from 'react';
import { Shield, Loader2, AlertCircle, Save, CheckCircle, Network } from 'lucide-react';
import { useTlsSettings, useUpdateTlsSettings } from '@/hooks/use-tls-settings';
import { useIngressSettings, useUpdateIngressSettings } from '@/hooks/use-ingress-settings';

const inputClass = 'w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 px-3 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function TlsSettings() {
  const { data: response, isLoading, isError, error } = useTlsSettings();
  const updateSettings = useUpdateTlsSettings();

  const settings = response?.data;

  const [issuerName, setIssuerName] = useState('');
  const [autoTls, setAutoTls] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setIssuerName(settings.clusterIssuerName);
      setAutoTls(settings.autoTlsEnabled);
    }
  }, [settings]);

  const handleSave = () => {
    setSaved(false);
    updateSettings.mutate(
      { clusterIssuerName: issuerName, autoTlsEnabled: autoTls },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-emerald-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="tls-settings-heading">Ingress & TLS Settings</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Configure ingress routing, cert-manager, and automatic TLS for client domains.</p>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-8">
          <Loader2 size={20} className="animate-spin text-brand-500" />
          <span className="text-sm text-gray-500">Loading TLS settings...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle size={16} />
          <span>Failed to load TLS settings: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {settings && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm space-y-6" data-testid="tls-settings-card">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              ClusterIssuer Name
            </label>
            <input
              type="text"
              value={issuerName}
              onChange={(e) => setIssuerName(e.target.value)}
              className={inputClass}
              placeholder="letsencrypt-production"
              data-testid="issuer-name-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The cert-manager ClusterIssuer used for automatic TLS certificates. Common values: <code className="text-gray-700 dark:text-gray-300">letsencrypt-production</code>, <code className="text-gray-700 dark:text-gray-300">letsencrypt-staging</code>, <code className="text-gray-700 dark:text-gray-300">local-ca-issuer</code>
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Automatic TLS
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                When enabled, cert-manager will automatically provision TLS certificates for all client domains via the configured ClusterIssuer.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAutoTls(!autoTls)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
                autoTls ? 'bg-brand-500' : 'bg-gray-200 dark:bg-gray-600'
              }`}
              data-testid="auto-tls-toggle"
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  autoTls ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="rounded-lg bg-gray-50 dark:bg-gray-900 p-4 text-sm text-gray-600 dark:text-gray-400 space-y-2">
            <p><strong>How it works:</strong></p>
            <ul className="list-disc list-inside space-y-1">
              <li>When auto-TLS is enabled, client Ingress resources include a <code className="text-gray-700 dark:text-gray-300">cert-manager.io/cluster-issuer</code> annotation and <code className="text-gray-700 dark:text-gray-300">spec.tls</code> block.</li>
              <li>cert-manager automatically provisions certificates from the ClusterIssuer (e.g., Let's Encrypt).</li>
              <li>Domains with full DNS control use DNS-01 challenges; others fall back to HTTP-01.</li>
              <li>Custom uploaded certificates override auto-provisioned ones.</li>
            </ul>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
            {saved && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle size={14} /> Saved
              </span>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={updateSettings.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="save-tls-settings"
            >
              {updateSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save Settings
            </button>
          </div>
        </div>
      )}

      <IngressSettingsCard />
    </div>
  );
}

// ─── Ingress Settings Card ──────────────────────────────────────────────────

function IngressSettingsCard() {
  const { data: response, isLoading } = useIngressSettings();
  const updateSettings = useUpdateIngressSettings();

  const settings = response?.data;

  const [baseDomain, setBaseDomain] = useState('');
  const [ipv4, setIpv4] = useState('');
  const [ipv6, setIpv6] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setBaseDomain(settings.ingressBaseDomain);
      setIpv4(settings.ingressDefaultIpv4);
      setIpv6(settings.ingressDefaultIpv6 ?? '');
    }
  }, [settings]);

  const handleSave = () => {
    setSaved(false);
    updateSettings.mutate(
      {
        ingressBaseDomain: baseDomain,
        ingressDefaultIpv4: ipv4,
        ingressDefaultIpv6: ipv6 || null,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 size={16} className="animate-spin text-brand-500" />
        <span className="text-sm text-gray-500">Loading ingress settings...</span>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm space-y-6" data-testid="ingress-settings-card">
      <div className="flex items-center gap-2">
        <Network size={20} className="text-brand-500" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Ingress Routing</h2>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Ingress Base Domain
        </label>
        <input
          type="text"
          value={baseDomain}
          onChange={(e) => setBaseDomain(e.target.value)}
          className={inputClass}
          placeholder="ingress.platform.example.net"
          data-testid="ingress-base-domain-input"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Base domain for CNAME targets. Each hostname route generates a unique <code className="text-gray-700 dark:text-gray-300">{'{slug}'}.{baseDomain || 'ingress.platform.net'}</code> entry.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Default IPv4
          </label>
          <input
            type="text"
            value={ipv4}
            onChange={(e) => setIpv4(e.target.value)}
            className={inputClass}
            placeholder="1.2.3.4"
            data-testid="ingress-ipv4-input"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Default A record IP for apex domains and CNAME resolution.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Default IPv6 <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="text"
            value={ipv6}
            onChange={(e) => setIpv6(e.target.value)}
            className={inputClass}
            placeholder="2001:db8::1"
            data-testid="ingress-ipv6-input"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            AAAA record IP for dual-stack. Leave empty for IPv4-only.
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-gray-50 dark:bg-gray-900 p-4 text-sm text-gray-600 dark:text-gray-400 space-y-2">
        <p><strong>CNAME chain architecture:</strong></p>
        <p className="font-mono text-xs leading-relaxed">
          blog.example.com<br />
          &nbsp;&nbsp;CNAME → blog-example-com.{baseDomain || 'ingress.platform.net'}<br />
          &nbsp;&nbsp;&nbsp;&nbsp;CNAME → node-1.platform.net<br />
          &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;A → {ipv4 || '1.2.3.4'}
        </p>
        <p className="mt-2">Subdomains use CNAME records. Apex domains use A/AAAA records pointing to the default IP. Node migration only requires updating platform DNS — no client action needed.</p>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
            <CheckCircle size={14} /> Saved
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={updateSettings.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="save-ingress-settings"
        >
          {updateSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Settings
        </button>
      </div>
    </div>
  );
}
