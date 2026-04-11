import { useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Loader2, AlertCircle, Plus, Trash2, X, Shield, Settings,
  ArrowLeftRight, ShieldAlert, Save,
} from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useRouteDetail,
  useUpdateRouteRedirects,
  useUpdateRouteSecurity,
  useUpdateRouteAdvanced,
  useRouteAuthUsers,
  useCreateRouteAuthUser,
  useDeleteRouteAuthUser,
  useToggleRouteAuthUser,
  useRouteWafLogs,
  type RouteDetailResponse,
  type RouteAuthUser,
  type WafLogEntry,
} from '@/hooks/use-route-settings';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

type Tab = 'redirects' | 'security' | 'advanced';

export default function RouteDetail() {
  const { domainId, routeId } = useParams<{ domainId: string; routeId: string }>();
  const { clientId } = useClientContext();
  const [activeTab, setActiveTab] = useState<Tab>('redirects');

  const { data: routeData, isLoading, isError } = useRouteDetail(clientId ?? undefined, routeId);
  const route = routeData?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="route-detail-loading">
        <Loader2 size={24} className="animate-spin text-blue-600" />
      </div>
    );
  }

  if (isError || !route) {
    return (
      <div className="py-20 text-center text-gray-500 dark:text-gray-400" data-testid="route-not-found">
        <p>Route not found.</p>
        <Link
          to={`/domains/${domainId}`}
          className="mt-2 text-blue-600 hover:underline"
        >
          Back to Domain
        </Link>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'redirects', label: 'Redirects', icon: <ArrowLeftRight size={14} /> },
    { key: 'security', label: 'Security', icon: <Shield size={14} /> },
    { key: 'advanced', label: 'Advanced', icon: <Settings size={14} /> },
  ];

  return (
    <div className="space-y-6" data-testid="route-detail-page">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <Link
          to="/domains"
          className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          data-testid="breadcrumb-domains"
        >
          Domains
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <Link
          to={`/domains/${domainId}`}
          className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          data-testid="breadcrumb-domain"
        >
          {route.domainId}
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <span className="text-gray-500 dark:text-gray-400">Routes</span>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {route.hostname}{route.path && route.path !== '/' ? route.path : ''}
        </span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          to={`/domains/${domainId}`}
          className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          data-testid="back-to-domain"
        >
          <ArrowLeft size={16} />
          Back
        </Link>
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100" data-testid="route-hostname-heading">
          {route.hostname}{route.path && route.path !== '/' ? route.path : ''}
        </h1>
        <span className={clsx(
          'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
          route.status === 'active'
            ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
        )}>
          {route.status}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
            )}
            data-testid={`tab-${tab.key}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'redirects' && <RedirectsTab clientId={clientId!} routeId={routeId!} route={route} />}
      {activeTab === 'security' && <SecurityTab clientId={clientId!} routeId={routeId!} route={route} />}
      {activeTab === 'advanced' && <AdvancedTab clientId={clientId!} routeId={routeId!} route={route} />}
    </div>
  );
}

// ─── Redirects Tab ──────────────────────────────────────────────────────────

function RedirectsTab({ clientId, routeId, route }: {
  readonly clientId: string;
  readonly routeId: string;
  readonly route: RouteDetailResponse;
}) {
  const updateRedirects = useUpdateRouteRedirects(clientId, routeId);

  const [forceHttps, setForceHttps] = useState(route.forceHttps);
  const [wwwRedirect, setWwwRedirect] = useState(route.wwwRedirect);
  const [customRedirectUrl, setCustomRedirectUrl] = useState(route.customRedirectUrl ?? '');
  const [dirty, setDirty] = useState(false);

  const markDirty = () => setDirty(true);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateRedirects.mutateAsync({
        force_https: forceHttps,
        www_redirect: wwwRedirect,
        custom_redirect_url: customRedirectUrl || null,
      });
      setDirty(false);
    } catch { /* error via updateRedirects.error */ }
  };

  return (
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-5"
      data-testid="redirects-form"
    >
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Redirect Settings</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Control how traffic is redirected for this route. Changes take effect immediately via NGINX Ingress annotations.
      </p>

      {/* Force HTTPS */}
      <label className="flex items-center justify-between" data-testid="force-https-row">
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Force HTTPS</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">Redirects all HTTP requests to HTTPS. Requires a valid SSL certificate.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={forceHttps}
          onClick={() => { setForceHttps(!forceHttps); markDirty(); }}
          className={clsx(
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            forceHttps ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
          )}
          data-testid="force-https-toggle"
        >
          <span
            className={clsx(
              'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform',
              forceHttps ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      </label>

      {/* www Redirect */}
      <div data-testid="www-redirect-row">
        <label htmlFor="www-redirect" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          www Redirect
        </label>
        <select
          id="www-redirect"
          value={wwwRedirect}
          onChange={(e) => { setWwwRedirect(e.target.value as 'none' | 'add-www' | 'remove-www'); markDirty(); }}
          className={INPUT_CLASS + ' mt-1 max-w-xs'}
          data-testid="www-redirect-select"
        >
          <option value="none">None</option>
          <option value="add-www">Add www</option>
          <option value="remove-www">Remove www</option>
        </select>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Controls whether the domain redirects between www and non-www versions. 'Add www' redirects example.com to www.example.com. 'Remove www' does the reverse.
        </p>
      </div>

      {/* Custom Redirect URL */}
      <div data-testid="custom-redirect-row">
        <label htmlFor="custom-redirect-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Custom Redirect URL
        </label>
        <input
          id="custom-redirect-url"
          type="text"
          className={INPUT_CLASS + ' mt-1'}
          placeholder="https://example.com"
          value={customRedirectUrl}
          onChange={(e) => { setCustomRedirectUrl(e.target.value); markDirty(); }}
          data-testid="custom-redirect-url-input"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Permanently redirects (301) all traffic for this route to the specified URL. Useful for domain migrations or parking pages. Leave empty to disable.
        </p>
      </div>

      {updateRedirects.error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="redirects-save-error">
          <AlertCircle size={14} />
          {updateRedirects.error instanceof Error ? updateRedirects.error.message : 'Failed to save redirect settings'}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!dirty || updateRedirects.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="save-redirects"
        >
          {updateRedirects.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
      </div>
    </form>
  );
}

// ─── Security Tab ───────────────────────────────────────────────────────────

function SecurityTab({ clientId, routeId, route }: {
  readonly clientId: string;
  readonly routeId: string;
  readonly route: RouteDetailResponse;
}) {
  const updateSecurity = useUpdateRouteSecurity(clientId, routeId);

  const [basicAuthEnabled, setBasicAuthEnabled] = useState(route.basicAuthEnabled);
  const [basicAuthRealm, setBasicAuthRealm] = useState(route.basicAuthRealm);
  const [ipAllowlist, setIpAllowlist] = useState(route.ipAllowlist ?? '');
  const [rateLimitRps, setRateLimitRps] = useState(String(route.rateLimitRps ?? ''));
  const [rateLimitConnections, setRateLimitConnections] = useState(String(route.rateLimitConnections ?? ''));
  const [rateLimitBurst, setRateLimitBurst] = useState(String(route.rateLimitBurst ?? ''));
  const [wafEnabled, setWafEnabled] = useState(route.wafEnabled);
  const [wafOwaspCoreRules, setWafOwaspCoreRules] = useState(route.wafOwaspCoreRules);
  const [wafAnomalyThreshold, setWafAnomalyThreshold] = useState(route.wafAnomalyThreshold);
  const [wafExcludedRuleIds, setWafExcludedRuleIds] = useState(route.wafExcludedRuleIds ?? '');
  const [dirty, setDirty] = useState(false);

  const markDirty = () => setDirty(true);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateSecurity.mutateAsync({
        basic_auth_enabled: basicAuthEnabled,
        basic_auth_realm: basicAuthRealm,
        ip_allowlist: ipAllowlist || null,
        rate_limit_rps: rateLimitRps ? Number(rateLimitRps) : null,
        rate_limit_connections: rateLimitConnections ? Number(rateLimitConnections) : null,
        rate_limit_burst: rateLimitBurst ? Number(rateLimitBurst) : null,
        waf_enabled: wafEnabled,
        waf_owasp_core_rules: wafOwaspCoreRules,
        waf_anomaly_threshold: wafAnomalyThreshold,
        waf_excluded_rule_ids: wafExcludedRuleIds || null,
      });
      setDirty(false);
    } catch { /* error via updateSecurity.error */ }
  };

  return (
    <div className="space-y-6" data-testid="security-tab">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Configure access control and protection for this route. All settings are enforced at the NGINX Ingress level before requests reach your application.
      </p>
      <form
        onSubmit={handleSave}
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-6"
        data-testid="security-form"
      >
        {/* Basic Auth */}
        <section className="space-y-4" data-testid="basic-auth-section">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 border-b border-gray-100 dark:border-gray-700 pb-2">
            Basic Authentication
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Require username and password before accessing this route. Uses HTTP Basic Auth at the ingress level — works with any backend application.
          </p>

          <label className="flex items-center justify-between" data-testid="basic-auth-enabled-row">
            <span className="text-sm text-gray-700 dark:text-gray-300">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={basicAuthEnabled}
              onClick={() => { setBasicAuthEnabled(!basicAuthEnabled); markDirty(); }}
              className={clsx(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                basicAuthEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
              )}
              data-testid="basic-auth-toggle"
            >
              <span className={clsx(
                'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform',
                basicAuthEnabled ? 'translate-x-5' : 'translate-x-0',
              )} />
            </button>
          </label>

          <div>
            <label htmlFor="basic-auth-realm" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Realm
            </label>
            <input
              id="basic-auth-realm"
              type="text"
              className={INPUT_CLASS + ' mt-1 max-w-sm'}
              value={basicAuthRealm}
              onChange={(e) => { setBasicAuthRealm(e.target.value); markDirty(); }}
              data-testid="basic-auth-realm-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The name shown in the browser's login dialog (e.g., 'Admin Area').
            </p>
          </div>

          <AuthUsersSection clientId={clientId} routeId={routeId} />
        </section>

        {/* IP Allowlist */}
        <section className="space-y-3" data-testid="ip-allowlist-section">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 border-b border-gray-100 dark:border-gray-700 pb-2">
            IP Allowlist
          </h3>
          <div>
            <input
              type="text"
              className={INPUT_CLASS}
              placeholder="192.168.1.0/24, 10.0.0.0/8"
              value={ipAllowlist}
              onChange={(e) => { setIpAllowlist(e.target.value); markDirty(); }}
              data-testid="ip-allowlist-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Comma-separated list of CIDR ranges. Only requests from these IP ranges will be allowed. Example: 10.0.0.0/8, 192.168.1.0/24
            </p>
          </div>
        </section>

        {/* Rate Limiting */}
        <section className="space-y-3" data-testid="rate-limiting-section">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 border-b border-gray-100 dark:border-gray-700 pb-2">
            Rate Limiting
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="rate-limit-rps" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Requests/sec
              </label>
              <input
                id="rate-limit-rps"
                type="number"
                min="0"
                className={INPUT_CLASS + ' mt-1'}
                value={rateLimitRps}
                onChange={(e) => { setRateLimitRps(e.target.value); markDirty(); }}
                data-testid="rate-limit-rps-input"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Maximum number of requests per second from a single IP address.
              </p>
            </div>
            <div>
              <label htmlFor="rate-limit-connections" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Connections
              </label>
              <input
                id="rate-limit-connections"
                type="number"
                min="0"
                className={INPUT_CLASS + ' mt-1'}
                value={rateLimitConnections}
                onChange={(e) => { setRateLimitConnections(e.target.value); markDirty(); }}
                data-testid="rate-limit-connections-input"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Maximum number of concurrent connections from a single IP address.
              </p>
            </div>
            <div>
              <label htmlFor="rate-limit-burst" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Burst multiplier
              </label>
              <input
                id="rate-limit-burst"
                type="number"
                min="0"
                className={INPUT_CLASS + ' mt-1'}
                value={rateLimitBurst}
                onChange={(e) => { setRateLimitBurst(e.target.value); markDirty(); }}
                data-testid="rate-limit-burst-input"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Allows temporary bursts above the rate limit. A value of 5 with 10 rps allows bursts up to 50 requests.
              </p>
            </div>
          </div>
        </section>

        {/* WAF */}
        <section className="space-y-4" data-testid="waf-section">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 border-b border-gray-100 dark:border-gray-700 pb-2">
            WAF (Web Application Firewall)
          </h3>

          <div>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">Enabled</span>
              <button
                type="button"
                role="switch"
                aria-checked={wafEnabled}
                onClick={() => { setWafEnabled(!wafEnabled); markDirty(); }}
                className={clsx(
                  'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                  wafEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
                )}
                data-testid="waf-enabled-toggle"
              >
                <span className={clsx(
                  'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform',
                  wafEnabled ? 'translate-x-5' : 'translate-x-0',
                )} />
              </button>
            </label>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              ModSecurity Web Application Firewall protects against common web attacks (SQL injection, XSS, etc.).
            </p>
          </div>

          <div>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">OWASP Core Rules</span>
              <button
                type="button"
                role="switch"
                aria-checked={wafOwaspCoreRules}
                onClick={() => { setWafOwaspCoreRules(!wafOwaspCoreRules); markDirty(); }}
                className={clsx(
                  'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                  wafOwaspCoreRules ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
                )}
                data-testid="waf-owasp-toggle"
              >
                <span className={clsx(
                  'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform',
                  wafOwaspCoreRules ? 'translate-x-5' : 'translate-x-0',
                )} />
              </button>
            </label>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              OWASP Core Rule Set provides pre-configured rules for common attack patterns. Disable only if causing false positives.
            </p>
          </div>

          <div>
            <label htmlFor="waf-anomaly-threshold" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Anomaly Threshold: {wafAnomalyThreshold}
            </label>
            <input
              id="waf-anomaly-threshold"
              type="range"
              min="1"
              max="50"
              value={wafAnomalyThreshold}
              onChange={(e) => { setWafAnomalyThreshold(Number(e.target.value)); markDirty(); }}
              className="mt-2 w-full max-w-sm accent-blue-600"
              data-testid="waf-anomaly-threshold-slider"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Lower values are stricter (more blocking). Default 10 is a good balance. Set higher (20-50) for applications with complex forms that trigger false positives.
            </p>
          </div>

          <div>
            <label htmlFor="waf-excluded-rules" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Excluded Rule IDs
            </label>
            <input
              id="waf-excluded-rules"
              type="text"
              className={INPUT_CLASS + ' mt-1'}
              placeholder="942100, 942200"
              value={wafExcludedRuleIds}
              onChange={(e) => { setWafExcludedRuleIds(e.target.value); markDirty(); }}
              data-testid="waf-excluded-rules-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Comma-separated ModSecurity rule IDs to skip. Use the WAF log below to identify rules causing false positives. Example: 942100, 941100
            </p>
          </div>
        </section>

        {updateSecurity.error && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="security-save-error">
            <AlertCircle size={14} />
            {updateSecurity.error instanceof Error ? updateSecurity.error.message : 'Failed to save security settings'}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!dirty || updateSecurity.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="save-security"
          >
            {updateSecurity.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </form>

      <WafLogSection clientId={clientId} routeId={routeId} />
    </div>
  );
}

// ─── Auth Users Section ─────────────────────────────────────────────────────

function AuthUsersSection({ clientId, routeId }: {
  readonly clientId: string;
  readonly routeId: string;
}) {
  const { data: usersData, isLoading } = useRouteAuthUsers(clientId, routeId);
  const createUser = useCreateRouteAuthUser(clientId, routeId);
  const deleteUser = useDeleteRouteAuthUser(clientId, routeId);
  const toggleUser = useToggleRouteAuthUser(clientId, routeId);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const users = usersData?.data ?? [];

  const handleAddUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newPassword) return;
    try {
      await createUser.mutateAsync({ username: newUsername, password: newPassword });
      setNewUsername('');
      setNewPassword('');
      setShowAddForm(false);
    } catch { /* error via createUser.error */ }
  };

  return (
    <div className="space-y-3" data-testid="auth-users-section">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Users</span>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
          data-testid="add-auth-user-button"
        >
          {showAddForm ? <X size={12} /> : <Plus size={12} />}
          {showAddForm ? 'Cancel' : 'Add User'}
        </button>
      </div>

      {showAddForm && (
        <div
          className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 p-3"
          data-testid="add-auth-user-form"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              type="text"
              placeholder="Username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className={INPUT_CLASS}
              data-testid="auth-user-username-input"
            />
            <input
              type="password"
              placeholder="Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={INPUT_CLASS}
              data-testid="auth-user-password-input"
            />
            <button
              type="button"
              onClick={handleAddUser}
              disabled={!newUsername || !newPassword || createUser.isPending}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="submit-auth-user"
            >
              {createUser.isPending && <Loader2 size={14} className="animate-spin" />}
              Add
            </button>
          </div>
          {createUser.error && (
            <div className="mt-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} />
              {createUser.error instanceof Error ? createUser.error.message : 'Failed to add user'}
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 size={14} className="animate-spin text-blue-600" />
          <span className="text-xs text-gray-500">Loading users...</span>
        </div>
      ) : users.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">No authentication users configured.</p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700 rounded-lg border border-gray-200 dark:border-gray-700">
          {users.map((user) => (
            <div
              key={user.id}
              className="flex items-center justify-between px-3 py-2"
              data-testid={`auth-user-row-${user.username}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.username}</span>
                <span className={clsx(
                  'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                  user.enabled
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
                )}>
                  {user.enabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleUser.mutate({ userId: user.id, enabled: !user.enabled })}
                  className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  data-testid={`toggle-auth-user-${user.username}`}
                >
                  {user.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  onClick={() => deleteUser.mutate(user.id)}
                  className="rounded-md p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                  data-testid={`delete-auth-user-${user.username}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── WAF Log Section ────────────────────────────────────────────────────────

const SEV_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  info: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
};

