import { useState, type FormEvent } from 'react';
import { Key, Plus, Trash2, Loader2, AlertCircle, X, Copy, Check, CheckCircle } from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useCanManage } from '@/hooks/use-can-manage';
import { useSshKeys, useCreateSshKey, useUpdateSshKey, useDeleteSshKey, type SshKey } from '@/hooks/use-ssh-keys';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import ReadOnlyNotice from '@/components/ReadOnlyNotice';

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <button type="button" onClick={onClick} className="ml-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Copy">
      {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
    </button>
  );
}

export default function SshKeys() {
  const { clientId } = useClientContext();
  const canManage = useCanManage();
  const { data, isLoading } = useSshKeys(clientId ?? undefined);
  const createKey = useCreateSshKey(clientId ?? undefined);
  const updateKey = useUpdateSshKey(clientId ?? undefined);
  const deleteKey = useDeleteSshKey(clientId ?? undefined);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [editKeyId, setEditKeyId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPublicKey, setEditPublicKey] = useState('');

  const keysRaw = data?.data ?? [];
  const { sortedData: keys, sortKey, sortDirection, onSort } = useSortable(keysRaw, 'name');

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createKey.mutateAsync({
        name: name.trim(),
        public_key: publicKey.trim(),
      });
      setName('');
      setPublicKey('');
      setShowForm(false);
    } catch {
      // Error surfaced via createKey.error below
    }
  };

  const handleDelete = (keyId: string) => {
    deleteKey.mutate(keyId, {
      onSuccess: () => setDeleteConfirmId(null),
    });
  };

  const editKey = editKeyId ? keysRaw.find((k) => k.id === editKeyId) : null;

  const openEditModal = (key: SshKey) => {
    setEditKeyId(key.id);
    setEditName(key.name);
    setEditPublicKey(key.publicKey);
  };

  const handleEditSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!editKeyId) return;
    try {
      await updateKey.mutateAsync({
        keyId: editKeyId,
        input: {
          name: editName.trim(),
          public_key: editPublicKey.trim(),
        },
      });
      setEditKeyId(null);
    } catch {
      // Error surfaced via updateKey.error
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Key size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="ssh-keys-heading">
          SSH Keys
        </h1>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Deployment-scoped SSH public keys. Add a key here and the platform will
        make it available to the appropriate workload ingestion paths (e.g. Git
        deploy pull, file-manager SSH access). Private keys are never sent to the
        platform and must be kept on the machine that uses them.
      </p>

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="ssh-keys-count">
          {keysRaw.length} key{keysRaw.length !== 1 ? 's' : ''}
        </p>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            data-testid="add-ssh-key-button"
          >
            {showForm ? <X size={14} /> : <Plus size={14} />} {showForm ? 'Cancel' : 'Add SSH Key'}
          </button>
        )}
      </div>

      {!canManage && <ReadOnlyNotice message="You have read-only access to SSH keys. Adding and removing SSH keys requires administrator access." />}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4"
          data-testid="ssh-key-form"
        >
          <div>
            <label htmlFor="ssh-key-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Name
            </label>
            <input
              id="ssh-key-name"
              type="text"
              className={INPUT_CLASS + ' mt-1'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={1}
              maxLength={255}
              placeholder="laptop-alice"
              data-testid="ssh-key-name-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              A short label so you can identify which machine this key belongs to.
            </p>
          </div>
          <div>
            <label htmlFor="ssh-key-public" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Public key
            </label>
            <textarea
              id="ssh-key-public"
              className={INPUT_CLASS + ' mt-1 font-mono text-xs'}
              rows={5}
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              required
              minLength={20}
              maxLength={10000}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host"
              data-testid="ssh-key-public-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Paste the full contents of your <code>~/.ssh/id_ed25519.pub</code> (or
              <code> id_rsa.pub</code>). OpenSSH format, one line.
            </p>
          </div>
          {createKey.isError && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="ssh-key-form-error">
              <AlertCircle size={14} />
              {createKey.error instanceof Error ? createKey.error.message : 'Failed to add key'}
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={createKey.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-ssh-key"
            >
              {createKey.isPending && <Loader2 size={14} className="animate-spin" />}
              Add SSH Key
            </button>
          </div>
        </form>
      )}

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 size={20} className="animate-spin text-brand-500" />
        </div>
      )}

      {!isLoading && keysRaw.length === 0 && !showForm && (
        <div
          className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-5 py-12 text-center"
          data-testid="ssh-keys-empty"
        >
          <Key size={36} className="mx-auto text-gray-300 dark:text-gray-600" />
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            No SSH keys registered yet. Add one to enable deployment flows that
            require key-based authentication.
          </p>
        </div>
      )}

      {!isLoading && keysRaw.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <table className="w-full" data-testid="ssh-keys-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Algorithm" sortKey="keyAlgorithm" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <th className="px-5 py-3">Fingerprint</th>
                <SortableHeader label="Added" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {keys.map((k) => (
                <SshKeyRow
                  key={k.id}
                  sshKey={k}
                  deleteConfirmId={deleteConfirmId}
                  setDeleteConfirmId={setDeleteConfirmId}
                  onDelete={handleDelete}
                  deletePending={deleteKey.isPending}
                  onRowClick={openEditModal}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit modal */}
      {editKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditKeyId(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit SSH Key</h2>
              <button type="button" onClick={() => setEditKeyId(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={18} /></button>
            </div>
            <form onSubmit={handleEditSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} required minLength={1} maxLength={255} className={INPUT_CLASS} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Public Key</label>
                <textarea value={editPublicKey} onChange={(e) => setEditPublicKey(e.target.value)} required minLength={20} maxLength={10000} rows={5} className={INPUT_CLASS + ' font-mono text-xs'} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Fingerprint</label>
                <div className="flex items-center">
                  <code className="text-xs font-mono text-gray-600 dark:text-gray-400 break-all">{editKey.keyFingerprint}</code>
                  <CopyButton value={editKey.keyFingerprint} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Algorithm</label>
                <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-700 px-2.5 py-0.5 text-xs font-mono font-medium text-gray-700 dark:text-gray-300">
                  {editKey.keyAlgorithm ?? 'unknown'}
                </span>
              </div>
              {updateKey.isError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle size={14} />
                  {updateKey.error instanceof Error ? updateKey.error.message : 'Failed to update key'}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setEditKeyId(null)} className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                  Cancel
                </button>
                <button type="submit" disabled={updateKey.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                  {updateKey.isPending && <Loader2 size={14} className="animate-spin" />}
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function SshKeyRow({
  sshKey,
  deleteConfirmId,
  setDeleteConfirmId,
  onDelete,
  deletePending,
  onRowClick,
}: {
  readonly sshKey: SshKey;
  readonly deleteConfirmId: string | null;
  readonly setDeleteConfirmId: (id: string | null) => void;
  readonly onDelete: (id: string) => void;
  readonly deletePending: boolean;
  readonly onRowClick: (key: SshKey) => void;
}) {
  const isConfirming = deleteConfirmId === sshKey.id;
  const addedAt = new Date(sshKey.createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer" data-testid={`ssh-key-row-${sshKey.id}`} onClick={() => onRowClick(sshKey)}>
      <td className="px-5 py-3.5">
        <div className="font-medium text-gray-900 dark:text-gray-100">{sshKey.name}</div>
      </td>
      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
        <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-700 px-2.5 py-0.5 text-xs font-mono font-medium text-gray-700 dark:text-gray-300">
          {sshKey.keyAlgorithm ?? 'unknown'}
        </span>
      </td>
      <td className="px-5 py-3.5 text-xs">
        <div className="flex items-center gap-1">
          <code className="font-mono text-gray-600 dark:text-gray-400 break-all">{sshKey.keyFingerprint}</code>
          <span onClick={(e) => e.stopPropagation()}>
            <CopyButton value={sshKey.publicKey} />
          </span>
        </div>
      </td>
      <td className="px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400">{addedAt}</td>
      <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
        {isConfirming ? (
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => onDelete(sshKey.id)}
              disabled={deletePending}
              className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid={`ssh-key-delete-confirm-${sshKey.id}`}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setDeleteConfirmId(null)}
              className="rounded-md border border-gray-200 dark:border-gray-600 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              data-testid={`ssh-key-delete-cancel-${sshKey.id}`}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDeleteConfirmId(sshKey.id)}
            className={clsx(
              'inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400',
              'hover:bg-red-50 dark:hover:bg-red-900/30',
            )}
            data-testid={`ssh-key-delete-${sshKey.id}`}
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
      </td>
    </tr>
  );
}
