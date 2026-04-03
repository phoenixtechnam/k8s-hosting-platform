import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Database, Table2, Play, Trash2, Download, Upload, Search,
  ChevronRight, ArrowLeft, Loader2, AlertCircle, Columns3,
  ChevronLeft, ChevronDown, Terminal, FileText,
} from 'lucide-react';
import Editor from '@monaco-editor/react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useDeployments, useDbDatabases } from '@/hooks/use-deployments';
import { useCatalog } from '@/hooks/use-catalog';
import {
  useExecuteQuery,
  useListTables,
  useTableStructure,
  useTableData,
  useRowCount,
  useExportDatabase,
  useImportSql,
} from '@/hooks/use-sql-manager';
import type { QueryResult, ColumnInfo } from '@/hooks/use-sql-manager';

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

type SidebarView = 'tables' | 'structure';
type ResultsView = 'query' | 'browse' | 'structure';
type SortDir = 'ASC' | 'DESC';

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
  const engine = detectEngine(selectedCatalogEntry?.name);

  // Databases for selected deployment
  const { data: dbData, isLoading: dbLoading } = useDbDatabases(
    clientId ?? undefined,
    selectedDeploymentId || undefined,
  );
  const databases = dbData?.data ?? [];

  // Auto-select first database
  useEffect(() => {
    if (databases.length > 0 && !selectedDatabase) {
      setSelectedDatabase(databases[0].name);
    }
  }, [databases, selectedDatabase]);

  // Tables
  const { data: tablesData, isLoading: tablesLoading } = useListTables(
    clientId,
    selectedDeploymentId || undefined,
    selectedDatabase || undefined,
  );
  const tables = tablesData?.data ?? [];

  // Execute query mutation
  const executeQuery = useExecuteQuery(clientId, selectedDeploymentId || undefined);

  // Table structure
  const { data: structureData, isLoading: structureLoading } = useTableStructure(
    clientId,
    selectedDeploymentId || undefined,
    selectedDatabase || undefined,
    structureTable || undefined,
  );
  const columns: readonly ColumnInfo[] = structureData?.data ?? [];

  // Table data for browse
  const { data: browseData, isLoading: browseLoading } = useTableData(
    clientId,
    selectedDeploymentId || undefined,
    selectedDatabase || undefined,
    browseTable || undefined,
    { page: browsePage, pageSize: PAGE_SIZE, orderBy: browseSortCol, orderDir: browseSortDir },
  );
  const browseResult = browseData?.data ?? null;

  // Row count for browse
  const { data: rowCountData } = useRowCount(
    clientId,
    selectedDeploymentId || undefined,
    selectedDatabase || undefined,
    browseTable || undefined,
  );
  const totalRows = rowCountData?.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  // Export / Import
  const exportDb = useExportDatabase(clientId);
  const importSql = useImportSql(clientId);

  // ─── Handlers ─────────────────────────────────────────────────────────────

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
    if (!sqlValue.trim() || !selectedDatabase) return;
    setQueryError(null);
    setQueryResult(null);
    setResultsView('query');
    executeQuery.mutate(
      { database: selectedDatabase, query: sqlValue.trim() },
      {
        onSuccess: (res) => setQueryResult(res.data),
        onError: (err) => setQueryError(err instanceof Error ? err.message : 'Query failed'),
      },
    );
  }, [sqlValue, selectedDatabase, executeQuery]);

  const handleClear = useCallback(() => {
    setSqlValue('');
    setQueryResult(null);
    setQueryError(null);
  }, []);

  const handleTableClick = useCallback((tableName: string) => {
    const defaultQuery =
      `SELECT * FROM ${tableName} LIMIT ${PAGE_SIZE};`;
    setSqlValue(defaultQuery);
    setResultsView('query');
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
    if (!selectedDeploymentId || !selectedDatabase) return;
    exportDb.mutate({ deploymentId: selectedDeploymentId, database: selectedDatabase });
  }, [selectedDeploymentId, selectedDatabase, exportDb]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !selectedDeploymentId || !selectedDatabase) return;
      importSql.mutate(
        { deploymentId: selectedDeploymentId, database: selectedDatabase, file },
        {
          onSuccess: () => {
            if (fileInputRef.current) fileInputRef.current.value = '';
          },
          onError: () => {
            if (fileInputRef.current) fileInputRef.current.value = '';
          },
        },
      );
    },
    [selectedDeploymentId, selectedDatabase, importSql],
  );

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

  // ─── No deployment selected prompt ─────────────────────────────────────────

  if (!selectedDeploymentId && !deploymentsLoading) {
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
              {databaseDeployments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => handleDeploymentChange(d.id)}
                  className="w-full flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                  data-testid={`deployment-option-${d.id}`}
                >
                  <Database size={18} className="text-blue-500 dark:text-blue-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{d.name}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{d.status}</div>
                  </div>
                </button>
              ))}
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
            onClick={() => navigate('/applications')}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            data-testid="back-to-applications"
          >
            <ArrowLeft size={16} />
            Back to Applications
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/30">
              <Terminal size={16} className="text-blue-600 dark:text-blue-400" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100" data-testid="sql-manager-heading">
              {engine === 'redis' ? 'Redis Manager' : engine === 'mongodb' ? 'MongoDB Manager' : 'SQL Manager'}
            </h1>
          </div>
        </div>

        {/* Deployment selector */}
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
            {databaseDeployments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main content */}
      <div className="flex gap-4 min-h-[600px]">
        {/* Sidebar */}
        <div className="w-60 shrink-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden flex flex-col">
          {/* Database selector */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <label htmlFor="database-select" className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              Database
            </label>
            {dbLoading ? (
              <div className="flex items-center justify-center py-2">
                <Loader2 size={16} className="animate-spin text-gray-400" />
              </div>
            ) : (
              <select
                id="database-select"
                value={selectedDatabase}
                onChange={(e) => {
                  setSelectedDatabase(e.target.value);
                  setBrowseTable('');
                  setStructureTable('');
                }}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                data-testid="database-selector"
              >
                {databases.length === 0 && <option value="">No databases</option>}
                {databases.map((db) => (
                  <option key={db.name} value={db.name}>
                    {db.name}
                  </option>
                ))}
              </select>
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
                  onClick={() => handleTableClick(table)}
                  onBrowse={() => handleBrowseTable(table)}
                  onStructure={() => handleViewStructure(table)}
                />
              ))}
            </div>
          </div>
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
                disabled={executeQuery.isPending || !sqlValue.trim() || !selectedDatabase}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="run-query-button"
              >
                {executeQuery.isPending ? (
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
                disabled={exportDb.isPending || !selectedDatabase}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                data-testid="export-button"
              >
                {exportDb.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Export
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importSql.isPending || !selectedDatabase}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                data-testid="import-button"
              >
                {importSql.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                Import
              </button>
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
          {importSql.isSuccess && (
            <div className="rounded-lg border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 px-4 py-2 text-sm text-green-800 dark:text-green-300" data-testid="import-success">
              SQL file imported successfully.
            </div>
          )}
          {importSql.isError && (
            <div className="rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-300" data-testid="import-error">
              {importSql.error instanceof Error ? importSql.error.message : 'Import failed'}
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
                isLoading={executeQuery.isPending}
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
              />
            )}

            {/* Structure view */}
            {resultsView === 'structure' && (
              <StructurePanel
                columns={columns}
                isLoading={structureLoading}
                tableName={structureTable}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function TableRow({
  name,
  engine,
  isActive,
  onClick,
  onBrowse,
  onStructure,
}: {
  readonly name: string;
  readonly engine: DbEngine;
  readonly isActive: boolean;
  readonly onClick: () => void;
  readonly onBrowse: () => void;
  readonly onStructure: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={clsx(
        'group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
        isActive
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50',
      )}
      data-testid={`table-row-${name}`}
    >
      <Table2 size={14} className={clsx('shrink-0', isActive ? 'text-blue-500' : 'text-gray-400')} />
      <button
        type="button"
        className="flex-1 text-left truncate text-sm font-mono"
        onClick={onClick}
        title={name}
      >
        {name}
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
          className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-opacity"
          data-testid={`table-menu-${name}`}
        >
          <ChevronDown size={14} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-6 z-40 w-36 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1" data-testid={`table-context-menu-${name}`}>
              <button
                type="button"
                onClick={() => { onBrowse(); setMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                data-testid={`table-browse-${name}`}
              >
                <Search size={14} />
                Browse
              </button>
              {engine === 'sql' && (
                <button
                  type="button"
                  onClick={() => { onStructure(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                  data-testid={`table-structure-${name}`}
                >
                  <Columns3 size={14} />
                  Structure
                </button>
              )}
            </div>
          </>
        )}
      </div>
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
    return (
      <div className="p-4" data-testid="query-error">
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
          <pre className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap font-mono">{error}</pre>
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

  return (
    <div className="flex flex-col flex-1">
      <DataGrid columns={result.columns} rows={result.rows} sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
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
}: {
  readonly columns: readonly ColumnInfo[];
  readonly isLoading: boolean;
  readonly tableName: string;
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
    <div className="flex-1 overflow-auto" data-testid="structure-grid">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-900/50 sticky top-0 z-10">
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Column</th>
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Type</th>
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Nullable</th>
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Default</th>
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Key</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((col, i) => (
            <tr
              key={col.name}
              className={clsx(
                'border-t border-gray-100 dark:border-gray-700/50',
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
            </tr>
          ))}
        </tbody>
      </table>
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
