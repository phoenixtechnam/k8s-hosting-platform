import { useState, type FormEvent } from 'react';
import { User, KeyRound, Save, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useChangePassword } from '@/hooks/use-password';
import { useUpdateProfile } from '@/hooks/use-profile';
import { ApiError } from '@/lib/api-client';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function UserSettings() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <User size={28} className="text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900" data-testid="user-settings-heading">
          User Settings
        </h1>
      </div>

      <ProfileForm
        initialName={user?.fullName ?? ''}
        initialEmail={user?.email ?? ''}
      />

      <PasswordForm />
    </div>
  );
}

function ProfileForm({
  initialName,
  initialEmail,
}: {
  readonly initialName: string;
  readonly initialEmail: string;
}) {
  const updateProfile = useUpdateProfile();
  const [fullName, setFullName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSuccessMessage('');
    setErrorMessage('');

    try {
      const result = await updateProfile.mutateAsync({ full_name: fullName, email });
      const storedUser = localStorage.getItem('auth_user');
      if (storedUser) {
        try {
          const parsed = JSON.parse(storedUser);
          const updated = { ...parsed, fullName: result.data.fullName, email: result.data.email };
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
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="profile-section">
      <div className="mb-4 flex items-center gap-2">
        <User size={20} className="text-gray-600" />
        <h2 className="text-lg font-semibold text-gray-900">Profile Information</h2>
      </div>
      <form className="max-w-md space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="fullName" className="block text-sm font-medium text-gray-700">
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
          <label htmlFor="email" className="block text-sm font-medium text-gray-700">
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
        {successMessage && (
          <p className="text-sm text-green-600" data-testid="profile-success">{successMessage}</p>
        )}
        {errorMessage && (
          <p className="text-sm text-red-600" data-testid="profile-error">{errorMessage}</p>
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
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="password-section">
      <div className="mb-4 flex items-center gap-2">
        <KeyRound size={20} className="text-gray-600" />
        <h2 className="text-lg font-semibold text-gray-900">Change Password</h2>
      </div>
      <form className="max-w-md space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700">
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
          <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700">
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
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
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
          <p className="text-sm text-green-600" data-testid="password-success">{successMessage}</p>
        )}
        {errorMessage && (
          <p className="text-sm text-red-600" data-testid="password-error">{errorMessage}</p>
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
