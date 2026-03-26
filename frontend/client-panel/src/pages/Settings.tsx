import { Settings as SettingsIcon, CreditCard, Bell } from 'lucide-react';

export default function Settings() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900" data-testid="settings-heading">
          Account Settings
        </h1>
      </div>

      {/* Subscription Settings Section */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="subscription-section">
        <div className="mb-4 flex items-center gap-2">
          <CreditCard size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Subscription</h2>
        </div>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-gray-500">Current Plan</dt>
            <dd className="mt-1 text-sm text-gray-900">Standard</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Status</dt>
            <dd className="mt-1 text-sm text-gray-900">
              <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                Active
              </span>
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-gray-400">
          Contact support to change your subscription plan.
        </p>
      </div>

      {/* Notification Preferences Section */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="notification-prefs-section">
        <div className="mb-4 flex items-center gap-2">
          <Bell size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Notification Preferences</h2>
        </div>
        <div className="space-y-3">
          <label className="flex items-center gap-3">
            <input type="checkbox" defaultChecked className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500" />
            <span className="text-sm text-gray-700">Email notifications for domain changes</span>
          </label>
          <label className="flex items-center gap-3">
            <input type="checkbox" defaultChecked className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500" />
            <span className="text-sm text-gray-700">Email notifications for backup completions</span>
          </label>
          <label className="flex items-center gap-3">
            <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500" />
            <span className="text-sm text-gray-700">Weekly usage summary</span>
          </label>
        </div>
      </div>
    </div>
  );
}
