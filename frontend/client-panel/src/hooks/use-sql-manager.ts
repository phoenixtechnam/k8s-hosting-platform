import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QueryResult {
  readonly columns: string[];
  readonly rows: string[][];
  readonly rowCount: number;
  readonly executionTimeMs: number;
  readonly error?: string;
}

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly key: string;
}

interface TableDataOptions {
  readonly page?: number;
  readonly pageSize?: number;
  readonly orderBy?: string;
  readonly orderDir?: 'ASC' | 'DESC';
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

export function useExecuteQuery(clientId: string | null | undefined, deploymentId: string | undefined) {
  return useMutation({
    mutationFn: ({ database, query }: { readonly database: string; readonly query: string }) => {
      if (!clientId || !deploymentId) throw new Error('Missing client or deployment');
      return apiFetch<{ data: QueryResult }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/query`,
        { method: 'POST', body: JSON.stringify({ database, query }) },
      );
    },
  });
}

export function useListTables(
  clientId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
) {
  return useQuery({
    queryKey: ['sql-tables', clientId, deploymentId, database],
    queryFn: () =>
      apiFetch<{ data: readonly string[] }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/tables?database=${encodeURIComponent(database!)}`,
      ),
    enabled: Boolean(clientId) && Boolean(deploymentId) && Boolean(database),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always' as const,
  });
}

export function useTableStructure(
  clientId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sql-structure', clientId, deploymentId, database, table],
    queryFn: () =>
      apiFetch<{ data: readonly ColumnInfo[] }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/table-structure?database=${encodeURIComponent(database!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(clientId) && Boolean(deploymentId) && Boolean(database) && Boolean(table),
  });
}

export function useTableData(
  clientId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
  table: string | undefined,
  options: TableDataOptions = {},
) {
  const { page = 1, pageSize = 50, orderBy, orderDir } = options;
  const offset = (page - 1) * pageSize;

  return useQuery({
    queryKey: ['sql-table-data', clientId, deploymentId, database, table, page, pageSize, orderBy, orderDir],
    queryFn: () => {
      const params = new URLSearchParams({
        database: database!,
        table: table!,
        limit: String(pageSize),
        offset: String(offset),
      });
      if (orderBy) params.set('orderBy', orderBy);
      if (orderDir) params.set('orderDir', orderDir);

      return apiFetch<{ data: QueryResult }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/table-data?${params}`,
      );
    },
    enabled: Boolean(clientId) && Boolean(deploymentId) && Boolean(database) && Boolean(table),
  });
}

export function useRowCount(
  clientId: string | null | undefined,
  deploymentId: string | undefined,
  database: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sql-row-count', clientId, deploymentId, database, table],
    queryFn: () =>
      apiFetch<{ data: { count: number } }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/row-count?database=${encodeURIComponent(database!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(clientId) && Boolean(deploymentId) && Boolean(database) && Boolean(table),
  });
}

export function useExportDatabase(clientId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({ deploymentId, database }: { readonly deploymentId: string; readonly database: string }) => {
      if (!clientId) throw new Error('No client selected');
      const token = localStorage.getItem('auth_token');
      const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
      const res = await fetch(
        `${API_BASE}/api/v1/clients/${clientId}/deployments/${deploymentId}/export?database=${encodeURIComponent(database)}`,
        { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: { message: 'Export failed' } }));
        throw new Error(body.error?.message ?? 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${database}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });
}

export function useImportSql(clientId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({
      deploymentId,
      database,
      file,
    }: {
      readonly deploymentId: string;
      readonly database: string;
      readonly file: File;
    }) => {
      if (!clientId) throw new Error('No client selected');

      // Read the .sql file as text, then send as JSON — the backend expects { database, sql }
      const sql = await file.text();
      return apiFetch<{ data: { message: string } }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/import`,
        { method: 'POST', body: JSON.stringify({ database, sql }) },
      );
    },
  });
}

// ─── SQLite Hooks ────────────────────────────────────────────────────────────
// SQLite files are queried directly via the file-manager pod.
// No deployment selector or database selector needed — the file path IS the database.

