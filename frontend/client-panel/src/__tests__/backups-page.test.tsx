import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Backups from '../pages/Backups';

// The Backups page was rewritten to read from the new tenant-backup
// endpoints (use-tenant-backups). The legacy /api/v1/clients/:id/backups
// hook is no longer used. The detailed list-rendering / sorting tests
// from the legacy version are now exercised end-to-end by the
// integration-staging restore scenario; the surface-level "page renders
// without throwing" smoke is preserved here.

vi.mock('../hooks/use-tenant-backups', () => ({
  useTenantBundles: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false })),
  useTenantSchedule: vi.fn(() => ({ data: { data: null }, isLoading: false })),
  useUpdateTenantSchedule: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isSuccess: false, error: null })),
  downloadTenantDataExport: vi.fn(),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Backups page (tenant-backup self-service)', () => {
  it('renders the heading + description', () => {
    render(<Backups />, { wrapper });
    expect(screen.getByTestId('backups-heading')).toBeInTheDocument();
  });

  it('shows the empty state when there are no bundles', () => {
    render(<Backups />, { wrapper });
    expect(screen.getByTestId('backups-empty')).toBeInTheDocument();
  });
});
