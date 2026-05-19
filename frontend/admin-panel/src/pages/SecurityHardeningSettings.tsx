/**
 * Security / Firewall / Node Hardening — Settings → Security & Hardening
 *
 * Read-mostly observability page. 10 tabs:
 *   1. Overview          — banner summary + node table
 *   2. SSH Lockdown      — per-node SSH posture + guided runbook modal
 *   3. Mesh Status       — detected mesh provider per node + install hints
 *   4. Firewall Posture  — mode, peer counts, public ports per node
 *   5. Node Hardening    — CIS-style check matrix
 *   6. K8s Posture       — pod security standards + privileged pods
 *   7. Authentication    — Dex / oauth2-proxy health + failed-login counts
 *   8. Network Policies  — bulk NetworkPolicy template catalog (P2.4)
 *   9. Security Events   — recent audit log entries (security-relevant)
 *  10. WAF Events        — cluster-wide ModSec/CRS events (admin + tenant hosts)
 *
 * Plus Phase 2 cards on Overview:
 *   - Calico WG verification
 *   - Reserved-hostname collisions
 *   - TLS cert expiry (<30d)
 *   - Backup target encryption + freshness
 *   - Audit-log gap detector
 *
 * Destructive ops (SSH lockdown flip) surface as guided runbooks: the
 * UI shows the paste-ready bootstrap.sh command + waits until the
 * probe ConfigMap reflects the new state. NO in-place mutations of
 * host firewall rules.
 *
 * Linked from /settings via the "Security & Hardening" card. Super_admin
 * gated at the route level + visible only to super_admin in
 * Settings.tsx.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronLeft,
  ShieldAlert,
  RefreshCw,
  Lock,
  Network,
  Activity,
  HardDrive,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Info,
  Copy,
  Filter,
  Globe,
  Play,
  Pause,
  Ban,
  Trash2,
  Plus,
} from 'lucide-react';
import {
  useSecurityHardeningSnapshot,
  useRefreshSecurityHardening,
} from '@/hooks/use-security-hardening';
import { useRefreshWafScraper, useWafEvents } from '@/hooks/use-waf-events';
import {
  useAddCrowdsecBan,
  useCrowdsecDecisions,
  useCrowdsecStatus,
  useDeleteCrowdsecDecision,
} from '@/hooks/use-crowdsec';
import type {
  NodeSecuritySnapshot,
  CisFinding,
  CisSeverity,
  SecurityHardeningSnapshot,
  WafEvent,
  WafEventScope,
  WafEventSeverity,
  WafEventsQuery,
  WafEventsResponse,
  WafScraperStatus,
  CrowdsecDecision,
  CrowdsecDecisionScope,
  CrowdsecListDecisionsQuery,
  CrowdsecStatus,
} from '@k8s-hosting/api-contracts';

type TabId = 'overview' | 'ssh' | 'mesh' | 'firewall' | 'hardening' | 'k8s' | 'auth' | 'netpol' | 'events' | 'waf' | 'bans';

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'ssh', label: 'SSH Lockdown' },
  { id: 'mesh', label: 'Mesh Status' },
  { id: 'firewall', label: 'Firewall Posture' },
  { id: 'hardening', label: 'Node Hardening' },
  { id: 'k8s', label: 'K8s Posture' },
  { id: 'auth', label: 'Authentication' },
  { id: 'netpol', label: 'Network Policies' },
  { id: 'events', label: 'Security Events' },
  { id: 'waf', label: 'WAF Events' },
  { id: 'bans', label: 'Banned IPs' },
];

export default function SecurityHardeningSettings() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const { data, isLoading, isError, error, refetch, isFetching } = useSecurityHardeningSnapshot();
  const refresh = useRefreshSecurityHardening();

  const snapshot = data?.data;

  return (
    <div className="space-y-6">
      <Link
        to="/settings"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-brand-600 dark:text-gray-400 dark:hover:text-brand-400"
      >
        <ChevronLeft size={16} />
        Back to Settings
      </Link>

      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <ShieldAlert size={24} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Security &amp; Hardening</h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
          Per-node SSH posture, mesh detection, firewall observability, and CIS-style hardening checks.
          Read-mostly &mdash; destructive changes (e.g. moving SSH off public :22) surface as guided runbooks
          driven by <code>bootstrap.sh --ssh-via-mesh</code>. Pending peers and trusted ranges are managed
          on the <Link to="/settings/cluster-network" className="text-brand-600 hover:underline dark:text-brand-400">Cluster Networking</Link> page.
        </p>
      </header>

      <div className="flex items-center justify-between">
        <div className="border-b border-gray-200 dark:border-gray-700 flex-1">
          <nav className="flex gap-1 -mb-px" data-testid="security-hardening-tabs">
            {TABS.map((t) => {
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={[
                    'px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
                    isActive
                      ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
                  ].join(' ')}
                  data-testid={`tab-${t.id}`}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <button
            type="button"
            onClick={() => {
              void refresh.mutateAsync();
            }}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="probe-refresh"
            title="Bump the probe DaemonSet annotation to force an early collect"
          >
            <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
            Refresh probe
          </button>
          <button
            type="button"
            onClick={() => {
              void refetch();
            }}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="snapshot-refetch"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            Reload
          </button>
        </div>
      </div>

      {isLoading && <SkeletonLoader />}
      {isError && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load snapshot: {error instanceof Error ? error.message : String(error)}
        </div>
      )}
      {snapshot && activeTab === 'overview' && <OverviewTab snapshot={snapshot} />}
      {snapshot && activeTab === 'ssh' && <SshTab snapshot={snapshot} />}
      {snapshot && activeTab === 'mesh' && <MeshTab snapshot={snapshot} />}
      {snapshot && activeTab === 'firewall' && <FirewallTab snapshot={snapshot} />}
      {snapshot && activeTab === 'hardening' && <HardeningTab snapshot={snapshot} />}
      {snapshot && activeTab === 'k8s' && <K8sPostureTab snapshot={snapshot} />}
      {snapshot && activeTab === 'auth' && <AuthTab snapshot={snapshot} />}
      {snapshot && activeTab === 'netpol' && <NetworkPolicyTab />}
      {snapshot && activeTab === 'events' && <EventsTab snapshot={snapshot} />}
      {/* WAF tab is unconditional — it has its own data hook and surfaces its own
          loading/error states, so it shouldn't go blank when the security-hardening
          snapshot is slow or failing (the snapshot is a DaemonSet-driven read). */}
      {activeTab === 'waf' && <WafEventsTab />}
      {/* Banned IPs tab is also unconditional — uses CrowdSec LAPI, not the
          security-hardening snapshot. */}
      {activeTab === 'bans' && <BannedIpsTab />}
    </div>
  );
}

// ─── Overview tab ───────────────────────────────────────────────────────

function OverviewTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  const counts = useMemo(() => {
    let nodesPublicSSH = 0;
    let nodesWithFailingCritical = 0;
    let staleNodes = 0;
    for (const n of snapshot.nodes) {
      if (n.ssh.restrictionMode === 'public') nodesPublicSSH++;
      if (n.hardening.cisFindings.some((f) => !f.passing && f.severity === 'critical')) nodesWithFailingCritical++;
      if (n.stale) staleNodes++;
    }
    return { nodesPublicSSH, nodesWithFailingCritical, staleNodes };
  }, [snapshot]);

  return (
    <section className="space-y-4">
      {/* Top banner — surfaces the headline risks */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SummaryCard
          variant={counts.nodesPublicSSH === 0 ? 'good' : 'bad'}
          icon={Lock}
          label="SSH publicly exposed"
          value={`${counts.nodesPublicSSH} of ${snapshot.nodes.length} nodes`}
          subtle={counts.nodesPublicSSH > 0 ? 'Run --ssh-via-mesh on affected nodes' : 'All nodes scoped'}
        />
        <SummaryCard
          variant={counts.nodesWithFailingCritical === 0 ? 'good' : 'bad'}
          icon={ShieldAlert}
          label="Critical CIS failures"
          value={`${counts.nodesWithFailingCritical} of ${snapshot.nodes.length} nodes`}
          subtle={counts.nodesWithFailingCritical > 0 ? 'See Node Hardening tab' : 'All critical checks pass'}
        />
        <SummaryCard
          variant={counts.staleNodes === 0 ? 'good' : 'warn'}
          icon={Clock}
          label="Stale probe reports"
          value={`${counts.staleNodes} of ${snapshot.nodes.length} nodes`}
          subtle={counts.staleNodes > 0 ? 'Probe pod may be down' : 'All probe reports < 5 min old'}
        />
      </div>

      {/* Per-node summary */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100">
          Nodes
        </div>
        <table className="min-w-full text-sm" data-testid="overview-nodes-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Node</th>
              <th className="px-4 py-2 text-left">SSH</th>
              <th className="px-4 py-2 text-left">Mesh</th>
              <th className="px-4 py-2 text-left">Critical findings</th>
              <th className="px-4 py-2 text-left">Probe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {snapshot.nodes.map((n) => (
              <tr key={n.name}>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{n.name}</td>
                <td className="px-4 py-2"><SshBadge mode={n.ssh.restrictionMode} /></td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.mesh.provider === 'none' ? '—' : n.mesh.provider}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.hardening.cisFindings.filter((f) => !f.passing && f.severity === 'critical').length}</td>
                <td className="px-4 py-2">{n.stale ? <StaleBadge /> : <FreshBadge ts={n.lastUpdatedAt} />}</td>
              </tr>
            ))}
            {snapshot.nodes.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">No probe reports yet — DaemonSet may still be rolling out.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Phase 2 cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {snapshot.calicoWg && (
          <Phase2Card
            icon={Network}
            title="Calico WireGuard (UDP/51821)"
            ok={snapshot.calicoWg.publicKeyAuthConfirmed}
            metric={`${snapshot.calicoWg.listeningNodes} / ${snapshot.calicoWg.totalNodes} nodes`}
            note="Pod-to-pod encryption (separate from operator SSH-via-mesh)"
          />
        )}
        {snapshot.auditLogHealth && (
          <Phase2Card
            icon={Activity}
            title="Audit log health"
            ok={!snapshot.auditLogHealth.gapSuspected && snapshot.auditLogHealth.rowCountMonotonic !== false}
            metric={
              snapshot.auditLogHealth.lastInsertAt
                ? `${snapshot.auditLogHealth.secondsSinceLastInsert ?? 0}s since last insert`
                : 'no inserts on record'
            }
            note={
              snapshot.auditLogHealth.rowCountMonotonic === false
                ? 'Row count went DOWN — possible audit-log tampering'
                : snapshot.auditLogHealth.gapSuspected
                  ? 'Gap suspected — audit logger may be down'
                  : `~${snapshot.auditLogHealth.rollingHourlyRate.toFixed(1)} rows/hour (7d avg)`
            }
          />
        )}
        <Phase2Card
          icon={ShieldAlert}
          title="TLS certs expiring < 30d"
          ok={snapshot.certExpiries.length === 0}
          metric={`${snapshot.certExpiries.length} certs`}
          note={snapshot.certExpiries.length > 0 ? `Soonest: ${snapshot.certExpiries[0].name} (${snapshot.certExpiries[0].daysRemaining}d)` : 'No urgent renewals'}
        />
        <Phase2Card
          icon={HardDrive}
          title="Backup targets"
          ok={snapshot.backupTargets.every((t) => t.encryptionAtRest && (t.daysSinceLastSnapshot ?? 0) < 7)}
          metric={`${snapshot.backupTargets.length} targets`}
          note={(() => {
            const unencrypted = snapshot.backupTargets.filter((t) => !t.encryptionAtRest).length;
            const stale = snapshot.backupTargets.filter((t) => (t.daysSinceLastSnapshot ?? 0) >= 7).length;
            if (unencrypted > 0) return `${unencrypted} target(s) unencrypted`;
            if (stale > 0) return `${stale} target(s) > 7d since last snapshot`;
            return 'All targets encrypted + recent';
          })()}
        />
        {snapshot.reservedHostnameCollisions.length > 0 && (
          <Phase2Card
            icon={AlertTriangle}
            title="Reserved hostname collisions"
            ok={false}
            metric={`${snapshot.reservedHostnameCollisions.length} attempts`}
            note="Tenant tried to register a reserved platform hostname (ADR-040)"
          />
        )}
      </div>
    </section>
  );
}

// ─── SSH tab ────────────────────────────────────────────────────────────

function SshTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  const [openModalNode, setOpenModalNode] = useState<NodeSecuritySnapshot | null>(null);
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <table className="min-w-full text-sm" data-testid="ssh-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Node</th>
              <th className="px-4 py-2 text-left">Mode</th>
              <th className="px-4 py-2 text-left">Port</th>
              <th className="px-4 py-2 text-left">PermitRootLogin</th>
              <th className="px-4 py-2 text-left">PasswordAuth</th>
              <th className="px-4 py-2 text-left">AllowUsers</th>
              <th className="px-4 py-2 text-left">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {snapshot.nodes.map((n) => (
              <tr key={n.name}>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{n.name}</td>
                <td className="px-4 py-2"><SshBadge mode={n.ssh.restrictionMode} /></td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.ssh.sshdFlags.port}</td>
                <td className="px-4 py-2"><SshdFlagCell value={n.ssh.sshdFlags.permitRootLogin} good="no" /></td>
                <td className="px-4 py-2"><SshdFlagCell value={n.ssh.sshdFlags.passwordAuthentication} good="no" /></td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.ssh.sshdFlags.allowUsers.join(', ') || <span className="text-gray-400">—</span>}</td>
                <td className="px-4 py-2">
                  {n.ssh.restrictionMode === 'public' && (
                    <button
                      type="button"
                      onClick={() => setOpenModalNode(n)}
                      className="text-sm text-brand-600 hover:underline dark:text-brand-400"
                      data-testid={`ssh-lockdown-${n.name}`}
                    >
                      Restrict to mesh
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openModalNode && (
        <SshLockdownModal node={openModalNode} onClose={() => setOpenModalNode(null)} />
      )}
    </section>
  );
}

// ─── Mesh tab ───────────────────────────────────────────────────────────

function MeshTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <table className="min-w-full text-sm" data-testid="mesh-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Node</th>
              <th className="px-4 py-2 text-left">Provider</th>
              <th className="px-4 py-2 text-left">Interface</th>
              <th className="px-4 py-2 text-left">IP</th>
              <th className="px-4 py-2 text-left">Peers</th>
              <th className="px-4 py-2 text-left">Last handshake</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {snapshot.nodes.map((n) => (
              <tr key={n.name}>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{n.name}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.mesh.provider === 'none' ? <span className="text-gray-400">none detected</span> : n.mesh.provider}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.mesh.interfaceName ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{n.mesh.interfaceIp ?? '—'}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.mesh.peerCount ?? '—'}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{n.mesh.lastHandshakeAgeSeconds !== null ? `${n.mesh.lastHandshakeAgeSeconds}s ago` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Install mesh agent on a node</h3>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
          The platform doesn't bundle these — install on each node manually, then run <code>bootstrap.sh --ssh-via-mesh &lt;iface&gt;</code>.
        </p>
        <InstallSnippets />
      </div>
    </section>
  );
}

