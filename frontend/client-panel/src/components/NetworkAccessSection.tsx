import { useState, useEffect, type FormEvent } from 'react';
import { Globe, Network, Share2, Loader2, AlertCircle, ExternalLink, CheckCircle, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useDeploymentNetworkAccess,
  useUpsertDeploymentNetworkAccess,
} from '@/hooks/use-deployment-network-access';
import { useZitiProviders } from '@/hooks/use-ziti-providers';
import { useZrokProviders } from '@/hooks/use-zrok-providers';
import type {
  DeploymentNetworkAccessInput,
  NetworkAccessMode,
} from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

interface Props {
  readonly clientId: string;
  readonly deploymentId: string;
  readonly deploymentName: string;
}

const MODE_INFO: Record<NetworkAccessMode, { label: string; icon: typeof Globe; description: string }> = {
  public: {
    label: 'Public',
    icon: Globe,
    description: 'Standard public Ingress with HTTPS + LE cert. Anyone on the internet can reach the app.',
  },
  tunneler: {
    label: 'Ziti Tunneler',
    icon: Network,
    description: 'App is advertised as a Ziti service. Public Ingress is suppressed; end users must run a Ziti tunneler on their device to reach the app via the mesh.',
  },
  zrok: {
    label: 'zrok Private Share',
    icon: Share2,
    description: 'App is exposed as a zrok private share. Public hostname keeps working but only zrok-authenticated callers (zrok access private) reach the upstream.',
  },
};

