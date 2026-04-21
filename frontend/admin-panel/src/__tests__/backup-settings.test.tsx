import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import BackupSettings from '../pages/BackupSettings';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BackupSettings page', () => {
  it('renders page heading', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<BackupSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('backup-settings-heading')).toBeInTheDocument();
    });
    expect(screen.getByText('Backup Configuration')).toBeInTheDocument();
  });

  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<BackupSettings />, { wrapper: createWrapper() });
    // The Loader2 spinner is rendered — check for the animate-spin class
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows empty state when no configs exist', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<BackupSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No backup targets configured. Add one to get started.')).toBeInTheDocument();
    });
  });

  it('shows add backup target button', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<BackupSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-backup-config-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Backup Target')).toBeInTheDocument();
  });

  it('shows form when add button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<BackupSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-backup-config-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-backup-config-button'));
    expect(screen.getByTestId('backup-config-form')).toBeInTheDocument();
    expect(screen.getByTestId('bc-name')).toBeInTheDocument();
    expect(screen.getByTestId('bc-type-ssh')).toBeInTheDocument();
    expect(screen.getByTestId('bc-type-s3')).toBeInTheDocument();
  });

  it('renders backup configs when data is returned', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: 'bc-1',
          name: 'Nightly SSH',
          storageType: 'ssh',
          sshUser: 'backup',
          sshHost: 'storage.example.com',
          sshPath: '/backups',
          sshPort: 22,
          s3Endpoint: null,
          s3Bucket: null,
          s3Region: null,
          s3Prefix: null,
          retentionDays: 30,
          scheduleExpression: '0 2 * * *',
          enabled: 1,
          lastTestedAt: null,
          lastTestStatus: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    render(<BackupSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('backup-config-bc-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Nightly SSH')).toBeInTheDocument();
    expect(screen.getByText('Retention: 30d')).toBeInTheDocument();
  });

  it('shows SSH fields by default in form', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<BackupSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-backup-config-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-backup-config-button'));
    expect(screen.getByTestId('bc-ssh-host')).toBeInTheDocument();
    expect(screen.getByTestId('bc-ssh-user')).toBeInTheDocument();
  });
});
