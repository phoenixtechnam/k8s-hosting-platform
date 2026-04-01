import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Workloads from '../pages/Workloads';
import { apiFetch } from '@/lib/api-client';

const MOCK_CATALOG_ENTRIES = [
  {
    id: 'entry-1',
    code: 'nginx-php84',
    name: 'NGINX + PHP 8.4',
    type: 'runtime',
    version: '8.4.0',
    description: null,
    category: null,
    tags: null,
    components: null,
    resources: null,
    status: 'active',
    featured: 0,
    popular: 0,
    url: null,
    documentation: null,
    manifestUrl: null,
    parameters: null,
    networking: null,
    volumes: null,
    healthCheck: null,
    sourceRepoId: null,
    registryUrl: 'ghcr.io/k8s-hosting/nginx-php84',
    imageType: 'runtime',
    createdAt: '2026-01-15T00:00:00Z',
  },
  {
    id: 'entry-2',
    code: 'mariadb-106',
    name: 'MariaDB 10.6',
    type: 'database',
    version: '10.6.0',
    description: null,
    category: null,
    tags: null,
    components: null,
    resources: null,
    status: 'active',
    featured: 0,
    popular: 0,
    url: null,
    documentation: null,
    manifestUrl: null,
    parameters: null,
    networking: null,
    volumes: null,
    healthCheck: null,
    sourceRepoId: null,
    registryUrl: 'ghcr.io/k8s-hosting/mariadb-106',
    imageType: 'database',
    createdAt: '2026-01-16T00:00:00Z',
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

describe('Deployments page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders page heading "Deployments"', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Deployments' })).toBeInTheDocument();
  });

  it('renders all three tabs', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
    expect(screen.getByTestId('tab-deployed')).toHaveTextContent('Deployed');
    expect(screen.getByTestId('tab-available')).toHaveTextContent('Available');
    expect(screen.getByTestId('tab-repos')).toHaveTextContent('Repositories');
  });

  it('defaults to "Deployed" tab', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('deployed-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('available-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('repos-tab')).not.toBeInTheDocument();
  });

  it('shows "Select a client" prompt on Deployed tab when no client selected', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('select-client-prompt')).toBeInTheDocument();
    expect(screen.getByText(/Select a client to view their deployed services/)).toBeInTheDocument();
  });

  it('switches to "Available" tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/catalog-repos')) return Promise.resolve({ data: [] });
      if (url.includes('/catalog')) return Promise.resolve({ data: MOCK_CATALOG_ENTRIES, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
      return Promise.resolve({ data: [] });
    });

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    expect(screen.getByTestId('available-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('deployed-tab')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('images-table')).toBeInTheDocument();
    });
    expect(screen.getByText('NGINX + PHP 8.4')).toBeInTheDocument();
  });

  it('switches to "Repositories" tab', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-repos'));

    expect(screen.getByTestId('repos-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('deployed-tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-repos-section')).toBeInTheDocument();
  });

  it('shows search input on Available tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/catalog-repos')) return Promise.resolve({ data: [] });
      if (url.includes('/catalog')) return Promise.resolve({ data: MOCK_CATALOG_ENTRIES, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
      return Promise.resolve({ data: [] });
    });

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    expect(screen.getByTestId('image-search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search images...')).toBeInTheDocument();
  });

  it('filters images by search on Available tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/catalog-repos')) return Promise.resolve({ data: [] });
      if (url.includes('/catalog')) return Promise.resolve({ data: MOCK_CATALOG_ENTRIES, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
      return Promise.resolve({ data: [] });
    });

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    await waitFor(() => {
      expect(screen.getByText('NGINX + PHP 8.4')).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId('image-search');
    fireEvent.change(searchInput, { target: { value: 'MariaDB' } });

    expect(screen.getByText('MariaDB 10.6')).toBeInTheDocument();
    expect(screen.queryByText('NGINX + PHP 8.4')).not.toBeInTheDocument();
  });

  it('shows stat cards on Available tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/catalog-repos')) return Promise.resolve({ data: [] });
      if (url.includes('/catalog')) return Promise.resolve({ data: MOCK_CATALOG_ENTRIES, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
      return Promise.resolve({ data: [] });
    });

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    await waitFor(() => {
      expect(screen.getByText('Total Images')).toBeInTheDocument();
    });
    expect(screen.getByText('Active Deployments')).toBeInTheDocument();
    expect(screen.getByText('Deployments Today')).toBeInTheDocument();
  });

  it('shows error state on Available tab when API fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    await waitFor(() => {
      expect(screen.getByTestId('error-message')).toBeInTheDocument();
    });
    expect(screen.getByText(/Failed to load catalog entries/)).toBeInTheDocument();
  });

  it('renders client search on Deployed tab', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-search-select')).toBeInTheDocument();
  });
});
