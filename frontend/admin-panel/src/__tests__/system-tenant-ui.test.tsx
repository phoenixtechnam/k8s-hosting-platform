import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TenantDetail from '../pages/TenantDetail';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
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

function buildTenantPayload(overrides: { isSystem: boolean; name?: string; status?: string }) {
  return {
    data: {
      id: 'sys-001',
      name: overrides.name ?? 'SYSTEM',
      primaryEmail: '_system@k8s-platform.test',
      secondaryEmail: null,
      status: overrides.status ?? 'active',
      planId: 'plan-starter',
      regionId: 'region-001',
      kubernetesNamespace: 'tenant-system',
      provisioningStatus: 'provisioned',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: null,
      isSystem: overrides.isSystem,
    },
  };
}

function setupMockApi(tenantPayload: { data: Record<string, unknown> }) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.match(/\/tenants\/sys-001$/)) return Promise.resolve(tenantPayload);
    if (path.includes('/metrics')) return Promise.resolve({ data: null });
    return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 25 } });
  });
}

function renderTenantDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tenants/sys-001']}>
        <Routes>
          <Route path="tenants/:id" element={<TenantDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TenantDetail — SYSTEM tenant gating (ADR-040)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the SYSTEM banner when tenant.isSystem is true', async () => {
    setupMockApi(buildTenantPayload({ isSystem: true }));
    renderTenantDetail();
    await waitFor(() => {
      expect(screen.getByTestId('system-tenant-banner')).toBeInTheDocument();
    });
    expect(screen.getByText(/platform-managed/i)).toBeInTheDocument();
  });

  it('hides Suspend, Archive, and Delete buttons on SYSTEM', async () => {
    setupMockApi(buildTenantPayload({ isSystem: true }));
    renderTenantDetail();
    await waitFor(() => {
      expect(screen.getByTestId('system-tenant-banner')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('suspend-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('archive-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reactivate-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('restore-button')).not.toBeInTheDocument();
  });

  it('shows the "(locked)" indicator instead of the status change button on SYSTEM', async () => {
    setupMockApi(buildTenantPayload({ isSystem: true }));
    renderTenantDetail();
    await waitFor(() => {
      expect(screen.getByTestId('system-tenant-banner')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('lifecycle-status-edit')).not.toBeInTheDocument();
    expect(screen.getByText(/\(locked\)/i)).toBeInTheDocument();
  });

  it('does NOT render the SYSTEM banner on a normal tenant', async () => {
    setupMockApi(buildTenantPayload({ isSystem: false, name: 'Acme Corp' }));
    renderTenantDetail();
    await waitFor(() => {
      // Wait for tenant data to load
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('system-tenant-banner')).not.toBeInTheDocument();
  });

  it('shows Suspend + Delete buttons on a normal active tenant', async () => {
    setupMockApi(buildTenantPayload({ isSystem: false, name: 'Acme Corp', status: 'active' }));
    renderTenantDetail();
    await waitFor(() => {
      expect(screen.getByTestId('suspend-button')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-button')).toBeInTheDocument();
    expect(screen.getByTestId('lifecycle-status-edit')).toBeInTheDocument();
  });
});