export function useSqliteQuery(clientId: string | null | undefined) {
  return useMutation({
    mutationFn: ({ filePath, query }: { readonly filePath: string; readonly query: string }) => {
      if (!clientId) throw new Error('No client selected');
      return apiFetch<{ data: QueryResult }>(
        `/api/v1/clients/${clientId}/sqlite/query`,
        { method: 'POST', body: JSON.stringify({ file_path: filePath, query }) },
      );
    },
  });
}

export function useSqliteTables(
  clientId: string | null | undefined,
  filePath: string | undefined,
) {
  return useQuery({
    queryKey: ['sqlite-tables', clientId, filePath],
    queryFn: () =>
      apiFetch<{ data: readonly string[] }>(
        `/api/v1/clients/${clientId}/sqlite/tables?file_path=${encodeURIComponent(filePath!)}`,
      ),
    enabled: Boolean(clientId) && Boolean(filePath),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always' as const,
  });
}

export function useSqliteTableStructure(
  clientId: string | null | undefined,
  filePath: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sqlite-structure', clientId, filePath, table],
    queryFn: () =>
      apiFetch<{ data: readonly ColumnInfo[] }>(
        `/api/v1/clients/${clientId}/sqlite/table-structure?file_path=${encodeURIComponent(filePath!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(clientId) && Boolean(filePath) && Boolean(table),
  });
}

export function useSqliteTableData(
  clientId: string | null | undefined,
  filePath: string | undefined,
  table: string | undefined,
  options: TableDataOptions = {},
) {
  const { page = 1, pageSize = 50, orderBy, orderDir } = options;
  const offset = (page - 1) * pageSize;

  return useQuery({
    queryKey: ['sqlite-table-data', clientId, filePath, table, page, pageSize, orderBy, orderDir],
    queryFn: () => {
      const params = new URLSearchParams({
        file_path: filePath!,
        table: table!,
        limit: String(pageSize),
        offset: String(offset),
      });
      if (orderBy) params.set('orderBy', orderBy);
      if (orderDir) params.set('orderDir', orderDir);

      return apiFetch<{ data: QueryResult }>(
        `/api/v1/clients/${clientId}/sqlite/table-data?${params}`,
      );
    },
    enabled: Boolean(clientId) && Boolean(filePath) && Boolean(table),
  });
}

export function useSqliteRowCount(
  clientId: string | null | undefined,
  filePath: string | undefined,
  table: string | undefined,
) {
  return useQuery({
    queryKey: ['sqlite-row-count', clientId, filePath, table],
    queryFn: () =>
      apiFetch<{ data: { count: number } }>(
        `/api/v1/clients/${clientId}/sqlite/row-count?file_path=${encodeURIComponent(filePath!)}&table=${encodeURIComponent(table!)}`,
      ),
    enabled: Boolean(clientId) && Boolean(filePath) && Boolean(table),
  });
}

export function useSqliteExport(clientId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({ filePath }: { readonly filePath: string }) => {
      if (!clientId) throw new Error('No client selected');
      const token = localStorage.getItem('auth_token');
      const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
      const res = await fetch(
        `${API_BASE}/api/v1/clients/${clientId}/sqlite/export?file_path=${encodeURIComponent(filePath)}`,
        { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: { message: 'Export failed' } }));
        throw new Error(body.error?.message ?? 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filePath.split('/').pop() ?? 'database'}-export.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });
}

export function useSqliteImport(clientId: string | null | undefined) {
  return useMutation({
    mutationFn: async ({
      filePath,
      file,
    }: {
      readonly filePath: string;
      readonly file: File;
    }) => {
      if (!clientId) throw new Error('No client selected');
      const sql = await file.text();
      return apiFetch<{ data: { success: boolean; error?: string } }>(
        `/api/v1/clients/${clientId}/sqlite/import`,
        { method: 'POST', body: JSON.stringify({ file_path: filePath, sql }) },
      );
    },
  });
}
