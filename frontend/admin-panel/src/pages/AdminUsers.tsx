import { useState, type FormEvent } from 'react';
import { Users, Plus, Trash2, Loader2, AlertCircle, X, Edit2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import BulkActionBar, { SelectCheckbox } from '@/components/ui/BulkActionBar';
import { useAdminUsers, useCreateAdminUser, useDeleteAdminUser } from '@/hooks/use-admin-users';
import { useSelection } from '@/hooks/use-selection';
import { useBulkDeleteAdminUsers } from '@/hooks/use-bulk-admin-users';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const ROLES = [
  { value: 'admin', label: 'Admin', desc: 'Full platform management' },
  { value: 'support', label: 'Support', desc: 'Client support, read + impersonate' },
  { value: 'billing', label: 'Billing', desc: 'Billing and subscription management' },
  { value: 'read_only', label: 'Read Only', desc: 'View-only access' },
] as const;

export default function AdminUsers() {
  const { data: response, isLoading } = useAdminUsers();
  const createUser = useCreateAdminUser();
  const deleteUser = useDeleteAdminUser();
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const selection = useSelection<{ id: string }>();
  const bulkDelete = useBulkDeleteAdminUsers();

  const users = response?.data ?? [];
  const { sortedData: sortedUsers, sortKey, sortDirection, onSort } = useSortable(users, 'fullName');

  const [form, setForm] = useState({
    email: '',
    full_name: '',
    password: '',
    role_name: 'admin',
  });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createUser.mutateAsync({
        email: form.email,
        full_name: form.full_name,
        password: form.password,
        role_name: form.role_name,
      });
      setForm({ email: '', full_name: '', password: '', role_name: 'admin' });
      setShowForm(false);
    } catch { /* error shown below */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteUser.mutateAsync(id);
      setDeleteConfirmId(null);
    } catch { /* error available */ }
  };

  const handleBulkDelete = async () => {
    const ids = [...selection.selectedIds];
    try {
      await bulkDelete.mutateAsync(ids);
      selection.deselectAll();
    } finally {
      setConfirmBulkDelete(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users size={28} className="text-gray-700 dark:text-gray-300" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="admin-users-heading">Admin Users</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          data-testid="add-admin-user-button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add Admin User'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="admin-user-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="au-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label>
              <input id="au-email" type="email" className={INPUT_CLASS + ' mt-1'} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required data-testid="au-email" />
            </div>
            <div>
              <label htmlFor="au-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Full Name</label>
              <input id="au-name" className={INPUT_CLASS + ' mt-1'} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required data-testid="au-name" />
            </div>
            <div>
              <label htmlFor="au-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label>
              <input id="au-password" type="password" className={INPUT_CLASS + ' mt-1'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} data-testid="au-password" />
            </div>
            <div>
              <label htmlFor="au-role" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Role</label>
              <select id="au-role" className={INPUT_CLASS + ' mt-1'} value={form.role_name} onChange={(e) => setForm({ ...form, role_name: e.target.value })} data-testid="au-role">
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>
                ))}
              </select>
            </div>
          </div>

          {createUser.error && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{createUser.error instanceof Error ? createUser.error.message : 'Failed to create user'}</div>
          )}

          <div className="flex justify-end">
            <button type="submit" disabled={createUser.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="au-submit">
              {createUser.isPending && <Loader2 size={14} className="animate-spin" />}
              Create User
            </button>
          </div>
        </form>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>
        )}

        {!isLoading && (
          <table className="w-full" data-testid="admin-users-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th className="w-10 px-3 py-3">
                  <SelectCheckbox
                    checked={selection.isAllSelected(users)}
                    indeterminate={selection.isIndeterminate(users)}
                    onChange={() => selection.isAllSelected(users) ? selection.deselectAll() : selection.selectAll(users)}
                  />
                </th>
                <SortableHeader label="Name" sortKey="fullName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Role" sortKey="roleName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Last Login" sortKey="lastLoginAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {sortedUsers.map((user) => (
                <tr key={user.id} className={`transition-colors ${
                  selection.isSelected(user.id)
                    ? 'bg-brand-50 dark:bg-brand-900/20'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                }`}>
                  <td className="w-10 px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                    <SelectCheckbox
                      checked={selection.isSelected(user.id)}
                      onChange={() => selection.toggle(user.id)}
                    />
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{user.fullName}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{user.email}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">{user.roleName}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={user.status === 'active' ? 'active' : 'suspended'} />
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 md:table-cell">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    {deleteConfirmId === user.id ? (
                      <div className="inline-flex items-center gap-1">
                        <button type="button" onClick={() => handleDelete(user.id)} disabled={deleteUser.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm</button>
                        <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setDeleteConfirmId(user.id)} className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-admin-user-${user.id}`}>
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">No admin users found.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <BulkActionBar selectedCount={selection.selectedCount} onDeselectAll={selection.deselectAll}>
        <button
          onClick={() => setConfirmBulkDelete(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
        >
          <Trash2 size={14} />
          Delete Selected
        </button>
      </BulkActionBar>

      {confirmBulkDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setConfirmBulkDelete(false)}>
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Delete {selection.selectedCount} admin user{selection.selectedCount !== 1 ? 's' : ''}?
            </h3>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              This will permanently delete the selected admin users. This action cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setConfirmBulkDelete(false)}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDelete.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 transition-colors"
              >
                {bulkDelete.isPending && <Loader2 size={14} className="animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
