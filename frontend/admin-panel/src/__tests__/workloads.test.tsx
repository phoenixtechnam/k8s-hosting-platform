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

  it('shows loading state initially', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {})); // never resolves

    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows all three stat cards', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_IMAGES });

    render(<Workloads />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('Total Images')).toBeInTheDocument();
    });
    expect(screen.getByText('Active Workloads')).toBeInTheDocument();
    expect(screen.getByText('Deployments Today')).toBeInTheDocument();
    const statCards = screen.getAllByTestId('stat-card');
    expect(statCards).toHaveLength(3);
  });

  it('shows search input for filtering images', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('image-search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search images...')).toBeInTheDocument();
  });

  it('renders container images from API', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_IMAGES });

    render(<Workloads />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('images-table')).toBeInTheDocument();
    });
    expect(screen.getByText('NGINX + PHP 8.4')).toBeInTheDocument();
    expect(screen.getByText('WordPress (PHP 8.4)')).toBeInTheDocument();
  });

  it('displays real image count in Total Images stat', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_IMAGES });

    render(<Workloads />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  it('filters images based on search input', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_IMAGES });

    render(<Workloads />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('NGINX + PHP 8.4')).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId('image-search');
    fireEvent.change(searchInput, { target: { value: 'WordPress' } });

    expect(screen.getByText('WordPress (PHP 8.4)')).toBeInTheDocument();
    expect(screen.queryByText('NGINX + PHP 8.4')).not.toBeInTheDocument();
  });

  it('shows empty state when no images match search', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_IMAGES });

    render(<Workloads />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('NGINX + PHP 8.4')).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId('image-search');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    expect(screen.getByText('No images found matching your search.')).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));

    render(<Workloads />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('error-message')).toBeInTheDocument();
    });
    expect(screen.getByText(/Failed to load container images/)).toBeInTheDocument();
  });

  it('shows image count footer', async () => {
    mockApiFetch.mockResolvedValue({ data: MOCK_IMAGES });

    render(<Workloads />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('2 images')).toBeInTheDocument();
    });
  });
});
