/**
 * Web Defense — Security Hub → Web Defense (2026-05-21).
 *
 * Owns the CrowdSec + ModSecurity / WAF operator surfaces that were
 * previously living as 3 of the 12 tabs on the legacy
 * `SecurityHardeningSettings.tsx` page. Now their own page under the
 * Security Hub.
 *
 * Layout:
 *   - L4 enforcement toggle banner at the top (full-width, prominent
 *     because flipping to `enforce` has cluster-wide blast radius)
 *   - 3 tabs: WAF Events · Banned IPs · WAF Exclusions
 *
 * Tab bodies are imported from
 * `components/security/web-defense-tabs.tsx` — that's where the
 * extracted CrowdSec + WAF render code lives. This page is just the
 * shell.
 */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import {
  BannedIpsTab,
  CrowdsecL4Card,
  WafEventsTab,
  WafExclusionsTab,
} from '@/components/security/web-defense-tabs';

type TabId = 'waf' | 'bans' | 'exclusions';

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string; readonly hint: string }> = [
  { id: 'waf', label: 'WAF Events', hint: 'Cluster-wide ModSec/CRS event stream' },
  { id: 'bans', label: 'Banned IPs', hint: 'CrowdSec decisions + manual ban/allowlist' },
  { id: 'exclusions', label: 'WAF Exclusions', hint: 'Per-route CRS rule exclusions' },
];

const VALID_TABS: ReadonlySet<TabId> = new Set(['waf', 'bans', 'exclusions']);

export default function WebDefensePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab: TabId = useMemo(() => {
    if (requested && VALID_TABS.has(requested as TabId)) return requested as TabId;
    return 'waf';
  }, [requested]);
  const setActiveTab = (id: TabId): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };
  // Local UI state so the L4 banner can be collapsed by the operator.
  const [l4Expanded, setL4Expanded] = useState(true);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <ShieldAlert size={24} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Web Defense</h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
          ModSecurity CRS events, CrowdSec ban decisions, and per-route WAF rule exclusions.
          Cluster-wide L4 enforcement (host-firewall drop of CrowdSec blocklist IPs) is toggled
          in the banner below — read the operator-IP-trust check before flipping to <code>enforce</code>.
        </p>
      </header>

      {/* L4 enforcement banner — prominent because of blast radius. */}
      <div className="rounded-md border border-amber-200 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-900/10">
        <button
          type="button"
          onClick={() => setL4Expanded((x) => !x)}
          className="w-full flex items-center justify-between gap-3 px-4 py-2 text-left text-sm font-medium text-amber-900 dark:text-amber-200"
          aria-expanded={l4Expanded}
          aria-controls="l4-banner"
          data-testid="l4-banner-toggle"
        >
          <span className="flex items-center gap-2">
            <ShieldAlert size={16} />
            CrowdSec L4 host-firewall enforcement
          </span>
          <span className="text-xs opacity-70">{l4Expanded ? 'collapse' : 'expand'}</span>
        </button>
        {l4Expanded && (
          <div id="l4-banner" className="px-4 pb-4 pt-2 border-t border-amber-200/60 dark:border-amber-700/30">
            <CrowdsecL4Card />
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700" role="tablist">
        {TABS.map(({ id, label, hint }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`web-defense-panel-${id}`}
              id={`web-defense-tab-${id}`}
              data-testid={`tab-${id}`}
              title={hint}
              onClick={() => setActiveTab(id)}
              className={clsx(
                '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      <div
        role="tabpanel"
        id={`web-defense-panel-${activeTab}`}
        aria-labelledby={`web-defense-tab-${activeTab}`}
      >
        {activeTab === 'waf' && <WafEventsTab />}
        {activeTab === 'bans' && <BannedIpsTab />}
        {activeTab === 'exclusions' && <WafExclusionsTab />}
      </div>
    </div>
  );
}
