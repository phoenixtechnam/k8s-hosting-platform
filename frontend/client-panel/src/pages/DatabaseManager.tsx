import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Database, Table2, Play, Trash2, Download, Upload, Search,
  ChevronRight, ArrowLeft, Loader2, AlertCircle, Columns3,
  ChevronLeft, ChevronDown, Terminal, FileText, Plus, Users,
  X, Edit3, PlusCircle, Minus, Copy, Check, RefreshCw, FolderOpen,
  File,
} from 'lucide-react';
import Editor from '@monaco-editor/react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useDeployments,
  useDbDatabases,
  useCreateDbDatabase,
  useDropDbDatabase,
  useDbUsers,
  useCreateDbUser,
  useDropDbUser,
  useSetDbUserPassword,
} from '@/hooks/use-deployments';
import type { DbUser } from '@/hooks/use-deployments';
import { useCatalog } from '@/hooks/use-catalog';
import {
  useExecuteQuery,
  useListTables,
  useTableStructure,
  useTableData,
  useRowCount,
  useExportDatabase,
  useImportSql,
  useImportSqlFromFile,
  useListPvcFiles,
  useSqliteQuery,
  useSqliteTables,
  useSqliteTableStructure,
  useSqliteTableData,
  useSqliteRowCount,
  useSqliteExport,
  useSqliteImport,
} from '@/hooks/use-sql-manager';
import type { QueryResult, ColumnInfo, PvcFileEntry } from '@/hooks/use-sql-manager';

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

const SQL_COLUMN_TYPES = [
  'INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
  'TEXT', 'VARCHAR(255)', 'CHAR(50)',
  'REAL', 'FLOAT', 'DOUBLE', 'DECIMAL(10,2)',
  'BLOB',
  'BOOLEAN',
  'DATE', 'DATETIME', 'TIMESTAMP',
] as const;

interface NewColumnDef {
  readonly name: string;
  readonly type: string;
  readonly primaryKey: boolean;
  readonly nullable: boolean;
}

function createEmptyColumn(): NewColumnDef {
  return { name: '', type: 'TEXT', primaryKey: false, nullable: true };
}

function generateRandomPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function copyToClipboard(text: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

type SidebarView = 'tables' | 'structure';
type ResultsView = 'query' | 'browse' | 'structure';
type SortDir = 'ASC' | 'DESC';

function getQueryErrorHint(error: string): string | null {
  const lower = error.toLowerCase();
  if (lower.includes('already exists')) return 'The table or object already exists. Use IF NOT EXISTS or drop it first.';
  if (lower.includes('unknown column')) return 'Check column names for typos and verify the table schema.';
  if (lower.includes('no such table') || lower.includes('doesn\'t exist') || lower.includes('table') && lower.includes('not found')) return 'The table does not exist. Verify the name and selected database.';
  if (lower.includes('access denied')) return 'The database user does not have permission for this operation.';
  if (lower.includes('syntax error') || lower.includes('you have an error in your sql syntax')) return 'Check your SQL syntax. Common issues: missing quotes, commas, or semicolons.';
  if (lower.includes('duplicate entry') || lower.includes('unique constraint')) return 'A row with this key already exists. Use INSERT IGNORE or ON DUPLICATE KEY UPDATE.';
  if (lower.includes('foreign key constraint')) return 'This operation violates a foreign key constraint. Check related tables.';
  if (lower.includes('lock wait timeout') || lower.includes('deadlock')) return 'The operation timed out due to a lock. Try again or check for long-running queries.';
  if (lower.includes('too large') || lower.includes('max_allowed_packet')) return 'The query or data is too large. Try splitting into smaller operations.';
  return null;
}

// ─── Helper: detect engine from catalog entry ────────────────────────────────

type DbEngine = 'sql' | 'redis' | 'mongodb';

function detectEngine(catalogEntryName: string | undefined): DbEngine {
  if (!catalogEntryName) return 'sql';
  const lower = catalogEntryName.toLowerCase();
  if (lower.includes('redis')) return 'redis';
  if (lower.includes('mongo')) return 'mongodb';
  return 'sql';
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function DatabaseManager() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { clientId } = useClientContext();

  // SQLite mode: detected from ?file= URL param
  const sqliteFile = searchParams.get('file') ?? undefined;
  const isSqlite = Boolean(sqliteFile);

  // State from URL
  const urlDeploymentId = searchParams.get('deploymentId') ?? '';

  // Local state
  const [selectedDeploymentId, setSelectedDeploymentId] = useState(urlDeploymentId);
  const [selectedDatabase, setSelectedDatabase] = useState<string>('');
  const [sqlValue, setSqlValue] = useState('');
  const [resultsView, setResultsView] = useState<ResultsView>('query');
  const [sidebarView, setSidebarView] = useState<SidebarView>('tables');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  // Browse state
  const [browseTable, setBrowseTable] = useState<string>('');
  const [browsePage, setBrowsePage] = useState(1);
  const [browseSortCol, setBrowseSortCol] = useState<string | undefined>();
  const [browseSortDir, setBrowseSortDir] = useState<SortDir>('ASC');

  // Structure state
  const [structureTable, setStructureTable] = useState<string>('');

  // Import
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Import from PVC file picker
  const [pvcPickerOpen, setPvcPickerOpen] = useState(false);
  const [pvcBrowsePath, setPvcBrowsePath] = useState('/');
  const [selectedPvcFile, setSelectedPvcFile] = useState<string | null>(null);

  // Table management state
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newTableColumns, setNewTableColumns] = useState<NewColumnDef[]>([createEmptyColumn()]);
  const [confirmDropTable, setConfirmDropTable] = useState<string | null>(null);
  const [tableActionPending, setTableActionPending] = useState(false);
  const [tableActionError, setTableActionError] = useState<string | null>(null);

  // Add column state (for structure view)
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [addColumnName, setAddColumnName] = useState('');
  const [addColumnType, setAddColumnType] = useState('TEXT');
  const [confirmDropColumn, setConfirmDropColumn] = useState<string | null>(null);

  // Row management state
  const [editRowData, setEditRowData] = useState<Record<string, string> | null>(null);
  const [editRowOriginal, setEditRowOriginal] = useState<Record<string, string> | null>(null);
  const [insertRowOpen, setInsertRowOpen] = useState(false);
  const [insertRowData, setInsertRowData] = useState<Record<string, string>>({});
  const [confirmDeleteRow, setConfirmDeleteRow] = useState<Record<string, string> | null>(null);
  const [rowActionPending, setRowActionPending] = useState(false);
  const [rowActionError, setRowActionError] = useState<string | null>(null);

  // ─── Data queries ───────────────────────────────────────────────────────────

  const { data: catalogData } = useCatalog();
  const { data: deploymentsData, isLoading: deploymentsLoading } = useDeployments(clientId ?? undefined);

  const catalogEntries = catalogData?.data ?? [];
  const allDeployments = deploymentsData?.data ?? [];

  // Filter to database-type deployments only
  const databaseDeployments = useMemo(() => {
    const dbCatalogIds = new Set(
      catalogEntries
        .filter((entry) => entry.type === 'database')
        .map((entry) => entry.id),
    );
    return allDeployments.filter(
      (d) => dbCatalogIds.has(d.catalogEntryId) && !d.deletedAt,
    );
  }, [allDeployments, catalogEntries]);

  const selectedDeployment = databaseDeployments.find((d) => d.id === selectedDeploymentId);
  const selectedCatalogEntry = catalogEntries.find((e) => e.id === selectedDeployment?.catalogEntryId);
  const engine: DbEngine = isSqlite ? 'sql' : detectEngine(selectedCatalogEntry?.name);

  // Databases for selected deployment (deployment mode only)
  const { data: dbData, isLoading: dbLoading } = useDbDatabases(
    isSqlite ? undefined : (clientId ?? undefined),
    isSqlite ? undefined : (selectedDeploymentId || undefined),
  );
  const databases = dbData?.data ?? [];

  // Auto-select first database (deployment mode only)
  useEffect(() => {
    if (!isSqlite && databases.length > 0 && !selectedDatabase) {
      setSelectedDatabase(databases[0].name);
    }
  }, [isSqlite, databases, selectedDatabase]);

  // ─── Deployment-mode hooks ────────────────────────────────────────────────

  const { data: deployTablesData, isLoading: deployTablesLoading } = useListTables(
    isSqlite ? undefined : clientId,
    isSqlite ? undefined : (selectedDeploymentId || undefined),
    isSqlite ? undefined : (selectedDatabase || undefined),
  );

  const deployExecuteQuery = useExecuteQuery(
    isSqlite ? undefined : clientId,
    isSqlite ? undefined : (selectedDeploymentId || undefined),
  );

  const { data: deployStructureData, isLoading: deployStructureLoading } = useTableStructure(
    isSqlite ? undefined : clientId,
    isSqlite ? undefined : (selectedDeploymentId || undefined),
    isSqlite ? undefined : (selectedDatabase || undefined),
    isSqlite ? undefined : (structureTable || undefined),
  );

  const { data: deployBrowseData, isLoading: deployBrowseLoading } = useTableData(
    isSqlite ? undefined : clientId,
    isSqlite ? undefined : (selectedDeploymentId || undefined),
    isSqlite ? undefined : (selectedDatabase || undefined),
    isSqlite ? undefined : (browseTable || undefined),
    { page: browsePage, pageSize: PAGE_SIZE, orderBy: browseSortCol, orderDir: browseSortDir },
  );

  const { data: deployRowCountData } = useRowCount(
    isSqlite ? undefined : clientId,
    isSqlite ? undefined : (selectedDeploymentId || undefined),
    isSqlite ? undefined : (selectedDatabase || undefined),
    isSqlite ? undefined : (browseTable || undefined),
  );

  const deployExportDb = useExportDatabase(isSqlite ? undefined : clientId);
  const deployImportSql = useImportSql(isSqlite ? undefined : clientId);
  const deployImportFromFile = useImportSqlFromFile(isSqlite ? undefined : clientId);

  // ─── SQLite-mode hooks ────────────────────────────────────────────────────

  const { data: sqliteTablesData, isLoading: sqliteTablesLoading } = useSqliteTables(
    isSqlite ? clientId : undefined,
    sqliteFile,
  );

  const sqliteExecuteQuery = useSqliteQuery(isSqlite ? clientId : undefined);

  const { data: sqliteStructureData, isLoading: sqliteStructureLoading } = useSqliteTableStructure(
    isSqlite ? clientId : undefined,
    sqliteFile,
    isSqlite ? (structureTable || undefined) : undefined,
  );

  const { data: sqliteBrowseData, isLoading: sqliteBrowseLoading } = useSqliteTableData(
    isSqlite ? clientId : undefined,
    sqliteFile,
    isSqlite ? (browseTable || undefined) : undefined,
    { page: browsePage, pageSize: PAGE_SIZE, orderBy: browseSortCol, orderDir: browseSortDir },
  );

  const { data: sqliteRowCountData } = useSqliteRowCount(
    isSqlite ? clientId : undefined,
    sqliteFile,
    isSqlite ? (browseTable || undefined) : undefined,
  );

  const sqliteExportDb = useSqliteExport(isSqlite ? clientId : undefined);
  const sqliteImportSqlMutation = useSqliteImport(isSqlite ? clientId : undefined);

  // PVC file listing for "Import from File" picker
  const { data: pvcFilesData, isLoading: pvcFilesLoading } = useListPvcFiles(
    clientId,
    pvcBrowsePath,
    pvcPickerOpen && !isSqlite,
  );
  const pvcEntries: readonly PvcFileEntry[] = pvcFilesData?.data?.entries ?? [];

  // ─── Unified data accessors ───────────────────────────────────────────────

  const tables = isSqlite ? (sqliteTablesData?.data ?? []) : (deployTablesData?.data ?? []);
  const tablesLoading = isSqlite ? sqliteTablesLoading : deployTablesLoading;

  const columns: readonly ColumnInfo[] = isSqlite
    ? (sqliteStructureData?.data ?? [])
    : (deployStructureData?.data ?? []);
  const structureLoading = isSqlite ? sqliteStructureLoading : deployStructureLoading;

  const browseResult = isSqlite
    ? (sqliteBrowseData?.data ?? null)
    : (deployBrowseData?.data ?? null);
  const browseLoading = isSqlite ? sqliteBrowseLoading : deployBrowseLoading;

  const totalRows = isSqlite
    ? (sqliteRowCountData?.data?.count ?? 0)
    : (deployRowCountData?.data?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  // Note: exportDb and importSqlMutation are not unified — handlers call the specific mutations directly.

  // Database management
  const createDbDatabase = useCreateDbDatabase(clientId ?? undefined);
  const dropDbDatabase = useDropDbDatabase(clientId ?? undefined);
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [confirmDeleteDb, setConfirmDeleteDb] = useState<string | null>(null);

  // User management
  const { data: usersData, isLoading: usersLoading } = useDbUsers(
    clientId ?? undefined,
    selectedDeploymentId || undefined,
  );
  const dbUsers: readonly DbUser[] = usersData?.data ?? [];
  const createDbUser = useCreateDbUser(clientId ?? undefined);
  const dropDbUser = useDropDbUser(clientId ?? undefined);
  const setDbUserPassword = useSetDbUserPassword(clientId ?? undefined);

  const [usersExpanded, setUsersExpanded] = useState(false);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newUserDatabase, setNewUserDatabase] = useState('');
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<string | null>(null);
  const [createdUserPassword, setCreatedUserPassword] = useState<string | null>(null);
  const [regeneratedPassword, setRegeneratedPassword] = useState<{ username: string; password: string } | null>(null);
  const [copiedPassword, setCopiedPassword] = useState(false);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleCreateDb = useCallback(() => {
    if (!newDbName.trim() || !selectedDeploymentId) return;
    createDbDatabase.mutate(
      { deploymentId: selectedDeploymentId, name: newDbName.trim() },
      {
        onSuccess: () => {
          setNewDbName('');
          setCreateDbOpen(false);
        },
      },
    );
  }, [newDbName, selectedDeploymentId, createDbDatabase]);

  const handleDropDb = useCallback(
    (dbName: string) => {
      if (!selectedDeploymentId) return;
      dropDbDatabase.mutate(
        { deploymentId: selectedDeploymentId, name: dbName },
        {
          onSuccess: () => {
            setConfirmDeleteDb(null);
            if (selectedDatabase === dbName) {
              setSelectedDatabase('');
            }
          },
        },
      );
    },
    [selectedDeploymentId, selectedDatabase, dropDbDatabase],
  );

  const handleCreateUser = useCallback(() => {
    if (!newUsername.trim() || !selectedDeploymentId) return;
    const generatedPassword = generateRandomPassword();
    setCreatedUserPassword(null);
    createDbUser.mutate(
      {
        deploymentId: selectedDeploymentId,
        username: newUsername.trim(),
        password: generatedPassword,
        database: newUserDatabase.trim() || undefined,
      },
      {
        onSuccess: () => {
          setCreatedUserPassword(generatedPassword);
          setCopiedPassword(false);
          setNewUsername('');
          setNewUserDatabase('');
          setCreateUserOpen(false);
        },
      },
    );
  }, [newUsername, newUserDatabase, selectedDeploymentId, createDbUser]);

  const handleDropUser = useCallback(
    (username: string) => {
      if (!selectedDeploymentId) return;
      dropDbUser.mutate(
        { deploymentId: selectedDeploymentId, username },
        { onSuccess: () => setConfirmDeleteUser(null) },
      );
    },
    [selectedDeploymentId, dropDbUser],
  );

  const handleRegeneratePassword = useCallback((username: string) => {
    if (!selectedDeploymentId) return;
    const generatedPassword = generateRandomPassword();
    setRegeneratedPassword(null);
    setDbUserPassword.mutate(
      {
        deploymentId: selectedDeploymentId,
        username,
        password: generatedPassword,
      },
      {
        onSuccess: () => {
          setRegeneratedPassword({ username, password: generatedPassword });
          setCopiedPassword(false);
        },
      },
    );
  }, [selectedDeploymentId, setDbUserPassword]);

  const handleDeploymentChange = useCallback(
    (id: string) => {
      setSelectedDeploymentId(id);
      setSelectedDatabase('');
      setQueryResult(null);
      setQueryError(null);
      setBrowseTable('');
      setStructureTable('');
      setSearchParams({ deploymentId: id });
    },
    [setSearchParams],
  );

  const handleRunQuery = useCallback(() => {
    if (!sqlValue.trim()) return;
    if (!isSqlite && !selectedDatabase) return;
    setQueryError(null);
    setQueryResult(null);
    setResultsView('query');

    if (isSqlite && sqliteFile) {
      sqliteExecuteQuery.mutate(
        { filePath: sqliteFile, query: sqlValue.trim() },
        {
          onSuccess: (res) => setQueryResult(res.data),
          onError: (err) => setQueryError(err instanceof Error ? err.message : 'Query failed'),
        },
      );
    } else {
      deployExecuteQuery.mutate(
        { database: selectedDatabase, query: sqlValue.trim() },
        {
          onSuccess: (res) => setQueryResult(res.data),
          onError: (err) => setQueryError(err instanceof Error ? err.message : 'Query failed'),
        },
      );
    }
  }, [sqlValue, selectedDatabase, isSqlite, sqliteFile, sqliteExecuteQuery, deployExecuteQuery]);

  const handleClear = useCallback(() => {
    setSqlValue('');
    setQueryResult(null);
    setQueryError(null);
  }, []);

  const handleBrowseTable = useCallback((tableName: string) => {
    setBrowseTable(tableName);
    setBrowsePage(1);
    setBrowseSortCol(undefined);
    setResultsView('browse');
  }, []);

  const handleViewStructure = useCallback((tableName: string) => {
    setStructureTable(tableName);
    setResultsView('structure');
  }, []);

  const handleExport = useCallback(() => {
    if (isSqlite && sqliteFile) {
      sqliteExportDb.mutate({ filePath: sqliteFile });
    } else {
      if (!selectedDeploymentId || !selectedDatabase) return;
      deployExportDb.mutate({ deploymentId: selectedDeploymentId, database: selectedDatabase });
    }
  }, [isSqlite, sqliteFile, selectedDeploymentId, selectedDatabase, sqliteExportDb, deployExportDb]);

  const invalidateTableQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['sql-tables'] });
    queryClient.invalidateQueries({ queryKey: ['sqlite-tables'] });
    queryClient.invalidateQueries({ queryKey: ['sql-table-data'] });
    queryClient.invalidateQueries({ queryKey: ['sqlite-table-data'] });
    queryClient.invalidateQueries({ queryKey: ['sql-structure'] });
    queryClient.invalidateQueries({ queryKey: ['sqlite-structure'] });
    queryClient.invalidateQueries({ queryKey: ['sql-row-count'] });
    queryClient.invalidateQueries({ queryKey: ['sqlite-row-count'] });
  }, [queryClient]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Only accept .sql files
      if (!file.name.toLowerCase().endsWith('.sql')) {
        // Reset input so user can try again
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      const clearInput = () => { if (fileInputRef.current) fileInputRef.current.value = ''; };
      const onImportSuccess = () => {
        clearInput();
        invalidateTableQueries();
      };

      if (isSqlite && sqliteFile) {
        sqliteImportSqlMutation.mutate(
          { filePath: sqliteFile, file },
          { onSuccess: onImportSuccess, onError: clearInput },
        );
      } else {
        if (!selectedDeploymentId || !selectedDatabase) return;
        deployImportSql.mutate(
          { deploymentId: selectedDeploymentId, database: selectedDatabase, file },
          { onSuccess: onImportSuccess, onError: clearInput },
        );
      }
    },
    [isSqlite, sqliteFile, selectedDeploymentId, selectedDatabase, sqliteImportSqlMutation, deployImportSql, invalidateTableQueries],
  );

  const handleOpenPvcPicker = useCallback(() => {
    setPvcBrowsePath('/');
    setSelectedPvcFile(null);
    setPvcPickerOpen(true);
  }, []);

  const handlePvcFileImport = useCallback(() => {
    if (!selectedPvcFile || !selectedDeploymentId || !selectedDatabase) return;
    deployImportFromFile.mutate(
      { deploymentId: selectedDeploymentId, database: selectedDatabase, filePath: selectedPvcFile },
      {
        onSuccess: () => {
          setPvcPickerOpen(false);
          setSelectedPvcFile(null);
          invalidateTableQueries();
        },
      },
    );
  }, [selectedPvcFile, selectedDeploymentId, selectedDatabase, deployImportFromFile, invalidateTableQueries]);

  const handleBrowseSort = useCallback(
    (col: string) => {
      if (browseSortCol === col) {
        setBrowseSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
      } else {
        setBrowseSortCol(col);
        setBrowseSortDir('ASC');
      }
      setBrowsePage(1);
    },
    [browseSortCol],
  );

  // ─── Unified DDL/DML executor ────────────────────────────────────────────

  const executeDdl = useCallback(
    async (sql: string): Promise<void> => {
      if (isSqlite && sqliteFile) {
        await new Promise<void>((resolve, reject) => {
          sqliteExecuteQuery.mutate(
            { filePath: sqliteFile, query: sql },
            { onSuccess: () => resolve(), onError: (err) => reject(err) },
          );
        });
      } else if (selectedDatabase) {
        await new Promise<void>((resolve, reject) => {
          deployExecuteQuery.mutate(
            { database: selectedDatabase, query: sql },
            { onSuccess: () => resolve(), onError: (err) => reject(err) },
          );
        });
      }
    },
    [isSqlite, sqliteFile, selectedDatabase, sqliteExecuteQuery, deployExecuteQuery],
  );

  // ─── Create Table ──────────────────────────────────────────────────────────

  const handleCreateTable = useCallback(async () => {
    const name = newTableName.trim();
    if (!name || newTableColumns.length === 0) return;

    const validCols = newTableColumns.filter((c) => c.name.trim());
    if (validCols.length === 0) return;

    const colDefs = validCols.map((c) => {
      const parts = [`"${c.name.trim()}" ${c.type}`];
      if (c.primaryKey) parts.push('PRIMARY KEY');
      if (!c.nullable && !c.primaryKey) parts.push('NOT NULL');
      return parts.join(' ');
    });

    const sql = `CREATE TABLE "${name}" (${colDefs.join(', ')})`;
    setTableActionPending(true);
    setTableActionError(null);

    try {
      await executeDdl(sql);
      setNewTableName('');
      setNewTableColumns([createEmptyColumn()]);
      setCreateTableOpen(false);
      invalidateTableQueries();
    } catch (err) {
      setTableActionError(err instanceof Error ? err.message : 'Failed to create table');
    } finally {
      setTableActionPending(false);
    }
  }, [newTableName, newTableColumns, executeDdl, invalidateTableQueries]);

  // ─── Drop Table ────────────────────────────────────────────────────────────

  const handleDropTable = useCallback(async (tableName: string) => {
    setTableActionPending(true);
    setTableActionError(null);

    try {
      await executeDdl(`DROP TABLE "${tableName}"`);
      setConfirmDropTable(null);
      if (browseTable === tableName) setBrowseTable('');
      if (structureTable === tableName) setStructureTable('');
      invalidateTableQueries();
    } catch (err) {
      setTableActionError(err instanceof Error ? err.message : 'Failed to drop table');
    } finally {
      setTableActionPending(false);
    }
  }, [executeDdl, invalidateTableQueries, browseTable, structureTable]);

  // ─── Add Column ────────────────────────────────────────────────────────────

  const handleAddColumn = useCallback(async () => {
    const colName = addColumnName.trim();
    if (!colName || !structureTable) return;

    const sql = `ALTER TABLE "${structureTable}" ADD COLUMN "${colName}" ${addColumnType}`;
    setTableActionPending(true);
    setTableActionError(null);

    try {
      await executeDdl(sql);
      setAddColumnName('');
      setAddColumnType('TEXT');
      setAddColumnOpen(false);
      invalidateTableQueries();
    } catch (err) {
      setTableActionError(err instanceof Error ? err.message : 'Failed to add column');
    } finally {
      setTableActionPending(false);
    }
  }, [addColumnName, addColumnType, structureTable, executeDdl, invalidateTableQueries]);

  // ─── Drop Column ───────────────────────────────────────────────────────────

  const handleDropColumn = useCallback(async (colName: string) => {
    if (!structureTable) return;

    const sql = `ALTER TABLE "${structureTable}" DROP COLUMN "${colName}"`;
    setTableActionPending(true);
    setTableActionError(null);

    try {
      await executeDdl(sql);
      setConfirmDropColumn(null);
      invalidateTableQueries();
    } catch (err) {
      setTableActionError(err instanceof Error ? err.message : 'Failed to drop column');
    } finally {
      setTableActionPending(false);
    }
  }, [structureTable, executeDdl, invalidateTableQueries]);

  // ─── Row Management: Find PK column ────────────────────────────────────────

  const browsePkColumn = useMemo(() => {
    // Try to find primary key from structure data
    const structData = isSqlite
      ? (sqliteStructureData?.data ?? [])
      : (deployStructureData?.data ?? []);
    const pk = structData.find((c) => c.key === 'PRI');
    return pk?.name ?? null;
  }, [isSqlite, sqliteStructureData, deployStructureData]);

  // Auto-fetch structure for browse table to identify PK — both hooks always called, conditionally enabled
  const { data: browseStructureSqlite } = useSqliteTableStructure(
    isSqlite ? clientId : undefined,
    sqliteFile,
    isSqlite ? (browseTable || undefined) : undefined,
  );
  const { data: browseStructureDeploy } = useTableStructure(
    isSqlite ? undefined : clientId,
    isSqlite ? undefined : (selectedDeploymentId || undefined),
    isSqlite ? undefined : (selectedDatabase || undefined),
    isSqlite ? undefined : (browseTable || undefined),
  );

  const browseStructureData = isSqlite ? browseStructureSqlite : browseStructureDeploy;

  const browseTablePkColumn = useMemo(() => {
    const cols = browseStructureData?.data ?? [];
    const pk = cols.find((c) => c.key === 'PRI');
    return pk?.name ?? null;
  }, [browseStructureData]);

  const browseTableColumns = useMemo(() => {
    return browseStructureData?.data ?? [];
  }, [browseStructureData]);

  // ─── Delete Row ────────────────────────────────────────────────────────────

  const handleDeleteRow = useCallback(async (rowData: Record<string, string>) => {
    if (!browseTable || !browseTablePkColumn) return;
    const pkValue = rowData[browseTablePkColumn];
    if (pkValue === undefined) return;

    const sql = `DELETE FROM "${browseTable}" WHERE "${browseTablePkColumn}" = '${pkValue.replace(/'/g, "''")}'`;
    setRowActionPending(true);
    setRowActionError(null);

    try {
      await executeDdl(sql);
      setConfirmDeleteRow(null);
      invalidateTableQueries();
    } catch (err) {
      setRowActionError(err instanceof Error ? err.message : 'Failed to delete row');
    } finally {
      setRowActionPending(false);
    }
  }, [browseTable, browseTablePkColumn, executeDdl, invalidateTableQueries]);

  // ─── Edit Row (save) ──────────────────────────────────────────────────────

  const handleSaveRow = useCallback(async () => {
    if (!browseTable || !browseTablePkColumn || !editRowData || !editRowOriginal) return;
    const pkValue = editRowOriginal[browseTablePkColumn];
    if (pkValue === undefined) return;

    const setClauses = Object.entries(editRowData)
      .filter(([key, val]) => val !== editRowOriginal[key])
      .map(([key, val]) => {
        if (val === '' || val === 'NULL') return `"${key}" = NULL`;
        return `"${key}" = '${val.replace(/'/g, "''")}'`;
      });

    if (setClauses.length === 0) {
      setEditRowData(null);
      setEditRowOriginal(null);
      return;
    }

    const sql = `UPDATE "${browseTable}" SET ${setClauses.join(', ')} WHERE "${browseTablePkColumn}" = '${pkValue.replace(/'/g, "''")}'`;
    setRowActionPending(true);
    setRowActionError(null);

    try {
      await executeDdl(sql);
      setEditRowData(null);
      setEditRowOriginal(null);
      invalidateTableQueries();
    } catch (err) {
      setRowActionError(err instanceof Error ? err.message : 'Failed to update row');
    } finally {
      setRowActionPending(false);
    }
  }, [browseTable, browseTablePkColumn, editRowData, editRowOriginal, executeDdl, invalidateTableQueries]);

  // ─── Insert Row ────────────────────────────────────────────────────────────

  const handleInsertRow = useCallback(async () => {
    if (!browseTable) return;
    const entries = Object.entries(insertRowData).filter(([, val]) => val.trim() !== '');
    if (entries.length === 0) return;

    const colNames = entries.map(([key]) => `"${key}"`).join(', ');
    const values = entries.map(([, val]) => `'${val.replace(/'/g, "''")}'`).join(', ');
    const sql = `INSERT INTO "${browseTable}" (${colNames}) VALUES (${values})`;

    setRowActionPending(true);
    setRowActionError(null);

    try {
      await executeDdl(sql);
      setInsertRowOpen(false);
      setInsertRowData({});
      invalidateTableQueries();
    } catch (err) {
      setRowActionError(err instanceof Error ? err.message : 'Failed to insert row');
    } finally {
      setRowActionPending(false);
    }
  }, [browseTable, insertRowData, executeDdl, invalidateTableQueries]);

  // ─── Column helpers for create table form ──────────────────────────────────

  const handleNewColumnChange = useCallback((index: number, field: keyof NewColumnDef, value: string | boolean) => {
    setNewTableColumns((prev) => prev.map((col, i) =>
      i === index ? { ...col, [field]: value } : col,
    ));
  }, []);

  const handleAddNewColumn = useCallback(() => {
    setNewTableColumns((prev) => [...prev, createEmptyColumn()]);
  }, []);

  const handleRemoveNewColumn = useCallback((index: number) => {
    setNewTableColumns((prev) => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev);
  }, []);

  // Keyboard shortcut: Ctrl+Enter to run
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleRunQuery();
      }
    },
    [handleRunQuery],
  );

  // ─── Computed state for render ──────────────────────────────────────────────

  const queryIsPending = isSqlite ? sqliteExecuteQuery.isPending : deployExecuteQuery.isPending;
  const importIsPending = isSqlite ? sqliteImportSqlMutation.isPending : (deployImportSql.isPending || deployImportFromFile.isPending);
  const importIsSuccess = isSqlite ? sqliteImportSqlMutation.isSuccess : (deployImportSql.isSuccess || deployImportFromFile.isSuccess);
  const importIsError = isSqlite ? sqliteImportSqlMutation.isError : (deployImportSql.isError || deployImportFromFile.isError);
  const importError = isSqlite ? sqliteImportSqlMutation.error : (deployImportSql.error || deployImportFromFile.error);
  const exportIsPending = isSqlite ? sqliteExportDb.isPending : deployExportDb.isPending;

  // In SQLite mode, the "database" is the file itself — no database selector needed
  const canRunQuery = isSqlite ? Boolean(sqliteFile) : Boolean(selectedDatabase);
  const canExport = isSqlite ? Boolean(sqliteFile) : Boolean(selectedDatabase);
  const canImport = isSqlite ? Boolean(sqliteFile) : Boolean(selectedDatabase);

  // SQLite file display name
  const sqliteFileName = sqliteFile?.split('/').pop() ?? '';

  // ─── No deployment selected prompt (deployment mode only) ──────────────────

  if (!isSqlite && !selectedDeploymentId && !deploymentsLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/applications')}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            data-testid="back-to-applications"
          >
            <ArrowLeft size={16} />
            Back to Applications
          </button>
        </div>

        <div className="flex flex-col items-center justify-center py-20 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <Database size={48} className="text-gray-300 dark:text-gray-600 mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2" data-testid="select-deployment-prompt">
            Select a Database Deployment
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-md text-center">
            Choose a database deployment to manage its tables, run queries, and browse data.
          </p>
          {databaseDeployments.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">
              No database deployments found. Deploy a database first from the Applications page.
            </p>
          ) : (
            <div className="space-y-2 w-full max-w-sm">
              {databaseDeployments.map((d) => {
                const isRunning = d.status === 'running';
                const dotColor = isRunning
                  ? 'bg-green-500'
                  : d.status === 'failed' || d.status === 'stopped'
                    ? 'bg-red-500'
                    : 'bg-amber-500';
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => isRunning ? handleDeploymentChange(d.id) : undefined}
                    disabled={!isRunning}
                    className={clsx(
                      'w-full flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                      isRunning
                        ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer'
                        : 'border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900/30 opacity-60 cursor-not-allowed',
                    )}
                    title={!isRunning ? 'This database is not running' : undefined}
                    data-testid={`deployment-option-${d.id}`}
                  >
                    <Database size={18} className={isRunning ? 'text-blue-500 dark:text-blue-400 shrink-0' : 'text-gray-400 dark:text-gray-500 shrink-0'} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{d.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{d.status}</div>
                    </div>
                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dotColor}`} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── SQL editor label by engine ────────────────────────────────────────────

  const editorLanguage = engine === 'mongodb' ? 'javascript' : engine === 'redis' ? 'plaintext' : 'sql';
  const editorPlaceholder =
    engine === 'redis'
      ? 'Enter Redis command (e.g., GET key, SET key value, KEYS *, HGETALL hash)'
      : engine === 'mongodb'
        ? 'Enter MongoDB query (e.g., db.collection.find({}))'
        : 'SELECT * FROM users WHERE age > 25 LIMIT 50;';

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4" data-testid="database-manager-page">
      {/* Top bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(isSqlite ? '/files' : '/applications')}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            data-testid="back-to-applications"
          >
            <ArrowLeft size={16} />
            {isSqlite ? 'Back to Files' : 'Back to Applications'}
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/30">
              <Terminal size={16} className="text-blue-600 dark:text-blue-400" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100" data-testid="sql-manager-heading">
              {isSqlite ? 'SQLite Manager' : engine === 'redis' ? 'Redis Manager' : engine === 'mongodb' ? 'MongoDB Manager' : 'SQL Manager'}
            </h1>
          </div>
        </div>

        {/* Deployment selector (deployment mode) or file path (SQLite mode) */}
        {isSqlite ? (
          <div className="flex items-center gap-2">
            <Database size={14} className="text-amber-500 dark:text-amber-400" />
            <span className="text-sm font-mono text-gray-700 dark:text-gray-300" data-testid="sqlite-file-path">
              {sqliteFile}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label htmlFor="deployment-select" className="text-xs text-gray-500 dark:text-gray-400">
              Deployment:
            </label>
            <select
              id="deployment-select"
              value={selectedDeploymentId}
              onChange={(e) => handleDeploymentChange(e.target.value)}
              className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              data-testid="deployment-selector"
            >
              <option value="">Select deployment...</option>
              {databaseDeployments.map((d) => {
                const statusDot = d.status === 'running' ? '\u{1F7E2}' : d.status === 'failed' || d.status === 'stopped' ? '\u{1F534}' : '\u{1F7E1}';
                const isDisabled = d.status !== 'running';
                return (
                  <option key={d.id} value={d.id} disabled={isDisabled} title={isDisabled ? 'This database is not running' : undefined}>
                    {statusDot} {d.name}{isDisabled ? ` (${d.status})` : ''}
                  </option>
                );
              })}
            </select>
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex gap-4 min-h-[600px]">
        {/* Sidebar */}
        <div className="w-72 shrink-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden flex flex-col">
          {/* Database selector (deployment mode) or file info (SQLite mode) */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            {isSqlite ? (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">SQLite File</span>
                <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1.5">
                  <Database size={14} className="text-amber-500 shrink-0" />
                  <span className="text-sm font-mono text-gray-900 dark:text-gray-100 truncate" title={sqliteFile}>
                    {sqliteFileName}
                  </span>
                </div>
              </div>
            ) : (
              <>
            <label htmlFor="database-select" className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              Database
            </label>
            {dbLoading ? (
              <div className="flex items-center justify-center py-2">
                <Loader2 size={16} className="animate-spin text-gray-400" />
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <select
                  id="database-select"
                  value={selectedDatabase}
                  onChange={(e) => {
                    setSelectedDatabase(e.target.value);
                    setBrowseTable('');
                    setStructureTable('');
                  }}
                  className="flex-1 min-w-0 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  data-testid="database-selector"
                >
                  {databases.length === 0 && <option value="">No databases</option>}
                  {databases.map((db) => (
                    <option key={db.name} value={db.name}>
                      {db.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setCreateDbOpen((prev) => !prev)}
                  title="Create database"
                  className="shrink-0 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 p-1.5 text-gray-500 hover:text-green-600 dark:text-gray-400 dark:hover:text-green-400 hover:border-green-300 dark:hover:border-green-600 transition-colors"
                  data-testid="create-database-button"
                >
                  <Plus size={14} />
                </button>
                {selectedDatabase && (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteDb(selectedDatabase)}
                    title="Delete database"
                    className="shrink-0 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 p-1.5 text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-600 transition-colors"
                    data-testid="delete-database-button"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            )}

            {/* Create database inline form */}
            {createDbOpen && (
              <div className="mt-2" data-testid="create-database-form">
                <div className="flex gap-1">
                  <input
                    value={newDbName}
                    onChange={(e) => setNewDbName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDb(); }}
                    placeholder="Database name"
                    className="flex-1 min-w-0 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    data-testid="new-database-name-input"
                  />
                  <button
                    type="button"
                    onClick={handleCreateDb}
                    disabled={createDbDatabase.isPending || !newDbName.trim()}
                    className="shrink-0 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="confirm-create-database"
                  >
                    {createDbDatabase.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
                  </button>
                </div>
                {createDbDatabase.isError && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid="create-database-error">
                    {createDbDatabase.error instanceof Error ? createDbDatabase.error.message : 'Failed to create database'}
                  </p>
                )}
              </div>
            )}

            {/* Confirm delete database */}
            {confirmDeleteDb && (
              <div className="mt-2 rounded-md border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2" data-testid="confirm-delete-database">
                <p className="text-xs text-red-700 dark:text-red-300 mb-1.5">
                  Drop <span className="font-mono font-semibold">{confirmDeleteDb}</span>? This cannot be undone.
                </p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => handleDropDb(confirmDeleteDb)}
                    disabled={dropDbDatabase.isPending}
                    className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    data-testid="confirm-drop-database"
                  >
                    {dropDbDatabase.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Drop'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteDb(null)}
                    className="rounded-md border border-gray-200 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                    data-testid="cancel-drop-database"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
              </>
            )}
          </div>

          {/* Table list */}
          <div className="flex-1 overflow-y-auto p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {engine === 'redis' ? 'Keys' : engine === 'mongodb' ? 'Collections' : 'Tables'}
              </span>
              {tablesLoading && <Loader2 size={12} className="animate-spin text-gray-400" />}
            </div>

            {!tablesLoading && tables.length === 0 && (
              <p className="text-xs text-gray-400 dark:text-gray-500 py-2">
                {engine === 'redis' ? 'No keys found.' : engine === 'mongodb' ? 'No collections found.' : 'No tables found.'}
              </p>
            )}

            <div className="space-y-0.5">
              {tables.map((table) => (
                <TableRow
                  key={table}
                  name={table}
                  engine={engine}
                  isActive={browseTable === table || structureTable === table}
                  onBrowse={() => handleBrowseTable(table)}
                  onStructure={() => handleViewStructure(table)}
                  onDrop={() => setConfirmDropTable(table)}
                />
              ))}
            </div>

            {/* Confirm drop table */}
            {confirmDropTable && (
              <div className="mt-2 rounded-md border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2" data-testid="confirm-drop-table">
                <p className="text-xs text-red-700 dark:text-red-300 mb-1.5">
                  Drop table <span className="font-mono font-semibold">{confirmDropTable}</span>? This cannot be undone.
                </p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => handleDropTable(confirmDropTable)}
                    disabled={tableActionPending}
                    className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    data-testid="confirm-drop-table-button"
                  >
                    {tableActionPending ? <Loader2 size={12} className="animate-spin" /> : 'Drop'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDropTable(null)}
                    className="rounded-md border border-gray-200 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                    data-testid="cancel-drop-table-button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Error display */}
            {tableActionError && (
              <div className="mt-2 rounded-md border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2">
                <div className="flex items-start gap-1.5">
                  <AlertCircle size={12} className="text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700 dark:text-red-300">{tableActionError}</p>
                  <button type="button" onClick={() => setTableActionError(null)} className="ml-auto shrink-0">
                    <X size={12} className="text-red-400 hover:text-red-600" />
                  </button>
                </div>
              </div>
            )}

            {/* Create table form */}
            {engine === 'sql' && (
              <>
                {createTableOpen ? (
                  <div className="mt-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-2 space-y-2" data-testid="create-table-form">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">New Table</span>
                      <button type="button" onClick={() => { setCreateTableOpen(false); setTableActionError(null); }}>
                        <X size={14} className="text-gray-400 hover:text-gray-600" />
                      </button>
                    </div>
                    <input
                      value={newTableName}
                      onChange={(e) => setNewTableName(e.target.value)}
                      placeholder="Table name"
                      className="w-full rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                      data-testid="new-table-name-input"
                    />
                    <div className="space-y-1">
                      <span className="text-xs text-gray-500 dark:text-gray-400">Columns</span>
                      {newTableColumns.map((col, i) => (
                        <div key={i} className="flex gap-1 items-center">
                          <input
                            value={col.name}
                            onChange={(e) => handleNewColumnChange(i, 'name', e.target.value)}
                            placeholder="Name"
                            className="flex-1 min-w-0 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-1.5 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                            data-testid={`col-name-${i}`}
                          />
                          <select
                            value={col.type}
                            onChange={(e) => handleNewColumnChange(i, 'type', e.target.value)}
                            className="w-24 shrink-0 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-1 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                            data-testid={`col-type-${i}`}
                          >
                            {SQL_COLUMN_TYPES.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                          <label className="flex items-center gap-0.5 text-xs text-gray-500 dark:text-gray-400 shrink-0" title="Primary Key">
                            <input
                              type="checkbox"
                              checked={col.primaryKey}
                              onChange={(e) => handleNewColumnChange(i, 'primaryKey', e.target.checked)}
                              className="rounded"
                              data-testid={`col-pk-${i}`}
                            />
                            PK
                          </label>
                          <button
                            type="button"
                            onClick={() => handleRemoveNewColumn(i)}
                            className="shrink-0 text-gray-400 hover:text-red-500"
                            title="Remove column"
                            data-testid={`col-remove-${i}`}
                          >
                            <Minus size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={handleAddNewColumn}
                        className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700"
                        data-testid="add-column-to-new-table"
                      >
                        <Plus size={12} />
                        Add Column
                      </button>
                      <button
                        type="button"
                        onClick={handleCreateTable}
                        disabled={tableActionPending || !newTableName.trim() || newTableColumns.every((c) => !c.name.trim())}
                        className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        data-testid="confirm-create-table"
                      >
                        {tableActionPending ? <Loader2 size={12} className="animate-spin" /> : 'Create Table'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setCreateTableOpen(true); setTableActionError(null); }}
                    className="mt-3 flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 w-full justify-center rounded-md border border-dashed border-gray-300 dark:border-gray-600 py-1.5 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
                    data-testid="new-table-button"
                  >
                    <Plus size={12} />
                    New Table
                  </button>
                )}
              </>
            )}
          </div>

          {/* Users section (deployment mode only -- SQLite has no users) */}
          {!isSqlite && selectedDeploymentId && (
            <div className="border-t border-gray-200 dark:border-gray-700 p-3" data-testid="users-section">
              <button
                type="button"
                onClick={() => setUsersExpanded((prev) => !prev)}
                className="flex items-center justify-between w-full text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1"
                data-testid="toggle-users-section"
              >
                <span className="flex items-center gap-1.5">
                  <Users size={12} />
                  Users
                  {!usersLoading && <span className="text-gray-400 dark:text-gray-500 font-normal normal-case">({dbUsers.length})</span>}
                </span>
                <ChevronDown
                  size={12}
                  className={clsx('transition-transform', usersExpanded && 'rotate-180')}
                />
              </button>

              {usersExpanded && (
                <div className="space-y-1 mt-1">
                  {usersLoading && (
                    <div className="flex items-center justify-center py-2">
                      <Loader2 size={14} className="animate-spin text-gray-400" />
                    </div>
                  )}

                  {!usersLoading && dbUsers.length === 0 && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-1">No users found.</p>
                  )}

                  {dbUsers.map((u) => (
                    <div
                      key={u.username}
                      className="flex items-center justify-between text-xs rounded-md px-1.5 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/50 group"
                      data-testid={`user-row-${u.username}`}
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-gray-700 dark:text-gray-300 truncate block">{u.username}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {u.databases?.length ? u.databases.map((d) => `@${d}`).join(', ') : '@ALL'}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRegeneratePassword(u.username)}
                          title="Regenerate password"
                          className="rounded p-0.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                          data-testid={`set-password-${u.username}`}
                        >
                          <RefreshCw size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteUser(u.username)}
                          title="Delete user"
                          className="rounded p-0.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                          data-testid={`delete-user-${u.username}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Confirm delete user */}
                  {confirmDeleteUser && (
                    <div className="rounded-md border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2" data-testid="confirm-delete-user">
                      <p className="text-xs text-red-700 dark:text-red-300 mb-1.5">
                        Drop user <span className="font-mono font-semibold">{confirmDeleteUser}</span>?
                      </p>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => handleDropUser(confirmDeleteUser)}
                          disabled={dropDbUser.isPending}
                          className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          data-testid="confirm-drop-user"
                        >
                          {dropDbUser.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Drop'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteUser(null)}
                          className="rounded-md border border-gray-200 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                          data-testid="cancel-drop-user"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Regenerated password display */}
                  {regeneratedPassword && (
                    <div className="rounded-md border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-2" data-testid="regenerated-password-banner">
                      <p className="text-xs font-medium text-green-800 dark:text-green-300 mb-1">
                        New password for <span className="font-mono font-semibold">{regeneratedPassword.username}</span>:
                      </p>
                      <div className="flex items-center gap-1">
                        <code className="flex-1 rounded bg-white dark:bg-gray-900 border border-green-200 dark:border-green-700 px-2 py-1 font-mono text-xs text-gray-900 dark:text-gray-100 select-all truncate">
                          {regeneratedPassword.password}
                        </code>
                        <button
                          type="button"
                          onClick={() => { copyToClipboard(regeneratedPassword.password); setCopiedPassword(true); }}
                          className="shrink-0 rounded p-1 text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                          data-testid="copy-regenerated-password"
                        >
                          {copiedPassword ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRegeneratedPassword(null)}
                          className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Created user password display */}
                  {createdUserPassword && (
                    <div className="rounded-md border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-2" data-testid="created-user-password-banner">
                      <p className="text-xs font-medium text-green-800 dark:text-green-300 mb-1">
                        User created. Copy the password now:
                      </p>
                      <div className="flex items-center gap-1">
                        <code className="flex-1 rounded bg-white dark:bg-gray-900 border border-green-200 dark:border-green-700 px-2 py-1 font-mono text-xs text-gray-900 dark:text-gray-100 select-all truncate">
                          {createdUserPassword}
                        </code>
                        <button
                          type="button"
                          onClick={() => { copyToClipboard(createdUserPassword); setCopiedPassword(true); }}
                          className="shrink-0 rounded p-1 text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                          data-testid="copy-created-user-password"
                        >
                          {copiedPassword ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setCreatedUserPassword(null)}
                          className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Create user form */}
                  {createUserOpen ? (
                    <div className="space-y-1 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-2" data-testid="create-user-form">
                      <input
                        value={newUsername}
                        onChange={(e) => setNewUsername(e.target.value)}
                        placeholder="Username"
                        className="w-full rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                        data-testid="new-username-input"
                      />
                      <select
                        value={newUserDatabase}
                        onChange={(e) => setNewUserDatabase(e.target.value)}
                        className="w-full rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                        data-testid="new-user-database-select"
                      >
                        <option value="">All databases</option>
                        {databases.map((db) => (
                          <option key={db.name} value={db.name}>{db.name}</option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        A secure password will be generated automatically.
                      </p>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={handleCreateUser}
                          disabled={createDbUser.isPending || !newUsername.trim()}
                          className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                          data-testid="confirm-create-user"
                        >
                          {createDbUser.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setCreateUserOpen(false); setNewUsername(''); setNewUserDatabase(''); }}
                          className="rounded-md border border-gray-200 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300"
                          data-testid="cancel-create-user"
                        >
                          Cancel
                        </button>
                      </div>
                      {createDbUser.isError && (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid="create-user-error">
                          {createDbUser.error instanceof Error ? createDbUser.error.message : 'Failed to create user'}
                        </p>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setCreateUserOpen(true); setCreatedUserPassword(null); }}
                      className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 mt-1"
                      data-testid="add-user-button"
                    >
                      <Plus size={12} />
                      Add User
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          {/* SQL Editor */}
          <div
            className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden"
            onKeyDown={handleEditorKeyDown}
          >
            <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText size={14} className="text-gray-400" />
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {engine === 'redis' ? 'Command' : engine === 'mongodb' ? 'Query (JS)' : 'SQL Query'}
                </span>
              </div>
              <span className="text-xs text-gray-400">
                Ctrl+Enter to run
              </span>
            </div>
            <Editor
              height="200px"
              language={editorLanguage}
              value={sqlValue}
              onChange={(val) => setSqlValue(val ?? '')}
              theme={document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light'}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 2,
                automaticLayout: true,
                placeholder: editorPlaceholder,
              }}
              data-testid="sql-editor"
            />
          </div>

          {/* Action bar */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRunQuery}
                disabled={queryIsPending || !sqlValue.trim() || !canRunQuery}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="run-query-button"
              >
                {queryIsPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
                Run Query
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                data-testid="clear-button"
              >
                <Trash2 size={14} />
                Clear
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={exportIsPending || !canExport}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                data-testid="export-button"
              >
                {exportIsPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Export
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importIsPending || !canImport}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                data-testid="import-button"
              >
                {importIsPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                Import
              </button>
              {!isSqlite && (
                <button
                  type="button"
                  onClick={handleOpenPvcPicker}
                  disabled={importIsPending || !canImport}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                  data-testid="import-from-file-button"
                  title="Import a .sql file already uploaded to the shared volume"
                >
                  {deployImportFromFile.isPending ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                  Import from File
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".sql"
                onChange={handleImport}
                className="hidden"
                data-testid="import-file-input"
              />
            </div>

            {/* Execution stats */}
            {queryResult && resultsView === 'query' && (
              <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="query-stats">
                {queryResult.executionTimeMs}ms, {queryResult.rowCount} row{queryResult.rowCount !== 1 ? 's' : ''} returned
              </span>
            )}
          </div>

          {/* Import result */}
          {importIsSuccess && (
            <div className="rounded-lg border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 px-4 py-3 text-sm text-green-800 dark:text-green-300 flex items-center gap-2" data-testid="import-success">
              <Check size={16} className="text-green-600 dark:text-green-400 shrink-0" />
              SQL file imported successfully. Tables have been refreshed.
            </div>
          )}
          {importIsError && (
            <div className="rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" data-testid="import-error">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Import failed</p>
                  <p className="mt-1 font-mono text-xs whitespace-pre-wrap">
                    {importError instanceof Error ? importError.message : 'An unknown error occurred during import.'}
                  </p>
                  {importError instanceof Error && importError.message.includes('syntax') && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      Hint: Check for SQL syntax errors in the import file. Ensure it is compatible with {isSqlite ? 'SQLite' : 'MySQL/MariaDB'}.
                    </p>
                  )}
                  {!isSqlite && importError instanceof Error && (importError.message.includes('too large') || importError.message.includes('50MB') || importError.message.includes('Payload Too Large')) && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      Hint: Upload the file via File Manager first, then use &quot;Import from File&quot; to bypass the upload size limit.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Results area */}
          <div className="flex-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden flex flex-col">
            {/* Results tabs */}
            <div className="flex items-center border-b border-gray-200 dark:border-gray-700 px-4">
              <ResultsTab
                label="Query Results"
                active={resultsView === 'query'}
                onClick={() => setResultsView('query')}
              />
              {browseTable && (
                <ResultsTab
                  label={`Browse: ${browseTable}`}
                  active={resultsView === 'browse'}
                  onClick={() => setResultsView('browse')}
                />
              )}
              {structureTable && (
                <ResultsTab
                  label={`Structure: ${structureTable}`}
                  active={resultsView === 'structure'}
                  onClick={() => setResultsView('structure')}
                />
              )}
            </div>

            {/* Query results */}
            {resultsView === 'query' && (
              <QueryResultsPanel
                result={queryResult}
                error={queryError}
                isLoading={queryIsPending}
              />
            )}

            {/* Browse results */}
            {resultsView === 'browse' && (
              <BrowsePanel
                result={browseResult}
                isLoading={browseLoading}
                page={browsePage}
                totalPages={totalPages}
                totalRows={totalRows}
                sortCol={browseSortCol}
                sortDir={browseSortDir}
                onSort={handleBrowseSort}
                onPageChange={setBrowsePage}
                pkColumn={browseTablePkColumn}
                tableColumns={browseTableColumns}
                editRowData={editRowData}
                insertRowOpen={insertRowOpen}
                insertRowData={insertRowData}
                confirmDeleteRow={confirmDeleteRow}
                rowActionPending={rowActionPending}
                rowActionError={rowActionError}
                onEditRow={(rowData, original) => { setEditRowData(rowData); setEditRowOriginal(original); setRowActionError(null); }}
                onCancelEditRow={() => { setEditRowData(null); setEditRowOriginal(null); }}
                onSaveRow={handleSaveRow}
                onEditFieldChange={(field, val) => setEditRowData((prev) => prev ? { ...prev, [field]: val } : prev)}
                onDeleteRow={setConfirmDeleteRow}
                onConfirmDeleteRow={handleDeleteRow}
                onCancelDeleteRow={() => setConfirmDeleteRow(null)}
                onOpenInsertRow={() => { setInsertRowOpen(true); setInsertRowData({}); setRowActionError(null); }}
                onCloseInsertRow={() => { setInsertRowOpen(false); setInsertRowData({}); }}
                onInsertFieldChange={(field, val) => setInsertRowData((prev) => ({ ...prev, [field]: val }))}
                onInsertRow={handleInsertRow}
                onDismissRowError={() => setRowActionError(null)}
              />
            )}

            {/* Structure view */}
            {resultsView === 'structure' && (
              <StructurePanel
                columns={columns}
                isLoading={structureLoading}
                tableName={structureTable}
                addColumnOpen={addColumnOpen}
                addColumnName={addColumnName}
                addColumnType={addColumnType}
                confirmDropColumn={confirmDropColumn}
                actionPending={tableActionPending}
                actionError={tableActionError}
                onToggleAddColumn={() => { setAddColumnOpen((prev) => !prev); setTableActionError(null); }}
                onAddColumnNameChange={setAddColumnName}
                onAddColumnTypeChange={setAddColumnType}
                onAddColumn={handleAddColumn}
                onConfirmDropColumn={setConfirmDropColumn}
                onDropColumn={handleDropColumn}
                onCancelDropColumn={() => setConfirmDropColumn(null)}
                onDismissError={() => setTableActionError(null)}
              />
            )}
          </div>
        </div>
      </div>

      {/* PVC File Picker Modal */}
      {pvcPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="pvc-file-picker-overlay">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg mx-4 flex flex-col max-h-[70vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Import SQL from File Manager</h3>
              <button
                type="button"
                onClick={() => setPvcPickerOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                data-testid="pvc-picker-close"
              >
                <X size={20} />
              </button>
            </div>

            {/* Breadcrumb */}
            <div className="px-5 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 overflow-x-auto">
              <button
                type="button"
                onClick={() => { setPvcBrowsePath('/'); setSelectedPvcFile(null); }}
                className="hover:text-blue-600 dark:hover:text-blue-400 font-medium shrink-0"
              >
                /
              </button>
              {pvcBrowsePath !== '/' && pvcBrowsePath.split('/').filter(Boolean).map((segment, idx, arr) => {
                const segPath = '/' + arr.slice(0, idx + 1).join('/');
                return (
                  <span key={segPath} className="flex items-center gap-1 shrink-0">
                    <ChevronRight size={12} />
                    <button
                      type="button"
                      onClick={() => { setPvcBrowsePath(segPath); setSelectedPvcFile(null); }}
                      className="hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      {segment}
                    </button>
                  </span>
                );
              })}
            </div>

            {/* File list */}
            <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[200px]">
              {pvcFilesLoading ? (
                <div className="flex items-center justify-center h-32 text-gray-400">
                  <Loader2 size={24} className="animate-spin" />
                </div>
              ) : pvcEntries.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">
                  No files in this directory
                </div>
              ) : (
                <div className="space-y-0.5">
                  {[...pvcEntries]
                    .sort((a, b) => {
                      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                      return a.name.localeCompare(b.name);
                    })
                    .map((entry) => {
                      const entryPath = pvcBrowsePath === '/'
                        ? `/${entry.name}`
                        : `${pvcBrowsePath}/${entry.name}`;
                      const isSqlFile = entry.type === 'file' && entry.name.toLowerCase().endsWith('.sql');
                      const isDir = entry.type === 'directory';
                      const isSelected = selectedPvcFile === entryPath;

                      return (
                        <button
                          key={entry.name}
                          type="button"
                          onClick={() => {
                            if (isDir) {
                              setPvcBrowsePath(entryPath);
                              setSelectedPvcFile(null);
                            } else if (isSqlFile) {
                              setSelectedPvcFile(isSelected ? null : entryPath);
                            }
                          }}
                          disabled={!isDir && !isSqlFile}
                          className={clsx(
                            'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors',
                            isSelected
                              ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-200 dark:ring-blue-700'
                              : isDir
                                ? 'hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300'
                                : isSqlFile
                                  ? 'hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300'
                                  : 'text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-50',
                          )}
                          data-testid={`pvc-entry-${entry.name}`}
                        >
                          {isDir ? (
                            <FolderOpen size={16} className="text-yellow-500 shrink-0" />
                          ) : (
                            <File size={16} className={clsx('shrink-0', isSqlFile ? 'text-blue-500' : 'text-gray-400')} />
                          )}
                          <span className="truncate flex-1 font-mono">{entry.name}</span>
                          {entry.type === 'file' && (
                            <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                              {entry.size < 1024
                                ? `${entry.size} B`
                                : entry.size < 1_048_576
                                  ? `${(entry.size / 1024).toFixed(1)} KB`
                                  : `${(entry.size / 1_048_576).toFixed(1)} MB`}
                            </span>
                          )}
                          {isDir && <ChevronRight size={14} className="text-gray-400 shrink-0" />}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3">
              <div className="text-xs text-gray-400 dark:text-gray-500 truncate flex-1">
                {selectedPvcFile ? (
                  <span className="font-mono">{selectedPvcFile}</span>
                ) : (
                  'Select a .sql file to import'
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setPvcPickerOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePvcFileImport}
                  disabled={!selectedPvcFile || deployImportFromFile.isPending}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  data-testid="pvc-picker-import"
                >
                  {deployImportFromFile.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  Import
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function TableRow({
  name,
  engine,
  isActive,
  onBrowse,
  onStructure,
  onDrop,
}: {
  readonly name: string;
  readonly engine: DbEngine;
  readonly isActive: boolean;
  readonly onBrowse: () => void;
  readonly onStructure: () => void;
  readonly onDrop: () => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  return (
    <div
      className={clsx(
        'group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
        isActive
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50',
      )}
      data-testid={`table-row-${name}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <Table2 size={14} className={clsx('shrink-0', isActive ? 'text-blue-500' : 'text-gray-400')} />
      <button
        type="button"
        className="flex-1 text-left truncate text-sm font-mono"
        onDoubleClick={onBrowse}
        title={`Double-click to browse ${name}`}
      >
        {name}
      </button>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          data-testid={`table-context-menu-${name}`}
        >
          <button
            type="button"
            onClick={() => { onBrowse(); setContextMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
            data-testid={`table-browse-${name}`}
          >
            <Search size={14} />
            Browse
          </button>
          {engine === 'sql' && (
            <button
              type="button"
              onClick={() => { onStructure(); setContextMenu(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
              data-testid={`table-structure-${name}`}
            >
              <Columns3 size={14} />
              Structure
            </button>
          )}
          <button
            type="button"
            onClick={() => { onDrop(); setContextMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            data-testid={`table-drop-menu-${name}`}
          >
            <Trash2 size={14} />
            Drop Table
          </button>
        </div>
      )}
    </div>
  );
}

function ResultsTab({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-3 py-2.5 text-xs font-medium border-b-2 transition-colors',
        active
          ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
      )}
    >
      {label}
    </button>
  );
}

function QueryResultsPanel({
  result,
  error,
  isLoading,
}: {
  readonly result: QueryResult | null;
  readonly error: string | null;
  readonly isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    const hint = getQueryErrorHint(error);
    return (
      <div className="p-4" data-testid="query-error">
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <pre className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap font-mono">{error}</pre>
            {hint && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                Hint: {hint}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-500">
        <Terminal size={32} className="mb-2" />
        <p className="text-sm">Run a query to see results</p>
      </div>
    );
  }

  // Query returned a result with an error field (e.g. SQL syntax error from the DB engine)
  if (result.error) {
    const hint = getQueryErrorHint(result.error);
    return (
      <div className="p-4" data-testid="query-result-error">
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <pre className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap font-mono">{result.error}</pre>
            {hint && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                Hint: {hint}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Non-SELECT (INSERT/UPDATE/DELETE) result
  if (result.columns.length === 0) {
    return (
      <div className="p-4" data-testid="query-message">
        <div className="rounded-lg border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 px-4 py-3">
          <p className="text-sm text-green-800 dark:text-green-300">
            Query executed successfully. {result.rowCount} row{result.rowCount !== 1 ? 's' : ''} affected.
          </p>
        </div>
      </div>
    );
  }

  return <DataGrid columns={result.columns} rows={result.rows} />;
}

function BrowsePanel({
  result,
  isLoading,
  page,
  totalPages,
  totalRows,
  sortCol,
  sortDir,
  onSort,
  onPageChange,
  pkColumn,
  tableColumns,
  editRowData,
  insertRowOpen,
  insertRowData,
  confirmDeleteRow,
  rowActionPending,
  rowActionError,
  onEditRow,
  onCancelEditRow,
  onSaveRow,
  onEditFieldChange,
  onDeleteRow,
  onConfirmDeleteRow,
  onCancelDeleteRow,
  onOpenInsertRow,
  onCloseInsertRow,
  onInsertFieldChange,
  onInsertRow,
  onDismissRowError,
}: {
  readonly result: QueryResult | null;
  readonly isLoading: boolean;
  readonly page: number;
  readonly totalPages: number;
  readonly totalRows: number;
  readonly sortCol: string | undefined;
  readonly sortDir: SortDir;
  readonly onSort: (col: string) => void;
  readonly onPageChange: (page: number) => void;
  readonly pkColumn: string | null;
  readonly tableColumns: readonly ColumnInfo[];
  readonly editRowData: Record<string, string> | null;
  readonly insertRowOpen: boolean;
  readonly insertRowData: Record<string, string>;
  readonly confirmDeleteRow: Record<string, string> | null;
  readonly rowActionPending: boolean;
  readonly rowActionError: string | null;
  readonly onEditRow: (data: Record<string, string>, original: Record<string, string>) => void;
  readonly onCancelEditRow: () => void;
  readonly onSaveRow: () => void;
  readonly onEditFieldChange: (field: string, value: string) => void;
  readonly onDeleteRow: (rowData: Record<string, string>) => void;
  readonly onConfirmDeleteRow: (rowData: Record<string, string>) => void;
  readonly onCancelDeleteRow: () => void;
  readonly onOpenInsertRow: () => void;
  readonly onCloseInsertRow: () => void;
  readonly onInsertFieldChange: (field: string, value: string) => void;
  readonly onInsertRow: () => void;
  readonly onDismissRowError: () => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <p className="text-sm">No data</p>
      </div>
    );
  }

  const buildRowMap = (row: string[]): Record<string, string> => {
    const map: Record<string, string> = {};
    result.columns.forEach((col, i) => { map[col] = row[i] ?? ''; });
    return map;
  };

  return (
    <div className="flex flex-col flex-1">
      {/* Row action bar */}
      {pkColumn && (
        <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 px-4 py-2">
          <button
            type="button"
            onClick={onOpenInsertRow}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="insert-row-button"
          >
            <PlusCircle size={12} />
            Insert Row
          </button>
          {rowActionError && (
            <div className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} />
              <span>{rowActionError}</span>
              <button type="button" onClick={onDismissRowError}><X size={12} /></button>
            </div>
          )}
        </div>
      )}

      {/* Insert row form */}
      {insertRowOpen && (
        <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3 bg-blue-50/50 dark:bg-blue-900/10 space-y-2" data-testid="insert-row-form">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">Insert New Row</span>
            <button type="button" onClick={onCloseInsertRow}>
              <X size={14} className="text-gray-400 hover:text-gray-600" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(tableColumns.length > 0 ? tableColumns : result.columns.map((c) => ({ name: c, type: '', key: '', nullable: true, defaultValue: null }))).map((col) => (
              <div key={col.name} className="flex items-center gap-1.5">
                <label className="text-xs font-mono text-gray-500 dark:text-gray-400 w-28 shrink-0 truncate" title={col.name}>
                  {col.name}
                  {col.key === 'PRI' && <span className="text-amber-500 ml-0.5">*</span>}
                </label>
                <input
                  value={insertRowData[col.name] ?? ''}
                  onChange={(e) => onInsertFieldChange(col.name, e.target.value)}
                  placeholder={col.key === 'PRI' ? 'auto' : 'NULL'}
                  className="flex-1 min-w-0 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                  data-testid={`insert-field-${col.name}`}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={onInsertRow}
              disabled={rowActionPending}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="confirm-insert-row"
            >
              {rowActionPending ? <Loader2 size={12} className="animate-spin" /> : 'Insert'}
            </button>
            <button
              type="button"
              onClick={onCloseInsertRow}
              className="rounded-md border border-gray-200 dark:border-gray-600 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Confirm delete row */}
      {confirmDeleteRow && pkColumn && (
        <div className="flex items-center gap-2 border-b border-red-200 dark:border-red-700 px-4 py-2 bg-red-50 dark:bg-red-900/20" data-testid="confirm-delete-row">
          <span className="text-xs text-red-700 dark:text-red-300">
            Delete row where <span className="font-mono font-semibold">{pkColumn} = {confirmDeleteRow[pkColumn]}</span>?
          </span>
          <button
            type="button"
            onClick={() => onConfirmDeleteRow(confirmDeleteRow)}
            disabled={rowActionPending}
            className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid="confirm-delete-row-button"
          >
            {rowActionPending ? <Loader2 size={12} className="animate-spin" /> : 'Delete'}
          </button>
          <button
            type="button"
            onClick={onCancelDeleteRow}
            className="rounded-md border border-gray-200 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Edit row form */}
      {editRowData && (
        <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3 bg-yellow-50/50 dark:bg-yellow-900/10 space-y-2" data-testid="edit-row-form">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">Edit Row</span>
            <button type="button" onClick={onCancelEditRow}>
              <X size={14} className="text-gray-400 hover:text-gray-600" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {result.columns.map((col) => (
              <div key={col} className="flex items-center gap-1.5">
                <label className="text-xs font-mono text-gray-500 dark:text-gray-400 w-28 shrink-0 truncate" title={col}>
                  {col}
                  {col === pkColumn && <span className="text-amber-500 ml-0.5">*</span>}
                </label>
                <input
                  value={editRowData[col] ?? ''}
                  onChange={(e) => onEditFieldChange(col, e.target.value)}
                  disabled={col === pkColumn}
                  className={clsx(
                    'flex-1 min-w-0 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50',
                    col === pkColumn && 'opacity-60 cursor-not-allowed',
                  )}
                  data-testid={`edit-field-${col}`}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={onSaveRow}
              disabled={rowActionPending}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="save-edit-row"
            >
              {rowActionPending ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
            </button>
            <button
              type="button"
              onClick={onCancelEditRow}
              className="rounded-md border border-gray-200 dark:border-gray-600 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Data grid */}
      <div className="flex-1 overflow-auto" data-testid="results-grid">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-900/50 sticky top-0 z-10">
              {pkColumn && <th className="w-20 px-2 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Actions</th>}
              {result.columns.map((col) => (
                <th
                  key={col}
                  className={clsx(
                    'text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap',
                    'cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none',
                  )}
                  onClick={() => onSort(col)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col}
                    {sortCol === col && (
                      <ChevronDown
                        size={12}
                        className={clsx('transition-transform', sortDir === 'DESC' && 'rotate-180')}
                      />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={result.columns.length + (pkColumn ? 1 : 0)} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                  No rows returned
                </td>
              </tr>
            ) : (
              result.rows.map((row, rowIdx) => {
                const rowMap = buildRowMap(row);
                return (
                  <tr
                    key={rowIdx}
                    className={clsx(
                      'border-t border-gray-100 dark:border-gray-700/50 group',
                      rowIdx % 2 === 1 && 'bg-gray-50/50 dark:bg-gray-900/25',
                    )}
                  >
                    {pkColumn && (
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={() => onEditRow({ ...rowMap }, { ...rowMap })}
                            className="rounded p-0.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                            title="Edit row"
                            data-testid={`edit-row-${rowIdx}`}
                          >
                            <Edit3 size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteRow(rowMap)}
                            className="rounded p-0.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                            title="Delete row"
                            data-testid={`delete-row-${rowIdx}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    )}
                    {row.map((cell, cellIdx) => (
                      <td
                        key={cellIdx}
                        className="px-4 py-1.5 text-gray-900 dark:text-gray-100 font-mono text-xs whitespace-nowrap max-w-xs truncate"
                        title={cell}
                      >
                        {cell === null || cell === 'NULL' ? (
                          <span className="text-gray-400 italic">NULL</span>
                        ) : (
                          cell
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 px-4 py-2">
        <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="browse-row-count">
          {totalRows} total row{totalRows !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="browse-prev"
          >
            <ChevronLeft size={14} />
            Prev
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="browse-page-info">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="browse-next"
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function StructurePanel({
  columns,
  isLoading,
  tableName,
  addColumnOpen,
  addColumnName,
  addColumnType,
  confirmDropColumn,
  actionPending,
  actionError,
  onToggleAddColumn,
  onAddColumnNameChange,
  onAddColumnTypeChange,
  onAddColumn,
  onConfirmDropColumn,
  onDropColumn,
  onCancelDropColumn,
  onDismissError,
}: {
  readonly columns: readonly ColumnInfo[];
  readonly isLoading: boolean;
  readonly tableName: string;
  readonly addColumnOpen: boolean;
  readonly addColumnName: string;
  readonly addColumnType: string;
  readonly confirmDropColumn: string | null;
  readonly actionPending: boolean;
  readonly actionError: string | null;
  readonly onToggleAddColumn: () => void;
  readonly onAddColumnNameChange: (v: string) => void;
  readonly onAddColumnTypeChange: (v: string) => void;
  readonly onAddColumn: () => void;
  readonly onConfirmDropColumn: (name: string | null) => void;
  readonly onDropColumn: (name: string) => void;
  readonly onCancelDropColumn: () => void;
  readonly onDismissError: () => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <p className="text-sm">No structure data for {tableName}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1">
      {/* Action bar */}
      <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 px-4 py-2">
        <button
          type="button"
          onClick={onToggleAddColumn}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          data-testid="toggle-add-column"
        >
          <PlusCircle size={12} />
          Add Column
        </button>
        {actionError && (
          <div className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
            <AlertCircle size={12} />
            <span>{actionError}</span>
            <button type="button" onClick={onDismissError}><X size={12} /></button>
          </div>
        )}
      </div>

      {/* Add column form */}
      {addColumnOpen && (
        <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 px-4 py-2 bg-gray-50 dark:bg-gray-900/50" data-testid="add-column-form">
          <input
            value={addColumnName}
            onChange={(e) => onAddColumnNameChange(e.target.value)}
            placeholder="Column name"
            className="rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            data-testid="add-column-name-input"
          />
          <select
            value={addColumnType}
            onChange={(e) => onAddColumnTypeChange(e.target.value)}
            className="rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            data-testid="add-column-type-select"
          >
            {SQL_COLUMN_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={onAddColumn}
            disabled={actionPending || !addColumnName.trim()}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="confirm-add-column"
          >
            {actionPending ? <Loader2 size={12} className="animate-spin" /> : 'Add'}
          </button>
          <button
            type="button"
            onClick={onToggleAddColumn}
            className="rounded-md border border-gray-200 dark:border-gray-600 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Confirm drop column */}
      {confirmDropColumn && (
        <div className="flex items-center gap-2 border-b border-red-200 dark:border-red-700 px-4 py-2 bg-red-50 dark:bg-red-900/20" data-testid="confirm-drop-column">
          <span className="text-xs text-red-700 dark:text-red-300">
            Drop column <span className="font-mono font-semibold">{confirmDropColumn}</span>?
          </span>
          <button
            type="button"
            onClick={() => onDropColumn(confirmDropColumn)}
            disabled={actionPending}
            className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid="confirm-drop-column-button"
          >
            {actionPending ? <Loader2 size={12} className="animate-spin" /> : 'Drop'}
          </button>
          <button
            type="button"
            onClick={onCancelDropColumn}
            className="rounded-md border border-gray-200 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto" data-testid="structure-grid">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-900/50 sticky top-0 z-10">
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Column</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Type</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Nullable</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Default</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Key</th>
              <th className="w-10 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, i) => (
              <tr
                key={col.name}
                className={clsx(
                  'border-t border-gray-100 dark:border-gray-700/50 group',
                  i % 2 === 1 && 'bg-gray-50/50 dark:bg-gray-900/25',
                )}
                data-testid={`structure-row-${col.name}`}
              >
                <td className="px-4 py-2 font-mono text-gray-900 dark:text-gray-100">{col.name}</td>
                <td className="px-4 py-2 font-mono text-blue-600 dark:text-blue-400">{col.type}</td>
                <td className="px-4 py-2">
                  <span className={clsx('text-xs font-medium', col.nullable ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-400')}>
                    {col.nullable ? 'YES' : 'NO'}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-gray-600 dark:text-gray-400">{col.defaultValue ?? 'NULL'}</td>
                <td className="px-4 py-2">
                  {col.key && (
                    <span className={clsx(
                      'inline-block rounded px-1.5 py-0.5 text-xs font-medium',
                      col.key === 'PRI' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                      col.key === 'UNI' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' :
                      'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
                    )}>
                      {col.key}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2">
                  {col.key !== 'PRI' && (
                    <button
                      type="button"
                      onClick={() => onConfirmDropColumn(col.name)}
                      className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-opacity"
                      title="Drop column"
                      data-testid={`drop-column-${col.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataGrid({
  columns,
  rows,
  sortCol,
  sortDir,
  onSort,
}: {
  readonly columns: string[];
  readonly rows: string[][];
  readonly sortCol?: string;
  readonly sortDir?: SortDir;
  readonly onSort?: (col: string) => void;
}) {
  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <p className="text-sm">No columns</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto" data-testid="results-grid">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-900/50 sticky top-0 z-10">
            {columns.map((col) => (
              <th
                key={col}
                className={clsx(
                  'text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap',
                  onSort && 'cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none',
                )}
                onClick={() => onSort?.(col)}
              >
                <span className="inline-flex items-center gap-1">
                  {col}
                  {sortCol === col && (
                    <ChevronDown
                      size={12}
                      className={clsx('transition-transform', sortDir === 'DESC' && 'rotate-180')}
                    />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                No rows returned
              </td>
            </tr>
          ) : (
            rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={clsx(
                  'border-t border-gray-100 dark:border-gray-700/50',
                  rowIdx % 2 === 1 && 'bg-gray-50/50 dark:bg-gray-900/25',
                )}
              >
                {row.map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    className="px-4 py-1.5 text-gray-900 dark:text-gray-100 font-mono text-xs whitespace-nowrap max-w-xs truncate"
                    title={cell}
                  >
                    {cell === null || cell === 'NULL' ? (
                      <span className="text-gray-400 italic">NULL</span>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
