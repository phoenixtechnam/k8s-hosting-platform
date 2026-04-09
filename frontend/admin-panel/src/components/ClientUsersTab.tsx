import { useState, type FormEvent } from 'react';
import {
  Users, Plus, Loader2, AlertCircle, Trash2, X, Edit2,
  Power, PowerOff, KeyRound, CheckCircle, Info,
} from 'lucide-react';
import {
  useAdminSubUsers,
  useAdminCreateSubUser,
  useAdminUpdateSubUser,
  useAdminResetSubUserPassword,
  useAdminDeleteSubUser,
  type SubUser,
  type SubUserRole,
} from '@/hooks/use-sub-users';

/**
 * Phase 5: admin panel per-client user management. Lives inside the
 * ClientDetail page as a tab. Functionally mirrors the client-panel
 * SubUsers page but runs with an admin JWT so staff can manage a
 * client's team on their behalf — useful for support cases and
 * initial onboarding.
 */

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const ROLE_LABELS: Record<SubUserRole, string> = {
  client_admin: 'Admin',
  client_user: 'Member',
};

const ROLE_BADGE_CLASSES: Record<SubUserRole, string> = {
  client_admin: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  client_user: 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
};

export default function ClientUsersTab({ clientId }: { readonly clientId: string }) {
  const { data, isLoading, isError } = useAdminSubUsers(clientId);
  const createUser = useAdminCreateSubUser(clientId);
  const updateUser = useAdminUpdateSubUser(clientId);
  const resetPassword = useAdminResetSubUserPassword(clientId);
  const deleteUser = useAdminDeleteSubUser(clientId);

  const users = data?.data ?? [];
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<SubUser | null>(null);
  const [resetPasswordUser, setResetPasswordUser] = useState<SubUser | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [disableConfirmId, setDisableConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState<{
    email: string;
    full_name: string;
    password: string;
    role_name: SubUserRole;
  }>({ email: '', full_name: '', password: '', role_name: 'client_user' });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createUser.mutateAsync(form);
      setForm({ email: '', full_name: '', password: '', role_name: 'client_user' });
      setShowForm(false);
    } catch {
      // Error surfaces via createUser.error
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteUser.mutateAsync(id);
      setDeleteConfirmId(null);
    } catch {
      // Error surfaces via deleteUser.error
    }
  };

  const handleToggleStatus = async (u: SubUser) => {
    // Enable is non-destructive; disable requires confirmation.
    if (u.status === 'active') {
      setDisableConfirmId(u.id);
      return;
    }
    try {
      await updateUser.mutateAsync({
        userId: u.id,
        patch: { status: 'active' },
      });
    } catch {
      // surfaced via updateUser.error
    }
  };

  const handleConfirmDisable = async (id: string) => {
    try {
      await updateUser.mutateAsync({
        userId: id,
        patch: { status: 'disabled' },
      });
      setDisableConfirmId(null);
    } catch {
      // Leave the confirm open for retry.
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="client-users-loading">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" data-testid="client-users-error">
        Failed to load client users.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="client-users-tab">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Client Team</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Manage this client&apos;s team members on their behalf. Actions
            taken here are recorded in the audit log and attributed to your
            staff account.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((prev) => !prev)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          aria-label={showForm ? 'Cancel add user' : 'Add user'}
          data-testid="client-users-add-button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add User'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4"
          data-testid="client-users-create-form"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Full Name</label>
              <input
                type="text"
                className={INPUT_CLASS + ' mt-1'}
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                required
                data-testid="client-users-name-input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Email</label>
              <input
                type="email"
                className={INPUT_CLASS + ' mt-1'}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                data-testid="client-users-email-input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Password</label>
              <input
                type="password"
                className={INPUT_CLASS + ' mt-1'}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                minLength={8}
                data-testid="client-users-password-input"
              />
            </div>
            <div>
              <label htmlFor="client-users-role" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Role</label>
              <select
                id="client-users-role"
                className={INPUT_CLASS + ' mt-1'}
                value={form.role_name}
                onChange={(e) => setForm({ ...form, role_name: e.target.value as SubUserRole })}
                data-testid="client-users-role-select"
              >
                <option value="client_user">Member (read-only)</option>
                <option value="client_admin">Administrator (can manage team)</option>
              </select>
            </div>
          </div>
          {createUser.error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600">
              <AlertCircle size={14} />
              {createUser.error instanceof Error ? createUser.error.message : 'Failed'}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={createUser.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="client-users-submit"
            >
              {createUser.isPending && <Loader2 size={14} className="animate-spin" />}
              Add User
            </button>
          </div>
        </form>
      )}

      {users.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 py-12 text-center" data-testid="client-users-empty">
          <Users size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
          <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No team members yet</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            This client has not provisioned any sub-users.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800" data-testid="client-users-table">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Name</th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Email</th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Role</th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Status</th>
                <th className="hidden px-6 py-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 sm:table-cell">Last Login</th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                  <td className="px-6 py-4 font-medium text-gray-900 dark:text-gray-100">{u.fullName}</td>
                  <td className="px-6 py-4 text-gray-600 dark:text-gray-400">{u.email}</td>
                  <td className="px-6 py-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE_CLASSES[u.roleName as SubUserRole] ?? ROLE_BADGE_CLASSES.client_user}`}>
                      {ROLE_LABELS[u.roleName as SubUserRole] ?? u.roleName}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${u.status === 'active' ? 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-50 text-gray-600 dark:bg-gray-700 dark:text-gray-400'}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="hidden px-6 py-4 text-gray-500 dark:text-gray-400 sm:table-cell">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-6 py-4">
                    {deleteConfirmId === u.id ? (
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() => handleDelete(u.id)}
                          disabled={deleteUser.isPending}
                          className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          data-testid={`client-users-delete-confirm-${u.id}`}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(null)}
                          className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : disableConfirmId === u.id ? (
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() => handleConfirmDisable(u.id)}
                          disabled={updateUser.isPending}
                          className="rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                          data-testid={`client-users-disable-confirm-${u.id}`}
                        >
                          Disable
                        </button>
                        <button
                          type="button"
                          onClick={() => setDisableConfirmId(null)}
                          className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingUser(u)}
                          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          aria-label="Edit user"
                          title="Edit user"
                          data-testid={`client-users-edit-${u.id}`}
                        >
                          <Edit2 size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setResetPasswordUser(u)}
                          className="rounded-md border border-purple-200 dark:border-purple-700 bg-white dark:bg-gray-800 p-1.5 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30"
                          aria-label="Reset password"
                          title="Reset password"
                          data-testid={`client-users-reset-${u.id}`}
                        >
                          <KeyRound size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(u)}
                          disabled={updateUser.isPending}
                          className={`rounded-md border p-1.5 ${u.status === 'active' ? 'border-amber-200 dark:border-amber-700 bg-white dark:bg-gray-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30' : 'border-emerald-200 dark:border-emerald-700 bg-white dark:bg-gray-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30'} disabled:opacity-50`}
                          aria-label={u.status === 'active' ? 'Disable user' : 'Enable user'}
                          title={u.status === 'active' ? 'Disable user' : 'Enable user'}
                          data-testid={`client-users-toggle-${u.id}`}
                        >
                          {u.status === 'active' ? <PowerOff size={12} /> : <Power size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(u.id)}
                          className="rounded-md border border-red-200 dark:border-red-700 bg-white dark:bg-gray-800 p-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                          aria-label="Delete user"
                          title="Delete user"
                          data-testid={`client-users-delete-${u.id}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSave={async (patch) => {
            try {
              await updateUser.mutateAsync({ userId: editingUser.id, patch });
              setEditingUser(null);
            } catch {
              // surfaced via updateUser.error in the modal
            }
          }}
          isPending={updateUser.isPending}
          error={updateUser.error}
        />
      )}

      {resetPasswordUser && (
        <ResetPasswordModal
          user={resetPasswordUser}
          onClose={() => {
            setResetPasswordUser(null);
            resetPassword.reset();
          }}
          onSave={async (newPassword) => {
            try {
              await resetPassword.mutateAsync({
                userId: resetPasswordUser.id,
                newPassword,
              });
            } catch {
              // surfaced via resetPassword.error
            }
          }}
          isPending={resetPassword.isPending}
          isSuccess={resetPassword.isSuccess}
          error={resetPassword.error}
        />
      )}
    </div>
  );
}

function EditUserModal({
  user,
  onClose,
  onSave,
  isPending,
  error,
}: {
  readonly user: SubUser;
  readonly onClose: () => void;
  readonly onSave: (patch: { full_name?: string; role_name?: SubUserRole; status?: 'active' | 'disabled' }) => Promise<void>;
  readonly isPending: boolean;
  readonly error: Error | null;
}) {
  const [fullName, setFullName] = useState(user.fullName);
  const [roleName, setRoleName] = useState<SubUserRole>((user.roleName as SubUserRole) ?? 'client_user');
  const [status, setStatus] = useState<'active' | 'disabled'>(
    user.status === 'disabled' ? 'disabled' : 'active',
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const patch: { full_name?: string; role_name?: SubUserRole; status?: 'active' | 'disabled' } = {};
    if (fullName !== user.fullName) patch.full_name = fullName;
    if (roleName !== user.roleName) patch.role_name = roleName;
    if (status !== user.status) patch.status = status;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    void onSave(patch);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="client-users-edit-modal"
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Team Member</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Email</label>
            <input
              type="email"
              value={user.email}
              disabled
              className={INPUT_CLASS + ' mt-1 opacity-60 cursor-not-allowed'}
            />
          </div>
          <div>
            <label htmlFor="edit-full-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Full Name</label>
            <input
              id="edit-full-name"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              maxLength={255}
              className={INPUT_CLASS + ' mt-1'}
              data-testid="client-users-edit-name-input"
            />
          </div>
          <div>
            <label htmlFor="edit-role" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Role</label>
            <select
              id="edit-role"
              value={roleName}
              onChange={(e) => setRoleName(e.target.value as SubUserRole)}
              className={INPUT_CLASS + ' mt-1'}
              data-testid="client-users-edit-role-select"
            >
              <option value="client_user">Member (read-only)</option>
              <option value="client_admin">Administrator (can manage team)</option>
            </select>
          </div>
          <div>
            <label htmlFor="edit-status" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Status</label>
            <select
              id="edit-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
              className={INPUT_CLASS + ' mt-1'}
              data-testid="client-users-edit-status-select"
            >
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle size={14} />
              {error instanceof Error ? error.message : 'Failed to update user'}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="client-users-edit-save"
            >
              {isPending && <Loader2 size={14} className="animate-spin" />}
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onSave,
  isPending,
  isSuccess,
  error,
}: {
  readonly user: SubUser;
  readonly onClose: () => void;
  readonly onSave: (newPassword: string) => Promise<void>;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly error: Error | null;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mismatchError, setMismatchError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setMismatchError(null);
    if (newPassword !== confirmPassword) {
      setMismatchError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setMismatchError('Password must be at least 8 characters');
      return;
    }
    void onSave(newPassword);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="client-users-reset-modal"
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Reset Password</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {isSuccess ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-4 py-3 text-sm text-green-700 dark:text-green-300" data-testid="client-users-reset-success">
              <CheckCircle size={16} className="mt-0.5 shrink-0" />
              <div>
                Password updated for <strong>{user.fullName}</strong>. Share the
                new password with them securely — it is not shown again.
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                data-testid="client-users-reset-done"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
              <Info size={14} className="mt-0.5 shrink-0" />
              <div>
                Setting a new password for <strong>{user.fullName}</strong>
                {' '}({user.email}). The user is not notified automatically.
                This action is recorded in the audit log.
              </div>
            </div>
            <div>
              <label htmlFor="admin-reset-new-password" className="block text-xs font-medium text-gray-700 dark:text-gray-300">New Password</label>
              <input
                id="admin-reset-new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                maxLength={255}
                className={INPUT_CLASS + ' mt-1'}
                data-testid="client-users-reset-new-input"
              />
            </div>
            <div>
              <label htmlFor="admin-reset-confirm-password" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Confirm New Password</label>
              <input
                id="admin-reset-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                maxLength={255}
                className={INPUT_CLASS + ' mt-1'}
                data-testid="client-users-reset-confirm-input"
              />
            </div>
            {mismatchError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="client-users-reset-mismatch-error">
                <AlertCircle size={14} />
                {mismatchError}
              </div>
            )}
            {error && !mismatchError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <AlertCircle size={14} />
                {error instanceof Error ? error.message : 'Failed to reset password'}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isPending}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="client-users-reset-save"
              >
                {isPending && <Loader2 size={14} className="animate-spin" />}
                Reset Password
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
