import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Applications from '../pages/Applications';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCatalog = {
  data: [
    {
      id: 'cat-001',
      code: 'wordpress',
      name: 'WordPress',
      version: '6.7',
      latestVersion: '6.9',
      defaultVersion: '6.9',
      description: 'WordPress CMS',
      url: null,
      documentation: null,
      category: 'cms',
      minPlan: null,
      tenancy: null,
      components: [{ name: 'wordpress', type: 'app', image: 'wordpress:6.7' }],
      networking: null,
      volumes: null,
      resources: null,
      healthCheck: null,
      parameters: null,
      tags: ['cms'],
      supportedVersions: null,
      status: 'available',
      featured: 1,
      popular: 1,
      sourceRepoId: null,
      manifestUrl: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  ],
};

// Matches AdminDeployment shape in use-application-upgrades.ts — this is what
// /admin/deployments returns via useAdminDeployments. The InstalledTab reads
// from this hook, not the deprecated /admin/application-instances endpoint.
const mockDeployments = {
  data: [
    {
      id: 'inst-001',
      name: 'my-wordpress',
      clientId: 'client-001',
      clientName: 'Acme Corp',
      catalogEntryId: 'cat-001',
      catalogEntryName: 'WordPress',
      catalogEntryCode: 'wordpress',
      catalogEntryType: 'app',
      status: 'running',
      statusMessage: null,
      lastError: null,
      cpuRequest: '100m',
      memoryRequest: '128Mi',
      storagePath: null,
      installedVersion: '6.7',
      replicaCount: 1,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
    {
      id: 'inst-002',
      name: 'blog-wordpress',
      clientId: 'client-002',
      clientName: 'Beta Inc',
      catalogEntryId: 'cat-001',
      catalogEntryName: 'WordPress',
      catalogEntryCode: 'wordpress',
      catalogEntryType: 'app',
      status: 'upgrading',
      statusMessage: null,
      lastError: null,
      cpuRequest: '100m',
      memoryRequest: '128Mi',
      storagePath: null,
      installedVersion: '6.8',
      replicaCount: 1,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  ],
  pagination: {
    page: 1,
    page_size: 50,
    total_count: 2,
    total_pages: 1,
    has_more: false,
  },
};

const mockUpgrades = {
  data: [
    {
      id: 'upg-001',
      deploymentId: 'inst-002',
      fromVersion: '6.8',
      toVersion: '6.9',
      status: 'upgrading',
      triggeredBy: 'admin',
      triggerType: 'manual',
      backupId: null,
      progressPct: 50,
      statusMessage: 'Upgrading application',
      errorMessage: null,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: null,
      createdAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'upg-002',
      deploymentId: 'inst-001',
      fromVersion: '6.6',
      toVersion: '6.7',
      status: 'completed',
      triggeredBy: 'admin',
      triggerType: 'manual',
      backupId: 'bak-001',
      progressPct: 100,
      statusMessage: 'Upgrade completed successfully',
      errorMessage: null,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T01:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    },
  ],
};

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn().mockImplementation((url: string) => {
    if (url.includes('/catalog')) return Promise.resolve(mockCatalog);
    if (url.includes('/admin/deployments')) return Promise.resolve(mockDeployments);
    if (url.includes('/admin/application-upgrades')) return Promise.resolve(mockUpgrades);
    return Promise.resolve({ data: [] });
  }),
}));

vi.mock('@/hooks/use-capacity-check', () => ({
  useCapacityCheck: () => ({ data: null }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // InstalledTab calls useNavigate — without a Router the render throws
  // silently and the body ends up empty. MemoryRouter keeps the router
  // context present without needing actual routes.
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Applications page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render all four tabs', () => {
    renderWithProviders(<Applications />);
    expect(screen.getByTestId('tab-catalog')).toBeDefined();
    expect(screen.getByTestId('tab-installed')).toBeDefined();
    expect(screen.getByTestId('tab-upgrades')).toBeDefined();
    expect(screen.getByTestId('tab-repos')).toBeDefined();
  });

  it('should render catalog tab by default', () => {
    renderWithProviders(<Applications />);
    expect(screen.getByTestId('catalog-tab')).toBeDefined();
  });

  it('should switch to installed tab', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-installed').click();
    await waitFor(() => {
      expect(screen.getByTestId('installed-tab')).toBeDefined();
    });
  });

  it('should switch to upgrades tab', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-upgrades').click();
    await waitFor(() => {
      expect(screen.getByTestId('upgrades-tab')).toBeDefined();
    });
  });

  it('should display deployments table in installed tab', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-installed').click();
    await waitFor(() => {
      expect(screen.getByTestId('deployments-table')).toBeDefined();
    });
  });

  it('should show restart button for running deployments', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-installed').click();
    await waitFor(() => {
      expect(screen.getByTestId('restart-btn-inst-001')).toBeDefined();
    });
  });

  it('should show upgrading status badge for deployments being upgraded', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-installed').click();
    await waitFor(() => {
      const table = screen.getByTestId('deployments-table');
      expect(within(table).getByText(/upgrading/i)).toBeDefined();
    });
  });

  it('should display upgrade history table', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-upgrades').click();
    await waitFor(() => {
      expect(screen.getByTestId('upgrades-table')).toBeDefined();
    });
  });

  it('should show rollback button for failed upgrades', async () => {
    // Override with a failed upgrade
    const { apiFetch } = await import('@/lib/api-client');
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/admin/application-upgrades')) {
        return Promise.resolve({
          data: [{
            ...mockUpgrades.data[0],
            id: 'upg-fail',
            deploymentId: 'inst-002',
            status: 'failed',
            progressPct: -1,
            errorMessage: 'Health check failed',
          }],
        });
      }
      if (url.includes('/catalog')) return Promise.resolve(mockCatalog);
      if (url.includes('/admin/deployments')) return Promise.resolve(mockDeployments);
      return Promise.resolve({ data: [] });
    });

    renderWithProviders(<Applications />);
    screen.getByTestId('tab-upgrades').click();
    await waitFor(() => {
      expect(screen.getByTestId('rollback-btn-upg-fail')).toBeDefined();
    });
  });
});
