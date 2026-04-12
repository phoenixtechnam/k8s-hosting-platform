import { useState, type FormEvent } from 'react';
import {
  HardDrive, Plus, Trash2, Loader2, AlertCircle, X, Copy, Check,
  RefreshCw, Shield, Clock, KeyRound, ChevronDown, ChevronUp,
} from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useCanManage } from '@/hooks/use-can-manage';
import {
  useSftpUsers, useCreateSftpUser, useUpdateSftpUser,
  useDeleteSftpUser, useRotateSftpPassword, useSftpConnectionInfo,
  useSftpAuditLog, type SftpUser,
} from '@/hooks/use-sftp-users';
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
      // Fallback for non-HTTPS contexts
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

function StatusBadge({ enabled, expiresAt }: { enabled: boolean; expiresAt: string | null }) {
  const expired = expiresAt && new Date(expiresAt) < new Date();
  if (!enabled || expired) {
    return <span className="inline-flex items-center rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">{expired ? 'Expired' : 'Disabled'}</span>;
  }
  return <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">Active</span>;
}

function ConnectionInfoCard({ clientId }: { clientId: string }) {
  const { data } = useSftpConnectionInfo(clientId);
  const info = data?.data;
  if (!info) return null;

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-blue-800 dark:text-blue-300 flex items-center gap-2">
        <Shield size={16} /> Connection Details
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <span className="text-gray-500 dark:text-gray-400">Host</span>
          <div className="font-mono text-gray-900 dark:text-gray-100 flex items-center">{info.host}<CopyButton value={info.host} /></div>
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">SSH Port</span>
          <div className="font-mono text-gray-900 dark:text-gray-100 flex items-center">{info.port}<CopyButton value={String(info.port)} /></div>
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">FTPS Port</span>
          <div className="font-mono text-gray-900 dark:text-gray-100 flex items-center">{info.ftps_port}<CopyButton value={String(info.ftps_port)} /></div>
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">Protocols</span>
          <div className="text-gray-900 dark:text-gray-100">{info.protocols.join(', ').toUpperCase()}</div>
        </div>
      </div>

      {/* Password-based examples */}
      <div className="space-y-1 text-xs font-mono text-gray-600 dark:text-gray-400">
        <p className="text-xs font-sans font-medium text-gray-500 dark:text-gray-400 mb-1">Password authentication:</p>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 w-12 flex-shrink-0">SFTP</span> {info.instructions.sftp}
          <CopyButton value={info.instructions.sftp} />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 w-12 flex-shrink-0">SCP</span> {info.instructions.scp}
          <CopyButton value={info.instructions.scp} />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 w-12 flex-shrink-0">rsync</span> {info.instructions.rsync}
          <CopyButton value={info.instructions.rsync} />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 w-12 flex-shrink-0">FTPS</span> {info.instructions.ftps}
          <CopyButton value={info.instructions.ftps} />
        </div>
      </div>

      {/* Key-based examples */}
      <div className="space-y-1 text-xs font-mono text-gray-600 dark:text-gray-400">
        <p className="text-xs font-sans font-medium text-gray-500 dark:text-gray-400 mb-1">SSH key authentication (SFTP, SCP, rsync only):</p>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 w-12 flex-shrink-0">SFTP</span> {info.instructions.sftp_key}
          <CopyButton value={info.instructions.sftp_key} />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 w-12 flex-shrink-0">SCP</span> {info.instructions.scp_key}
          <CopyButton value={info.instructions.scp_key} />
        </div>
      </div>

      {/* SSH key note */}
      <p className="text-xs text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
        <KeyRound size={12} /> {info.ssh_key_note}
      </p>
    </div>
  );
}

