import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Workloads from '../pages/Workloads';
import { apiFetch } from '@/lib/api-client';

const MOCK_IMAGES = [
  {
    id: 'img-1',
    code: 'nginx-php84',
    name: 'NGINX + PHP 8.4',
    imageType: 'php',
    registryUrl: 'ghcr.io/k8s-hosting/nginx-php84',
    status: 'active',
    createdAt: '2026-01-15T00:00:00Z',
  },
  {
    id: 'img-2',
    code: 'wordpress-php84',
    name: 'WordPress (PHP 8.4)',
    imageType: 'wordpress',
    registryUrl: 'ghcr.io/k8s-hosting/wordpress-php84',
    status: 'active',
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

describe('Workloads page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders page heading "Workloads"', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Workloads' })).toBeInTheDocument();
  });

  it('renders all three tabs', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
    expect(screen.getByTestId('tab-deployed')).toHaveTextContent('Deployed Workloads');
    expect(screen.getByTestId('tab-available')).toHaveTextContent('Available Workloads');
    expect(screen.getByTestId('tab-repos')).toHaveTextContent('Repositories');
  });

  it('defaults to "Deployed Workloads" tab', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('deployed-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('available-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('repos-tab')).not.toBeInTheDocument();
  });

  it('shows "Select a client" prompt on Deployed tab when no client selected', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('select-client-prompt')).toBeInTheDocument();
    expect(screen.getByText('Select a client to view their deployed workloads.')).toBeInTheDocument();
  });

  it('switches to "Available Workloads" tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('container-images')) return Promise.resolve({ data: MOCK_IMAGES });
      if (url.includes('workload-repos')) return Promise.resolve({ data: [] });
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
    expect(screen.getByTestId('workload-repos-section')).toBeInTheDocument();
  });

  it('shows search input on Available Workloads tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('container-images')) return Promise.resolve({ data: MOCK_IMAGES });
      if (url.includes('workload-repos')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    expect(screen.getByTestId('image-search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search images...')).toBeInTheDocument();
  });

  it('filters images by search on Available Workloads tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('container-images')) return Promise.resolve({ data: MOCK_IMAGES });
      if (url.includes('workload-repos')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    await waitFor(() => {
      expect(screen.getByText('NGINX + PHP 8.4')).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId('image-search');
    fireEvent.change(searchInput, { target: { value: 'WordPress' } });

    expect(screen.getByText('WordPress (PHP 8.4)')).toBeInTheDocument();
    expect(screen.queryByText('NGINX + PHP 8.4')).not.toBeInTheDocument();
  });

  it('shows stat cards on Available Workloads tab', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('container-images')) return Promise.resolve({ data: MOCK_IMAGES });
      if (url.includes('workload-repos')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    await waitFor(() => {
      expect(screen.getByText('Total Images')).toBeInTheDocument();
    });
    expect(screen.getByText('Active Workloads')).toBeInTheDocument();
    expect(screen.getByText('Deployments Today')).toBeInTheDocument();
  });

  it('shows error state on Available Workloads tab when API fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));

    render(<Workloads />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-available'));

    await waitFor(() => {
      expect(screen.getByTestId('error-message')).toBeInTheDocument();
    });
    expect(screen.getByText(/Failed to load container images/)).toBeInTheDocument();
  });

  it('renders client search on Deployed tab', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-search-select')).toBeInTheDocument();
  });
});
