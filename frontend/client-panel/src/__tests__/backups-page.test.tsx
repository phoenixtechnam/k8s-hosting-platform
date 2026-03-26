import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Backups from '../pages/Backups';

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

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({
    clientId: 'client-1',
    clientName: 'Test Company',
    isLoading: false,
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

describe('Backups Page', () => {
  it('renders the heading and description', () => {
    mockedUseBackups.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByTestId('backups-heading')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('View and manage your backup snapshots.')).toBeInTheDocument();
  });

  it('shows loading state with spinner', () => {
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

  it('shows empty state when no backups exist', () => {
    mockedUseBackups.mockReturnValue({
      data: { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 20 } },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByTestId('backups-empty')).toBeInTheDocument();
    expect(screen.getByText('No backups yet')).toBeInTheDocument();
    expect(screen.getByText('Your backup snapshots will appear here once created.')).toBeInTheDocument();
  });

  it('shows error state with error message', () => {
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

  it('renders backup list with type, resource, status, and size', () => {
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
    // Backup IDs (truncated to first 8 chars)
    expect(screen.getByText('abcdef12')).toBeInTheDocument();
    expect(screen.getByText('98765432')).toBeInTheDocument();
    // Backup types
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
    // Resource types
    expect(screen.getByText('database')).toBeInTheDocument();
    expect(screen.getByText('files')).toBeInTheDocument();
    // Statuses
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('formats size bytes correctly for completed backup', () => {
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
        ],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    // 1048576 bytes = 1.0 MB
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
  });

  it('shows table header columns', () => {
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
        ],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.getByText('Backup ID')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Resource')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.getByText('Expires')).toBeInTheDocument();
  });

  it('does not show table when loading', () => {
    mockedUseBackups.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.queryByTestId('backups-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backups-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backups-error')).not.toBeInTheDocument();
  });

  it('does not show loading or empty when error occurs', () => {
    mockedUseBackups.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Service unavailable'),
    } as unknown as ReturnType<typeof useBackups>);
    renderWithProviders(<Backups />);
    expect(screen.queryByTestId('backups-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backups-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backups-table')).not.toBeInTheDocument();
  });
});
