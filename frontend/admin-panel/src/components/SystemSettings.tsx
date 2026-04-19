import { useState, useEffect } from 'react';
import { Loader2, Save, CheckCircle, AlertCircle } from 'lucide-react';
import { useSystemSettings, useUpdateSystemSettings } from '@/hooks/use-system-settings';
import TimezoneSelect from './TimezoneSelect';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function SystemSettingsForm() {
  const { data: response, isLoading, isError, error } = useSystemSettings();
  const updateSettings = useUpdateSystemSettings();
  const settings = response?.data;

  const [platformName, setPlatformName] = useState('Hosting Platform');
  const [adminPanelUrl, setAdminPanelUrl] = useState('');
  const [clientPanelUrl, setClientPanelUrl] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [supportUrl, setSupportUrl] = useState('');
  const [ingressBaseDomain, setIngressBaseDomain] = useState('');
  const [apiRateLimit, setApiRateLimit] = useState(100);
  const [timezone, setTimezone] = useState('UTC');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setPlatformName(settings.platformName);
      setAdminPanelUrl(settings.adminPanelUrl ?? '');
      setClientPanelUrl(settings.clientPanelUrl ?? '');
      setSupportEmail(settings.supportEmail ?? '');
      setSupportUrl(settings.supportUrl ?? '');
      setIngressBaseDomain(settings.ingressBaseDomain ?? '');
      setApiRateLimit(settings.apiRateLimit);
      setTimezone(settings.timezone ?? 'UTC');
    }
  }, [settings]);

  const handleSave = () => {
    setSaved(false);
    setSaveError(null);
    updateSettings.mutate(
      {
        platformName,
        adminPanelUrl: adminPanelUrl || null,
        clientPanelUrl: clientPanelUrl || null,
        supportEmail: supportEmail || null,
        supportUrl: supportUrl || null,
        ingressBaseDomain: ingressBaseDomain || null,
        apiRateLimit,
        timezone,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        },
        onError: (err) => {
          setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 size={20} className="animate-spin text-brand-500" />
        <span className="text-sm text-gray-500 dark:text-gray-400">Loading system settings...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        <AlertCircle size={16} />
        <span>Failed to load system settings: {error?.message ?? 'Unknown error'}</span>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="space-y-6" data-testid="system-settings-form">
      {/* Platform Identity */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Platform Identity</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Platform Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={platformName}
              onChange={(e) => setPlatformName(e.target.value)}
              className={INPUT_CLASS}
              placeholder="Hosting Platform"
              required
              data-testid="platform-name-input"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Admin Panel URL
              </label>
              <input
                type="url"
                value={adminPanelUrl}
                onChange={(e) => setAdminPanelUrl(e.target.value)}
                className={INPUT_CLASS}
                placeholder="https://admin.example.com"
                data-testid="admin-panel-url-input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Client Panel URL
              </label>
              <input
                type="url"
                value={clientPanelUrl}
                onChange={(e) => setClientPanelUrl(e.target.value)}
                className={INPUT_CLASS}
                placeholder="https://my.example.com"
                data-testid="client-panel-url-input"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Support Email
              </label>
              <input
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                className={INPUT_CLASS}
                placeholder="support@example.com"
                data-testid="support-email-input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Support URL
              </label>
              <input
                type="url"
                value={supportUrl}
                onChange={(e) => setSupportUrl(e.target.value)}
                className={INPUT_CLASS}
                placeholder="https://docs.example.com"
                data-testid="support-url-input"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Networking */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Networking</h3>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Ingress Base Domain
          </label>
          <input
            type="text"
            value={ingressBaseDomain}
            onChange={(e) => setIngressBaseDomain(e.target.value)}
            className={INPUT_CLASS}
            placeholder="ingress.example.com"
            data-testid="ingress-base-domain-input"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Base domain used for CNAME routing targets (e.g., slug.ingress.example.com).
          </p>
        </div>
      </div>

      {/* Limits */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Limits & Regional</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              API Rate Limit
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={apiRateLimit}
                onChange={(e) => setApiRateLimit(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))}
                className={INPUT_CLASS}
                min={1}
                max={10000}
                data-testid="api-rate-limit-input"
              />
              <span className="shrink-0 text-sm text-gray-500 dark:text-gray-400">req/min</span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              System Timezone
            </label>
            <TimezoneSelect value={timezone} onChange={setTimezone} />
            <p className="text-xs text-gray-400 mt-1">Default timezone for new clients. Clients can override in their settings.</p>
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
            <CheckCircle size={14} /> Settings saved
          </span>
        )}
        {saveError && (
          <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={14} /> {saveError}
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={updateSettings.isPending || !platformName.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="save-system-settings"
        >
          {updateSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Settings
        </button>
      </div>
    </div>
  );
}
