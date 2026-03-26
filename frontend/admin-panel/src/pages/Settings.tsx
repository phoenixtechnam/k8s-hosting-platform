import { Settings as SettingsIcon, Server } from 'lucide-react';

const platformConfig = [
  { label: 'Platform Name', value: 'K8s Hosting Platform' },
  { label: 'Version', value: '0.1.0' },
  { label: 'Environment', value: 'Production' },
  { label: 'JWT Expiry', value: '24 hours' },
  { label: 'Rate Limit', value: '100 req/min' },
] as const;

export default function Settings() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900" data-testid="settings-heading">
          Platform Settings
        </h1>
      </div>

      {/* Platform Configuration Section */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="platform-config-section">
        <div className="mb-4 flex items-center gap-2">
          <Server size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Platform Configuration</h2>
        </div>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {platformConfig.map(({ label, value }) => (
            <div key={label}>
              <dt className="text-sm font-medium text-gray-500">{label}</dt>
              <dd className="mt-1 text-sm text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-gray-400">
          Configuration is managed via environment variables.
        </p>
      </div>
    </div>
  );
}
