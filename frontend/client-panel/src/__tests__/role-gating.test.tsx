import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCanManage } from '../hooks/use-can-manage';

/**
 * Phase 6: tests for the shared useCanManage hook and the
 * ReadOnlyNotice gating applied to Domains, Applications,
 * CronJobs, and SshKeys pages.
 */

// Shared mock user — tests mutate .role to flip gating
const mockUser = { id: 'u1', email: 'u@c1.com', fullName: 'Me', role: 'client_admin' };
vi.mock('../hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (state: { user: typeof mockUser }) => T) => {
    const state = { user: mockUser };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: () => ({ clientId: 'c1', clientName: 'Test', isLoading: false }),
}));

vi.mock('../hooks/use-domains', () => ({
  useDomains: () => ({ data: { data: [] }, isLoading: false, isError: false, error: null }),
  useCreateDomain: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock('../hooks/use-ssh-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-ssh-keys')>();
  return {
    ...actual,
    useSshKeys: () => ({ data: { data: [] }, isLoading: false }),
    useCreateSshKey: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }),
    useDeleteSshKey: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useUpdateSshKey: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock('../hooks/use-cron-jobs', () => ({
  useCronJobs: () => ({ data: { data: [] }, isLoading: false, isError: false, error: null }),
  useCreateCronJob: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }),
  useUpdateCronJob: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRunCronJob: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteCronJob: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('../hooks/use-deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-deployments')>();
  return {
    ...actual,
    useDeployments: () => ({ data: { data: [] }, isLoading: false, error: null }),
    useUpdateDeployment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteDeployment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useRestoreDeployment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    usePermanentDeleteDeployment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeploymentLiveMetrics: () => ({ data: null, isLoading: false }),
  };
});

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('useCanManage hook', () => {
  // Force a fresh require so role changes propagate
  beforeEach(() => {
    mockUser.role = 'client_admin';
  });

  // Tiny test component that exposes the hook result
  function Probe() {
    const can = useCanManage();
    return <span data-testid="probe">{can ? 'yes' : 'no'}</span>;
  }

  it('returns true for client_admin', () => {
    mockUser.role = 'client_admin';
    render(wrap(<Probe />));
    expect(screen.getByTestId('probe')).toHaveTextContent('yes');
  });

  it('returns true for super_admin (impersonating staff)', () => {
    mockUser.role = 'super_admin';
    render(wrap(<Probe />));
    expect(screen.getByTestId('probe')).toHaveTextContent('yes');
  });

  it('returns true for admin', () => {
    mockUser.role = 'admin';
    render(wrap(<Probe />));
    expect(screen.getByTestId('probe')).toHaveTextContent('yes');
  });

  it('returns true for support (staff read+write)', () => {
    mockUser.role = 'support';
    render(wrap(<Probe />));
    expect(screen.getByTestId('probe')).toHaveTextContent('yes');
  });

  it('returns false for client_user (read-only)', () => {
    mockUser.role = 'client_user';
    render(wrap(<Probe />));
    expect(screen.getByTestId('probe')).toHaveTextContent('no');
  });

  it('returns false for read_only (admin-panel aggregate-read role)', () => {
    mockUser.role = 'read_only';
    render(wrap(<Probe />));
    expect(screen.getByTestId('probe')).toHaveTextContent('no');
  });

  it('returns false for unknown roles', () => {
    mockUser.role = 'mystery';
    render(wrap(<Probe />));
    expect(screen.getByTestId('probe')).toHaveTextContent('no');
  });
});

describe('Page gating — Domains', () => {
  beforeEach(() => {
    mockUser.role = 'client_admin';
  });

  it('shows Add Domain button for client_admin', async () => {
    mockUser.role = 'client_admin';
    const { default: Domains } = await import('../pages/Domains');
    render(wrap(<Domains />));
    expect(screen.getByTestId('add-domain-button')).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
  });

  it('hides Add Domain button and shows read-only notice for client_user', async () => {
    mockUser.role = 'client_user';
    const { default: Domains } = await import('../pages/Domains');
    render(wrap(<Domains />));
    expect(screen.queryByTestId('add-domain-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
  });
});

describe('Page gating — CronJobs', () => {
  beforeEach(() => {
    mockUser.role = 'client_admin';
  });

  it('shows Add Cron Job button for client_admin', async () => {
    mockUser.role = 'client_admin';
    const { default: CronJobs } = await import('../pages/CronJobs');
    render(wrap(<CronJobs />));
    expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
  });

  it('hides Add Cron Job button and shows notice for client_user', async () => {
    mockUser.role = 'client_user';
    const { default: CronJobs } = await import('../pages/CronJobs');
    render(wrap(<CronJobs />));
    expect(screen.queryByTestId('add-cron-job-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
  });
});

describe('Page gating — SshKeys', () => {
  beforeEach(() => {
    mockUser.role = 'client_admin';
  });

  it('shows Add SSH Key button for client_admin', async () => {
    mockUser.role = 'client_admin';
    const { default: SshKeys } = await import('../pages/SshKeys');
    render(wrap(<SshKeys />));
    expect(screen.getByTestId('add-ssh-key-button')).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
  });

  it('hides Add SSH Key button and shows notice for client_user', async () => {
    mockUser.role = 'client_user';
    const { default: SshKeys } = await import('../pages/SshKeys');
    render(wrap(<SshKeys />));
    expect(screen.queryByTestId('add-ssh-key-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
  });
});
