import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Globe,
  AppWindow,
  Database,
  Clock,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Network,
  UserCog,
  Activity,
  ScrollText,
  Server,
  Settings,
  KeyRound,
  Package,
  GitBranch,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useRuntimeInfo } from '@/hooks/use-runtime-info';

/** Compact identity block under the sidebar title — version, branch,
 *  and the node name of the platform-api pod that's serving us. Hidden
 *  until the fetch completes; null fields render as "—". */
function RuntimeInfoBlock() {
  const info = useRuntimeInfo();
  if (!info) return null;
  return (
    <div className="px-5 pb-3 text-[10px] uppercase tracking-wide text-white/60" data-testid="sidebar-runtime-info">
      <div className="font-mono normal-case text-[11px] tracking-normal text-white/80" title="Running version">
        {info.version}
      </div>
      <div className="flex gap-2 normal-case tracking-normal">
        {info.branch && <span title="Build branch">{info.branch}</span>}
        {info.node && <span title="Serving node">· {info.node}</span>}
      </div>
    </div>
  );
}

interface SimpleNavItem {
  readonly kind: 'item';
  readonly to: string;
  readonly icon: typeof LayoutDashboard;
  readonly label: string;
}
interface GroupNavItem {
  readonly kind: 'group';
  readonly id: string;
  readonly icon: typeof LayoutDashboard;
  readonly label: string;
  readonly children: ReadonlyArray<SimpleNavItem>;
}
type NavItem = SimpleNavItem | GroupNavItem;

const navItems: ReadonlyArray<NavItem> = [
  { kind: 'item',  to: '/',                       icon: LayoutDashboard, label: 'Dashboard' },
  { kind: 'item',  to: '/tenants',                icon: Users,           label: 'Tenants' },
  { kind: 'item',  to: '/domains',                icon: Globe,           label: 'Domains' },
  { kind: 'item',  to: '/applications',           icon: AppWindow,       label: 'Applications' },
  {
    kind: 'group',
    id: 'backups',
    icon: Database,
    label: 'Backups',
    children: [
      { kind: 'item', to: '/backups/system',                       icon: KeyRound,  label: 'System' },
      { kind: 'item', to: '/backups/tenants',                      icon: Package,   label: 'Tenant' },
      { kind: 'item', to: '/settings/backup-infrastructure',       icon: GitBranch, label: 'Infrastructure' },
    ],
  },
  { kind: 'item',  to: '/cron-jobs',              icon: Clock,           label: 'Cron Jobs' },
  {
    kind: 'group',
    id: 'security',
    icon: Shield,
    label: 'Security',
    children: [
      { kind: 'item', to: '/security/posture',        icon: ShieldCheck, label: 'Posture' },
      { kind: 'item', to: '/security/network-trust',  icon: Network,     label: 'Network Trust' },
      { kind: 'item', to: '/security/identity',       icon: UserCog,     label: 'Identity & Sessions' },
      { kind: 'item', to: '/security/web-defense',    icon: ShieldAlert, label: 'Web Defense' },
    ],
  },
  { kind: 'item',  to: '/monitoring',             icon: Activity,        label: 'Monitoring' },
  { kind: 'item',  to: '/monitoring/audit-logs',  icon: ScrollText,      label: 'Audit Logs' },
  { kind: 'item',  to: '/nodes-and-storage',      icon: Server,          label: 'Nodes & Storage' },
  { kind: 'item',  to: '/settings',               icon: Settings,        label: 'Settings' },
];

interface SidebarProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const location = useLocation();

  // Auto-expand any group whose child route is currently active so
  // the user lands on a visible nav item after a deep-link.
  const initialExpanded = new Set<string>();
  for (const item of navItems) {
    if (item.kind === 'group' && item.children.some((c) => location.pathname.startsWith(c.to))) {
      initialExpanded.add(item.id);
    }
  }
  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);

  // Auto-expand on client-side navigation (NavLink keeps Sidebar
  // mounted, so initialExpanded only fires once on first render).
  // Merges into existing state so operator-collapsed groups don't
  // pop back open unless their child route is the new pathname.
  useEffect(() => {
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const item of navItems) {
        if (item.kind !== 'group') continue;
        if (item.children.some((c) => location.pathname.startsWith(c.to)) && !next.has(item.id)) {
          next.add(item.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [location.pathname]);

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

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
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-linear-to-b from-brand-500 to-accent-500 transition-transform duration-200 lg:static lg:translate-x-0 dark:from-brand-900 dark:to-accent-700',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        data-testid="sidebar"
      >
        <div className="flex h-16 items-center justify-between px-5">
          <span className="text-lg font-bold text-white">K8s Hosting</span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-white/80 hover:text-white lg:hidden"
            aria-label="Close sidebar"
          >
            <X size={20} />
          </button>
        </div>

        <RuntimeInfoBlock />

        <nav className="flex-1 space-y-1 px-3 py-4" role="navigation" aria-label="Main">
          {navItems.map((item) => {
            if (item.kind === 'item') {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
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
                  {item.label}
                </NavLink>
              );
            }
            // Group
            const GroupIcon = item.icon;
            const isExpanded = expanded.has(item.id);
            const childActive = item.children.some((c) => location.pathname.startsWith(c.to));
            return (
              <div key={item.id} data-testid={`sidebar-group-${item.id}`}>
                <button
                  type="button"
                  onClick={() => toggleGroup(item.id)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    childActive
                      ? 'bg-white/15 text-white'
                      : 'text-white/70 hover:bg-white/10 hover:text-white',
                  )}
                  aria-expanded={isExpanded}
                >
                  <GroupIcon size={18} />
                  <span className="flex-1 text-left">{item.label}</span>
                  {isExpanded
                    ? <ChevronDown size={14} className="text-white/50" />
                    : <ChevronRight size={14} className="text-white/50" />}
                </button>
                {isExpanded && (
                  <div className="ml-3 mt-1 space-y-1 border-l border-white/20 pl-2">
                    {item.children.map((c) => {
                      const ChildIcon = c.icon;
                      return (
                        <NavLink
                          key={c.to}
                          to={c.to}
                          onClick={onClose}
                          className={({ isActive }) =>
                            clsx(
                              'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                              isActive
                                ? 'bg-white/20 text-white'
                                : 'text-white/60 hover:bg-white/10 hover:text-white',
                            )
                          }
                        >
                          <ChildIcon size={14} />
                          {c.label}
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
