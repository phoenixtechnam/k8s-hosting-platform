import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CronJobs from '../pages/CronJobs';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({ clientId: 'c1', clientName: 'Test Corp', isLoading: false })),
}));

// Phase 6: CronJobs now uses useCanManage which reads from useAuth.
// Default to client_admin so the existing tests still see the Add button.
const _mockAuthUser = { id: 'u1', email: 'u@c1.com', fullName: 'Me', role: 'client_admin' };
vi.mock('@/hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (state: { user: typeof _mockAuthUser }) => T) => {
    const state = { user: _mockAuthUser };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message); this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

const _MOCK_CLIENT = { id: 'c1', companyName: 'Test Corp' };
const MOCK_JOBS = [
  { id: 'cj1', clientId: 'c1', name: 'daily-backup', schedule: '0 2 * * *', command: '/bin/backup.sh', enabled: 1, lastRunAt: '2026-01-10T02:00:00Z', lastRunStatus: 'success', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-10T02:00:00Z' },
  { id: 'cj2', clientId: 'c1', name: 'cleanup', schedule: '0 0 * * 0', command: '/bin/cleanup.sh', enabled: 0, lastRunAt: null, lastRunStatus: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

function setupMocks() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/cron-jobs')) return Promise.resolve({ data: MOCK_JOBS, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Client CronJobs page', () => {
  it('renders heading', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-jobs-heading')).toHaveTextContent('Cron Jobs'));
  });

  it('renders cron job rows', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-jobs-table')).toBeInTheDocument());
    expect(screen.getByText('daily-backup')).toBeInTheDocument();
    expect(screen.getByText('cleanup')).toBeInTheDocument();
  });

  it('shows add cron job button', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument());
  });

  it('shows create form on click', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument());
    await user.click(screen.getByTestId('add-cron-job-button'));
    expect(screen.getByTestId('cron-job-form')).toBeInTheDocument();
    expect(screen.getByTestId('cron-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('cron-schedule-input')).toBeInTheDocument();
    // Default type is webcron — shows URL field
    expect(screen.getByTestId('cron-url-input')).toBeInTheDocument();
  });

  it('has start/stop toggle per cron job', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('toggle-cron-cj1')).toBeInTheDocument());
    expect(screen.getByTestId('toggle-cron-cj2')).toBeInTheDocument();
  });

  it('has run-now button per cron job', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('run-cron-cj1')).toBeInTheDocument());
  });

  it('has delete button per cron job', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('delete-cron-cj1')).toBeInTheDocument());
  });

  it('shows empty state when no cron jobs', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/cron-jobs')) return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } });
      return Promise.resolve({ data: [] });
    });
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-jobs-empty')).toBeInTheDocument());
  });
});
