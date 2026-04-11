import { useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Loader2, AlertCircle, Plus, Trash2, X, Shield, Settings,
  ArrowLeftRight, ShieldAlert, Save, ChevronDown, ChevronUp, ChevronRight, FolderLock,
} from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useRouteDetail,
  useUpdateRouteRedirects,
  useUpdateRouteSecurity,
  useUpdateRouteAdvanced,
  useProtectedDirs,
  useCreateProtectedDir,
  useUpdateProtectedDir,
  useDeleteProtectedDir,
  useDirUsers,
  useCreateDirUser,
  useDeleteDirUser,
  useToggleDirUser,
  useRouteWafLogs,
  type RouteDetailResponse,
  type ProtectedDir,
  type DirUser,
  type WafLogEntry,
} from '@/hooks/use-route-settings';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

type Tab = 'redirects' | 'security' | 'protected-dirs' | 'advanced';

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
    { key: 'protected-dirs', label: 'Protected Dirs', icon: <FolderLock size={14} /> },
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
          {route.hostname.split('/')[0]}
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
      {activeTab === 'protected-dirs' && <ProtectedDirsSection clientId={clientId!} routeId={routeId!} />}
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
  const { data: logsData, isLoading: wafLogsLoading } = useRouteWafLogs(clientId, routeId);
  const wafLogs = logsData?.data ?? [];

  /* ── WAF state ── */
  const [wafEnabled, setWafEnabled] = useState(route.wafEnabled);
  const [wafOwaspCoreRules, setWafOwaspCoreRules] = useState(route.wafOwaspCoreRules);
  const [wafAnomalyThreshold, setWafAnomalyThreshold] = useState(route.wafAnomalyThreshold);
  const [wafExcludedRuleIds, setWafExcludedRuleIds] = useState(route.wafExcludedRuleIds ?? '');
  const [wafDirty, setWafDirty] = useState(false);
  const [showWafLog, setShowWafLog] = useState(false);
  const markWafDirty = () => setWafDirty(true);

  /* ── IP Allowlist state ── */
  const [ipAllowlist, setIpAllowlist] = useState(route.ipAllowlist ?? '');
  const [ipDirty, setIpDirty] = useState(false);
  const markIpDirty = () => setIpDirty(true);

  /* ── Rate Limiting state ── */
  const [rateLimitRps, setRateLimitRps] = useState(String(route.rateLimitRps ?? ''));
  const [rateLimitConnections, setRateLimitConnections] = useState(String(route.rateLimitConnections ?? ''));
  const [rateLimitBurst, setRateLimitBurst] = useState(String(route.rateLimitBurst ?? ''));
  const [rateDirty, setRateDirty] = useState(false);
  const markRateDirty = () => setRateDirty(true);

  /* ── Separate save error states ── */
  const [wafSaveError, setWafSaveError] = useState<string | null>(null);
  const [ipSaveError, setIpSaveError] = useState<string | null>(null);
  const [rateSaveError, setRateSaveError] = useState<string | null>(null);
  const [wafSaving, setWafSaving] = useState(false);
  const [ipSaving, setIpSaving] = useState(false);
  const [rateSaving, setRateSaving] = useState(false);

  const handleSaveWaf = async (e: FormEvent) => {
    e.preventDefault();
    setWafSaveError(null);
    setWafSaving(true);
    try {
      await updateSecurity.mutateAsync({
        waf_enabled: wafEnabled,
        waf_owasp_core_rules: wafOwaspCoreRules,
        waf_anomaly_threshold: wafAnomalyThreshold,
        waf_excluded_rule_ids: wafExcludedRuleIds || null,
      });
      setWafDirty(false);
    } catch (err) {
      setWafSaveError(err instanceof Error ? err.message : 'Failed to save WAF settings');
    } finally {
      setWafSaving(false);
    }
  };

  const handleSaveIp = async (e: FormEvent) => {
    e.preventDefault();
    setIpSaveError(null);
    setIpSaving(true);
    try {
      await updateSecurity.mutateAsync({
        ip_allowlist: ipAllowlist || null,
      });
      setIpDirty(false);
    } catch (err) {
      setIpSaveError(err instanceof Error ? err.message : 'Failed to save IP allowlist');
    } finally {
      setIpSaving(false);
    }
  };

  const handleSaveRate = async (e: FormEvent) => {
    e.preventDefault();
    setRateSaveError(null);
    setRateSaving(true);
    try {
      await updateSecurity.mutateAsync({
        rate_limit_rps: rateLimitRps ? Number(rateLimitRps) : null,
        rate_limit_connections: rateLimitConnections ? Number(rateLimitConnections) : null,
        rate_limit_burst: rateLimitBurst ? Number(rateLimitBurst) : null,
      });
      setRateDirty(false);
    } catch (err) {
      setRateSaveError(err instanceof Error ? err.message : 'Failed to save rate limiting settings');
    } finally {
      setRateSaving(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="security-tab">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Configure access control and protection for this route. All settings are enforced at the NGINX Ingress level before requests reach your application.
      </p>

      {/* ── WAF Card ── */}
      <form
        onSubmit={handleSaveWaf}
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4"
        data-testid="waf-form"
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100" data-testid="waf-section">
          WAF (Web Application Firewall)
        </h3>

        <div>
          <label className="flex items-center justify-between">
            <span className="text-sm text-gray-700 dark:text-gray-300">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={wafEnabled}
              onClick={() => { setWafEnabled(!wafEnabled); markWafDirty(); }}
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
              onClick={() => { setWafOwaspCoreRules(!wafOwaspCoreRules); markWafDirty(); }}
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
            onChange={(e) => { setWafAnomalyThreshold(Number(e.target.value)); markWafDirty(); }}
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
            onChange={(e) => { setWafExcludedRuleIds(e.target.value); markWafDirty(); }}
            data-testid="waf-excluded-rules-input"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Comma-separated ModSecurity rule IDs to skip. Use the WAF log below to identify rules causing false positives. Example: 942100, 941100
          </p>
        </div>

        {wafSaveError && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="waf-save-error">
            <AlertCircle size={14} />
            {wafSaveError}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!wafDirty || wafSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="save-waf"
          >
            {wafSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>

        {/* Collapsible WAF Log */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
          <button
            type="button"
            onClick={() => setShowWafLog(!showWafLog)}
            className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300"
            data-testid="toggle-waf-log"
          >
            {showWafLog ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            WAF Log ({wafLogs.length} events)
          </button>
          {showWafLog && (
            <div className="mt-3">
              {wafLogsLoading ? (
                <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-600" /></div>
              ) : wafLogs.length === 0 ? (
                <div className="py-4 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="waf-log-empty">No WAF events recorded.</div>
              ) : (
                <WafLogTable logs={wafLogs} />
              )}
            </div>
          )}
        </div>
      </form>

      {/* ── IP Allowlist Card ── */}
      <form
        onSubmit={handleSaveIp}
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3"
        data-testid="ip-allowlist-form"
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100" data-testid="ip-allowlist-section">
          IP Allowlist
        </h3>
        <div>
          <input
            type="text"
            className={INPUT_CLASS}
            placeholder="192.168.1.0/24, 10.0.0.0/8"
            value={ipAllowlist}
            onChange={(e) => { setIpAllowlist(e.target.value); markIpDirty(); }}
            data-testid="ip-allowlist-input"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Comma-separated list of CIDR ranges. Only requests from these IP ranges will be allowed. Example: 10.0.0.0/8, 192.168.1.0/24
          </p>
        </div>

        {ipSaveError && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="ip-save-error">
            <AlertCircle size={14} />
            {ipSaveError}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!ipDirty || ipSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="save-ip-allowlist"
          >
            {ipSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </form>

      {/* ── Rate Limiting Card ── */}
      <form
        onSubmit={handleSaveRate}
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3"
        data-testid="rate-limiting-form"
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100" data-testid="rate-limiting-section">
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
              onChange={(e) => { setRateLimitRps(e.target.value); markRateDirty(); }}
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
              onChange={(e) => { setRateLimitConnections(e.target.value); markRateDirty(); }}
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
              onChange={(e) => { setRateLimitBurst(e.target.value); markRateDirty(); }}
              data-testid="rate-limit-burst-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Allows temporary bursts above the rate limit. A value of 5 with 10 rps allows bursts up to 50 requests.
            </p>
          </div>
        </div>

        {rateSaveError && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="rate-save-error">
            <AlertCircle size={14} />
            {rateSaveError}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!rateDirty || rateSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="save-rate-limiting"
          >
            {rateSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Protected Directories Section ──────────────────────────────────────────

function ProtectedDirsSection({ clientId, routeId }: {
  readonly clientId: string;
  readonly routeId: string;
}) {
  const { data: dirsData, isLoading } = useProtectedDirs(clientId, routeId);
  const createDir = useCreateProtectedDir(clientId, routeId);
  const deleteDir = useDeleteProtectedDir(clientId, routeId);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newRealm, setNewRealm] = useState('Restricted');
  const [pathError, setPathError] = useState<string | null>(null);
  const [expandedDirId, setExpandedDirId] = useState<string | null>(null);

  const dirs = dirsData?.data ?? [];

  const validatePath = (value: string): string | null => {
    if (!value.startsWith('/')) return 'Path must start with /';
    if (/\s/.test(value)) return 'Path must not contain spaces';
    return null;
  };

  const handleAddDir = async (e: FormEvent) => {
    e.preventDefault();
    const error = validatePath(newPath);
    if (error) {
      setPathError(error);
      return;
    }
    try {
      await createDir.mutateAsync({ path: newPath, realm: newRealm || 'Restricted' });
      setNewPath('');
      setNewRealm('Restricted');
      setPathError(null);
      setShowAddForm(false);
    } catch { /* error via createDir.error */ }
  };

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4"
      data-testid="protected-dirs-section"
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <FolderLock size={16} />
            Password-Protected Directories
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Protect specific URL paths with HTTP Basic Auth. Each directory has its own
            users and realm. Protection is enforced at the NGINX Ingress level — works
            with any backend application.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
          data-testid="add-protected-dir-button"
        >
          {showAddForm ? <X size={12} /> : <Plus size={12} />}
          {showAddForm ? 'Cancel' : 'Add Protected Directory'}
        </button>
      </div>

      {showAddForm && (
        <div
          className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 p-3 space-y-3"
          data-testid="add-protected-dir-form"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label htmlFor="new-dir-path" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Path
              </label>
              <input
                id="new-dir-path"
                type="text"
                placeholder="/admin/"
                value={newPath}
                onChange={(e) => { setNewPath(e.target.value); setPathError(null); }}
                className={clsx(INPUT_CLASS, 'font-mono', pathError && 'border-red-400 dark:border-red-500')}
                data-testid="protected-dir-path-input"
              />
              {pathError && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{pathError}</p>
              )}
            </div>
            <div>
              <label htmlFor="new-dir-realm" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Realm
              </label>
              <input
                id="new-dir-realm"
                type="text"
                placeholder="Restricted"
                value={newRealm}
                onChange={(e) => setNewRealm(e.target.value)}
                className={INPUT_CLASS}
                data-testid="protected-dir-realm-input"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleAddDir}
                disabled={!newPath || createDir.isPending}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="submit-protected-dir"
              >
                {createDir.isPending && <Loader2 size={14} className="animate-spin" />}
                Create
              </button>
            </div>
          </div>
          {createDir.error && (
            <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} />
              {createDir.error instanceof Error ? createDir.error.message : 'Failed to create directory'}
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 size={14} className="animate-spin text-blue-600" />
          <span className="text-xs text-gray-500 dark:text-gray-400">Loading directories...</span>
        </div>
      ) : dirs.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="protected-dirs-empty">
          No protected directories configured.
        </p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700 rounded-lg border border-gray-200 dark:border-gray-700">
          {dirs.map((dir) => (
            <div key={dir.id} data-testid={`protected-dir-row-${dir.id}`}>
              <button
                type="button"
                onClick={() => setExpandedDirId(expandedDirId === dir.id ? null : dir.id)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
                data-testid={`toggle-protected-dir-${dir.id}`}
              >
                <div className="flex items-center gap-3">
                  {expandedDirId === dir.id ? <ChevronDown size={12} className="text-gray-400" /> : <ChevronRight size={12} className="text-gray-400" />}
                  <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">{dir.path}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">&quot;{dir.realm}&quot;</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {dir.userCount} {dir.userCount === 1 ? 'user' : 'users'}
                  </span>
                  <span className={clsx(
                    'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                    dir.enabled
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
                  )}>
                    {dir.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); deleteDir.mutate(dir.id); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); deleteDir.mutate(dir.id); } }}
                    className="rounded-md p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                    data-testid={`delete-protected-dir-${dir.id}`}
                  >
                    <Trash2 size={14} />
                  </span>
                </div>
              </button>
              {expandedDirId === dir.id && (
                <ProtectedDirDetail clientId={clientId} routeId={routeId} dir={dir} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Protected Directory Detail (Expanded Inline) ───────────────────────────

function ProtectedDirDetail({ clientId, routeId, dir }: {
  readonly clientId: string;
  readonly routeId: string;
  readonly dir: ProtectedDir;
}) {
  const updateDir = useUpdateProtectedDir(clientId, routeId, dir.id);
  const { data: usersData, isLoading: usersLoading } = useDirUsers(clientId, routeId, dir.id);
  const createUser = useCreateDirUser(clientId, routeId, dir.id);
  const deleteUser = useDeleteDirUser(clientId, routeId, dir.id);
  const toggleUser = useToggleDirUser(clientId, routeId, dir.id);

  const [realm, setRealm] = useState(dir.realm);
  const [enabled, setEnabled] = useState(dir.enabled);
  const [dirDirty, setDirDirty] = useState(false);

  const [showAddUser, setShowAddUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const users = usersData?.data ?? [];

  const handleSaveDir = async () => {
    try {
      await updateDir.mutateAsync({ realm, enabled });
      setDirDirty(false);
    } catch { /* error via updateDir.error */ }
  };

  const handleAddUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newPassword) return;
    try {
      await createUser.mutateAsync({ username: newUsername, password: newPassword });
      setNewUsername('');
      setNewPassword('');
      setShowAddUser(false);
    } catch { /* error via createUser.error */ }
  };

  return (
    <div
      className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-3 space-y-4"
      data-testid={`protected-dir-detail-${dir.id}`}
    >
      {/* Directory settings */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Path</label>
          <input
            type="text"
            value={dir.path}
            disabled
            className={clsx(INPUT_CLASS, 'font-mono bg-gray-100 dark:bg-gray-800 cursor-not-allowed')}
            data-testid={`dir-path-readonly-${dir.id}`}
          />
        </div>
        <div>
          <label htmlFor={`dir-realm-${dir.id}`} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Realm
          </label>
          <input
            id={`dir-realm-${dir.id}`}
            type="text"
            value={realm}
            onChange={(e) => { setRealm(e.target.value); setDirDirty(true); }}
            className={INPUT_CLASS}
            data-testid={`dir-realm-input-${dir.id}`}
          />
        </div>
        <div className="flex items-end justify-between gap-2">
          <label className="flex items-center gap-2" data-testid={`dir-enabled-row-${dir.id}`}>
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => { setEnabled(!enabled); setDirDirty(true); }}
              className={clsx(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
              )}
              data-testid={`dir-enabled-toggle-${dir.id}`}
            >
              <span className={clsx(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform',
                enabled ? 'translate-x-4' : 'translate-x-0',
              )} />
            </button>
          </label>
          <button
            type="button"
            disabled={!dirDirty || updateDir.isPending}
            onClick={handleSaveDir}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid={`save-dir-settings-${dir.id}`}
          >
            {updateDir.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
        </div>
      </div>

      {updateDir.error && (
        <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle size={12} />
          {updateDir.error instanceof Error ? updateDir.error.message : 'Failed to update directory'}
        </div>
      )}

      {/* Users */}
      <div className="space-y-3" data-testid={`dir-users-section-${dir.id}`}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Users</span>
          <button
            type="button"
            onClick={() => setShowAddUser(!showAddUser)}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
            data-testid={`add-dir-user-button-${dir.id}`}
          >
            {showAddUser ? <X size={12} /> : <Plus size={12} />}
            {showAddUser ? 'Cancel' : 'Add User'}
          </button>
        </div>

        {showAddUser && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-2.5" data-testid={`add-dir-user-form-${dir.id}`}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input
                type="text"
                placeholder="Username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className={INPUT_CLASS}
                data-testid={`dir-user-username-input-${dir.id}`}
              />
              <input
                type="password"
                placeholder="Password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={INPUT_CLASS}
                data-testid={`dir-user-password-input-${dir.id}`}
              />
              <button
                type="button"
                onClick={handleAddUser}
                disabled={!newUsername || !newPassword || createUser.isPending}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid={`submit-dir-user-${dir.id}`}
              >
                {createUser.isPending && <Loader2 size={12} className="animate-spin" />}
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

        {usersLoading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 size={12} className="animate-spin text-blue-600" />
            <span className="text-xs text-gray-500 dark:text-gray-400">Loading users...</span>
          </div>
        ) : users.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`dir-users-empty-${dir.id}`}>
            No users configured for this directory.
          </p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700 rounded-lg border border-gray-200 dark:border-gray-700">
            {users.map((user) => (
              <div
                key={user.id}
                className="flex items-center justify-between px-3 py-1.5"
                data-testid={`dir-user-row-${user.id}`}
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
                    data-testid={`toggle-dir-user-${user.id}`}
                  >
                    {user.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteUser.mutate(user.id)}
                    className="rounded-md p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                    data-testid={`delete-dir-user-${user.id}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
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

type SortKey = 'createdAt' | 'sourceIp' | 'severity' | 'ruleId' | 'score' | 'request';
type SortDir = 'asc' | 'desc';

function getScore(msg: string): number | null {
  const m = msg.match(/Score:\s*(\d+)|Total Score:\s*(\d+)/);
  return m ? parseInt(m[1] || m[2], 10) : null;
}

function WafLogTable({ logs }: { readonly logs: readonly WafLogEntry[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sorted = [...logs].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortKey) {
      case 'createdAt': return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case 'sourceIp': return dir * (a.sourceIp ?? '').localeCompare(b.sourceIp ?? '');
      case 'severity': { const order: Record<string, number> = { critical: 0, warning: 1, info: 2 }; return dir * ((order[a.severity] ?? 3) - (order[b.severity] ?? 3)); }
      case 'ruleId': return dir * a.ruleId.localeCompare(b.ruleId);
      case 'score': return dir * ((getScore(a.message) ?? -1) - (getScore(b.message) ?? -1));
      case 'request': return dir * ((a.requestUri ?? '').localeCompare(b.requestUri ?? ''));
      default: return 0;
    }
  });

  const SortHeader = ({ label, k, className }: { label: string; k: SortKey; className?: string }) => (
    <th
      className={clsx('px-2 py-2 cursor-pointer select-none hover:text-gray-300 transition-colors', className)}
      onClick={() => toggleSort(k)}
    >
      {label} {sortKey === k ? (sortDir === 'asc' ? '▲' : '▼') : ''}
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-b-xl" data-testid="waf-log-entries">
      <table className="w-full font-mono text-[11px] bg-gray-950">
        <thead>
          <tr className="border-b border-gray-800 text-gray-500 text-left">
            <SortHeader label="Time" k="createdAt" className="w-[110px]" />
            <SortHeader label="IP" k="sourceIp" className="w-[80px]" />
            <SortHeader label="Level" k="severity" className="w-[62px]" />
            <SortHeader label="Rule" k="ruleId" />
            <SortHeader label="Score" k="score" className="w-[48px]" />
            <SortHeader label="Request" k="request" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((log, idx) => {
            const score = getScore(log.message);
            const isBlockRule = log.ruleId === '949110';
            const ruleName = isBlockRule ? 'Anomaly Threshold' : log.message;
            return (
              <tr
                key={log.id}
                className={clsx(idx % 2 === 0 ? 'bg-gray-950' : 'bg-gray-900')}
                data-testid={`waf-log-entry-${log.id}`}
              >
                <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{formatTs(log.createdAt)}</td>
                <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{log.sourceIp ?? '-'}</td>
                <td className="px-2 py-1.5">
                  <span className={clsx('inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', SEV_STYLE[log.severity] ?? SEV_STYLE.info)}>
                    {log.severity}
                  </span>
                </td>
                <td className="px-2 py-1.5" title={log.message}>
                  <span className="text-blue-400 font-bold">{log.ruleId}</span>
                  <span className="text-gray-600 mx-1">-</span>
                  <span className="text-gray-300">{ruleName}</span>
                </td>
                <td className="px-2 py-1.5 text-amber-400 font-bold whitespace-nowrap">{score ?? ''}</td>
                <td className="px-2 py-1.5 text-green-400 truncate max-w-[400px]" title={`${log.requestMethod ?? 'GET'} ${log.requestUri ?? '/'}`}>
                  {log.requestMethod ?? 'GET'} {log.requestUri ?? '/'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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

  /* ── Custom Error Pages state ── */
  const [customErrorCodes, setCustomErrorCodes] = useState(route.customErrorCodes ?? '');
  const [customErrorPath, setCustomErrorPath] = useState(route.customErrorPath ?? '');
  const [errorDirty, setErrorDirty] = useState(false);
  const [errorSaving, setErrorSaving] = useState(false);
  const [errorSaveError, setErrorSaveError] = useState<string | null>(null);
  const markErrorDirty = () => setErrorDirty(true);

  /* ── Response Headers state ── */
  const [headers, setHeaders] = useState<readonly { readonly name: string; readonly value: string }[]>(
    route.additionalHeaders ? Object.entries(route.additionalHeaders).map(([name, value]) => ({ name, value })) : [],
  );
  const [headersDirty, setHeadersDirty] = useState(false);
  const [headersSaving, setHeadersSaving] = useState(false);
  const [headersSaveError, setHeadersSaveError] = useState<string | null>(null);
  const markHeadersDirty = () => setHeadersDirty(true);

  const handleAddHeader = () => {
    if (headers.length >= 50) return;
    setHeaders([...headers, { name: '', value: '' }]);
    markHeadersDirty();
  };

  const handleUpdateHeader = (index: number, field: 'name' | 'value', val: string) => {
    const updated = headers.map((h, i) => (i === index ? { ...h, [field]: val } : h));
    setHeaders(updated);
    markHeadersDirty();
  };

  const handleRemoveHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
    markHeadersDirty();
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

  const handleSaveErrors = async (e: FormEvent) => {
    e.preventDefault();
    setErrorSaveError(null);
    setErrorSaving(true);
    try {
      await updateAdvanced.mutateAsync({
        custom_error_codes: customErrorCodes || null,
        custom_error_path: customErrorPath || null,
      });
      setErrorDirty(false);
    } catch (err) {
      setErrorSaveError(err instanceof Error ? err.message : 'Failed to save error page settings');
    } finally {
      setErrorSaving(false);
    }
  };

  const handleSaveHeaders = async (e: FormEvent) => {
    e.preventDefault();
    if (headerError) return;
    setHeadersSaveError(null);
    setHeadersSaving(true);
    const filteredHeaders = headers.filter((h) => h.name.trim() !== '');
    try {
      const headersObj: Record<string, string> = {};
      for (const h of filteredHeaders) headersObj[h.name] = h.value;
      await updateAdvanced.mutateAsync({
        additional_headers: Object.keys(headersObj).length > 0 ? headersObj : null,
      });
      setHeadersDirty(false);
    } catch (err) {
      setHeadersSaveError(err instanceof Error ? err.message : 'Failed to save response headers');
    } finally {
      setHeadersSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Configure response headers and error handling. Response headers are added to every response from this route.
      </p>

      {/* ── Custom Error Pages Card ── */}
      <form
        onSubmit={handleSaveErrors}
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3"
        data-testid="error-pages-form"
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100" data-testid="custom-error-pages-section">
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
              onChange={(e) => { setCustomErrorCodes(e.target.value); markErrorDirty(); }}
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
              onChange={(e) => { setCustomErrorPath(e.target.value); markErrorDirty(); }}
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

        {errorSaveError && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="error-pages-save-error">
            <AlertCircle size={14} />
            {errorSaveError}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!errorDirty || errorSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="save-error-pages"
          >
            {errorSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </form>

      {/* ── Response Headers Card ── */}
      <form
        onSubmit={handleSaveHeaders}
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3"
        data-testid="response-headers-form"
      >
        <div className="flex items-center justify-between" data-testid="proxy-headers-section">
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

        {headersSaveError && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="headers-save-error">
            <AlertCircle size={14} />
            {headersSaveError}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!headersDirty || !!headerError || headersSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="save-response-headers"
          >
            {headersSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
