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

// AdminUpgradesGroup shape — returned by GET /admin/upgrades/overview
// and consumed by DeploymentUpgradesTab via useAdminUpgradesOverview.
const mockUpgradesOverview = {
  data: [
    {
      catalogEntryId: 'cat-001',
      code: 'wordpress',
      name: 'WordPress',
      lockMode: 'advisory',
      latestVersion: '6.9',
      defaultVersion: '6.9',
      deployments: [
        {
          id: 'inst-001',
          clientId: 'client-001',
          clientCompanyName: 'Acme Corp',
          name: 'my-wordpress',
          status: 'running',
          installedVersion: '6.7',
          previousVersion: null,
          autoUpgrade: false,
          lastUpgradedAt: null,
          domainName: null,
          previewUrl: null,
          availableUpgradeCount: 2,
          latestReachable: '6.9',
        },
        {
          id: 'inst-002',
          clientId: 'client-002',
          clientCompanyName: 'Beta Inc',
          name: 'blog-wordpress',
          status: 'running',
          installedVersion: '6.8',
          previousVersion: null,
          autoUpgrade: false,
          lastUpgradedAt: null,
          domainName: null,
          previewUrl: null,
          availableUpgradeCount: 1,
          latestReachable: '6.9',
        },
      ],
    },
  ],
};

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn().mockImplementation((url: string) => {
    if (url.includes('/catalog')) return Promise.resolve(mockCatalog);
    if (url.includes('/admin/deployments')) return Promise.resolve(mockDeployments);
    if (url.includes('/admin/upgrades/overview')) return Promise.resolve(mockUpgradesOverview);
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

  it('should render tab bar with all tabs', async () => {
    renderWithProviders(<Applications />);
    await waitFor(() => {
      expect(screen.getByTestId('tab-catalog')).toBeDefined();
      expect(screen.getByTestId('tab-installed')).toBeDefined();
      expect(screen.getByTestId('tab-upgrades')).toBeDefined();
      expect(screen.getByTestId('tab-repos')).toBeDefined();
    });
  });

  it('should render catalog tab by default', async () => {
    renderWithProviders(<Applications />);
    await waitFor(() => {
      expect(screen.getByTestId('catalog-tab')).toBeDefined();
    });
  });

  it('should switch to upgrades tab', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-upgrades').click();
    await waitFor(() => {
      expect(screen.getByTestId('deployment-upgrades-tab')).toBeDefined();
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

  it('should display upgrade overview table', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-upgrades').click();
    await waitFor(() => {
      expect(screen.getByTestId('deployments-table-wordpress')).toBeDefined();
    });
  });

  it('should show rollback button for deployments with a previous version', async () => {
    const { apiFetch } = await import('@/lib/api-client');
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/admin/upgrades/overview')) {
        return Promise.resolve({
          data: [{
            ...mockUpgradesOverview.data[0],
            deployments: [{
              ...mockUpgradesOverview.data[0].deployments[0],
              id: 'inst-rollback',
              previousVersion: '6.6',
              availableUpgradeCount: 1,
              latestReachable: '6.9',
            }],
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
      expect(screen.getByTestId('rollback-btn-inst-rollback')).toBeDefined();
    });
  });
});
