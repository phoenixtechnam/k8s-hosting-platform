import { Settings as SettingsIcon, CreditCard, Bell } from 'lucide-react';

export default function Settings() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="settings-heading">
          Account Settings
        </h1>
      </div>

      {/* Subscription Settings Section */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="subscription-section">
        <div className="mb-4 flex items-center gap-2">
          <CreditCard size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Subscription</h2>
        </div>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Current Plan</dt>
            <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">—</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Status</dt>
            <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
              <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-700 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
                —
              </span>
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
          Contact support to change your subscription plan. Plan and status will appear here once a client-facing subscription endpoint is available.
        </p>
      </div>

      {/*
        Notification Preferences Section
        Round-4 Phase A: the previous version rendered three interactive
        checkboxes with `defaultChecked` but no save mechanism, making
        users think they were toggling preferences when nothing was
        persisted. Per the gap scan MEDIUM-6, the section is now a
        read-only "coming soon" panel until a real backend endpoint
        exists. All notifications currently ship to the notifications
        dropdown — email delivery is enabled globally via
        OIDC_ENCRYPTION_KEY + the SMTP relay config on the platform.
      */}
      <div
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
        data-testid="notification-prefs-section"
      >
        <div className="mb-4 flex items-center gap-2">
          <Bell size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Notification Preferences
          </h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          All notifications currently land in the bell menu in the top right of the
          client panel. Per-category email delivery opt-outs will be added in a
          future release.
        </p>
      </div>
    </div>
  );
}
