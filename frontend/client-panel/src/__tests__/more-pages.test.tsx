import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Backups from '../pages/Backups';
import Email from '../pages/Email';
import Files from '../pages/Files';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'client-1', email: 'test@example.com', fullName: 'Test User', role: 'client' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-backups', () => ({
  useBackups: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  })),
}));

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({
    clientId: 'client-1',
    clientName: 'Test Company',
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-file-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-file-manager')>();
  return {
    ...actual,
    useFileManagerStatus: vi.fn(() => ({ data: { ready: false, phase: 'starting' }, isLoading: false, error: null })),
    useStartFileManager: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useDirectoryListing: vi.fn(() => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() })),
    useFileContent: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
    useCreateDirectory: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useWriteFile: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useRenameFile: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
    useDeleteFile: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
    useDownloadFile: vi.fn(() => vi.fn()),
    useUploadFiles: vi.fn(() => ({ uploads: [], uploadFiles: vi.fn(), clearUploads: vi.fn(), visible: false, setVisible: vi.fn() })),
    useCopyFile: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
    useArchiveFiles: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useExtractArchive: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useGitClone: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useAuthenticatedBlobUrl: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
    useDiskUsage: vi.fn(() => ({ data: null, isLoading: false })),
    useFolderSize: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
    useChmod: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
  };
});

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
}));

vi.mock('../hooks/use-email', () => ({
  useEmailDomains: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useMailboxes: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailAliases: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useWebmailToken: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useEnableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDisableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null })),
  useEmailDomainDisablePreview: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  useUpdateEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailDomainDnsRecords: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
  useDkimKeys: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useRotateDkimKey: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useActivateDkimKey: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useMailSubmitCredential: vi.fn(() => ({ data: { data: { exists: false } }, isLoading: false })),
  useRotateMailSubmitCredential: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useImapSyncJobs: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateImapSyncJob: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useCancelImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  usePurgeImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useResyncImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useMailRateLimit: vi.fn(() => ({
    data: { data: { limitPerHour: 100, source: 'hardcoded_default', suspended: false } },
    isLoading: false,
  })),
  useMailboxUsage: vi.fn(() => ({
    data: { data: { limit: 50, current: 0, remaining: 50, source: 'plan' } },
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-domains', () => ({
  useDomains: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
  })),
}));

import { useBackups } from '../hooks/use-backups';

const mockedUseBackups = vi.mocked(useBackups);

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Backups', () => {
  it('renders the heading', () => {
    mockedUseBackups.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByTestId('backups-heading')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    mockedUseBackups.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByTestId('backups-loading')).toBeInTheDocument();
    expect(screen.getByText('Loading backups...')).toBeInTheDocument();
  });

  it('shows empty state when no backups', () => {
    mockedUseBackups.mockReturnValue({
      data: { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 20 } },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByTestId('backups-empty')).toBeInTheDocument();
    expect(screen.getByText('No backups yet')).toBeInTheDocument();
  });

  it('shows error state', () => {
    mockedUseBackups.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network error'),
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByTestId('backups-error')).toBeInTheDocument();
    expect(screen.getByText(/Network error/)).toBeInTheDocument();
  });

  it('renders backup rows when data is present', () => {
    mockedUseBackups.mockReturnValue({
      data: {
        data: [
          {
            id: 'abcdef12-3456-7890-abcd-ef1234567890',
            clientId: 'c1',
            backupType: 'auto',
            resourceType: 'database',
            status: 'completed',
            storagePath: '/backups/abcdef12',
            sizeBytes: 1048576,
            expiresAt: '2026-04-25T00:00:00Z',
            createdAt: '2026-03-25T00:00:00Z',
          },
          {
            id: '98765432-abcd-ef01-2345-678901234567',
            clientId: 'c1',
            backupType: 'manual',
            resourceType: 'files',
            status: 'pending',
            storagePath: null,
            sizeBytes: null,
            expiresAt: null,
            createdAt: '2026-03-24T00:00:00Z',
          },
        ],
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByTestId('backups-table')).toBeInTheDocument();
    expect(screen.getByText('abcdef12')).toBeInTheDocument();
    expect(screen.getByText('98765432')).toBeInTheDocument();
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});

describe('Email', () => {
  it('renders the heading', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-heading')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('shows the Enable Email card when no email domains', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-enable-card')).toBeInTheDocument();
    expect(screen.getByText('Enable Email Hosting')).toBeInTheDocument();
  });
});

describe('Files', () => {
  it('renders the heading', () => {
    renderWithProviders(<Files />);
    expect(screen.getByTestId('files-heading')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('shows loading state when starting', () => {
    renderWithProviders(<Files />);
    // File manager status defaults to starting/not_deployed, should show loading
    expect(screen.getByText('Starting File Manager')).toBeInTheDocument();
  });
});
