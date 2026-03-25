import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  Database,
  FolderOpen,
  Mail,
  Archive,
  Settings,
  X,
  LogOut,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '@/hooks/use-auth';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/domains', icon: Globe, label: 'Domains' },
  { to: '/databases', icon: Database, label: 'Databases' },
  { to: '/files', icon: FolderOpen, label: 'Files' },
  { to: '/email', icon: Mail, label: 'Email' },
  { to: '/backups', icon: Archive, label: 'Backups' },
  { to: '/settings', icon: Settings, label: 'Settings' },
] as const;

interface SidebarProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
          data-testid="sidebar-overlay"
        />
      )}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-gradient-to-b from-brand-500 to-accent-500 transition-transform duration-200 lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        data-testid="sidebar"
      >
        <div className="flex h-16 items-center justify-between px-5">
          <span className="text-lg font-bold text-white">Client Portal</span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-white/80 hover:text-white lg:hidden"
            aria-label="Close sidebar"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4" role="navigation" aria-label="Main">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white',
                )
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <UserSection />
      </aside>
    </>
  );
}

function UserSection() {
  const { user, logout } = useAuth();
  const initial = (user?.fullName ?? user?.email ?? 'U')[0].toUpperCase();

  return (
    <div className="border-t border-white/20 p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-sm font-medium text-white">
          {initial}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <div className="truncate font-medium text-white">{user?.fullName ?? 'User'}</div>
          <div className="truncate text-xs text-white/60">{user?.email ?? ''}</div>
        </div>
        <button
          onClick={logout}
          className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
          aria-label="Sign out"
          data-testid="logout-button"
        >
          <LogOut size={16} />
        </button>
      </div>
    </div>
  );
}