export default function NetworkAccessSection({ clientId, deploymentId, deploymentName }: Props) {
  const { data: existing, isLoading } = useDeploymentNetworkAccess(clientId, deploymentId);
  const { data: zitiProviders } = useZitiProviders(clientId);
  const { data: zrokProviders } = useZrokProviders(clientId);
  const upsert = useUpsertDeploymentNetworkAccess(clientId, deploymentId);

  const [mode, setMode] = useState<NetworkAccessMode>('public');
  const [zitiProviderId, setZitiProviderId] = useState('');
  const [zitiServiceName, setZitiServiceName] = useState('');
  const [zrokProviderId, setZrokProviderId] = useState('');
  const [zrokShareToken, setZrokShareToken] = useState('');
  const [passIdentityHeaders, setPassIdentityHeaders] = useState(true);

  useEffect(() => {
    if (!existing) return;
    setMode(existing.mode);
    setZitiProviderId(existing.zitiProviderId ?? '');
    setZitiServiceName(existing.zitiServiceName ?? '');
    setZrokProviderId(existing.zrokProviderId ?? '');
    setZrokShareToken(existing.zrokShareToken ?? '');
    setPassIdentityHeaders(existing.passIdentityHeaders);
  }, [existing]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input: DeploymentNetworkAccessInput = {
      mode,
      ...(mode === 'tunneler' ? {
        zitiProviderId: zitiProviderId || null,
        zitiServiceName: zitiServiceName || null,
      } : {}),
      ...(mode === 'zrok' ? {
        zrokProviderId: zrokProviderId || null,
        zrokShareToken: zrokShareToken || null,
      } : {}),
      passIdentityHeaders,
    };
    await upsert.mutateAsync(input);
  }

  if (isLoading) {
    return (
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <Loader2 size={14} className="animate-spin" />
      </section>
    );
  }

  const ModeIcon = MODE_INFO[mode].icon;
  const isMeshOnly = existing?.publicIngressSuppressed ?? false;

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5" data-testid="network-access-section">
      <div className="mb-4 flex items-center gap-2">
        <ModeIcon size={18} className="text-gray-600 dark:text-gray-400" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Network Access</h3>
        {existing?.provisioned && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 px-2 py-0.5 text-xs">
            <CheckCircle size={12} /> mesh-proxy ready
          </span>
        )}
      </div>

      {isMeshOnly && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>
            Public Ingress is suppressed for <strong>{deploymentName}</strong>. End users
            cannot reach this app via public DNS — they must be on the Ziti mesh.
          </span>
        </div>
      )}

      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Controls how this app is reachable on the network. Mode applies to ALL ingress routes
        pointing at the deployment.
      </p>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(Object.keys(MODE_INFO) as NetworkAccessMode[]).map((m) => {
            const info = MODE_INFO[m];
            const Icon = info.icon;
            return (
              <label
                key={m}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition ${
                  mode === m
                    ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-700'
                    : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <input
                  type="radio"
                  name="network-mode"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="mt-1 h-4 w-4"
                  data-testid={`network-mode-${m}`}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                    <Icon size={14} /> {info.label}
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{info.description}</p>
                </div>
              </label>
            );
          })}
        </div>

        {mode === 'tunneler' && (
          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">Ziti Settings</legend>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">Pick a registered Ziti controller.</p>
              <Link
                to="/settings/openziti-providers"
                className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Manage providers <ExternalLink size={12} />
              </Link>
            </div>
            <div>
              <label className={LABEL_CLASS}>Ziti Provider</label>
              <select
                className={INPUT_CLASS}
                value={zitiProviderId}
                onChange={(e) => setZitiProviderId(e.target.value)}
                required={mode === 'tunneler'}
                data-testid="network-ziti-provider"
              >
                <option value="">— pick a provider —</option>
                {(zitiProviders ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {p.controllerUrl}</option>
                ))}
              </select>
              {(!zitiProviders || zitiProviders.length === 0) && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  No providers yet. <Link to="/settings/openziti-providers" className="text-blue-600 hover:underline">Create one →</Link>
                </p>
              )}
            </div>
            <div>
              <label className={LABEL_CLASS}>Ziti Service Name</label>
              <input
                className={INPUT_CLASS}
                value={zitiServiceName}
                onChange={(e) => setZitiServiceName(e.target.value)}
                required={mode === 'tunneler'}
                placeholder="my-internal-app"
                data-testid="network-ziti-service-name"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                The name of the Ziti service to bind to (must already exist on your Ziti controller).
              </p>
            </div>
          </fieldset>
        )}

        {mode === 'zrok' && (
          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">zrok Settings</legend>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">Pick a registered zrok account.</p>
              <Link
                to="/settings/zrok-providers"
                className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Manage providers <ExternalLink size={12} />
              </Link>
            </div>
            <div>
              <label className={LABEL_CLASS}>zrok Account</label>
              <select
                className={INPUT_CLASS}
                value={zrokProviderId}
                onChange={(e) => setZrokProviderId(e.target.value)}
                required={mode === 'zrok'}
                data-testid="network-zrok-provider"
              >
                <option value="">— pick an account —</option>
                {(zrokProviders ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {p.controllerUrl}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS}>zrok Share Token</label>
              <input
                className={INPUT_CLASS}
                value={zrokShareToken}
                onChange={(e) => setZrokShareToken(e.target.value)}
                required={mode === 'zrok'}
                placeholder="abc123de"
                data-testid="network-zrok-share-token"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                The private share token end users will use with <code>zrok access private &lt;token&gt;</code>.
              </p>
            </div>
          </fieldset>
        )}

        {(mode === 'tunneler' || mode === 'zrok') && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={passIdentityHeaders}
              onChange={(e) => setPassIdentityHeaders(e.target.checked)}
              className="h-4 w-4 rounded"
            />
            <span className="text-sm text-gray-900 dark:text-gray-100">
              Forward mesh identity headers to upstream
            </span>
          </label>
        )}

        {existing?.lastError && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
            <AlertCircle size={14} className="mt-0.5" />
            <span>Last reconcile error: {existing.lastError}</span>
          </div>
        )}

        {upsert.error != null && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
            <AlertCircle size={14} className="mt-0.5" />
            <span>{upsert.error instanceof Error ? upsert.error.message : String(upsert.error)}</span>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="network-access-save"
          >
            {upsert.isPending && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
