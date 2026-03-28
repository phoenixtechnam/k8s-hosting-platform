import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings as SettingsIcon, Server, Shield, Globe, CreditCard, ChevronRight, Loader2, HardDrive, Users, Heart, Download, Mail, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { usePlatformStatus } from '@/hooks/use-dashboard';
import { usePlatformVersion, useUpdateSettings, useTriggerUpdate } from '@/hooks/use-platform-updates';

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
              <div key={label}><dt className="text-sm font-medium text-gray-500">{label}</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{value}</dd></div>
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
              <div><dt className="text-sm font-medium text-gray-500">Current Version</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="current-version">{version.currentVersion}</dd></div>
              <div><dt className="text-sm font-medium text-gray-500">Latest Version</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="latest-version">{version.latestVersion ?? '—'}</dd></div>
              <div><dt className="text-sm font-medium text-gray-500">Environment</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="environment">{version.environment}</dd></div>
              <div><dt className="text-sm font-medium text-gray-500">Last Checked</dt><dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{version.lastCheckedAt ? new Date(version.lastCheckedAt).toLocaleString() : '—'}</dd></div>
            </dl>

            <div className="flex flex-wrap items-center gap-4 border-t border-gray-100 dark:border-gray-700 pt-4">
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

              <button
                type="button"
                data-testid="check-updates-btn"
                onClick={() => refetchVersion()}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
              >
                <RefreshCw size={14} />
                Check for Updates
              </button>

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
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">Unable to fetch version information.</p>
        )}
      </div>

      <Link to="/settings/oidc" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="oidc-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400"><Shield size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">OIDC / SSO Configuration</h2><p className="text-sm text-gray-500 dark:text-gray-400">Configure external identity provider for single sign-on</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/dns" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="dns-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400"><Globe size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">DNS Servers</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage external DNS servers for domain provisioning</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/plans" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="plan-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"><CreditCard size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Hosting Plans</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage hosting plans and resource limits</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/email" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="email-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"><Mail size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Email System</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage email domains, mailboxes, SMTP relays, and spam settings</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/backups" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="backup-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400"><HardDrive size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Backup Configuration</h2><p className="text-sm text-gray-500 dark:text-gray-400">Configure SSH and S3 backup storage targets</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/users" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="admin-users-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-50 dark:bg-cyan-900/20 text-cyan-600 dark:text-cyan-400"><Users size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Admin Users</h2><p className="text-sm text-gray-500 dark:text-gray-400">Manage admin, support, billing, and read-only users</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/monitoring/health" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="health-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400"><Heart size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">System Health</h2><p className="text-sm text-gray-500 dark:text-gray-400">Database, DNS, and OIDC provider health checks</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/export-import" className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20/30 transition-colors" data-testid="export-import-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400"><Download size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Export / Import</h2><p className="text-sm text-gray-500 dark:text-gray-400">Export or import platform data as JSON</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>
    </div>
  );
}
