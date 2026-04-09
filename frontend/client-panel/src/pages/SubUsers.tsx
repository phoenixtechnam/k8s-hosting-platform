import { useState, type FormEvent } from 'react';
import { Users, Plus, Loader2, AlertCircle, Trash2, X, Info } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useSubUsers,
  useCreateSubUser,
  useDeleteSubUser,
  type SubUserRole,
} from '@/hooks/use-sub-users';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

/**
 * Phase 2: canonical display labels for sub-user roles. Kept as a
 * `Record<SubUserRole, string>` so TypeScript will flag any
 * `subUserRoleSchema` expansion that forgets to add a label.
 */
const ROLE_LABELS: Record<SubUserRole, string> = {
  client_admin: 'Admin',
  client_user: 'Member',
};

const ROLE_BADGE_CLASSES: Record<SubUserRole, string> = {
  client_admin: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  client_user: 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
};

export default function SubUsers() {
  const { clientId } = useClientContext();
  const authUser = useAuth((s) => s.user);
  // Phase 1: only client_admin (and impersonating staff) can mutate
  // the team. client_user has READ access but should not see buttons
  // that would 403 on click. Backend still enforces this.
  const canManage = authUser?.role === 'client_admin';
  const { data: response, isLoading, isError } = useSubUsers(clientId);
  const createUser = useCreateSubUser(clientId);
  const deleteUser = useDeleteSubUser(clientId);

  const usersRaw = response?.data ?? [];
  const { sortedData: users, sortKey, sortDirection, onSort } = useSortable(usersRaw, 'fullName');
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
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
      // Mutation error is surfaced via `createUser.error` in the form UI
      // below — no need to re-throw, but never silently swallow without
      // the error being visible somewhere.
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteUser.mutateAsync(id);
      setDeleteConfirmId(null);
    } catch {
      // Mutation error surfaces via `deleteUser.error` (not rendered yet
      // in the row; covered by Phase 6 polish sweep). Leaving the confirm
      // open so the user can retry or cancel.
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400"><Users size={20} /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="sub-users-heading">Users</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Manage users who can access your account.</p>
          </div>
        </div>
        {canManage && (
          <button type="button" onClick={() => setShowForm((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" data-testid="add-user-button">
            {showForm ? <X size={14} /> : <Plus size={14} />} {showForm ? 'Cancel' : 'Add User'}
          </button>
        )}
      </div>

      {!canManage && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-sm text-blue-700 dark:text-blue-300" data-testid="read-only-notice">
          <Info size={16} className="mt-0.5 shrink-0" />
          <div>
            You have read-only access to the team. Only administrators can add,
            edit, or remove users. Ask a client admin to make changes.
          </div>
        </div>
      )}

      {canManage && showForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4" data-testid="create-user-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Full Name</label><input type="text" className={INPUT_CLASS + ' mt-1'} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required data-testid="user-name-input" /></div>
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Email</label><input type="email" className={INPUT_CLASS + ' mt-1'} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required data-testid="user-email-input" /></div>
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Password</label><input type="password" className={INPUT_CLASS + ' mt-1'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} data-testid="user-password-input" /></div>
            <div>
              <label htmlFor="new-user-role" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Role</label>
              <select
                id="new-user-role"
                className={INPUT_CLASS + ' mt-1'}
                value={form.role_name}
                onChange={(e) => setForm({ ...form, role_name: e.target.value as SubUserRole })}
                data-testid="user-role-select"
              >
                <option value="client_user">Member (read-only)</option>
                <option value="client_admin">Administrator (can manage team)</option>
              </select>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                Administrators can add, edit, and remove users. Members have read-only access.
              </p>
            </div>
          </div>
          {createUser.error && <div className="mt-3 flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{createUser.error instanceof Error ? createUser.error.message : 'Failed'}</div>}
          <div className="mt-3 flex justify-end">
            <button type="submit" disabled={createUser.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="submit-user">{createUser.isPending && <Loader2 size={14} className="animate-spin" />} Add User</button>
          </div>
        </form>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading && <div className="flex items-center justify-center py-16"><div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" /></div>}
        {isError && <div className="px-6 py-16 text-center text-sm text-red-600">Failed to load users.</div>}
        {!isLoading && !isError && usersRaw.length === 0 && (
          <div className="px-6 py-16 text-center"><Users size={40} className="mx-auto text-gray-300 dark:text-gray-600" /><p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No sub-users yet</p><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Add users to give team members access.</p></div>
        )}
        {!isLoading && !isError && usersRaw.length > 0 && (
          <div className="overflow-x-auto" data-testid="users-table">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                <SortableHeader label="Name" sortKey="fullName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                <SortableHeader label="Email" sortKey="email" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                <SortableHeader label="Role" sortKey="roleName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                <SortableHeader label="Last Login" sortKey="lastLoginAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden px-6 font-medium text-gray-500 dark:text-gray-400 sm:table-cell" />
                {canManage && <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>}
              </tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-gray-100">{u.fullName}</td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-400">{u.email}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE_CLASSES[u.roleName as SubUserRole] ?? ROLE_BADGE_CLASSES.client_user}`}
                      >
                        {ROLE_LABELS[u.roleName as SubUserRole] ?? u.roleName}
                      </span>
                    </td>
                    <td className="px-6 py-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${u.status === 'active' ? 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-50 text-gray-600 dark:bg-gray-700 dark:text-gray-400'}`}>{u.status}</span></td>
                    <td className="hidden px-6 py-4 text-gray-500 dark:text-gray-400 sm:table-cell">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}</td>
                    {canManage && (
                      <td className="px-6 py-4">
                        {deleteConfirmId === u.id ? (
                          <div className="inline-flex gap-1">
                            <button type="button" onClick={() => handleDelete(u.id)} disabled={deleteUser.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                          </div>
                        ) : (
                          <button type="button" onClick={() => setDeleteConfirmId(u.id)} className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30" data-testid={`delete-user-${u.id}`}><Trash2 size={12} /></button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
