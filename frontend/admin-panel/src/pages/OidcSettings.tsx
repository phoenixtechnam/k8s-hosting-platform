import { useState, useEffect, type FormEvent } from 'react';
import { Shield, Loader2, AlertCircle, CheckCircle, Save, Plug, Eye, EyeOff } from 'lucide-react';
import { useOidcSettings, useSaveOidcSettings, useTestOidcConnection } from '@/hooks/use-oidc-settings';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function OidcSettings() {
  const { data: response, isLoading } = useOidcSettings();
  const saveSettings = useSaveOidcSettings();
  const testConnection = useTestOidcConnection();

  const settings = response?.data;

  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [disableLocalAuth, setDisableLocalAuth] = useState(false);
  const [backchannelLogout, setBackchannelLogout] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (settings && !initialized) {
      setIssuerUrl(settings.issuerUrl ?? '');
      setClientId(settings.clientId ?? '');
      setClientSecret(''); // never pre-fill secret
      setEnabled(settings.enabled);
      setDisableLocalAuth(settings.disableLocalAuth);
      setBackchannelLogout(settings.backchannelLogoutEnabled);
      setInitialized(true);
    }
  }, [settings, initialized]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!issuerUrl.trim() || !clientId.trim() || !clientSecret.trim()) return;
    try {
      await saveSettings.mutateAsync({
        issuer_url: issuerUrl.trim(),
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        enabled,
        disable_local_auth: disableLocalAuth,
        backchannel_logout_enabled: backchannelLogout,
      });
    } catch { /* error displayed in UI */ }
  };

  const handleTest = async () => {
    try {
      await testConnection.mutateAsync();
    } catch { /* error displayed in UI */ }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="oidc-settings-page">
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">OIDC / SSO Configuration</h1>
          <p className="text-sm text-gray-500">Configure an external OpenID Connect identity provider for single sign-on.</p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Provider Configuration</h2>

          <div>
            <label htmlFor="oidc-issuer" className="block text-sm font-medium text-gray-700">
              Issuer URL
            </label>
            <input
              id="oidc-issuer"
              type="url"
              className={INPUT_CLASS}
              placeholder="https://dex.example.com"
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
              required
              data-testid="oidc-issuer-input"
            />
            <p className="mt-1 text-xs text-gray-500">
              The OIDC provider's issuer URL. Discovery will be fetched from {issuerUrl ? `${issuerUrl}/.well-known/openid-configuration` : '<issuer>/.well-known/openid-configuration'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="oidc-client-id" className="block text-sm font-medium text-gray-700">
                Client ID
              </label>
              <input
                id="oidc-client-id"
                type="text"
                className={INPUT_CLASS}
                placeholder="hosting-platform"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
                data-testid="oidc-client-id-input"
              />
            </div>
            <div>
              <label htmlFor="oidc-client-secret" className="block text-sm font-medium text-gray-700">
                Client Secret
              </label>
              <div className="relative">
                <input
                  id="oidc-client-secret"
                  type={showSecret ? 'text' : 'password'}
                  className={INPUT_CLASS + ' pr-10'}
                  placeholder={settings ? '(unchanged — enter new value to update)' : 'Enter client secret'}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  required={!settings}
                  data-testid="oidc-client-secret-input"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((p) => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 mt-0.5 text-gray-400 hover:text-gray-600"
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Options</h2>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                if (!e.target.checked) setDisableLocalAuth(false);
              }}
              className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
              data-testid="oidc-enabled-toggle"
            />
            <div>
              <span className="text-sm font-medium text-gray-700">Enable OIDC Login</span>
              <p className="text-xs text-gray-500">Show "Sign in with SSO" button on the login page</p>
            </div>
          </label>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={disableLocalAuth}
              onChange={(e) => setDisableLocalAuth(e.target.checked)}
              disabled={!enabled}
              className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500 disabled:opacity-50"
              data-testid="oidc-disable-local-toggle"
            />
            <div>
              <span className="text-sm font-medium text-gray-700">Disable Local Authentication</span>
              <p className="text-xs text-gray-500">When enabled, email/password login is blocked. Users must use SSO.</p>
            </div>
          </label>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={backchannelLogout}
              onChange={(e) => setBackchannelLogout(e.target.checked)}
              disabled={!enabled}
              className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500 disabled:opacity-50"
              data-testid="oidc-backchannel-toggle"
            />
            <div>
              <span className="text-sm font-medium text-gray-700">Backchannel Logout</span>
              <p className="text-xs text-gray-500">Allow the OIDC provider to remotely terminate user sessions</p>
            </div>
          </label>
        </div>

        {/* Test Connection */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Connection Test</h2>
            <button
              type="button"
              onClick={handleTest}
              disabled={testConnection.isPending || !settings}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              data-testid="oidc-test-button"
            >
              {testConnection.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              Test Connection
            </button>
          </div>

          {testConnection.isSuccess && testConnection.data && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-2" data-testid="oidc-test-success">
              <div className="flex items-center gap-2 text-green-700">
                <CheckCircle size={16} />
                <span className="text-sm font-medium">Connection successful</span>
              </div>
              <dl className="grid grid-cols-1 gap-1 text-xs text-green-800 sm:grid-cols-2">
                <div><dt className="font-medium">Issuer:</dt><dd className="font-mono">{(testConnection.data as any).data?.issuer}</dd></div>
                <div><dt className="font-medium">JWKS Keys:</dt><dd>{(testConnection.data as any).data?.keys_count}</dd></div>
                <div><dt className="font-medium">Backchannel Logout:</dt><dd>{(testConnection.data as any).data?.backchannel_logout_supported ? 'Supported' : 'Not supported'}</dd></div>
              </dl>
            </div>
          )}

          {testConnection.isError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4" data-testid="oidc-test-error">
              <div className="flex items-center gap-2 text-red-700">
                <AlertCircle size={16} />
                <span className="text-sm font-medium">Connection failed</span>
              </div>
              <p className="mt-1 text-xs text-red-600">
                {testConnection.error instanceof Error ? testConnection.error.message : 'Unable to connect to the OIDC provider'}
              </p>
            </div>
          )}

          {!settings && (
            <p className="text-sm text-gray-500">Save settings first to test the connection.</p>
          )}
        </div>

        {/* Save */}
        {saveSettings.error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-testid="oidc-save-error">
            <AlertCircle size={16} />
            {saveSettings.error instanceof Error ? saveSettings.error.message : 'Failed to save OIDC settings'}
          </div>
        )}

        {saveSettings.isSuccess && (
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700" data-testid="oidc-save-success">
            <CheckCircle size={16} />
            OIDC settings saved successfully. Discovery metadata fetched.
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saveSettings.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid="oidc-save-button"
          >
            {saveSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save OIDC Settings
          </button>
        </div>
      </form>
    </div>
  );
}
