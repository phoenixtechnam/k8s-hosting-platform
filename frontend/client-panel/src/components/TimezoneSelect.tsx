import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';

/**
 * Full IANA timezone list, grouped by continent. `Intl.supportedValuesOf('timeZone')`
 * returns every zone the runtime knows (440+ entries in recent browsers/Node),
 * including aliases like `US/Eastern` that map onto `America/New_York`. We
 * bucket each zone by the slash-prefix and surface the short "Common" group
 * at the top for the normal case where the admin just wants a familiar zone.
 *
 * Zones without a slash (`UTC`, `GMT`, `Etc/*` collapsed) land in the "UTC"
 * bucket. Aliases like `US/*` and `Canada/*` keep their prefix as-is so the
 * admin can pick them directly if they're used to them.
 */
const COMMON_ZONES = [
  'UTC',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Kolkata', 'Asia/Dubai',
  'Australia/Sydney', 'Pacific/Auckland',
] as const;

function buildTimezoneGroups(): Record<string, string[]> {
  const all: string[] = (() => {
    try {
      // Node 18+ and all modern browsers (Chrome 99+, Safari 15.4+, Firefox 106+).
      const fn = (Intl as unknown as { supportedValuesOf?: (kind: string) => string[] }).supportedValuesOf;
      if (typeof fn === 'function') return fn('timeZone').slice().sort();
    } catch {
      // Fall through to hardcoded
    }
    // Defensive fallback if the runtime lacks Intl.supportedValuesOf: at
    // minimum guarantee the Common set so the UI doesn't render empty.
    return [...COMMON_ZONES].sort();
  })();

  const groups: Record<string, string[]> = { Common: [...COMMON_ZONES] };
  for (const tz of all) {
    const slashIdx = tz.indexOf('/');
    const prefix = slashIdx === -1 ? 'UTC / Etc' : tz.slice(0, slashIdx);
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(tz);
  }
  // Sort group names but keep "Common" first.
  const sortedKeys = Object.keys(groups).filter((k) => k !== 'Common').sort();
  const ordered: Record<string, string[]> = { Common: groups.Common };
  for (const k of sortedKeys) ordered[k] = groups[k];
  return ordered;
}

const TIMEZONE_GROUPS = buildTimezoneGroups();

interface TimezoneSelectProps {
  value: string;
  onChange: (tz: string) => void;
  placeholder?: string;
  className?: string;
}

export default function TimezoneSelect({ value, onChange, placeholder = 'Select timezone...', className = '' }: TimezoneSelectProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return TIMEZONE_GROUPS;
    const q = search.toLowerCase();
    const result: Record<string, string[]> = {};
    for (const [group, tzs] of Object.entries(TIMEZONE_GROUPS)) {
      const filtered = tzs.filter((tz) => tz.toLowerCase().includes(q));
      if (filtered.length) result[group] = filtered;
    }
    return result;
  }, [search]);

  const displayValue = value || placeholder;

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-left text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-600"
        data-testid="timezone-select-button"
      >
        {displayValue}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full max-h-72 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg flex flex-col">
            <div className="p-2 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-2 py-1">
                <Search size={14} className="text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search timezones..."
                  className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 outline-none placeholder:text-gray-400"
                  autoFocus
                  data-testid="timezone-select-search"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {Object.entries(filteredGroups).map(([group, tzs]) => (
                <div key={group}>
                  <div className="px-3 py-1 text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                    {group}
                  </div>
                  {tzs.map((tz) => (
                    <button
                      key={`${group}-${tz}`}
                      type="button"
                      onClick={() => { onChange(tz); setOpen(false); setSearch(''); }}
                      className={`w-full px-3 py-1.5 text-sm text-left hover:bg-brand-50 dark:hover:bg-brand-900/20 ${
                        tz === value ? 'text-brand-600 dark:text-brand-400 font-medium bg-brand-50/50 dark:bg-brand-900/10' : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {tz}
                    </button>
                  ))}
                </div>
              ))}
              {Object.keys(filteredGroups).length === 0 && (
                <p className="px-3 py-4 text-sm text-gray-400 text-center">No timezones match &quot;{search}&quot;</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
