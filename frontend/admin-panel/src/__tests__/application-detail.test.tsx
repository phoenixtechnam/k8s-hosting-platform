import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Applications from '../pages/Applications';
import { apiFetch } from '@/lib/api-client';

const MOCK_CATALOG_ENTRIES = [
  {
    id: 'cat-1',
    code: 'wordpress',
    name: 'WordPress',
    version: '6.7',
    description: 'Managed WordPress CMS with MariaDB',
    category: 'cms',
    minPlan: 'starter',
    tenancy: ['single-tenant'],
    components: [
      { name: 'wordpress', type: 'deployment', image: 'wordpress:6.7-php8.4-apache', ports: [{ port: 80, protocol: 'TCP', ingress: true }] },
      { name: 'mariadb', type: 'statefulset', image: 'mariadb:10.11', ports: [{ port: 3306, protocol: 'TCP', ingress: false }] },
    ],
    networking: {
      ingress_ports: [{ port: 443, protocol: 'TCP', tls: true, description: 'Web UI' }],
      host_ports: [],
      websocket: false,
    },
    volumes: [
      { name: 'wp-content', mount_path: '/var/www/html/wp-content', default_size: '10Gi', description: 'Themes, plugins' },
    ],
    resources: {
      default: { cpu: '0.50', memory: '512Mi', storage: '15Gi' },
      minimum: { cpu: '0.25', memory: '256Mi', storage: '5Gi' },
    },
    healthCheck: {
      path: '/wp-login.php',
      port: 80,
      initial_delay_seconds: 30,
      period_seconds: 15,
    },
    parameters: [
      { key: 'wordpress.siteTitle', label: 'Site Title', type: 'string', default: 'My Site', required: true },
      { key: 'wordpress.adminUser', label: 'Admin Username', type: 'string', default: 'admin', required: true },
    ],
    tags: ['cms', 'wordpress'],
    status: 'available',
    sourceRepoId: 'repo-1',
    manifestUrl: 'https://example.com/manifest.json',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
] as const;

const CAPACITY_FITS = {
  data: {
    totalCpu: 4,
    totalMemory: 8,
    totalStorage: 80,
    allocatedCpu: 0,
    allocatedMemory: 0,
    allocatedStorage: 0,
    requestedCpu: 0.25,
    requestedMemory: 0.25,
    requestedStorage: 5,
    fits: true,
    warnings: [],
  },
};

const CAPACITY_NOT_FITS = {
  data: {
    totalCpu: 4,
    totalMemory: 8,
    totalStorage: 80,
    allocatedCpu: 3.9,
    allocatedMemory: 7.8,
    allocatedStorage: 76,
    requestedCpu: 0.25,
    requestedMemory: 0.25,
    requestedStorage: 5,
    fits: false,
    warnings: [
      'This application requires 0.25 CPU but only 0.10 CPU is available',
      'This application requires 0.25Gi memory but only 0.20Gi is available',
    ],
  },
};

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

describe('Application Detail Panel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('opens the detail panel when clicking an app card', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/application-catalog')) {
        return Promise.resolve({ data: MOCK_CATALOG_ENTRIES });
      }
      if (url.includes('/capacity-check')) {
        return Promise.resolve(CAPACITY_FITS);
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<Applications />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-card-wordpress')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('catalog-card-wordpress'));

    await waitFor(() => {
      expect(screen.getByTestId('app-detail-panel')).toBeInTheDocument();
    });

    // Header content — multiple "WordPress" elements exist (card + detail panel)
    expect(screen.getAllByText('WordPress').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Managed WordPress CMS with MariaDB').length).toBeGreaterThanOrEqual(1);

    // Components table
    expect(screen.getByTestId('components-table')).toBeInTheDocument();
    expect(screen.getByText('wordpress:6.7-php8.4-apache')).toBeInTheDocument();
    expect(screen.getByText('mariadb:10.11')).toBeInTheDocument();

    // Parameters table
    expect(screen.getByTestId('parameters-table')).toBeInTheDocument();
    expect(screen.getByText('Site Title')).toBeInTheDocument();

    // Volumes table
    expect(screen.getByTestId('volumes-table')).toBeInTheDocument();
    expect(screen.getByText('wp-content')).toBeInTheDocument();

    // Resources section
    expect(screen.getAllByText('Default').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Minimum').length).toBeGreaterThanOrEqual(1);

    // Health check
    expect(screen.getByText('/wp-login.php')).toBeInTheDocument();

    // Install button disabled
    expect(screen.getByTestId('install-button')).toBeDisabled();
  });

  it('closes the detail panel when clicking Close', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/application-catalog')) {
        return Promise.resolve({ data: MOCK_CATALOG_ENTRIES });
      }
      if (url.includes('/capacity-check')) {
        return Promise.resolve(CAPACITY_FITS);
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<Applications />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-card-wordpress')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('catalog-card-wordpress'));

    await waitFor(() => {
      expect(screen.getByTestId('app-detail-panel')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('close-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('app-detail-panel')).not.toBeInTheDocument();
    });
  });

  it('shows capacity warning when resources do not fit', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/application-catalog')) {
        return Promise.resolve({ data: MOCK_CATALOG_ENTRIES });
      }
      if (url.includes('/capacity-check')) {
        return Promise.resolve(CAPACITY_NOT_FITS);
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<Applications />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-card-wordpress')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('catalog-card-wordpress'));

    await waitFor(() => {
      expect(screen.getByTestId('capacity-warning')).toBeInTheDocument();
    });

    expect(screen.getByText(/Resource warning/)).toBeInTheDocument();
    expect(screen.getByText(/only 0.10 CPU is available/)).toBeInTheDocument();
  });

  it('does not show capacity warning when resources fit', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/application-catalog')) {
        return Promise.resolve({ data: MOCK_CATALOG_ENTRIES });
      }
      if (url.includes('/capacity-check')) {
        return Promise.resolve(CAPACITY_FITS);
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<Applications />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-card-wordpress')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('catalog-card-wordpress'));

    await waitFor(() => {
      expect(screen.getByTestId('app-detail-panel')).toBeInTheDocument();
    });

    // Should not have the warning
    expect(screen.queryByTestId('capacity-warning')).not.toBeInTheDocument();
  });
});