function AuditLogSection({ clientId }: { clientId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useSftpAuditLog(clientId, 20);
  const entries = data?.data ?? [];

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between p-4 text-left"
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Clock size={16} /> Recent Activity
        </h3>
        {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>
      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4">
          {isLoading ? (
            <Loader2 className="mx-auto animate-spin text-gray-400" size={20} />
          ) : entries.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">No activity recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-2 py-1.5 text-left">Event</th>
                    <th className="px-2 py-1.5 text-left">Protocol</th>
                    <th className="px-2 py-1.5 text-left">Source IP</th>
                    <th className="px-2 py-1.5 text-left">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="px-2 py-1.5">
                        <span className={clsx(
                          'inline-block rounded px-1.5 py-0.5 font-medium',
                          e.event === 'FAILED_AUTH' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' :
                          e.event === 'CONNECT' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
                          'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
                        )}>
                          {e.event}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300 uppercase">{e.protocol}</td>
                      <td className="px-2 py-1.5 font-mono text-gray-600 dark:text-gray-400">{e.sourceIp}</td>
                      <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400">{new Date(e.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SftpUsers() {
  const { clientId } = useClientContext();
  const canManage = useCanManage();
  const { data, isLoading } = useSftpUsers(clientId ?? undefined);
  const createUser = useCreateSftpUser(clientId ?? undefined);
  const updateUser = useUpdateSftpUser(clientId ?? undefined);
  const deleteUser = useDeleteSftpUser(clientId ?? undefined);
  const rotatePassword = useRotateSftpPassword(clientId ?? undefined);

  const [showForm, setShowForm] = useState(false);
  const [description, setDescription] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState<{ password: string; username: string } | null>(null);
  const [rotateUserId, setRotateUserId] = useState<string | null>(null);
  const [rotatedPassword, setRotatedPassword] = useState<string | null>(null);

  const usersRaw = data?.data ?? [];
  const { sortedData: users, sortKey, sortDirection, onSort } = useSortable(usersRaw, 'username');

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await createUser.mutateAsync({
        description: description.trim() || undefined,
      });
      const created = result.data as SftpUser & { password?: string };
      setNewPassword({ password: created.password ?? '', username: created.username });
      setDescription('');
      setShowForm(false);
    } catch { /* surfaced via createUser.error */ }
  };

  const handleToggleEnabled = (user: SftpUser) => {
    updateUser.mutate({ userId: user.id, input: { enabled: !user.enabled } });
  };

  const handleDelete = (userId: string) => {
    deleteUser.mutate(userId, { onSuccess: () => setDeleteConfirmId(null) });
  };

  const handleRotate = async (userId: string) => {
    try {
      const result = await rotatePassword.mutateAsync({ userId });
      setRotatedPassword(result.data.password);
      setRotateUserId(userId);
    } catch { /* surfaced via rotatePassword.error */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <HardDrive size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="sftp-heading">
          SFTP Access
        </h1>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Manage file transfer users for your deployments. Supports SFTP, SCP, rsync (with password or SSH key), and FTPS (password only).
        Files uploaded here appear in the web file manager and vice versa.
      </p>

      {clientId && <ConnectionInfoCard clientId={clientId} />}

      {!canManage && <ReadOnlyNotice />}

      {/* New password alert */}
      {newPassword && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">User created. Save these credentials — the password won't be shown again.</p>
              <div className="mt-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-600 dark:text-amber-400 w-16">Username</span>
                  <code className="rounded bg-amber-100 dark:bg-amber-800/40 px-3 py-1 text-sm font-mono text-amber-900 dark:text-amber-200">{newPassword.username}</code>
                  <CopyButton value={newPassword.username} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-600 dark:text-amber-400 w-16">Password</span>
                  <code className="rounded bg-amber-100 dark:bg-amber-800/40 px-3 py-1 text-sm font-mono text-amber-900 dark:text-amber-200">{newPassword.password}</code>
                  <CopyButton value={newPassword.password} />
                </div>
              </div>
            </div>
            <button type="button" onClick={() => setNewPassword(null)} className="text-amber-400 hover:text-amber-600"><X size={16} /></button>
          </div>
        </div>
      )}

      {/* Rotated password alert */}
      {rotatedPassword && rotateUserId && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Password rotated. Save the new password — it won't be shown again.</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="rounded bg-amber-100 dark:bg-amber-800/40 px-3 py-1 text-sm font-mono text-amber-900 dark:text-amber-200">{rotatedPassword}</code>
                <CopyButton value={rotatedPassword} />
              </div>
            </div>
            <button type="button" onClick={() => { setRotatedPassword(null); setRotateUserId(null); }} className="text-amber-400 hover:text-amber-600"><X size={16} /></button>
          </div>
        </div>
      )}

      {/* Header + Add button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="sftp-user-count">
          {usersRaw.length} user{usersRaw.length !== 1 ? 's' : ''}
        </p>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            data-testid="add-sftp-user-button"
          >
            {showForm ? <X size={14} /> : <Plus size={14} />} {showForm ? 'Cancel' : 'Add User'}
          </button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. CI/CD deployment, backup sync"
              className={INPUT_CLASS}
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            A unique username and secure password will be auto-generated.
            You can also authenticate using SSH keys from the SSH Keys page (SFTP, SCP, rsync only).
          </p>
          {createUser.error && (
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle size={14} /> {(createUser.error as Error).message}
            </p>
          )}
          <button
            type="submit"
            disabled={createUser.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {createUser.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create User
          </button>
        </form>
      )}

      {/* Users table */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="animate-spin text-brand-500" size={32} /></div>
      ) : users.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <HardDrive className="mx-auto mb-2 opacity-40" size={40} />
          <p>No file transfer users yet. Create one to enable access.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <SortableHeader label="Username" sortKey="username" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left" />
                <SortableHeader label="Status" sortKey="enabled" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left" />
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Description</th>
                <SortableHeader label="Last Login" sortKey="lastLoginAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left" />
                {canManage && <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3 font-mono text-gray-900 dark:text-gray-100">
                    <span className="flex items-center gap-2">
                      <KeyRound size={14} className="text-gray-400" />
                      {user.username}
                      <CopyButton value={user.username} />
                    </span>
                  </td>
                  <td className="px-4 py-3"><StatusBadge enabled={user.enabled} expiresAt={user.expiresAt} /></td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{user.description || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleToggleEnabled(user)}
                          className={clsx(
                            'rounded px-2 py-1 text-xs font-medium',
                            user.enabled
                              ? 'text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                              : 'text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20',
                          )}
                          title={user.enabled ? 'Disable' : 'Enable'}
                        >
                          {user.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRotate(user.id)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
                          title="Rotate password"
                        >
                          <RefreshCw size={14} />
                        </button>
                        {deleteConfirmId === user.id ? (
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => handleDelete(user.id)} className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600">Delete</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmId(user.id)}
                            className="rounded p-1 text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Audit log */}
      {clientId && <AuditLogSection clientId={clientId} />}
    </div>
  );
}
