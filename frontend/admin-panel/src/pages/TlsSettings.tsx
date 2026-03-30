import { useState, useEffect } from 'react';
import { Shield, Loader2, AlertCircle, Save, CheckCircle } from 'lucide-react';
import { useTlsSettings, useUpdateTlsSettings } from '@/hooks/use-tls-settings';

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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="tls-settings-heading">TLS / Certificate Settings</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Configure cert-manager integration and automatic TLS for client domains.</p>
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
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm space-y-6">
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
    </div>
  );
}
