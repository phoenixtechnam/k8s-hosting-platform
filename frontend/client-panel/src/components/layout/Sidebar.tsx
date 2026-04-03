import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  AppWindow,
  Database,
  Clock,
  FolderOpen,
  Mail,
  Archive,
  Users,
  Settings,
  X,
} from 'lucide-react';
import clsx from 'clsx';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/domains', icon: Globe, label: 'Domains' },
  { to: '/applications', icon: AppWindow, label: 'Applications' },
  { to: '/database-manager', icon: Database, label: 'SQL Manager' },
  { to: '/cron-jobs', icon: Clock, label: 'Scheduled Tasks' },
  { to: '/files', icon: FolderOpen, label: 'File Manager' },
  { to: '/email', icon: Mail, label: 'Email' },
  { to: '/backups', icon: Archive, label: 'Backups' },
  { to: '/users', icon: Users, label: 'Users' },
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
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-gradient-to-b from-brand-500 to-accent-500 dark:from-brand-900 dark:to-accent-700 transition-transform duration-200 lg:static lg:translate-x-0',
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
      </aside>
    </>
  );
}
