import { Settings as SettingsIcon, User, Server, Lock } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const platformConfig = [
  { label: 'Platform Name', value: 'K8s Hosting Platform' },
  { label: 'Version', value: '0.1.0' },
  { label: 'Environment', value: 'Production' },
  { label: 'JWT Expiry', value: '24 hours' },
  { label: 'Rate Limit', value: '100 req/min' },
] as const;

export default function Settings() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900" data-testid="settings-heading">
          Settings
        </h1>
      </div>

      {/* Profile Section */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="profile-section">
        <div className="mb-4 flex items-center gap-2">
          <User size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Profile</h2>
        </div>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm font-medium text-gray-500">Full Name</dt>
            <dd className="mt-1 text-sm text-gray-900" data-testid="profile-name">
              {user?.fullName ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Email</dt>
            <dd className="mt-1 text-sm text-gray-900" data-testid="profile-email">
              {user?.email ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Role</dt>
            <dd className="mt-1 text-sm capitalize text-gray-900" data-testid="profile-role">
              {user?.role ?? '—'}
            </dd>
          </div>
        </dl>
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

      {/* Change Password Section */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="change-password-section">
        <div className="mb-4 flex items-center gap-2">
          <Lock size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Change Password</h2>
        </div>
        <form className="max-w-md space-y-4" onSubmit={(e) => e.preventDefault()}>
          <div>
            <label htmlFor="current-password" className="block text-sm font-medium text-gray-700">
              Current Password
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              className={INPUT_CLASS}
              placeholder="Enter current password"
              data-testid="current-password-input"
              disabled
            />
          </div>
          <div>
            <label htmlFor="new-password" className="block text-sm font-medium text-gray-700">
              New Password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              className={INPUT_CLASS}
              placeholder="Enter new password"
              data-testid="new-password-input"
              disabled
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700">
              Confirm New Password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              className={INPUT_CLASS}
              placeholder="Confirm new password"
              data-testid="confirm-password-input"
              disabled
            />
          </div>
          <div>
            <button
              type="submit"
              disabled
              className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white opacity-50"
              data-testid="update-password-button"
            >
              Update Password
            </button>
            <p className="mt-2 text-xs text-gray-400">Coming soon</p>
          </div>
        </form>
      </div>
    </div>
  );
}