// ─── Firewall tab ───────────────────────────────────────────────────────

function FirewallTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Stat label="Firewall mode" value={snapshot.firewall.mode} />
        <Stat label="Trusted ranges (v4 / v6)" value={`${snapshot.firewall.trustedRangesV4Count} / ${snapshot.firewall.trustedRangesV6Count}`} />
        <Stat label="Cluster peers (v4 / v6)" value={`${snapshot.firewall.clusterPeersV4Count} / ${snapshot.firewall.clusterPeersV6Count}`} />
        <Stat label="Denied (last 60s)" value={snapshot.firewall.deniedCountWindow.available ? String(snapshot.firewall.deniedCountWindow.denies ?? 0) : 'unavailable'} />
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100">
          Public ports per node
        </div>
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Node</th>
              <th className="px-4 py-2 text-left">Public TCP</th>
              <th className="px-4 py-2 text-left">Public UDP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {snapshot.firewall.publicPortsPerNode.map((p) => (
              <tr key={p.nodeName}>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{p.nodeName}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{p.tcp.join(', ') || '—'}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{p.udp.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-gray-600 dark:text-gray-400">
        Manage trusted ranges and pending peers on the{' '}
        <Link to="/settings/cluster-network" className="text-brand-600 hover:underline dark:text-brand-400">Cluster Networking</Link>{' '}
        page.
      </div>
    </section>
  );
}

// ─── Node Hardening tab ─────────────────────────────────────────────────

function HardeningTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  const [hideInfo, setHideInfo] = useState(true);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600 dark:text-gray-400">CIS-style checks evaluated on every probe loop ({snapshot.nodes.length} node{snapshot.nodes.length === 1 ? '' : 's'}).</p>
        <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
          <input
            type="checkbox"
            checked={hideInfo}
            onChange={(e) => setHideInfo(e.target.checked)}
            data-testid="hide-info-toggle"
          />
          Hide info-only checks
        </label>
      </div>
      {snapshot.nodes.map((n) => (
        <details key={n.name} open className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
            {n.name}
            <span className="ml-2 text-xs text-gray-500">{n.hardening.osPretty} · kernel {n.hardening.kernelVersion}</span>
          </summary>
          <div className="px-4 pb-4 space-y-1">
            {n.hardening.cisFindings.filter((f) => !hideInfo || f.severity !== 'info').map((f) => (
              <FindingRow key={f.id} finding={f} />
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}

// ─── K8s Posture tab ────────────────────────────────────────────────────

function K8sPostureTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  const posture = snapshot.k8sPosture;
  if (!posture) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-4 text-sm">
        K8s posture data unavailable — backend could not list pods or namespaces. Check platform-api ServiceAccount RBAC.
      </div>
    );
  }
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Stat label="Total pods" value={String(posture.totalPodCount)} />
        <Stat label="Privileged pods" value={String(posture.privilegedPods.length)} />
        <Stat label="hostPath pods" value={String(posture.hostPathPods.length)} />
        <Stat label="hostNetwork pods" value={String(posture.hostNetworkPods.length)} />
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100">
          Namespace Pod Security Standard labels
        </div>
        <table className="min-w-full text-sm" data-testid="pss-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Namespace</th>
              <th className="px-4 py-2 text-left">Enforce</th>
              <th className="px-4 py-2 text-left">Warn</th>
              <th className="px-4 py-2 text-left">Audit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {posture.namespacePss.map((ns) => (
              <tr key={ns.namespace}>
                <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{ns.namespace}</td>
                <td className="px-4 py-2"><PssBadge level={ns.enforceLevel} /></td>
                <td className="px-4 py-2"><PssBadge level={ns.warnLevel} /></td>
                <td className="px-4 py-2"><PssBadge level={ns.auditLevel} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PodListCard title="Privileged pods" pods={posture.privilegedPods} testid="privileged-pods-table" />
      <PodListCard title="hostPath users" pods={posture.hostPathPods} testid="hostpath-pods-table" />
      <PodListCard title="hostNetwork users" pods={posture.hostNetworkPods} testid="hostnet-pods-table" />
    </section>
  );
}

function PssBadge({ level }: { level: 'privileged' | 'baseline' | 'restricted' | 'unset' }) {
  if (level === 'restricted') return <Badge tone="good" icon={CheckCircle2}>restricted</Badge>;
  if (level === 'baseline') return <Badge tone="warn" icon={Info}>baseline</Badge>;
  if (level === 'privileged') return <Badge tone="bad" icon={XCircle}>privileged</Badge>;
  return <span className="text-xs text-gray-400">unset</span>;
}

function PodListCard({ title, pods, testid }: { title: string; pods: ReadonlyArray<{ namespace: string; name: string; reasons: ReadonlyArray<string> }>; testid: string }) {
  if (pods.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm text-gray-500">
        <span className="font-medium text-gray-900 dark:text-gray-100">{title}</span> — none.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100">
        {title} ({pods.length})
      </div>
      <table className="min-w-full text-sm" data-testid={testid}>
        <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <tr>
            <th className="px-4 py-2 text-left">Namespace</th>
            <th className="px-4 py-2 text-left">Pod</th>
            <th className="px-4 py-2 text-left">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {pods.map((p) => (
            <tr key={`${p.namespace}/${p.name}`}>
              <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{p.namespace}</td>
              <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{p.name}</td>
              <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">{p.reasons.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Auth tab ───────────────────────────────────────────────────────────

function AuthTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  const auth = snapshot.authPosture;
  if (!auth) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-4 text-sm">
        Authentication posture unavailable.
      </div>
    );
  }
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat label="Failed logins (24h)" value={String(auth.failedLogins24h)} />
        <Stat label="Failed logins (7d)" value={String(auth.failedLogins7d)} />
        <Stat
          label="Oldest active session"
          value={
            auth.oldestActiveSessionAgeSeconds !== null
              ? `${Math.floor(auth.oldestActiveSessionAgeSeconds / 3600)}h`
              : '—'
          }
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Phase2Card
          icon={CheckCircle2}
          title="Dex OIDC"
          ok={auth.dexHealthy === true}
          metric={auth.dexHealthy === null ? 'not deployed' : auth.dexHealthy ? 'healthy' : 'degraded'}
          note="External identity provider for admin SSO"
        />
        <Phase2Card
          icon={CheckCircle2}
          title="oauth2-proxy"
          ok={auth.oauth2ProxyHealthy === true}
          metric={auth.oauth2ProxyHealthy === null ? 'not deployed' : auth.oauth2ProxyHealthy ? 'healthy' : 'degraded'}
          note="Forward-auth gate for admin-only Ingresses"
        />
      </div>
    </section>
  );
}

// ─── NetworkPolicy templates tab (Phase 2.4) ───────────────────────────

function NetworkPolicyTab() {
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm text-gray-700 dark:text-gray-200">
        Bulk-apply NetworkPolicy templates to all tenant namespaces. Phase 2.4 ships the read-only catalog
        (preview-only). Bulk apply is wired via task-center (long-running op with progress modal); per-tenant
        opt-out is honored. Templates are <strong>static</strong> — operators with custom policies should
        exclude the affected namespaces.
      </div>
      <NetworkPolicyTemplatesList />
    </section>
  );
}

function NetworkPolicyTemplatesList() {
  // Static list mirrored from packages/api-contracts/src/security-hardening.ts.
  const templates = [
    {
      id: 'isolate-tenant',
      title: 'Isolate tenant',
      description: 'Pods in this namespace can only communicate with pods in the same namespace + kube-dns.',
    },
    {
      id: 'deny-all-egress',
      title: 'Deny all egress',
      description: 'Pods in this namespace cannot make outbound connections. Use for high-security tenants.',
    },
    {
      id: 'allow-dns-only',
      title: 'Allow DNS only',
      description: 'Pods can resolve DNS via kube-dns but cannot make any other outbound connections.',
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {templates.map((t) => (
        <div key={t.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.title}</h3>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{t.description}</p>
          <button
            type="button"
            disabled
            className="mt-3 inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400"
            data-testid={`netpol-apply-${t.id}`}
            title="Bulk apply ships in P2.4.1 — preview catalogue for now"
          >
            Preview only (P2.4.1)
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Events tab ─────────────────────────────────────────────────────────

function EventsTab({ snapshot }: { snapshot: SecurityHardeningSnapshot }) {
  return (
    <section>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <table className="min-w-full text-sm" data-testid="events-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">When</th>
              <th className="px-4 py-2 text-left">Resource</th>
              <th className="px-4 py-2 text-left">Action</th>
              <th className="px-4 py-2 text-left">Outcome</th>
              <th className="px-4 py-2 text-left">Actor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {snapshot.recentEvents.map((e) => (
              <tr key={`${e.occurredAt}-${e.resourceType}-${e.action}-${e.resourceName ?? ''}`}>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200 font-mono text-xs">{new Date(e.occurredAt).toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{e.resourceType}{e.resourceName ? ` · ${e.resourceName}` : ''}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{e.action}</td>
                <td className="px-4 py-2"><OutcomeBadge outcome={e.outcome} /></td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200 font-mono text-xs">{e.userId ?? '—'}</td>
              </tr>
            ))}
            {snapshot.recentEvents.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">No recent security events.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function SshBadge({ mode }: { mode: NodeSecuritySnapshot['ssh']['restrictionMode'] }) {
  switch (mode) {
    case 'public':
      return <Badge tone="bad" icon={XCircle}>public</Badge>;
    case 'mesh-only':
      return <Badge tone="good" icon={Lock}>mesh only</Badge>;
    case 'trusted-only':
      return <Badge tone="good" icon={Lock}>trusted only</Badge>;
    case 'mesh-and-trusted':
      return <Badge tone="good" icon={Lock}>mesh + trusted</Badge>;
  }
}

function SshdFlagCell({ value, good }: { value: string | null; good: string }) {
  if (value === null) return <span className="text-gray-400">unset</span>;
  const ok = value.toLowerCase() === good.toLowerCase();
  return (
    <span className={ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
      {value}
    </span>
  );
}

function StaleBadge() {
  return <Badge tone="warn" icon={Clock}>stale &gt; 5min</Badge>;
}

function FreshBadge({ ts }: { ts: string | null }) {
  if (!ts) return <span className="text-gray-400">—</span>;
  const ageSec = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  return <span className="text-xs text-gray-600 dark:text-gray-400">{ageSec}s ago</span>;
}

function OutcomeBadge({ outcome }: { outcome: 'success' | 'failure' | 'unknown' }) {
  if (outcome === 'success') return <Badge tone="good" icon={CheckCircle2}>success</Badge>;
  if (outcome === 'failure') return <Badge tone="bad" icon={XCircle}>failure</Badge>;
  return <Badge tone="warn" icon={Info}>unknown</Badge>;
}

function Badge({ tone, icon: Icon, children }: { tone: 'good' | 'bad' | 'warn'; icon: React.ComponentType<{ size?: number }>; children: React.ReactNode }) {
  const cls =
    tone === 'good'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
      : tone === 'bad'
        ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon size={12} />
      {children}
    </span>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  subtle,
  variant,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  subtle: string;
  variant: 'good' | 'bad' | 'warn';
}) {
  const tone =
    variant === 'good'
      ? 'border-emerald-200 dark:border-emerald-700'
      : variant === 'bad'
        ? 'border-red-300 dark:border-red-700'
        : 'border-amber-300 dark:border-amber-700';
  return (
    <div className={`rounded-lg border ${tone} bg-white dark:bg-gray-800 p-4`}>
      <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
        <Icon size={14} />
        {label}
      </div>
      <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-2">{value}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{subtle}</div>
    </div>
  );
}

function Phase2Card({
  icon: Icon,
  title,
  ok,
  metric,
  note,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  ok: boolean;
  metric: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          <Icon size={16} />
          {title}
        </div>
        {ok ? <CheckCircle2 size={16} className="text-emerald-500" /> : <AlertTriangle size={16} className="text-amber-500" />}
      </div>
      <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-2">{metric}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{note}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      <div className="text-xs uppercase text-gray-600 dark:text-gray-400">{label}</div>
      <div className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-1">{value}</div>
    </div>
  );
}

function FindingRow({ finding }: { finding: CisFinding }) {
  const tone = severityTone(finding.severity);
  const Icon = finding.passing ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 last:border-0 py-2">
      <div className="flex items-center gap-2">
        <Icon size={14} className={finding.passing ? 'text-emerald-500' : tone.text} />
        <code className="text-xs text-gray-500">{finding.id}</code>
        <span className="text-sm text-gray-900 dark:text-gray-100">{finding.title}</span>
      </div>
      <div className="text-xs text-gray-500">
        observed: <code>{finding.observed}</code> · expected: <code>{finding.expected}</code>
      </div>
    </div>
  );
}

function severityTone(s: CisSeverity): { text: string } {
  switch (s) {
    case 'critical':
      return { text: 'text-red-600 dark:text-red-400' };
    case 'high':
      return { text: 'text-red-500 dark:text-red-300' };
    case 'medium':
      return { text: 'text-amber-500 dark:text-amber-300' };
    case 'low':
      return { text: 'text-blue-500 dark:text-blue-300' };
    default:
      return { text: 'text-gray-500' };
  }
}

function SkeletonLoader() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="h-24 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      <div className="h-48 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
    </div>
  );
}

// ─── Lockdown runbook modal ─────────────────────────────────────────────

function SshLockdownModal({ node, onClose }: { node: NodeSecuritySnapshot; onClose: () => void }) {
  const [typedHostname, setTypedHostname] = useState('');
  const [ackConsole, setAckConsole] = useState(false);
  // Require a concrete interface name — provider name alone is not
  // valid input for `bootstrap.sh --ssh-via-mesh <iface>`. Without
  // an interfaceName the runbook can't generate a working command.
  const mesh = node.mesh.provider !== 'none' && node.mesh.interfaceName !== null ? node.mesh : null;
  const canReveal = mesh !== null && typedHostname === node.name && ackConsole;
  const command = mesh
    ? `bash bootstrap.sh \\\n  --rejoin \\\n  --ssh-via-mesh ${mesh.interfaceName}`
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-lg bg-white dark:bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Restrict SSH to mesh on {node.name}</h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="px-5 py-4 space-y-4 text-sm">
          {mesh === null ? (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-3 text-red-700 dark:text-red-300">
              <strong>No mesh interface detected on this node.</strong> Enabling SSH-via-mesh would lock you out.
              Install one of NetBird / Tailscale / WireGuard on this node and let the probe re-detect (60s) before
              continuing.
            </div>
          ) : (
            <>
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 text-amber-800 dark:text-amber-200">
                <strong>This command changes the host firewall.</strong> If your mesh isn't actually reachable from your
                workstation, you'll be locked out of SSH on this node. Confirm console / KVM / cloud-rescue access
                BEFORE running.
              </div>

              <ol className="list-decimal pl-5 space-y-2 text-gray-800 dark:text-gray-200">
                <li>Detected mesh interface: <code className="text-xs">{mesh.interfaceName ?? mesh.provider}</code> ({mesh.provider}) with IP <code className="text-xs">{mesh.interfaceIp ?? 'unknown'}</code>.</li>
                <li>Confirm your workstation can reach <code className="text-xs">{node.name}</code> via the mesh.</li>
                <li>Run the command below on the node. SSH service is NOT restarted — only the firewall rule is rewritten.</li>
                <li>Probe will re-publish within 60s. Refresh this page to confirm <code className="text-xs">SSH</code> badge flipped to <em>mesh + trusted</em>.</li>
              </ol>

              <div>
                <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Type the node hostname to confirm</label>
                <input
                  type="text"
                  value={typedHostname}
                  onChange={(e) => setTypedHostname(e.target.value)}
                  placeholder={node.name}
                  className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                  data-testid="lockdown-confirm-input"
                />
              </div>
              <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                <input
                  type="checkbox"
                  checked={ackConsole}
                  onChange={(e) => setAckConsole(e.target.checked)}
                  className="mt-1"
                  data-testid="lockdown-ack-console"
                />
                I have verified I can access this node via console / KVM / cloud rescue if SSH-via-mesh fails.
              </label>

              {canReveal && (
                <div className="rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase text-gray-600 dark:text-gray-400">Run on {node.name}</span>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(command)}
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400"
                      data-testid="lockdown-copy-command"
                    >
                      <Copy size={12} /> Copy
                    </button>
                  </div>
                  <pre className="text-xs font-mono text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{command}</pre>
                </div>
              )}
            </>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function InstallSnippets() {
  return (
    <div className="space-y-3" data-testid="install-snippets">
      <details className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
        <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">NetBird</summary>
        <pre className="mt-2 text-xs font-mono text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{`curl -fsSL https://pkgs.netbird.io/install.sh | sh
netbird up --management-url https://<your-mgmt-url> --setup-key <KEY>`}</pre>
      </details>
      <details className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
        <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">Tailscale</summary>
        <pre className="mt-2 text-xs font-mono text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{`curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key=<KEY>`}</pre>
      </details>
      <details className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
        <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">WireGuard (self-hosted)</summary>
        <pre className="mt-2 text-xs font-mono text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{`# Debian/Ubuntu
apt-get install -y wireguard
# Put your config at /etc/wireguard/wg0.conf, then:
systemctl enable --now wg-quick@wg0`}</pre>
      </details>
    </div>
  );
}

// ─── WAF Events tab ─────────────────────────────────────────────────────
//
// Cluster-wide view of ModSec/CRS events from the waf_logs table. Includes
// admin/api/client-host events that have no per-tenant ingress_route — those
// are invisible in the per-route /tenants/.../waf-logs endpoint and were the
// motivation for this tab (e.g. the 930120 LFI FP on POST
// /admin/system-backup/dr-drill/runs on 2026-05-19).

const SINCE_OPTIONS: ReadonlyArray<{ readonly label: string; readonly seconds: number }> = [
  { label: 'Last hour', seconds: 3_600 },
  { label: 'Last 24 hours', seconds: 86_400 },
  { label: 'Last 7 days', seconds: 604_800 },
  { label: 'All', seconds: 0 },
];

const SEVERITY_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: '' | WafEventSeverity }> = [
  { label: 'All severities', value: '' },
  { label: 'Critical only', value: 'critical' },
  { label: 'Warning only', value: 'warning' },
  { label: 'Info only', value: 'info' },
];

const SCOPE_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: '' | WafEventScope }> = [
  { label: 'All scopes', value: '' },
  { label: 'Admin/platform hosts only', value: 'admin-host' },
  { label: 'Tenant routes only', value: 'tenant-route' },
];

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

function WafEventsTab() {
  const [ruleId, setRuleId] = useState('');
  const [severity, setSeverity] = useState<'' | WafEventSeverity>('');
  const [host, setHost] = useState('');
  const [scope, setScope] = useState<'' | WafEventScope>('');
  const [sinceSeconds, setSinceSeconds] = useState(86_400);
  const [live, setLive] = useState(false);
  // Lifted to tab-level so the BanIpModal can render once and survive
  // any WafEventRow re-mounting from the 30s refetch.
  const [banModalPrefill, setBanModalPrefill] = useState<{ value: string; reason: string } | null>(null);

  // Debounce text inputs so a keystroke doesn't fan out into one request per
  // character — the backend would re-run the same expensive cluster-wide
  // query 13 times for "admin.example".
  const debouncedRuleId = useDebouncedValue(ruleId, 400);
  const debouncedHost = useDebouncedValue(host, 400);

  const query: WafEventsQuery = useMemo(() => {
    const q: WafEventsQuery = { sinceSeconds, limit: 200 };
    if (debouncedRuleId.trim()) q.ruleId = debouncedRuleId.trim();
    if (severity) q.severity = severity;
    if (debouncedHost.trim()) q.host = debouncedHost.trim();
    if (scope) q.scope = scope;
    return q;
  }, [debouncedRuleId, severity, debouncedHost, scope, sinceSeconds]);

  const { data, isLoading, isError, isFetching, error, refetch } = useWafEvents(query, { live });
  const payload: WafEventsResponse | undefined = data?.data;
  const refresh = useRefreshWafScraper();

  const onRefresh = () => {
    // 1. Trigger an inline scrape cycle (server rate-limits to 1/3s).
    // 2. Refetch the listing immediately — don't wait for the polling tick.
    refresh.mutate(undefined, { onSettled: () => { void refetch(); } });
  };

  return (
    <section className="space-y-4" data-testid="waf-events-tab">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm text-gray-700 dark:text-gray-200">
        Cluster-wide WAF events from the ModSecurity / OWASP CRS rule engine.
        Includes <strong>admin/api/client/platform-host</strong> events that have
        no per-tenant ingress route (e.g. CRS rule 930120 blocking
        <code className="text-xs mx-1">POST /admin/system-backup/dr-drill/runs</code>),
        plus the same per-route events surfaced under each Domain.
        Scraper polls the <code className="text-xs">modsec-crs</code> pod every 30s;
        admin-host events are capped at 500 globally, per-route at 50.
      </div>

      {/* Scraper-status banner — explains an empty table BEFORE the operator wonders. */}
      {payload?.scraperStatus && (
        <WafScraperStatusBanner
          status={payload.scraperStatus}
          eventsInView={payload.events.length}
          lastInsertAt={payload.stats.mostRecentAt}
        />
      )}

      {/* Live-tail + refresh controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3" data-testid="waf-controls">
        <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <span>
            Auto-refresh:{' '}
            <span className={live ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-gray-700 dark:text-gray-300'}>
              {live ? 'live (3s)' : '30s'}
            </span>
          </span>
          {isFetching && <span className="text-brand-600 dark:text-brand-400">· reloading…</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className={[
              'inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium',
              live
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-700'
                : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700',
            ].join(' ')}
            data-testid="waf-live-toggle"
            aria-pressed={live}
          >
            {live ? <Pause size={14} /> : <Play size={14} />}
            {live ? 'Stop live tail' : 'Live tail'}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="waf-refresh-now"
            title="Force a scrape cycle now (rate-limited to once per 3s)"
          >
            <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
            Refresh now
          </button>
        </div>
      </div>

      {/* Stats panel */}
      {payload?.stats && <WafStatsPanel stats={payload.stats} />}

      {/* Filter bar */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3" data-testid="waf-filters">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Rule ID(s)" hint="comma-separated">
            <input
              type="text"
              value={ruleId}
              onChange={(e) => setRuleId(e.target.value)}
              placeholder="930120,931100"
              className="w-40 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm font-mono"
              data-testid="waf-filter-rule"
            />
          </FilterField>
          <FilterField label="Severity">
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as '' | WafEventSeverity)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="waf-filter-severity"
            >
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Host substring">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="admin."
              className="w-44 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm font-mono"
              data-testid="waf-filter-host"
            />
          </FilterField>
          <FilterField label="Scope">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as '' | WafEventScope)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="waf-filter-scope"
            >
              {SCOPE_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Window">
            <select
              value={sinceSeconds}
              onChange={(e) => setSinceSeconds(Number(e.target.value))}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="waf-filter-since"
            >
              {SINCE_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>{o.label}</option>
              ))}
            </select>
          </FilterField>
          <button
            type="button"
            onClick={() => { setRuleId(''); setSeverity(''); setHost(''); setScope(''); setSinceSeconds(86_400); }}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            data-testid="waf-filter-clear"
          >
            <Filter size={12} /> Clear filters
          </button>
        </div>
      </div>

      {isLoading && <SkeletonLoader />}
      {isError && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load WAF events: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {payload && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center justify-between">
            <span>Events ({payload.events.length}{payload.truncated ? '+' : ''})</span>
            {payload.truncated && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Result capped — narrow filters to see older events
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="waf-events-table">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">When</th>
                  <th className="px-4 py-2 text-left">Rule</th>
                  <th className="px-4 py-2 text-left">Severity</th>
                  <th className="px-4 py-2 text-left">Host</th>
                  <th className="px-4 py-2 text-left">Source IP</th>
                  <th className="px-4 py-2 text-left">Request</th>
                  <th className="px-4 py-2 text-left">Message</th>
                  <th className="px-4 py-2 text-left">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {payload.events.map((ev) => (
                  <WafEventRow
                    key={ev.id}
                    ev={ev}
                    onBan={(ip) => setBanModalPrefill({ value: ip, reason: `WAF: rule ${ev.ruleId} on ${ev.hostname} (${ev.requestMethod ?? 'GET'} ${ev.requestUri ?? '/'})` })}
                  />
                ))}
                {payload.events.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500 text-sm">
                      <WafEmptyState
                        scraperStatus={payload.scraperStatus}
                        lastInsertAt={payload.stats.mostRecentAt}
                        hasActiveFilters={Boolean(ruleId || severity || host || scope)}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {banModalPrefill && (
        <BanIpModal
          // key forces remount when the operator clicks "Ban IP" on a different
          // WAF row while the modal is already open from a previous row —
          // without it, the modal's internal state would still hold the first
          // row's prefill values.
          key={`${banModalPrefill.value}|${banModalPrefill.reason}`}
          prefill={banModalPrefill}
          onClose={() => setBanModalPrefill(null)}
        />
      )}
    </section>
  );
}

function ageSeconds(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// Distinguishes the three reasons an operator might see "no events":
//   1. modsec-crs pod not running         → scraper has nothing to read
//   2. scraper hasn't fired its first cycle yet (≤15s after process boot)
//   3. scraper is healthy but cluster is genuinely quiet
function WafScraperStatusBanner({
  status,
  eventsInView,
  lastInsertAt,
}: {
  status: WafScraperStatus;
  eventsInView: number;
  lastInsertAt: string | null;
}) {
  const intervalS = Math.round(status.scrapeIntervalMs / 1000);
  const sinceLastRun = ageSeconds(status.lastRunAt);
  const sinceLastInsert = ageSeconds(lastInsertAt);

  // Healthy + recent insert + table populated = happy path, suppress banner
  // so it doesn't add visual noise to an operator who is just browsing.
  if (status.hasRunOnce && status.modsecPodFound && eventsInView > 0) {
    return null;
  }

  let variant: 'good' | 'warn' | 'bad' = 'warn';
  let title = '';
  let detail: React.ReactNode = null;

  if (!status.hasRunOnce) {
    variant = 'warn';
    title = 'Scraper has not run yet';
    detail = <>The platform-api scheduler fires its first cycle ~15s after process start. If you just rolled out the deployment, give it a moment.</>;
  } else if (!status.modsecPodFound) {
    variant = 'bad';
    title = 'modsec-crs pod not found';
    detail = (
      <>
        The scraper ran <span className="font-medium">{sinceLastRun !== null ? formatAge(sinceLastRun) : 'recently'}</span> but found no pod with{' '}
        <code className="text-xs">app=modsec-crs</code> in the <code className="text-xs">traefik</code> namespace.
        This is normal in single-node clusters where the anti-affinity replicas=2 doesn't satisfy.
        Without it, no events will be captured.
      </>
    );
  } else if (eventsInView === 0 && sinceLastInsert !== null && sinceLastInsert > 24 * 3600) {
    variant = 'good';
    title = 'No events in window';
    detail = (
      <>
        Scraper is healthy (last cycle {sinceLastRun !== null ? formatAge(sinceLastRun) : 'unknown'}, every {intervalS}s) — no CRS rules fired in the selected window.
        Most-recent event was {formatAge(sinceLastInsert)}; widen the Window filter to see it.
      </>
    );
  } else if (eventsInView === 0) {
    variant = 'good';
    title = 'Scraper healthy — cluster is quiet';
    detail = (
      <>
        Last cycle {sinceLastRun !== null ? formatAge(sinceLastRun) : 'unknown'} (every {intervalS}s). No CRS rules fired during the current window — that's a good sign.
      </>
    );
  } else {
    return null;
  }

  const tone =
    variant === 'good' ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-700 text-emerald-900 dark:text-emerald-100' :
    variant === 'warn' ? 'border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 text-amber-900 dark:text-amber-100' :
                         'border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 text-red-900 dark:text-red-100';
  const Icon = variant === 'good' ? CheckCircle2 : variant === 'warn' ? Clock : AlertTriangle;

  return (
    <div className={`rounded-lg border p-4 ${tone}`} data-testid="waf-scraper-status">
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0" />
        <div className="flex-1 text-sm">
          <div className="font-semibold mb-1">{title}</div>
          <div className="text-xs leading-relaxed">{detail}</div>
          {status.lastCycleErrors.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer font-medium">
                Last cycle errors ({status.lastCycleErrors.length})
              </summary>
              <ul className="mt-1 list-disc pl-5 font-mono text-[11px]">
                {status.lastCycleErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function WafEmptyState({
  scraperStatus,
  lastInsertAt,
  hasActiveFilters,
}: {
  scraperStatus: WafScraperStatus;
  lastInsertAt: string | null;
  hasActiveFilters: boolean;
}) {
  const sinceLastInsert = ageSeconds(lastInsertAt);
  if (!scraperStatus.hasRunOnce) {
    return <span>Waiting for the first scraper cycle.</span>;
  }
  if (!scraperStatus.modsecPodFound) {
    return <span>No <code className="text-xs">modsec-crs</code> pod available — see status banner above.</span>;
  }
  if (hasActiveFilters) {
    return (
      <span>
        No events match the current filters
        {lastInsertAt && ` — last scraper write was ${formatAge(sinceLastInsert ?? 0)}`}.
        Clear filters to see the full window.
      </span>
    );
  }
  if (!lastInsertAt) {
    return <span>Scraper is healthy but no CRS rules have fired yet (table is empty).</span>;
  }
  return (
    <span>
      No events in the selected window. Last scraper write was {formatAge(sinceLastInsert ?? 0)} — widen the Window filter to see it.
    </span>
  );
}

function WafStatsPanel({ stats }: { stats: WafEventsResponse['stats'] }) {
  const hours = Math.round(stats.windowSeconds / 3_600);
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="waf-stats-panel">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <Activity size={14} /> Events ({hours}h)
        </div>
        <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-2">
          {stats.totalEvents.toLocaleString()}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {stats.totalEventsAdminHost.toLocaleString()} admin / {stats.totalEventsTenantRoute.toLocaleString()} tenant
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <ShieldAlert size={14} /> Top rules ({hours}h)
        </div>
        <ul className="mt-2 space-y-1 text-xs" data-testid="waf-top-rules">
          {stats.topRules.length === 0 && <li className="text-gray-500">No events in window</li>}
          {stats.topRules.slice(0, 5).map((r) => (
            <li key={r.ruleId} className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-gray-700 dark:text-gray-200 shrink-0">{r.ruleId}</span>
              <span className="truncate text-gray-600 dark:text-gray-400 text-[11px] flex-1" title={r.sampleMessage}>{r.sampleMessage}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100 shrink-0">{r.count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <Globe size={14} /> Top hosts ({hours}h)
        </div>
        <ul className="mt-2 space-y-1 text-xs" data-testid="waf-top-hosts">
          {stats.topHosts.length === 0 && <li className="text-gray-500">No events in window</li>}
          {stats.topHosts.slice(0, 5).map((h) => (
            <li key={`${h.hostname}-${h.scope}`} className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-gray-700 dark:text-gray-200 truncate" title={h.hostname}>{h.hostname || '(empty)'}</span>
              <span className="text-[10px] uppercase text-gray-500 shrink-0">{h.scope === 'admin-host' ? 'admin' : 'tenant'}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100 shrink-0">{h.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function WafEventRow({ ev, onBan }: { ev: WafEvent; onBan: (ip: string) => void }) {
  const sevTone =
    ev.severity === 'critical'
      ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200'
      : ev.severity === 'warning'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
        : 'bg-gray-100 text-gray-700 dark:bg-gray-700/40 dark:text-gray-300';
  // Don't offer a Ban button for the parser's "no IP extractable" placeholder.
  const banAvailable = Boolean(ev.sourceIp && ev.sourceIp !== '0.0.0.0');
  return (
    <tr>
      <td className="px-4 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-200 whitespace-nowrap">
        {new Date(ev.occurredAt).toISOString().replace('T', ' ').slice(0, 19)}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{ev.ruleId}</td>
      <td className="px-4 py-2">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${sevTone}`}>
          {ev.severity}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">
        <span className="font-mono">{ev.hostname || '(unknown)'}</span>
        {ev.scope === 'admin-host' && (
          <span className="ml-1 text-[9px] uppercase text-amber-700 dark:text-amber-300">admin</span>
        )}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{ev.sourceIp || '—'}</td>
      <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">
        {ev.requestMethod ? `${ev.requestMethod} ` : ''}{ev.requestUri || '/'}
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">{ev.message}</td>
      <td className="px-4 py-2">
        {banAvailable && (
          <button
            type="button"
            onClick={() => onBan(ev.sourceIp as string)}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40"
            data-testid={`waf-ban-${ev.id}`}
            title={`Ban ${ev.sourceIp} via CrowdSec`}
          >
            <Ban size={11} /> Ban IP
          </button>
        )}
      </td>
    </tr>
  );
}

function FilterField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
      <span>
        {label}
        {hint && <span className="ml-1 text-[10px] text-gray-400">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

// ─── Banned IPs tab ─────────────────────────────────────────────────────
//
// Surfaces active CrowdSec decisions (community blocklist + scenario hits +
// operator-added manual bans). Enforcement is cluster-wide because the
// Traefik DaemonSet's crowdsec middleware queries the LAPI on every
// request — see backend/src/modules/security-hardening/crowdsec.ts.

const DURATION_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: '1 hour', value: '1h' },
  { label: '4 hours', value: '4h' },
  { label: '12 hours', value: '12h' },
  { label: '1 day', value: '24h' },
  { label: '7 days', value: '168h' },
  { label: '30 days', value: '720h' },
];

function BannedIpsTab() {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'' | CrowdsecDecisionScope>('');
  const [manualOnly, setManualOnly] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const debouncedQ = useDebouncedValue(q, 400);

  const query: CrowdsecListDecisionsQuery = useMemo(() => {
    const out: CrowdsecListDecisionsQuery = {};
    if (debouncedQ.trim()) out.q = debouncedQ.trim();
    if (scope) out.scope = scope;
    if (manualOnly) out.manualOnly = true;
    return out;
  }, [debouncedQ, scope, manualOnly]);

  const { data, isLoading, isError, error, refetch, isFetching } = useCrowdsecDecisions(query);
  const status = useCrowdsecStatus();
  const del = useDeleteCrowdsecDecision();

  const payload = data?.data;

  return (
    <section className="space-y-4" data-testid="banned-ips-tab">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm text-gray-700 dark:text-gray-200">
        Active CrowdSec ban decisions (community blocklist + scenario triggers + operator-added manual bans).
        Enforcement is cluster-wide — the <code className="text-xs">crowdsec</code> Traefik middleware queries the
        LAPI on every request, so a ban applies on every node simultaneously. Adding or removing a ban here
        propagates to all <code className="text-xs">traefik</code> DaemonSet pods within a few seconds.
      </div>

      {status.data?.data && <CrowdsecStatusPanel status={status.data.data} />}

      {/* Controls */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Search" hint="IP / CIDR / country">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="1.2.3.4 or US"
              className="w-44 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm font-mono"
              data-testid="bans-filter-q"
            />
          </FilterField>
          <FilterField label="Scope">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as '' | CrowdsecDecisionScope)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="bans-filter-scope"
            >
              <option value="">All scopes</option>
              <option value="Ip">IP</option>
              <option value="Range">Range (CIDR)</option>
              <option value="Country">Country</option>
              <option value="AS">AS</option>
            </select>
          </FilterField>
          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={manualOnly}
              onChange={(e) => setManualOnly(e.target.checked)}
              data-testid="bans-filter-manual"
            />
            Manual bans only
          </label>
        </div>
        <div className="flex items-center gap-2">
          {isFetching && <span className="text-xs text-brand-600 dark:text-brand-400">reloading…</span>}
          <button
            type="button"
            onClick={() => { void refetch(); }}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="bans-reload"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            Reload
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40"
            data-testid="bans-add-manual"
          >
            <Plus size={14} /> Add manual ban
          </button>
        </div>
      </div>

      {isLoading && <SkeletonLoader />}
      {isError && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load decisions: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {payload && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center justify-between">
            <span>Active bans ({payload.decisions.length} shown / {payload.totalActive} total)</span>
            {del.isError && (
              <span className="text-xs text-red-600 dark:text-red-400">
                Unban failed: {del.error?.message ?? 'unknown error'}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="bans-table">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Scope</th>
                  <th className="px-4 py-2 text-left">Value</th>
                  <th className="px-4 py-2 text-left">Type</th>
                  <th className="px-4 py-2 text-left">Origin</th>
                  <th className="px-4 py-2 text-left">Reason</th>
                  <th className="px-4 py-2 text-left">Time left</th>
                  <th className="px-4 py-2 text-left">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {payload.decisions.map((d) => (
                  <DecisionRow
                    key={d.id}
                    d={d}
                    onUnban={() => del.mutate(d.id)}
                    isUnbanning={del.isPending && del.variables === d.id}
                  />
                ))}
                {payload.decisions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500 text-sm">
                      {payload.totalActive > 0
                        ? 'No bans match the current filters. Clear filters to see all.'
                        : 'No active bans. The community blocklist refreshes hourly — check back, or add a manual ban above.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {addOpen && (
        <BanIpModal
          prefill={{ value: '', reason: '' }}
          onClose={() => setAddOpen(false)}
        />
      )}
    </section>
  );
}

function CrowdsecStatusPanel({ status }: { status: CrowdsecStatus }) {
  const coverageOk = status.coverage.traefikPodsTotal > 0 && status.coverage.traefikPodsCovered === status.coverage.traefikPodsTotal;
  const fullCoverage = coverageOk && status.coverage.traefikPodsTotal === status.coverage.nodesTotal;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="crowdsec-status-panel">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <ShieldAlert size={14} /> LAPI
        </div>
        <div className="text-base font-semibold mt-1 flex items-center gap-2">
          {status.lapiHealthy
            ? <span className="text-emerald-700 dark:text-emerald-300">healthy</span>
            : <span className="text-red-700 dark:text-red-300">unreachable</span>}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {status.lapiError ?? `${status.scenariosLoaded} scenarios loaded`}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Community blocklist:{' '}
          {status.communityBlocklistEnabled
            ? <span className="text-emerald-600 dark:text-emerald-400">enabled</span>
            : <span className="text-amber-600 dark:text-amber-400">disabled</span>}
          {!status.capiAuthenticated && <span className="text-amber-600 dark:text-amber-400"> (CAPI auth failed)</span>}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <Globe size={14} /> Enforcement coverage
        </div>
        <div className="text-base font-semibold mt-1">
          {fullCoverage
            ? <span className="text-emerald-700 dark:text-emerald-300">all {status.coverage.traefikPodsCovered} / {status.coverage.nodesTotal} nodes</span>
            : <span className="text-amber-700 dark:text-amber-300">{status.coverage.traefikPodsCovered} / {status.coverage.traefikPodsTotal} Traefik pods</span>}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Bouncer enforces on every Traefik replica via the crowdsec middleware.
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          modsec-crs pods: {status.coverage.modsecPodsTotal} (independent — feeds WAF Events tab)
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <Activity size={14} /> Bouncers ({status.bouncers.length})
        </div>
        <ul className="mt-2 space-y-1 text-xs" data-testid="crowdsec-bouncers">
          {status.bouncers.length === 0 && <li className="text-amber-600 dark:text-amber-400">No bouncers registered — bans won't be enforced!</li>}
          {status.bouncers.map((b) => (
            <li key={b.name} className="flex items-center justify-between gap-2">
              <span className="font-mono text-gray-700 dark:text-gray-200">{b.name}</span>
              <span className={b.online ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                {b.online ? 'online' : 'stale'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DecisionRow({ d, onUnban, isUnbanning }: { d: CrowdsecDecision; onUnban: () => void; isUnbanning: boolean }) {
  const expiresIn = d.expiresAt
    ? formatAge(Math.max(0, Math.floor((new Date(d.expiresAt).getTime() - Date.now()) / 1000))).replace(' ago', '')
    : d.duration;
  return (
    <tr>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200 whitespace-nowrap">{d.scope}</td>
      <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{d.value}</td>
      <td className="px-4 py-2 text-xs">
        <span className="inline-flex items-center rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200 px-2 py-0.5 text-[10px] font-medium">
          {d.type}{d.simulated && <span className="ml-1 opacity-70">(sim)</span>}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">
        <span className="font-mono">{d.origin || '—'}</span>
        {d.manualByOperator && <span className="ml-1 text-[9px] uppercase text-amber-700 dark:text-amber-300">manual</span>}
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200 max-w-md truncate" title={d.scenario}>{d.scenario}</td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200 whitespace-nowrap">{expiresIn}</td>
      <td className="px-4 py-2">
        <button
          type="button"
          onClick={onUnban}
          disabled={isUnbanning}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid={`bans-unban-${d.id}`}
          title={`Unban ${d.value} (decision id ${d.id})`}
        >
          <Trash2 size={11} /> {isUnbanning ? 'Unbanning…' : 'Unban'}
        </button>
      </td>
    </tr>
  );
}

// ─── Shared Ban-IP modal (used by WAF Events row + Banned IPs tab) ──────

function BanIpModal({
  prefill,
  onClose,
}: {
  prefill: { value: string; reason: string };
  onClose: () => void;
}) {
  const [value, setValue] = useState(prefill.value);
  const [scope, setScope] = useState<CrowdsecDecisionScope>('Ip');
  const [duration, setDuration] = useState('4h');
  const [reason, setReason] = useState(prefill.reason);
  const add = useAddCrowdsecBan();

  const valid = /^[a-fA-F0-9.:/]+$/.test(value) && value.length >= 1 && reason.trim().length >= 3;

  const onSubmit = () => {
    if (!valid) return;
    add.mutate(
      { value, scope, duration, reason: reason.trim() },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 shadow-xl" data-testid="ban-ip-modal">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Ban IP (CrowdSec)</h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <div>
            <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">IP / CIDR</label>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="1.2.3.4 or 1.2.3.0/24"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono"
              data-testid="ban-modal-value"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as CrowdsecDecisionScope)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                data-testid="ban-modal-scope"
              >
                <option value="Ip">IP</option>
                <option value="Range">Range (CIDR)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Duration</label>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                data-testid="ban-modal-duration"
              >
                {DURATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for the ban — surfaced in the decisions list"
              rows={3}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              data-testid="ban-modal-reason"
            />
            <div className="text-[10px] text-gray-500 mt-1">
              Will be stored as <code>admin-panel:&lt;your-userId&gt;:{reason.trim() || '<reason>'}</code> so it's
              distinguishable from automatic bans.
            </div>
          </div>
          {add.isError && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-2 text-xs text-red-700 dark:text-red-300">
              {add.error?.message ?? 'Ban failed'}
            </div>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!valid || add.isPending}
            className="rounded-md px-3 py-1.5 text-sm border border-red-300 bg-red-600 dark:bg-red-700 text-white hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50"
            data-testid="ban-modal-submit"
          >
            {add.isPending ? 'Banning…' : 'Ban'}
          </button>
        </div>
      </div>
    </div>
  );
}
