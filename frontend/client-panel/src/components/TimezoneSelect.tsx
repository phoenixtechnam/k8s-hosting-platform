import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';

const TIMEZONE_GROUPS: Record<string, string[]> = {
  'Common': ['UTC', 'US/Eastern', 'US/Central', 'US/Mountain', 'US/Pacific', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney'],
  'Africa': ['Africa/Cairo', 'Africa/Casablanca', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi'],
  'America': ['America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Chicago', 'America/Denver', 'America/Halifax', 'America/Los_Angeles', 'America/Mexico_City', 'America/New_York', 'America/Phoenix', 'America/Santiago', 'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver'],
  'Asia': ['Asia/Bangkok', 'Asia/Colombo', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Istanbul', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Kuala_Lumpur', 'Asia/Manila', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Taipei', 'Asia/Tehran', 'Asia/Tokyo'],
  'Australia': ['Australia/Adelaide', 'Australia/Brisbane', 'Australia/Darwin', 'Australia/Hobart', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney'],
  'Europe': ['Europe/Amsterdam', 'Europe/Athens', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Brussels', 'Europe/Bucharest', 'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Kiev', 'Europe/Lisbon', 'Europe/London', 'Europe/Madrid', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris', 'Europe/Prague', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Vienna', 'Europe/Warsaw', 'Europe/Zurich'],
  'Pacific': ['Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Guam', 'Pacific/Honolulu', 'Pacific/Samoa'],
};

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
      >
        {displayValue}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full max-h-64 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg flex flex-col">
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
                      key={tz}
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
                <p className="px-3 py-4 text-sm text-gray-400 text-center">No timezones match "{search}"</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
