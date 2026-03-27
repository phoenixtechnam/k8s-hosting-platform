import { useState, useEffect, useRef, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Menu, Search, UserCircle, KeyRound, LogOut, Settings } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useChangePassword } from '@/hooks/use-password';
import { ApiError } from '@/lib/api-client';
import NotificationDropdown from '@/components/NotificationDropdown';
import DarkModeToggle from '@/components/DarkModeToggle';

interface HeaderProps {
  readonly onMenuClick: () => void;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function Header({ onMenuClick }: HeaderProps) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setShowPassword(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const handleToggle = () => {
    setMenuOpen((prev) => !prev);
    if (menuOpen) {
      setShowPassword(false);
    }
  };

  const handleSignOut = () => {
    setMenuOpen(false);
    logout();
  };

  return (
    <header className="flex h-16 items-center gap-4 border-b border-gray-200 bg-white px-4 lg:px-6">
      <button
        onClick={onMenuClick}
        className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 lg:hidden"
        aria-label="Open menu"
        data-testid="menu-button"
      >
        <Menu size={20} />
      </button>

      <div className="relative flex-1 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="search"
          placeholder="Search clients, domains..."
          className="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <DarkModeToggle />
        <NotificationDropdown />

        <div className="relative" ref={menuRef}>
          <button
            onClick={handleToggle}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label="User menu"
            data-testid="user-menu-button"
          >
            <UserCircle size={20} />
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-gray-200 bg-white shadow-lg z-50"
              data-testid="user-menu-dropdown"
            >
              <div className="border-b border-gray-100 p-4">
                <p className="font-medium text-gray-900" data-testid="user-menu-name">
                  {user?.fullName ?? 'User'}
                </p>
                <p className="text-xs text-gray-500" data-testid="user-menu-email">
                  {user?.email ?? ''}
                </p>
              </div>

              {showPassword ? (
                <ChangePasswordForm onClose={() => setShowPassword(false)} />
              ) : (
                <div className="p-2">
                  <Link
                    to="/user-settings"
                    onClick={() => setMenuOpen(false)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    data-testid="user-settings-menu-item"
                  >
                    <Settings size={16} />
                    Settings
                  </Link>
                  <button
                    onClick={() => setShowPassword(true)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    data-testid="change-password-menu-item"
                  >
                    <KeyRound size={16} />
                    Change Password
                  </button>
                  <div className="my-1 border-t border-gray-100" />
                  <button
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    data-testid="user-menu-sign-out"
                  >
                    <LogOut size={16} />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function ChangePasswordForm({ onClose }: { readonly onClose: () => void }) {
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
      const message =
        err instanceof ApiError
          ? err.message
          : 'Failed to update password. Please try again.';
      setErrorMessage(message);
    }
  };

  return (
    <div className="p-4" data-testid="user-menu-password-form">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Change Password</h3>
        <button
          onClick={onClose}
          className="text-xs text-gray-500 hover:text-gray-700"
          data-testid="password-form-back"
        >
          Back
        </button>
      </div>
      <form className="space-y-3" onSubmit={handleSubmit}>
        <div>
          <input
            type="password"
            autoComplete="current-password"
            className={INPUT_CLASS}
            placeholder="Current password"
            data-testid="menu-current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div>
          <input
            type="password"
            autoComplete="new-password"
            className={INPUT_CLASS}
            placeholder="New password"
            data-testid="menu-new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div>
          <input
            type="password"
            autoComplete="new-password"
            className={INPUT_CLASS}
            placeholder="Confirm new password"
            data-testid="menu-confirm-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        {successMessage && (
          <p className="text-xs text-green-600" data-testid="menu-password-success">
            {successMessage}
          </p>
        )}
        {errorMessage && (
          <p className="text-xs text-red-600" data-testid="menu-password-error">
            {errorMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={changePassword.isPending}
          className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="menu-update-password-button"
        >
          {changePassword.isPending ? 'Updating...' : 'Update Password'}
        </button>
      </form>
    </div>
  );
}
