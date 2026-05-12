// Manage the per-deployment PAT (private registry credential).
// Three states:
//   - none on file: register form
//   - registered:   show last-4-of-token + rotate / revoke buttons
//   - submitting:   spinner

import { useState } from 'react';
import { KeyRound, Loader2, Trash2, X } from 'lucide-react';
import { useAttachPullCredential, usePullCredential, useRevokePullCredential } from '@/hooks/use-custom-deployments';
import { Tooltip } from '@/components/ui/Tooltip';

interface Props {
  readonly clientId: string;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly onClose: () => void;
}

export function PrivateRegistryPanel({ clientId, deploymentId, deploymentName, onClose }: Props) {
  const { data, isLoading, refetch } = usePullCredential(clientId, deploymentId);
  const attach = useAttachPullCredential(clientId);
  const revoke = useRevokePullCredential(clientId);

  const [registryHost, setRegistryHost] = useState('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await attach.mutateAsync({
        id: deploymentId,
        input: { registry_host: registryHost, username, token },
      });
      setToken('');
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'attach failed');
    }
  };

  const onRevoke = async () => {
    setError(null);
    if (!confirm('Revoke this PAT? The Pod will lose access to the private registry on next pull.')) return;
    try {
      await revoke.mutateAsync(deploymentId);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'revoke failed');
    }
  };

  const existing = data?.data;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-gray-500" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Private registry</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={18} />
          </button>
        </header>
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          Stored encrypted at rest. The platform renders this as a <code className="font-mono">kubernetes.io/dockerconfigjson</code> Secret in the tenant namespace.
        </p>

        {isLoading && <Loader2 size={16} className="mx-auto animate-spin text-gray-400" />}

        {existing && (
          <div className="mb-4 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Current</div>
            <div className="font-mono text-gray-700 dark:text-gray-200">
              {existing.username}@{existing.registryHost}
              <span className="ml-2 text-xs text-gray-400">…{existing.tokenLastFour}</span>
            </div>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={onRevoke}
                disabled={revoke.isPending}
                className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20"
              >
                <Trash2 size={12} /> {revoke.isPending ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-1">
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Registry host</label>
              <Tooltip text="Hostname of your container registry (e.g. ghcr.io, registry.hub.docker.com, registry.example.com). The credential is scoped to this host — only image pulls from this hostname use this token." />
            </div>
            <input type="text" value={registryHost} onChange={(e) => setRegistryHost(e.target.value)} placeholder="ghcr.io" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
          </div>
          <div>
            <div className="flex items-center gap-1">
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Username</label>
              <Tooltip text="Your registry account username, GitHub handle, or service account name. Combined with the token to form the pull secret." />
            </div>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="my-github-handle" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
          </div>
          <div>
            <div className="flex items-center gap-1">
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Token (PAT)</label>
              <Tooltip text="A Personal Access Token or robot account password with at least package:read scope. Stored AES-256 encrypted at rest and never returned in full — only the last 4 characters are shown after saving. If the token is lost or expired, rotate it here." />
            </div>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_…" autoComplete="off" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" data-testid="custom-pat-token" />
            <span className="mt-1 block text-[10px] text-gray-500 dark:text-gray-400">Never logged. Returned to API responses only as last 4 chars.</span>
          </div>
        </div>

        {error && <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
            Close
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!registryHost || !username || !token || attach.isPending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="custom-pat-submit"
          >
            {attach.isPending ? 'Saving…' : existing ? 'Rotate' : 'Save'}
          </button>
        </div>
        <p className="mt-3 text-[10px] text-gray-400 dark:text-gray-500">Deployment: <span className="font-mono">{deploymentName}</span></p>
      </div>
    </div>
  );
}