function formatTs(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function WafLogSection({ clientId, routeId }: {
  readonly clientId: string;
  readonly routeId: string;
}) {
  const { data: logsData, isLoading } = useRouteWafLogs(clientId, routeId);
  const logs = logsData?.data ?? [];

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="waf-log-section">
      <div className="border-b border-gray-100 dark:border-gray-700 px-5 py-4">
        <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          <ShieldAlert size={16} />
          WAF Log
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          ModSecurity WAF events for this route. Shows the last 50 blocked or logged requests. Use rule IDs from this log to add exclusions above.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-600" /></div>
      ) : logs.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="waf-log-empty">No WAF events recorded.</div>
      ) : (
        <div className="overflow-x-auto rounded-b-xl bg-gray-950" data-testid="waf-log-entries">
          {logs.map((log, idx) => (
            <div
              key={log.id}
              className={clsx('flex items-center gap-1.5 px-4 py-1.5 font-mono text-[11px] whitespace-nowrap', idx % 2 === 0 ? 'bg-gray-950' : 'bg-gray-900')}
              data-testid={`waf-log-entry-${log.id}`}
            >
              <span className="text-gray-500 w-[110px] shrink-0">{formatTs(log.createdAt)}</span>
              <span className="text-gray-400 w-[100px] shrink-0">{log.sourceIp ?? '-'}</span>
              <span className={clsx('inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase w-[62px] justify-center shrink-0', SEV_STYLE[log.severity] ?? SEV_STYLE.info)}>
                {log.severity}
              </span>
              <span className="text-blue-400 font-bold w-[52px] shrink-0">{log.ruleId}</span>
              {(() => { const m = log.message.match(/Score:\s*(\d+)|Total Score:\s*(\d+)/); const s = m ? (m[1] || m[2]) : null; return s ? <span className="text-amber-400 w-[52px] shrink-0">Score:{s}</span> : null; })()}
              <span className="text-green-400 flex-1 truncate" title={`${log.requestMethod ?? 'GET'} ${log.requestUri ?? '/'}`}>
                {log.requestMethod ?? 'GET'} {log.requestUri ?? '/'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Advanced Tab ───────────────────────────────────────────────────────────

function AdvancedTab({ clientId, routeId, route }: {
  readonly clientId: string;
  readonly routeId: string;
  readonly route: RouteDetailResponse;
}) {
  const updateAdvanced = useUpdateRouteAdvanced(clientId, routeId);

  const [customErrorCodes, setCustomErrorCodes] = useState(route.customErrorCodes ?? '');
  const [customErrorPath, setCustomErrorPath] = useState(route.customErrorPath ?? '');
  const [headers, setHeaders] = useState<readonly { readonly name: string; readonly value: string }[]>(
    route.additionalHeaders ? Object.entries(route.additionalHeaders).map(([name, value]) => ({ name, value })) : [],
  );
  const [dirty, setDirty] = useState(false);

  const markDirty = () => setDirty(true);

  const handleAddHeader = () => {
    if (headers.length >= 50) return;
    setHeaders([...headers, { name: '', value: '' }]);
    markDirty();
  };

  const handleUpdateHeader = (index: number, field: 'name' | 'value', val: string) => {
    const updated = headers.map((h, i) => (i === index ? { ...h, [field]: val } : h));
    setHeaders(updated);
    markDirty();
  };

  const handleRemoveHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
    markDirty();
  };

  const validateHeaders = (): string | null => {
    for (const h of headers) {
      if (h.name && /\s/.test(h.name)) return 'Header names must not contain spaces.';
      if (h.value && /\n/.test(h.value)) return 'Header values must not contain newlines.';
    }
    if (headers.length > 50) return 'Maximum 50 headers allowed.';
    return null;
  };

  const headerError = validateHeaders();

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (headerError) return;
    const filteredHeaders = headers.filter((h) => h.name.trim() !== '');
    try {
      const headersObj: Record<string, string> = {};
      for (const h of filteredHeaders) headersObj[h.name] = h.value;
      await updateAdvanced.mutateAsync({
        custom_error_codes: customErrorCodes || null,
        custom_error_path: customErrorPath || null,
        additional_headers: Object.keys(headersObj).length > 0 ? headersObj : null,
      });
      setDirty(false);
    } catch { /* error via updateAdvanced.error */ }
  };

  return (
    <div className="space-y-6">
    <p className="text-xs text-gray-500 dark:text-gray-400">
      Configure response headers and error handling. Response headers are added to every response from this route.
    </p>
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-6"
      data-testid="advanced-form"
    >
      {/* Custom Error Pages */}
      <section className="space-y-3" data-testid="custom-error-pages-section">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 border-b border-gray-100 dark:border-gray-700 pb-2">
          Custom Error Pages
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="error-codes" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Error Codes
            </label>
            <input
              id="error-codes"
              type="text"
              className={INPUT_CLASS + ' mt-1'}
              placeholder="404, 500, 503"
              value={customErrorCodes}
              onChange={(e) => { setCustomErrorCodes(e.target.value); markDirty(); }}
              data-testid="error-codes-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Comma-separated HTTP status codes to intercept. When these errors occur, NGINX serves the custom error page instead of the default.
            </p>
          </div>
          <div>
            <label htmlFor="error-pages-path" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Error Pages Path
            </label>
            <input
              id="error-pages-path"
              type="text"
              className={INPUT_CLASS + ' mt-1'}
              placeholder=".platform/errors/"
              value={customErrorPath}
              onChange={(e) => { setCustomErrorPath(e.target.value); markDirty(); }}
              data-testid="error-pages-path-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Path within your file storage where custom error pages are stored. Create files like 404.html, 500.html in this directory.
            </p>
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Must be in your file storage. Pages are looked up as &lt;path&gt;/&lt;code&gt;.html.
        </p>
      </section>

      {/* Response Headers */}
      <section className="space-y-3" data-testid="proxy-headers-section">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 pb-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Response Headers
          </h3>
          <button
            type="button"
            onClick={handleAddHeader}
            disabled={headers.length >= 50}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
            data-testid="add-header-button"
          >
            <Plus size={12} />
            Add Header
          </button>
        </div>

        {headers.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No additional proxy headers configured.
          </p>
        ) : (
          <div className="space-y-2" data-testid="proxy-headers-list">
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              <span>Header Name</span>
              <span>Header Value</span>
              <span />
            </div>
            {headers.map((header, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2" data-testid={`proxy-header-row-${idx}`}>
                <input
                  type="text"
                  className={INPUT_CLASS}
                  placeholder="X-Custom-Header"
                  value={header.name}
                  onChange={(e) => handleUpdateHeader(idx, 'name', e.target.value)}
                  data-testid={`proxy-header-name-${idx}`}
                />
                <input
                  type="text"
                  className={INPUT_CLASS}
                  placeholder="value"
                  value={header.value}
                  onChange={(e) => handleUpdateHeader(idx, 'value', e.target.value)}
                  data-testid={`proxy-header-value-${idx}`}
                />
                <button
                  type="button"
                  onClick={() => handleRemoveHeader(idx)}
                  className="rounded-md p-2 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                  data-testid={`remove-header-${idx}`}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {headerError && (
          <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400" data-testid="header-validation-error">
            <AlertCircle size={12} />
            {headerError}
          </div>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          HTTP headers added to every response. Common security headers: X-Frame-Options (clickjacking protection), X-Content-Type-Options (MIME sniffing prevention), Content-Security-Policy (XSS/injection prevention).
        </p>
      </section>

      {updateAdvanced.error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="advanced-save-error">
          <AlertCircle size={14} />
          {updateAdvanced.error instanceof Error ? updateAdvanced.error.message : 'Failed to save advanced settings'}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!dirty || !!headerError || updateAdvanced.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="save-advanced"
        >
          {updateAdvanced.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
      </div>
    </form>
    </div>
  );
}
