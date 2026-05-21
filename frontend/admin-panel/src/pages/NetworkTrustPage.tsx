/**
 * Network Trust — Security Hub → Network Trust (2026-05-21).
 *
 * Renamed from `ClusterNetworkingSettings.tsx`. Three tabs:
 *   1. Trusted Ranges   — CRUD ClusterTrustedRange CRs (host firewall trust)
 *   2. Pending Peers    — CRUD ClusterPendingPeer CRs + bootstrap command
 *   3. Trusted Proxies  — operator-managed upstream-proxy CIDRs for the
 *                          nginx + Traefik reverse-proxy layer (moved from
 *                          /nodes-and-storage's Trusted Proxies tab)
 *
 * Both reconciler-backed tabs (trusted-ranges, pending-peers) poll on
 * a short interval (5–30s) so the operator sees the reconciler's
 * status writes (Synced / Failed / Claimed) live.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Network,
  Plus,
  Trash2,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  X,
  Loader2,
} from 'lucide-react';
import {
  useTrustedRanges,
  useCreateTrustedRange,
  useDeleteTrustedRange,
  usePendingPeers,
  useCreatePendingPeer,
  useDeletePendingPeer,
  fetchBootstrapCommand,
} from '@/hooks/use-cluster-network';
import type { TrustedRange, PendingPeer, BootstrapCommandResponse } from '@k8s-hosting/api-contracts';
import TrustedProxiesCard from '@/components/TrustedProxiesCard';

type TabId = 'trusted-ranges' | 'pending-peers' | 'trusted-proxies';

const VALID_TABS: ReadonlySet<TabId> = new Set(['trusted-ranges', 'pending-peers', 'trusted-proxies']);

export default function NetworkTrustPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab: TabId = useMemo(() => {
    if (requested && VALID_TABS.has(requested as TabId)) return requested as TabId;
    return 'trusted-ranges';
  }, [requested]);
  const setActiveTab = (id: TabId): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <Network size={24} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Network Trust</h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
          Manage trust for the always-on set-mode cluster firewall + the reverse-proxy layer.
          <strong> Trusted ranges</strong> open full TCP/UDP from operator-blessed IPs/CIDRs (workstations, private LANs, monitoring scrapers).
          <strong> Pending peers</strong> pre-authorise a node's IP on every existing peer so its k3s join handshake reaches :6443 before kube-API knows it exists.
          <strong> Trusted proxies</strong> tell nginx + Traefik which upstream CIDRs (CDN, L7 LB, floating-IP gateway) may set <code>X-Forwarded-For</code>, so the real client IP propagates to CrowdSec / audit logs / rate limiting.
        </p>
      </header>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-1 -mb-px" data-testid="cluster-network-tabs">
          {(
            [
              { id: 'trusted-ranges' as const, label: 'Trusted Ranges' },
              { id: 'pending-peers' as const, label: 'Pending Peers' },
              { id: 'trusted-proxies' as const, label: 'Trusted Proxies' },
            ]
          ).map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={[
                  'px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
                  isActive
                    ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                    : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-600',
                ].join(' ')}
                data-testid={`cluster-network-tab-${t.id}`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === 'trusted-ranges' && <TrustedRangesTab />}
      {activeTab === 'pending-peers' && <PendingPeersTab />}
      {activeTab === 'trusted-proxies' && <TrustedProxiesCard />}
    </div>
  );
}

// ─── Trusted ranges tab ──────────────────────────────────────────────────

function TrustedRangesTab() {
  const list = useTrustedRanges();
  const create = useCreateTrustedRange();
  const del = useDeleteTrustedRange();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [cidr, setCidr] = useState('');
  const [description, setDescription] = useState('');

  const ranges = list.data?.data?.data ?? [];

  const handleAdd = async (): Promise<void> => {
    try {
      await create.mutateAsync({ name, cidr, description });
      setShowAdd(false);
      setName('');
      setCidr('');
      setDescription('');
    } catch {
      // mutation error stays on the form
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {list.isLoading ? 'Loading…' : `${ranges.length} trusted range${ranges.length === 1 ? '' : 's'}`}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => list.refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <RefreshCw size={14} className={list.isFetching ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 px-3 py-1.5 text-sm font-medium text-white"
            data-testid="add-trusted-range"
          >
            <Plus size={14} />
            Add Trusted Range
          </button>
        </div>
      </div>

      {list.error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span>{list.error.message}</span>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              <Th>Name</Th>
              <Th>CIDR</Th>
              <Th>Family</Th>
              <Th>Description</Th>
              <Th>Status</Th>
              <Th>Added By</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            {ranges.length === 0 && !list.isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                  No trusted ranges configured. Click <strong>Add Trusted Range</strong> to seed your workstation IP or a private LAN CIDR.
                </td>
              </tr>
            ) : (
              ranges.map((r) => <TrustedRangeRow key={r.name} range={r} onDelete={(name) => del.mutate(name)} />)
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal title="Add Trusted Range" onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <Field label="Name" hint="lowercase letters, digits, hyphens (e.g. nyc-office, monitoring-scraper)">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. nyc-office"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              />
            </Field>
            <Field label="CIDR or IP" hint="bare IPv4/v6 implies /32 or /128. /0 not allowed.">
              <input
                value={cidr}
                onChange={(e) => setCidr(e.target.value)}
                placeholder="e.g. 198.51.100.7 or 10.0.0.0/16"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono"
              />
            </Field>
            <Field label="Description (optional)" hint="Operator-readable purpose">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. NYC office VPN, on-call monitoring scraper"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              />
            </Field>
            {create.error && (
              <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-2 text-sm text-red-700 dark:text-red-300">
                {create.error.message}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="rounded-lg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={create.isPending || !name || !cidr}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 px-3 py-1.5 text-sm font-medium text-white"
              >
                {create.isPending && <Loader2 size={14} className="animate-spin" />}
                Add
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TrustedRangeRow({ range, onDelete }: { range: TrustedRange; onDelete: (name: string) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
      <Td>
        <span className="font-medium text-gray-900 dark:text-gray-100">{range.name}</span>
      </Td>
      <Td>
        <span className="font-mono text-xs">{range.cidr}</span>
      </Td>
      <Td>
        <FamilyBadge family={range.family} />
      </Td>
      <Td>
        <span className="text-gray-600 dark:text-gray-400">{range.description || '—'}</span>
      </Td>
      <Td>
        <ReadyBadge ready={range.ready} reason={range.readyReason} message={range.readyMessage} />
      </Td>
      <Td>
        <span className="text-gray-500 dark:text-gray-400 text-xs">{range.addedBy || '—'}</span>
      </Td>
      <Td>
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onDelete(range.name);
                setConfirmDelete(false);
              }}
              className="rounded px-2 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
            aria-label="Delete trusted range"
          >
            <Trash2 size={14} />
          </button>
        )}
      </Td>
    </tr>
  );
}

// ─── Pending peers tab ───────────────────────────────────────────────────

function PendingPeersTab() {
  const list = usePendingPeers();
  const create = useCreatePendingPeer();
  const del = useDeletePendingPeer();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [hostname, setHostname] = useState('');
  const [role, setRole] = useState<'server' | 'worker'>('worker');
  const [ttlMinutes, setTtlMinutes] = useState<number>(30);
  const [showCmd, setShowCmd] = useState<string | null>(null);

  const peers = list.data?.data?.data ?? [];

  const handleAdd = async (): Promise<void> => {
    try {
      await create.mutateAsync({ name, ip, hostname, role, ttlSeconds: ttlMinutes * 60 });
      setShowAdd(false);
      setName('');
      setIp('');
      setHostname('');
      setRole('worker');
      setTtlMinutes(30);
    } catch {
      // mutation error stays on the form
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {list.isLoading ? 'Loading…' : `${peers.length} pending peer${peers.length === 1 ? '' : 's'} (TTL-enforced; auto-cleared after claim)`}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => list.refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <RefreshCw size={14} className={list.isFetching ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 px-3 py-1.5 text-sm font-medium text-white"
            data-testid="add-pending-peer"
          >
            <Plus size={14} />
            Pre-Enroll Node
          </button>
        </div>
      </div>

      {list.error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          <AlertCircle size={16} className="inline mr-1" />
          {list.error.message}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              <Th>Name</Th>
              <Th>IP</Th>
              <Th>Role</Th>
              <Th>Hostname</Th>
              <Th>Expires</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            {peers.length === 0 && !list.isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                  No pending peers. Click <strong>Pre-Enroll Node</strong> to add a node's IP to the cluster_peers nft set on every existing node before its k3s join.
                </td>
              </tr>
            ) : (
              peers.map((p) => (
                <PendingPeerRow
                  key={p.name}
                  peer={p}
                  onDelete={(n) => del.mutate(n)}
                  onShowCommand={() => setShowCmd(p.name)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal title="Pre-Enroll Node" onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <Field label="Name" hint="lowercase letters, digits, hyphens">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. worker-3"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              />
            </Field>
            <Field label="IP" hint="Bare IPv4 or IPv6 of the node about to bootstrap">
              <input
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="e.g. 10.0.0.5"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono"
              />
            </Field>
            <Field label="Role">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'server' | 'worker')}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              >
                <option value="worker">Worker</option>
                <option value="server">Server (control-plane)</option>
              </select>
            </Field>
            <Field label="Hostname (optional)" hint="UI label only; the actual k8s node name is determined by k3s">
              <input
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="e.g. worker-3.dc1"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              />
            </Field>
            <Field label="TTL (minutes)" hint="Window for the bootstrap to complete. After expiry the IP is removed from cluster_peers and the CR deleted.">
              <input
                type="number"
                value={ttlMinutes}
                min={1}
                max={1440}
                onChange={(e) => setTtlMinutes(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              />
            </Field>
            {create.error && (
              <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-2 text-sm text-red-700 dark:text-red-300">
                {create.error.message}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="rounded-lg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={create.isPending || !name || !ip}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 px-3 py-1.5 text-sm font-medium text-white"
              >
                {create.isPending && <Loader2 size={14} className="animate-spin" />}
                Pre-Enroll
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showCmd && <BootstrapCommandModal cppName={showCmd} onClose={() => setShowCmd(null)} />}
    </div>
  );
}

function PendingPeerRow({
  peer,
  onDelete,
  onShowCommand,
}: {
  peer: PendingPeer;
  onDelete: (name: string) => void;
  onShowCommand: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const claimed = !!peer.claimedAt;
  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
      <Td>
        <span className="font-medium text-gray-900 dark:text-gray-100">{peer.name}</span>
      </Td>
      <Td>
        <span className="font-mono text-xs">{peer.ip}</span>
      </Td>
      <Td>
        <span className="text-xs uppercase text-gray-600 dark:text-gray-400">{peer.role}</span>
      </Td>
      <Td>
        <span className="text-gray-600 dark:text-gray-400">{peer.hostname || '—'}</span>
      </Td>
      <Td>
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {peer.expiresAt ? new Date(peer.expiresAt).toLocaleString() : '—'}
        </span>
      </Td>
      <Td>
        {claimed ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
            <CheckCircle2 size={12} />
            Claimed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            <Clock size={12} />
            Pending
          </span>
        )}
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          {!claimed && (
            <button
              type="button"
              onClick={onShowCommand}
              className="rounded px-2 py-1 text-xs text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20"
            >
              Get bootstrap command
            </button>
          )}
          {confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => {
                  onDelete(peer.name);
                  setConfirmDelete(false);
                }}
                className="rounded px-2 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
              aria-label="Delete pending peer"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </Td>
    </tr>
  );
}

function BootstrapCommandModal({ cppName, onClose }: { cppName: string; onClose: () => void }) {
  const [data, setData] = useState<BootstrapCommandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchBootstrapCommand(cppName)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cppName]);

  return (
    <Modal title={`Bootstrap command — ${cppName}`} onClose={onClose}>
      {loading && (
        <div className="flex items-center gap-2 py-6 text-sm text-gray-500">
          <Loader2 size={14} className="animate-spin" />
          Fetching command…
        </div>
      )}
      {error && (
        <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {data && (
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              Run this on your workstation
            </h3>
            <CodeBlock text={data.bootstrapCommand} />
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Replace the token placeholder by running <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">cat /var/lib/rancher/k3s/server/node-token</code> on
              the existing peer at <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">{data.serverIp}</code>.
            </p>
          </div>

          {data.preAuthCommand && (
            <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
                Break-glass: pre-authorise on every existing peer
              </summary>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                The reconciler propagates the pending-peer entry within ~30s. If the bootstrap is faster, run
                this command on your workstation first to pre-authorise on every peer:
              </p>
              <div className="mt-2">
                <CodeBlock text={data.preAuthCommand} />
              </div>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── shared atoms ────────────────────────────────────────────────────────

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {children}
    </th>
  );
}

function Td({ children }: { children?: React.ReactNode }) {
  return <td className="px-4 py-2">{children}</td>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog">
      <div className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function FamilyBadge({ family }: { family: 'v4' | 'v6' | null }) {
  if (!family) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  return (
    <span
      className={[
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        family === 'v4'
          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
          : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
      ].join(' ')}
    >
      {family.toUpperCase()}
    </span>
  );
}

function ReadyBadge({
  ready,
  reason,
  message,
}: {
  ready: 'True' | 'False' | 'Unknown';
  reason: string | null;
  message: string | null;
}) {
  if (ready === 'True') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300"
        title={message ?? reason ?? ''}
      >
        <CheckCircle2 size={12} />
        Synced
      </span>
    );
  }
  if (ready === 'False') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300"
        title={message ?? reason ?? ''}
      >
        <AlertCircle size={12} />
        {reason ?? 'Failed'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400">
      <Clock size={12} />
      Pending
    </span>
  );
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="relative rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3">
      <pre className="overflow-x-auto text-xs font-mono text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-all">
        {text}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 inline-flex items-center gap-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        <Copy size={12} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
