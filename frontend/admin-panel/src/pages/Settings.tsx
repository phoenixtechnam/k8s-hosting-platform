import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings as SettingsIcon, Server, Shield, Globe, CreditCard, ChevronRight, Loader2, HardDrive, Users, Heart, Download, Mail, RefreshCw, CheckCircle, AlertCircle, Cpu, Container } from 'lucide-react';
import { usePlatformStatus } from '@/hooks/use-dashboard';
import { usePlatformVersion, useUpdateSettings, useTriggerUpdate } from '@/hooks/use-platform-updates';
import { usePlatformImages } from '@/hooks/use-platform-images';

export default function Settings() {
  const { data: statusRes, isLoading } = usePlatformStatus();
  const status = statusRes?.data;

  const { data: versionRes, isLoading: versionLoading, refetch: refetchVersion } = usePlatformVersion();
  const version = versionRes?.data;
  const updateSettings = useUpdateSettings();
  const triggerUpdate = useTriggerUpdate();
  const [autoUpdateLocal, setAutoUpdateLocal] = useState<boolean | null>(null);

  const platformConfig = [
    { label: 'Platform Name', value: 'K8s Hosting Platform' },
    { label: 'Version', value: status?.version ?? '—' },
    { label: 'Status', value: status?.status ?? '—' },
    { label: 'Last Check', value: status?.timestamp ? new Date(status.timestamp).toLocaleString() : '—' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="settings-heading">Platform Settings</h1>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="platform-config-section">
        <div className="mb-4 flex items-center gap-2">
          <Server size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Platform Status</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4"><Loader2 size={16} className="animate-spin text-gray-400" /><span className="text-sm text-gray-500 dark:text-gray-400">Loading...</span></div>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {platformConfig.map(({ label, value }) => (
              <div key={label}><dt className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{value}</dd></div>
            ))}
          </dl>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="platform-updates-section">
        <div className="mb-4 flex items-center gap-2">
          <Download size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Platform Updates</h2>
        </div>
        {versionLoading ? (
          <div className="flex items-center gap-2 py-4"><Loader2 size={16} className="animate-spin text-gray-400" /><span className="text-sm text-gray-500 dark:text-gray-400">Loading...</span></div>
        ) : version ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Current Version</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="current-version">{version.currentVersion}</dd></div>
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Latest Version</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="latest-version">
                  {version.latestVersion ?? (
                    version.latestSource === 'none'
                      ? <span className="text-gray-500 dark:text-gray-400">no releases published</span>
                      : version.latestSource === 'unreachable'
                        ? <span className="text-amber-700 dark:text-amber-300">GitHub unreachable</span>
                        : '—'
                  )}
                </dd>
              </div>
              <div><dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Environment</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="environment">{version.environment}</dd></div>
              <div><dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Last Checked</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{version.lastCheckedAt ? new Date(version.lastCheckedAt).toLocaleString() : '—'}</dd></div>
            </dl>

            <div className="flex flex-wrap items-center gap-4 border-t border-gray-100 dark:border-gray-700 pt-4">
              {version.imageUpdateStrategy === 'auto' ? (
                // Staging/dev: Flux Image Automation (or our deploy-rev rollout)
                // handles rollouts on every main-branch push. The manual
                // Auto-Update toggle + Update Now button don't apply here —
                // they'd mislead the operator into thinking they can gate
                // rollouts from this UI.
                <span
                  className="inline-flex items-center gap-1.5 rounded-md bg-green-50 dark:bg-green-900/20 px-3 py-1.5 text-sm font-medium text-green-700 dark:text-green-300"
                  data-testid="auto-managed-badge"
                >
                  <CheckCircle size={14} />
                  Auto-managed by Flux — pods roll on every main push
                </span>
              ) : (
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    data-testid="auto-update-toggle"
                    checked={autoUpdateLocal ?? version.autoUpdate}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      setAutoUpdateLocal(newValue);
                      updateSettings.mutate(newValue);
                    }}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Automatic Updates
                </label>
              )}

              <button
                type="button"
                data-testid="check-updates-btn"
                onClick={() => refetchVersion()}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
              >
                <RefreshCw size={14} />
                {version.imageUpdateStrategy === 'auto' ? 'Refresh' : 'Check for Updates'}
              </button>

              {version.imageUpdateStrategy === 'manual' && (
                <>
                  <button
                    type="button"
                    data-testid="settings-update-now-btn"
                    disabled={!version.updateAvailable || triggerUpdate.isPending}
                    onClick={() => triggerUpdate.mutate()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {triggerUpdate.isPending ? (
                      <><Loader2 size={14} className="animate-spin" />Updating...</>
                    ) : (
                      'Update Now'
                    )}
                  </button>

                  {triggerUpdate.isSuccess && (
                    <span className="flex items-center gap-1 text-sm text-green-700 dark:text-green-300"><CheckCircle size={14} />Update started</span>
                  )}
                  {triggerUpdate.isError && (
                    <span className="flex items-center gap-1 text-sm text-red-700 dark:text-red-300"><AlertCircle size={14} />Update failed</span>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">Unable to fetch version information.</p>
        )}
      </div>

      <ImageInventoryCard />

      <Link to="/settings/system" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="system-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-900/40 text-gray-600 dark:text-gray-400"><SettingsIcon size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">System Settings</h2><p className="text-sm text-gray-500 dark:text-gray-400">Platform identity, networking, mail server, and rate limits</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/oidc" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="oidc-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400"><Shield size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">OIDC / SSO Configuration</h2><p className="text-sm text-gray-500 dark:text-gray-400">Configure external identity provider for single sign-on</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/dns" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="dns-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400"><Globe size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">DNS Servers</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage external DNS servers for domain provisioning</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/plans" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="plan-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"><CreditCard size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Hosting Plans</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage hosting plans and resource limits</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/email" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="email-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"><Mail size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Email System</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage email domains, mailboxes, SMTP relays, and spam settings</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/ai" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="ai-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400"><Cpu size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">AI Settings</h2><p className="text-sm text-gray-500 dark:text-gray-400">Configure LLM providers, models, and AI editing capabilities</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/tls" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="tls-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400"><Shield size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Ingress & TLS Settings</h2><p className="text-sm text-gray-500 dark:text-gray-400">Configure ingress routing, cert-manager, ClusterIssuer, and node IPs</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/backups" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="backup-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400"><HardDrive size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Backup Configuration</h2><p className="text-sm text-gray-500 dark:text-gray-400">Configure SSH and S3 backup storage targets</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/users" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="admin-users-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-50 dark:bg-cyan-900/20 text-cyan-600 dark:text-cyan-400"><Users size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Admin Users</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage admin, support, billing, and read-only users</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/monitoring/health" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="health-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400"><Heart size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">System Health</h2><p className="text-sm text-gray-500 dark:text-gray-400">Database, DNS, and OIDC provider health checks</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/export-import" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-gray-700 transition-colors" data-testid="export-import-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400"><Download size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Export / Import</h2><p className="text-sm text-gray-500 dark:text-gray-400">Export or import platform data as JSON</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>
    </div>
  );
}

/**
 * Shows the container images + resolved tags currently running on the
 * cluster for platform-owned components. Sourced from the k8s API at
 * request time — "current version" reflects reality rather than what
 * the platform-version ConfigMap claims.
 */
function ImageInventoryCard() {
  const { data, isLoading, isError } = usePlatformImages();
  const images = data?.data ?? [];

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="platform-images-section">
      <div className="mb-4 flex items-center gap-2">
        <Container size={20} className="text-gray-600 dark:text-gray-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Deployed Images</h2>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-4">
          <Loader2 size={16} className="animate-spin text-gray-400" />
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading image inventory…</span>
        </div>
      ) : isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load image inventory.</p>
      ) : images.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No images enumerated. The backend may lack cluster read permissions.</p>
      ) : (
        <div className="overflow-x-auto -mx-2">
          <table className="min-w-full text-sm" data-testid="platform-images-table">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                <th className="px-2 py-2 font-medium">Component</th>
                <th className="px-2 py-2 font-medium">Namespace</th>
                <th className="px-2 py-2 font-medium">Image</th>
                <th className="px-2 py-2 font-medium">Tag</th>
                <th className="px-2 py-2 font-medium text-right">Ready</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {images.map((row) => (
                <tr key={`${row.namespace}/${row.component}/${row.image}`}>
                  <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-medium">{row.component}</td>
                  <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs">{row.namespace}</td>
                  <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs break-all">{row.image}</td>
                  <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-mono text-xs">{row.tag}</td>
                  <td className="px-2 py-2 text-right">
                    <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                      row.healthy
                        ? 'text-green-700 dark:text-green-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}>
                      {row.running}/{row.desired}
                      {row.healthy ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
