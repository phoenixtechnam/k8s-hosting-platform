import { useState, useEffect, type FormEvent } from 'react';
import { User, KeyRound, Save, Loader2, Clock, Fingerprint, Trash2, Plus, AlertCircle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useChangePassword } from '@/hooks/use-password';
import { useUpdateProfile } from '@/hooks/use-profile';
import { usePasskey } from '@/hooks/use-passkey';
import { ApiError } from '@/lib/api-client';
import type { PasskeySummary, PasskeyMode } from '@k8s-hosting/api-contracts';
import TimezoneSelect from '@/components/TimezoneSelect';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function UserSettings() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <User size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="user-settings-heading">
          User Settings
        </h1>
      </div>

      <ProfileForm
        initialName={user?.fullName ?? ''}
        initialEmail={user?.email ?? ''}
        initialTimezone={(user as unknown as { timezone?: string | null })?.timezone ?? ''}
      />

      <PasswordForm />

      <PasskeySection />
    </div>
  );
}

function PasskeySection() {
  const passkey = usePasskey();
  const [list, setList] = useState<readonly PasskeySummary[]>([]);
  const [mode, setMode] = useState<PasskeyMode>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingNickname, setPendingNickname] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await passkey.list();
      setList(data.passkeys);
      setMode(data.mode);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load passkeys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (!pendingNickname.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await passkey.register(pendingNickname.trim());
      setPendingNickname('');
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message
        : err instanceof Error
          ? (err.name === 'NotAllowedError' || err.name === 'AbortError'
            ? 'Registration cancelled'
            : err.message)
          : 'Registration failed';
      setError(msg);
    } finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this passkey? You won\'t be able to use it for sign-in anymore.')) return;
    setBusy(true);
    setError(null);
    try {
      await passkey.remove(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete passkey');
    } finally { setBusy(false); }
  };

  const handleModeChange = async (next: PasskeyMode) => {
    setBusy(true);
    setError(null);
    try {
      await passkey.setMode(next);
      setMode(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change mode');
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <Fingerprint size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="passkey-section-heading">
          Passkeys
        </h2>
      </div>

      {!passkey.supported && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-100" data-testid="passkey-unsupported">
          <AlertCircle size={14} className="mr-1 inline" />
          This browser doesn't support passkeys. Use a recent Chrome, Safari, Firefox, or Edge.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300" data-testid="passkey-error">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (
        <>
          <div className="mb-6">
            <h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Sign-in mode</h3>
            <div className="flex flex-col gap-2 sm:flex-row" data-testid="passkey-mode-group">
              <ModeOption
                label="Password only"
                description="Use email and password to sign in. (Default)"
                checked={mode === null}
                disabled={busy}
                onSelect={() => handleModeChange(null)}
                testid="passkey-mode-none"
              />
              <ModeOption
                label="Passkey alternative"
                description="Use either password or passkey."
                checked={mode === 'alternative'}
                disabled={busy || list.length === 0}
                onSelect={() => handleModeChange('alternative')}
                testid="passkey-mode-alternative"
              />
              <ModeOption
                label="Password + passkey (2FA)"
                description="Require both factors at every sign-in."
                checked={mode === 'second_factor'}
                disabled={busy || list.length === 0}
                onSelect={() => handleModeChange('second_factor')}
                testid="passkey-mode-2fa"
              />
            </div>
            {list.length === 0 && mode === null && (
              <p className="mt-2 text-xs text-gray-500">Register a passkey below to enable alternative or 2FA modes.</p>
            )}
          </div>

          {list.length > 0 && (
            <div className="mb-6">
              <h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Registered passkeys</h3>
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:border-gray-700 dark:divide-gray-700" data-testid="passkey-list">
                {list.map((pk) => (
                  <li key={pk.id} className="flex items-center justify-between gap-4 px-4 py-3" data-testid={`passkey-row-${pk.id}`}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{pk.nickname}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {pk.backedUp ? 'Synced (multi-device)' : 'Single-device'} ·
                        Created {new Date(pk.createdAt).toLocaleDateString()}
                        {pk.lastUsedAt ? ` · Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(pk.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                      data-testid={`passkey-delete-${pk.id}`}
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {passkey.supported && (
            <form onSubmit={handleRegister} className="flex flex-col gap-2 sm:flex-row sm:items-end" data-testid="passkey-register-form">
              <div className="flex-1">
                <label htmlFor="passkey-nickname" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Nickname for the new passkey</label>
                <input
                  id="passkey-nickname"
                  type="text"
                  value={pendingNickname}
                  onChange={(e) => setPendingNickname(e.target.value)}
                  required
                  maxLength={100}
                  placeholder="iPhone, YubiKey, work laptop…"
                  className={INPUT_CLASS}
                  data-testid="passkey-nickname-input"
                />
              </div>
              <button
                type="submit"
                disabled={busy || !pendingNickname.trim()}
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="passkey-register-button"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Add passkey
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function ModeOption({
  label, description, checked, disabled, onSelect, testid,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      data-testid={testid}
      className={`flex-1 rounded-lg border p-3 text-left text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${
        checked
          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
          : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className={`h-3 w-3 rounded-full border ${checked ? 'border-brand-500 bg-brand-500' : 'border-gray-300 dark:border-gray-500'}`} />
        <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{description}</p>
    </button>
  );
}

function ProfileForm({
  initialName,
  initialEmail,
  initialTimezone,
}: {
  readonly initialName: string;
  readonly initialEmail: string;
  readonly initialTimezone: string;
}) {
  const updateProfile = useUpdateProfile();
  const [fullName, setFullName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSuccessMessage('');
    setErrorMessage('');

    try {
      const result = await updateProfile.mutateAsync({
        full_name: fullName,
        email,
        timezone: timezone === '' ? null : timezone,
      });
      // Update local storage with new user data
      const storedUser = localStorage.getItem('auth_user');
      if (storedUser) {
        try {
          const parsed = JSON.parse(storedUser);
          const updated = {
            ...parsed,
            fullName: result.data.fullName,
            email: result.data.email,
            timezone: result.data.timezone ?? null,
          };
          localStorage.setItem('auth_user', JSON.stringify(updated));
        } catch {
          // ignore parse errors
        }
      }
      setSuccessMessage('Profile updated successfully');
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : 'Failed to update profile. Please try again.',
      );
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="profile-section">
      <div className="mb-4 flex items-center gap-2">
        <User size={20} className="text-gray-600 dark:text-gray-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Profile Information</h2>
      </div>
      <form className="max-w-md space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="fullName" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Full Name
          </label>
          <input
            id="fullName"
            type="text"
            className={INPUT_CLASS}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            data-testid="profile-full-name"
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Email
          </label>
          <input
            id="email"
            type="email"
            className={INPUT_CLASS}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="profile-email"
          />
        </div>
        <div>
          <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            <Clock size={14} className="inline -mt-0.5 mr-1" />
            Timezone
          </label>
          <TimezoneSelect value={timezone} onChange={setTimezone} placeholder="Use system default" className="mt-1" />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Used when displaying dates and times in the UI. Leave empty to inherit the system default.
          </p>
        </div>
        {successMessage && (
          <p className="text-sm text-green-600 dark:text-green-400" data-testid="profile-success">{successMessage}</p>
        )}
        {errorMessage && (
          <p className="text-sm text-red-600 dark:text-red-400" data-testid="profile-error">{errorMessage}</p>
        )}
        <button
          type="submit"
          disabled={updateProfile.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="profile-save-button"
        >
          {updateProfile.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Changes
        </button>
      </form>
    </div>
  );
}

function PasswordForm() {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSuccessMessage('');
    setErrorMessage('');

    if (newPassword !== confirmPassword) {
      setErrorMessage('New passwords do not match');
      return;
    }

    try {
      await changePassword.mutateAsync({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setSuccessMessage('Password updated successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : 'Failed to update password. Please try again.',
      );
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="password-section">
      <div className="mb-4 flex items-center gap-2">
        <KeyRound size={20} className="text-gray-600 dark:text-gray-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Change Password</h2>
      </div>
      <form className="max-w-md space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Current Password
          </label>
          <input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            className={INPUT_CLASS}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            data-testid="settings-current-password"
          />
        </div>
        <div>
          <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            New Password
          </label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            className={INPUT_CLASS}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            data-testid="settings-new-password"
          />
        </div>
        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Confirm New Password
          </label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            className={INPUT_CLASS}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            data-testid="settings-confirm-password"
          />
        </div>
        {successMessage && (
          <p className="text-sm text-green-600 dark:text-green-400" data-testid="password-success">{successMessage}</p>
        )}
        {errorMessage && (
          <p className="text-sm text-red-600 dark:text-red-400" data-testid="password-error">{errorMessage}</p>
        )}
        <button
          type="submit"
          disabled={changePassword.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="settings-update-password-button"
        >
          {changePassword.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
          Update Password
        </button>
      </form>
    </div>
  );
}
