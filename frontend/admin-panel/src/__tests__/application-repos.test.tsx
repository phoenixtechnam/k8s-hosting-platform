import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ApplicationRepoSettings from '../components/ApplicationRepoSettings';
import { apiFetch } from '@/lib/api-client';

const MOCK_REPOS = [
  {
    id: 'repo-1',
    name: 'production-apps',
    url: 'https://github.com/org/production-apps.git',
    branch: 'main',
    syncIntervalMinutes: 5,
    lastSyncedAt: '2026-03-20T10:00:00Z',
    status: 'active' as const,
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'repo-2',
    name: 'staging-apps',
    url: 'https://github.com/org/staging-apps.git',
    branch: 'develop',
    syncIntervalMinutes: 10,
    lastSyncedAt: null,
    status: 'error' as const,
    lastError: 'Authentication failed',
    createdAt: '2026-02-01T00:00:00Z',
  },
] as const;

vi.mock('@/lib/api-client', () => ({
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

describe('ApplicationRepoSettings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the "Application Repositories" heading', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });
    expect(screen.getByText('Application Repositories')).toBeInTheDocument();
  });

  it('shows the "Add Repository" button', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-repo-button')).toBeInTheDocument();
    expect(screen.getByText('Add Repository')).toBeInTheDocument();
  });

  it('renders table headers (Name, URL, Branch, Status, Actions)', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_REPOS });
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('repos-table')).toBeInTheDocument();
    });

    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('URL')).toBeInTheDocument();
    expect(screen.getByText('Branch')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('displays repositories from API response', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_REPOS });
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('production-apps')).toBeInTheDocument();
    });
    expect(screen.getByText('staging-apps')).toBeInTheDocument();
    expect(screen.getByText('https://github.com/org/production-apps.git')).toBeInTheDocument();
    expect(screen.getByText('develop')).toBeInTheDocument();
  });

  it('shows the add repository form when button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    const user = userEvent.setup();

    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('repos-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('add-repo-button'));
    expect(screen.getByTestId('add-repo-form')).toBeInTheDocument();
    expect(screen.getByTestId('repo-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('repo-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('repo-branch-input')).toBeInTheDocument();
  });

  it('shows loading state while fetching repos', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('repos-loading')).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('repos-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/Failed to load repositories/)).toBeInTheDocument();
  });

  it('shows empty state when no repos are configured', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('No application repositories configured. Add one to get started.')).toBeInTheDocument();
    });
  });

  it('shows sync and delete buttons for each repo', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_REPOS });
    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('sync-repo-repo-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-repo-repo-1')).toBeInTheDocument();
    expect(screen.getByTestId('sync-repo-repo-2')).toBeInTheDocument();
    expect(screen.getByTestId('delete-repo-repo-2')).toBeInTheDocument();
  });

  it('shows delete confirmation when delete button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_REPOS });
    const user = userEvent.setup();

    render(<ApplicationRepoSettings />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('delete-repo-repo-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('delete-repo-repo-1'));
    expect(screen.getByTestId('confirm-delete-repo-repo-1')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-delete-repo-repo-1')).toBeInTheDocument();
  });
});
