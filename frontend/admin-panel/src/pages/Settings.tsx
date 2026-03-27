import { Link } from 'react-router-dom';
import { Settings as SettingsIcon, Server, Shield, Globe, CreditCard, ChevronRight, Loader2, HardDrive, Users, Heart, Download } from 'lucide-react';
import { usePlatformStatus } from '@/hooks/use-dashboard';

export default function Settings() {
  const { data: statusRes, isLoading } = usePlatformStatus();
  const status = statusRes?.data;

  const platformConfig = [
    { label: 'Platform Name', value: 'K8s Hosting Platform' },
    { label: 'Version', value: status?.version ?? '—' },
    { label: 'Status', value: status?.status ?? '—' },
    { label: 'Last Check', value: status?.timestamp ? new Date(status.timestamp).toLocaleString() : '—' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900" data-testid="settings-heading">Platform Settings</h1>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="platform-config-section">
        <div className="mb-4 flex items-center gap-2">
          <Server size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Platform Status</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4"><Loader2 size={16} className="animate-spin text-gray-400" /><span className="text-sm text-gray-500">Loading...</span></div>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {platformConfig.map(({ label, value }) => (
              <div key={label}><dt className="text-sm font-medium text-gray-500">{label}</dt><dd className="mt-1 text-sm text-gray-900">{value}</dd></div>
            ))}
          </dl>
        )}
      </div>

      <Link to="/settings/oidc" className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-testid="oidc-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Shield size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900">OIDC / SSO Configuration</h2><p className="text-sm text-gray-500">Configure external identity provider for single sign-on</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/dns" className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-testid="dns-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50 text-green-600"><Globe size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900">DNS Servers</h2><p className="text-sm text-gray-500">Manage external DNS servers for domain provisioning</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/plans" className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-testid="plan-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-600"><CreditCard size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900">Hosting Plans</h2><p className="text-sm text-gray-500">Manage hosting plans and resource limits</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/backups" className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-testid="backup-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 text-purple-600"><HardDrive size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900">Backup Configuration</h2><p className="text-sm text-gray-500">Configure SSH and S3 backup storage targets</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/users" className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-testid="admin-users-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-50 text-cyan-600"><Users size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900">Admin Users</h2><p className="text-sm text-gray-500">Manage admin, support, billing, and read-only users</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/monitoring/health" className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-testid="health-settings-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-600"><Heart size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900">System Health</h2><p className="text-sm text-gray-500">Database, DNS, and OIDC provider health checks</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>

      <Link to="/settings/export-import" className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-testid="export-import-link">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-teal-600"><Download size={20} /></div>
          <div><h2 className="text-base font-semibold text-gray-900">Export / Import</h2><p className="text-sm text-gray-500">Export or import platform data as JSON</p></div>
        </div>
        <ChevronRight size={20} className="text-gray-400" />
      </Link>
    </div>
  );
}
