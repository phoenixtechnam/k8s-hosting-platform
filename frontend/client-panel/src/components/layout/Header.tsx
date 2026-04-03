import { useState, useEffect, useRef, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Menu, Search, UserCircle, KeyRound, LogOut, Settings, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useChangePassword } from '@/hooks/use-password';
import { useClientContext } from '@/hooks/use-client-context';
import { useResourceUsage } from '@/hooks/use-deployments';
import { ApiError } from '@/lib/api-client';
import NotificationDropdown from '@/components/NotificationDropdown';
import DarkModeToggle from '@/components/DarkModeToggle';

interface HeaderProps {
  readonly onMenuClick: () => void;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

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
    <header className="flex h-16 items-center gap-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 lg:px-6">
      <button
        onClick={onMenuClick}
        className="rounded-md p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 lg:hidden"
        aria-label="Open menu"
        data-testid="menu-button"
      >
        <Menu size={20} />
      </button>

      <div className="relative flex-1 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
        <input
          type="search"
          placeholder="Search domains, databases..."
          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 py-2 pl-9 pr-4 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:bg-white dark:focus:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ResourceUsageTags />
        <DarkModeToggle />
        <NotificationDropdown />

        <div className="relative" ref={menuRef}>
          <button
            onClick={handleToggle}
            className="rounded-md p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="User menu"
            data-testid="user-menu-button"
          >
            <UserCircle size={20} />
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50"
              data-testid="user-menu-dropdown"
            >
              <div className="border-b border-gray-100 dark:border-gray-700 p-4">
                <p className="font-medium text-gray-900 dark:text-gray-100" data-testid="user-menu-name">
                  {user?.fullName ?? 'User'}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="user-menu-email">
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
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    data-testid="user-settings-menu-item"
                  >
                    <Settings size={16} />
                    Settings
                  </Link>
                  <button
                    onClick={() => setShowPassword(true)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    data-testid="change-password-menu-item"
                  >
                    <KeyRound size={16} />
                    Change Password
                  </button>
                  <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                  <button
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
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

// ─── K8s Resource Usage Helpers ───────────────────────────────────────────────

/** Parse K8s CPU string (e.g. "500m", "1.5", "2") to numeric cores. */
function parseCpu(value: string): number {
  if (value.endsWith('m')) return parseInt(value, 10) / 1000;
  return parseFloat(value) || 0;
}

/** Parse K8s memory string (e.g. "512Mi", "2Gi", "1073741824") to GiB. */
function parseMemory(value: string): number {
  if (value.endsWith('Gi')) return parseFloat(value);
  if (value.endsWith('Mi')) return parseFloat(value) / 1024;
  if (value.endsWith('Ki')) return parseFloat(value) / (1024 * 1024);
  // Plain number = bytes
  const bytes = parseFloat(value);
  if (isNaN(bytes)) return 0;
  return bytes / (1024 * 1024 * 1024);
}

/** Parse K8s storage string to GiB */
function parseStorage(value: string): number {
  return parseMemory(value);
}

function formatNum(n: number): string {
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

/** Format a K8s CPU value to human-readable text (e.g. "250m" -> "0.25 CPUs"). */
function humanizeCpu(value: string): string {
  const cores = parseCpu(value);
  return `${cores % 1 === 0 ? cores.toFixed(0) : cores.toFixed(2).replace(/0+$/, '')} CPUs`;
}

/** Format a K8s memory/storage value to human-readable text (e.g. "256Mi" -> "0.25 GB"). */
function humanizeBytes(value: string): string {
  const gib = parseMemory(value);
  if (gib >= 1) return `${gib % 1 === 0 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
  return `${(gib * 1024) % 1 === 0 ? (gib * 1024).toFixed(0) : (gib * 1024).toFixed(0)} MB`;
}

function ResourceTag({
  icon,
  label,
  used,
  limit,
  parser,
  unit,
  humanizer,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly used: string;
  readonly limit: string;
  readonly parser: (v: string) => number;
  readonly unit: string;
  readonly humanizer: (v: string) => string;
}) {
  const usedNum = parser(used);
  const limitNum = parser(limit);
  const ratio = limitNum > 0 ? usedNum / limitNum : 0;

  let colorClasses: string;
  if (ratio >= 0.9) {
    colorClasses = 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800';
  } else if (ratio >= 0.7) {
    colorClasses = 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800';
  } else {
    colorClasses = 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700';
  }

  const usedHuman = humanizer(used);
  const limitHuman = humanizer(limit);

  return (
    <span
      className={`hidden lg:inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium border ${colorClasses}`}
      title={`${usedHuman} used of ${limitHuman} available`}
      data-testid={`resource-tag-${label.toLowerCase()}`}
    >
      {icon}
      {formatNum(usedNum)}/{formatNum(limitNum)}{unit}
    </span>
  );
}

function ResourceUsageTags() {
  const { clientId } = useClientContext();
  const { data } = useResourceUsage(clientId);

  const usage = data?.data;
  if (!usage) return null;

  // Skip if limits are all zero (not provisioned)
  const cpuLimit = parseCpu(usage.cpu.limit);
  if (cpuLimit <= 0) return null;

  return (
    <div className="flex items-center gap-1.5" data-testid="resource-usage-tags">
      <ResourceTag
        icon={<Cpu size={14} />}
        label="CPU"
        used={usage.cpu.used}
        limit={usage.cpu.limit}
        parser={parseCpu}
        unit=""
        humanizer={humanizeCpu}
      />
      <ResourceTag
        icon={<MemoryStick size={14} />}
        label="Memory"
        used={usage.memory.used}
        limit={usage.memory.limit}
        parser={parseMemory}
        unit="Gi"
        humanizer={humanizeBytes}
      />
      <ResourceTag
        icon={<HardDrive size={14} />}
        label="Storage"
        used={usage.storage.used}
        limit={usage.storage.limit}
        parser={parseStorage}
        unit="Gi"
        humanizer={humanizeBytes}
      />
    </div>
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
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Change Password</h3>
        <button
          onClick={onClose}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
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
