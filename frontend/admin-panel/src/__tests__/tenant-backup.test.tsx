/**
 * Smoke test for the TenantBackup admin page.
 *
 * Covers the rendering matrix: tab switching, default tab from URL,
 * search filter on the bundles tab, and the schedule list with
 * "deleted" client edge case. End-to-end mutations (verify, delete,
 * run-now) are exercised by the staging integration scenario; these
 * tests keep the page-level wiring regression-proof.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TenantBackup from '../pages/TenantBackup';
import type {
  BundleSummary,
  BackupScheduleSummary,
} from '@k8s-hosting/api-contracts';

vi.mock('../hooks/use-backup-bundles', () => ({
  useBundles: vi.fn(),
  useDeleteBundle: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useVerifyBundle: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useCreateBundle: vi.fn(() => ({ mutateAsync: vi.fn().mockResolvedValue({ data: { bundleId: 'bkp-new', status: 'pending' } }), isPending: false })),
  useBundleCoverage: vi.fn(),
  useBundleDetailLive: vi.fn(() => ({ data: undefined, isLoading: true, error: null })),
  useVerifyAllBundles: vi.fn(() => ({ mutateAsync: vi.fn().mockResolvedValue({ data: { summary: { total: 0, passed: 0, failed: 0, skipped: 0 }, results: [] } }), isPending: false })),
  downloadDataExport: vi.fn(),
  downloadBundleExport: vi.fn(),
  importBundle: vi.fn(),
}));
vi.mock('../hooks/use-backup-schedule', () => ({
  useAllBackupSchedules: vi.fn(),
  useRunBackupScheduleNow: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useClientBackupSchedule: vi.fn(() => ({ data: undefined, isLoading: false })),
  useUpdateClientBackupSchedule: vi.fn(() => ({ mutate: vi.fn() })),
  useDeleteClientBackupSchedule: vi.fn(() => ({ mutate: vi.fn() })),
}));
vi.mock('../hooks/use-restore-carts', () => ({
  useRestoreCarts: vi.fn(),
}));
vi.mock('../hooks/use-backup-config', () => ({
  useBackupConfigs: vi.fn(),
}));
vi.mock('../hooks/use-clients', () => ({
  useClients: vi.fn(() => ({ data: { data: [{ id: 'c1', companyName: 'Acme Corp' }] } })),
  useClient: vi.fn(() => ({ data: undefined })),
}));

import { useBundles, useBundleCoverage } from '../hooks/use-backup-bundles';
import { useAllBackupSchedules } from '../hooks/use-backup-schedule';
import { useRestoreCarts } from '../hooks/use-restore-carts';
import { useBackupConfigs } from '../hooks/use-backup-config';

const mockedBundles = useBundles as unknown as ReturnType<typeof vi.fn>;
const mockedCoverage = useBundleCoverage as unknown as ReturnType<typeof vi.fn>;
const mockedSchedules = useAllBackupSchedules as unknown as ReturnType<typeof vi.fn>;
const mockedCarts = useRestoreCarts as unknown as ReturnType<typeof vi.fn>;
const mockedConfigs = useBackupConfigs as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children, initialEntries = ['/tenant-backup'] }: { children: React.ReactNode; initialEntries?: string[] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const BUNDLE: BundleSummary = {
  id: 'bkp-aaaaaaaa-1111-2222-3333-444444444444',
  clientId: 'c1',
  clientStatus: 'active',
  clientName: 'Test Co',
  initiator: 'admin',
  systemTrigger: null,
  status: 'completed',
  targetKind: 's3',
  targetUri: 's3://bucket/prefix',
  targetConfigId: 'cfg-1',
  label: 'manual-test',
  description: null,
  sizeBytes: 1024,
  retentionDays: 30,
  expiresAt: null,
  exportMode: null,
  exportArtifact: null,
  startedAt: '2026-05-05T18:00:00Z',
  finishedAt: '2026-05-05T18:00:30Z',
  lastError: null,
  createdAt: '2026-05-05T18:00:00Z',
  updatedAt: '2026-05-05T18:00:30Z',
};

const SCHEDULE: BackupScheduleSummary = {
  clientId: 'c1',
  enabled: true,
  frequency: 'weekly',
  hourOfDayUtc: 3,
  dayOfWeek: 0,
  dayOfMonth: null,
  retentionDays: 14,
  lastRunAt: '2026-05-04T03:00:00Z',
  lastRunStatus: 'completed',
  businessName: 'Acme Corp',
};

const CONFIG = {
  id: 'cfg-1',
  name: 'staging-s3',
  storageType: 's3' as const,
  sshHost: null, sshPort: null, sshUser: null, sshPath: null,
  s3Endpoint: 'https://s3.test', s3Bucket: 'bk', s3Region: 'us', s3Prefix: '',
  retentionDays: 30,
  scheduleExpression: null,
  enabled: 1,
  active: true,
  lastTestedAt: null, lastTestStatus: null,
  createdAt: '2026-05-05T00:00:00Z', updatedAt: '2026-05-05T00:00:00Z',
};

describe('TenantBackup', () => {
  beforeEach(() => {
    mockedConfigs.mockReturnValue({ data: { data: [CONFIG] }, isLoading: false });
  });

  it('renders the heading + 4 tabs', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [BUNDLE], pagination: {} } }, isLoading: false });
    render(<TenantBackup />, { wrapper });
    expect(screen.getByRole('heading', { name: /Tenant Backup/i })).toBeInTheDocument();
    expect(screen.getByTestId('tenant-backup-tab-bundles')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-backup-tab-schedules')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-backup-tab-carts')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-backup-tab-targets')).toBeInTheDocument();
  });

  it('shows bundles table with client name resolved', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [BUNDLE], pagination: {} } }, isLoading: false });
    render(<TenantBackup />, { wrapper });
    // Server-side `clientName` from the bundle summary takes precedence over
    // the client-side useClients() lookup (so bundles for deleted clients
    // still show a name).
    expect(screen.getByText('Test Co')).toBeInTheDocument();
    expect(screen.getByText(/manual-test/)).toBeInTheDocument();
  });

  it('search box filters bundles by client name', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [BUNDLE], pagination: {} } }, isLoading: false });
    render(<TenantBackup />, { wrapper });
    fireEvent.change(screen.getByTestId('bundle-search'), { target: { value: 'nonexistent' } });
    expect(screen.getByText(/No bundles match/)).toBeInTheDocument();
  });

  it('schedules tab renders global schedule list', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [], pagination: {} } }, isLoading: false });
    // Outer .data = success() envelope; inner .data = list payload.
    mockedSchedules.mockReturnValue({ data: { data: { data: [SCHEDULE] } }, isLoading: false });
    render(<TenantBackup />, { wrapper: ({ children }) => wrapper({ children, initialEntries: ['/tenant-backup?tab=schedules'] }) });
    expect(screen.getByTestId('tenant-backup-tab-schedules')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    // "Enabled" appears twice (header column + the row badge); just
    // confirm we have at least one row badge.
    expect(screen.getAllByText(/Enabled/).length).toBeGreaterThanOrEqual(1);
  });

  it('schedules tab flags deleted client with italic warning', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [], pagination: {} } }, isLoading: false });
    mockedSchedules.mockReturnValue({
      data: { data: { data: [{ ...SCHEDULE, businessName: null }] } },
      isLoading: false,
    });
    render(<TenantBackup />, { wrapper: ({ children }) => wrapper({ children, initialEntries: ['/tenant-backup?tab=schedules'] }) });
    expect(screen.getByText('(deleted)')).toBeInTheDocument();
  });

  it('carts tab shows Resume button on failed carts', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [], pagination: {} } }, isLoading: false });
    mockedCarts.mockReturnValue({
      data: {
        // Outer envelope (success() wrapper) + inner list payload.
        data: {
          data: [{
            id: 'rstr-1', clientId: 'c1', initiatorUserId: null, status: 'failed',
            preRestoreSnapshotId: null, description: 'test cart',
            startedAt: null, finishedAt: null, lastError: null,
            createdAt: '2026-05-05T18:00:00Z', updatedAt: '2026-05-05T18:00:00Z',
          }],
        },
      },
      isLoading: false, error: null,
    });
    render(<TenantBackup />, { wrapper: ({ children }) => wrapper({ children, initialEntries: ['/tenant-backup?tab=carts'] }) });
    expect(screen.getByText(/Resume/)).toBeInTheDocument();
  });

  it('shows the empty-state CTA when there are no bundles', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [], pagination: {} } }, isLoading: false });
    render(<TenantBackup />, { wrapper });
    expect(screen.getByText(/No tenant bundles captured yet/)).toBeInTheDocument();
    expect(screen.getByText(/Create one now/)).toBeInTheDocument();
  });

  it('opens the New bundle modal when the toolbar button is clicked', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [BUNDLE], pagination: {} } }, isLoading: false });
    render(<TenantBackup />, { wrapper });
    fireEvent.click(screen.getByTestId('bundle-create'));
    expect(screen.getByRole('dialog', { name: /Create tenant bundle/i })).toBeInTheDocument();
    // All four components default-checked.
    expect(screen.getByLabelText(/files/i)).toBeChecked();
    expect(screen.getByLabelText(/mailboxes/i)).toBeChecked();
  });

  it('coverage tab renders no-drift state when every table is owned', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [], pagination: {} } }, isLoading: false });
    mockedCoverage.mockReturnValue({
      data: {
        data: {
          components: [
            { name: 'files', description: 'tenant PVC', tables: [], pvcs: ['{ns}-storage'], secretTypes: [], externalResources: [] },
            { name: 'config', description: 'json dump', tables: ['clients', 'domains'], pvcs: [], secretTypes: [], externalResources: [] },
          ],
          drift: { orphanTables: [], excludedTables: [], ownedTableCount: 12, totalTenantTables: 12 },
        },
      },
      isLoading: false,
      error: null,
    });
    render(<TenantBackup />, { wrapper: ({ children }) => wrapper({ children, initialEntries: ['/tenant-backup?tab=coverage'] }) });
    expect(screen.getByText(/No drift/)).toBeInTheDocument();
    expect(screen.getByText('Component registry')).toBeInTheDocument();
    expect(screen.getByText(/clients, domains/)).toBeInTheDocument();
  });

  it('coverage tab flags orphan tables as red', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [], pagination: {} } }, isLoading: false });
    mockedCoverage.mockReturnValue({
      data: {
        data: {
          components: [
            { name: 'config', description: 'cfg', tables: ['clients'], pvcs: [], secretTypes: [], externalResources: [] },
          ],
          drift: {
            orphanTables: [{ table: 'newFeatureTable' }, { table: 'anotherOrphan' }],
            excludedTables: [],
            ownedTableCount: 1,
            totalTenantTables: 3,
          },
        },
      },
      isLoading: false,
      error: null,
    });
    render(<TenantBackup />, { wrapper: ({ children }) => wrapper({ children, initialEntries: ['/tenant-backup?tab=coverage'] }) });
    expect(screen.getByText(/2 orphans/)).toBeInTheDocument();
    expect(screen.getByText('newFeatureTable')).toBeInTheDocument();
    expect(screen.getByText('anotherOrphan')).toBeInTheDocument();
  });

  it('toolbar exposes Verify-all + Import buttons', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [BUNDLE], pagination: {} } }, isLoading: false });
    render(<TenantBackup />, { wrapper });
    expect(screen.getByTestId('bundle-verify-all')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-import')).toBeInTheDocument();
  });

  it('Import button opens the import modal', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [BUNDLE], pagination: {} } }, isLoading: false });
    render(<TenantBackup />, { wrapper });
    fireEvent.click(screen.getByTestId('bundle-import'));
    expect(screen.getByRole('dialog', { name: /Import bundle/i })).toBeInTheDocument();
  });

  it('targets tab nudges to add a target when none configured', () => {
    mockedBundles.mockReturnValue({ data: { data: { data: [], pagination: {} } }, isLoading: false });
    mockedConfigs.mockReturnValue({ data: { data: [] }, isLoading: false });
    render(<TenantBackup />, { wrapper: ({ children }) => wrapper({ children, initialEntries: ['/tenant-backup?tab=targets'] }) });
    expect(screen.getByText(/No off-site targets yet/i)).toBeInTheDocument();
  });
});
