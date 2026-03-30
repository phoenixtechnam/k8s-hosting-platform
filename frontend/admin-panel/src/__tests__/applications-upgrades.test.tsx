import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const mockInstances = {
  data: [
    {
      id: 'inst-001',
      clientId: 'client-001',
      applicationCatalogId: 'cat-001',
      name: 'my-wordpress',
      domainName: 'example.com',
      configuration: null,
      helmReleaseName: 'wp-001',
      installedVersion: '6.7',
      targetVersion: null,
      lastUpgradedAt: null,
      status: 'running',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
    {
      id: 'inst-002',
      clientId: 'client-002',
      applicationCatalogId: 'cat-001',
      name: 'blog-wordpress',
      domainName: 'blog.example.com',
      configuration: null,
      helmReleaseName: 'wp-002',
      installedVersion: '6.8',
      targetVersion: '6.9',
      lastUpgradedAt: null,
      status: 'upgrading',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  ],
};

const mockUpgrades = {
  data: [
    {
      id: 'upg-001',
      instanceId: 'inst-002',
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
      instanceId: 'inst-001',
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
  apiFetch: vi.fn().mockImplementation((url: string) => {
    if (url.includes('/admin/application-catalog')) return Promise.resolve(mockCatalog);
    if (url.includes('/admin/application-instances') && !url.includes('upgrade')) return Promise.resolve(mockInstances);
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
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
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

  it('should display instances table in installed tab', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-installed').click();
    await waitFor(() => {
      expect(screen.getByTestId('instances-table')).toBeDefined();
    });
  });

  it('should show upgrade button for running instances without target', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-installed').click();
    await waitFor(() => {
      expect(screen.getByTestId('upgrade-btn-inst-001')).toBeDefined();
    });
  });

  it('should show upgrading indicator for instances being upgraded', async () => {
    renderWithProviders(<Applications />);
    screen.getByTestId('tab-installed').click();
    await waitFor(() => {
      expect(screen.getByText('Upgrading...')).toBeDefined();
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
            status: 'failed',
            progressPct: -1,
            errorMessage: 'Health check failed',
          }],
        });
      }
      if (url.includes('/admin/application-catalog')) return Promise.resolve(mockCatalog);
      if (url.includes('/admin/application-instances')) return Promise.resolve(mockInstances);
      return Promise.resolve({ data: [] });
    });

    renderWithProviders(<Applications />);
    screen.getByTestId('tab-upgrades').click();
    await waitFor(() => {
      expect(screen.getByTestId('rollback-btn-upg-fail')).toBeDefined();
    });
  });
});
