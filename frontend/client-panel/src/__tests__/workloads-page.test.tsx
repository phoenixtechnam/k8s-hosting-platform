import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Workloads from '../pages/Workloads';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({ clientId: 'c1', clientName: 'Test Corp', isLoading: false })),
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
const MOCK_DEPLOYMENTS = [
  { id: 'w1', clientId: 'c1', name: 'my-app', catalogEntryId: 'img1', replicaCount: 2, cpuRequest: '0.5', memoryRequest: '512Mi', status: 'running', createdAt: '2026-01-10T00:00:00Z', updatedAt: '2026-01-10T00:00:00Z' },
  { id: 'w2', clientId: 'c1', name: 'worker', catalogEntryId: 'img2', replicaCount: 1, cpuRequest: '0.25', memoryRequest: '256Mi', status: 'stopped', createdAt: '2026-01-10T00:00:00Z', updatedAt: '2026-01-10T00:00:00Z' },
];
const MOCK_CATALOG = [
  { id: 'img1', code: 'nginx', name: 'NGINX', imageType: 'web', registryUrl: null, status: 'active', createdAt: '2026-01-01T00:00:00Z' },
];

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

function setupMocks() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/deployments')) return Promise.resolve({ data: MOCK_DEPLOYMENTS, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
    if (url.includes('/catalog')) return Promise.resolve({ data: MOCK_CATALOG, pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Client Workloads page', () => {
  it('renders heading', async () => {
    setupMocks();
    render(<Workloads />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('workloads-heading')).toHaveTextContent('Workloads'));
  });

  it('renders workload rows in deployed tab', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<Workloads />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('tab-deployed'));
    await waitFor(() => expect(screen.getByTestId('workloads-table')).toBeInTheDocument());
    expect(screen.getByText('my-app')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
  });

  it('shows deploy button in deployed tab', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<Workloads />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('tab-deployed'));
    await waitFor(() => expect(screen.getByTestId('deploy-workload-button')).toBeInTheDocument());
  });

  it('shows deploy modal on click', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<Workloads />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('tab-deployed'));
    await waitFor(() => expect(screen.getByTestId('deploy-workload-button')).toBeInTheDocument());
    await user.click(screen.getByTestId('deploy-workload-button'));
    expect(screen.getByTestId('deploy-workload-modal')).toBeInTheDocument();
  });

  it('has start/stop toggle per workload', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<Workloads />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('tab-deployed'));
    await waitFor(() => expect(screen.getByTestId('toggle-workload-w1')).toBeInTheDocument());
    expect(screen.getByTestId('toggle-workload-w2')).toBeInTheDocument();
  });

  it('has delete button per workload', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<Workloads />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('tab-deployed'));
    await waitFor(() => expect(screen.getByTestId('delete-workload-w1')).toBeInTheDocument());
  });

  it('shows empty state when no workloads', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/deployments')) return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } });
      if (url.includes('/catalog')) return Promise.resolve({ data: MOCK_CATALOG, pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<Workloads />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('tab-deployed'));
    await waitFor(() => expect(screen.getByTestId('workloads-empty')).toBeInTheDocument());
  });
});
