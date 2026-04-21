import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import TlsSettings from '../pages/TlsSettings';

const mockTlsData = {
  data: { clusterIssuerName: 'letsencrypt-production', autoTlsEnabled: true },
};

vi.mock('@/hooks/use-tls-settings', () => ({
  useTlsSettings: vi.fn(() => ({ data: mockTlsData, isLoading: false, isError: false, error: null })),
  useUpdateTlsSettings: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/use-ingress-settings', () => ({
  useIngressSettings: vi.fn(() => ({
    data: { data: { ingressBaseDomain: 'example.com', ingressDefaultIpv4: '1.2.3.4', ingressDefaultIpv6: null } },
    isLoading: false,
    isError: false,
    error: null,
  })),
  useUpdateIngressSettings: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/use-cluster-issuers', () => ({
  // Default: no issuers returned — component falls back to text input,
  // matching what tests did before the dropdown was added.
  useClusterIssuers: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('TLS Settings page', () => {
  it('renders heading', () => {
    render(<TlsSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tls-settings-heading')).toBeInTheDocument();
    expect(screen.getByText('Ingress & TLS Settings')).toBeInTheDocument();
  });

  it('shows cluster issuer name field', () => {
    render(<TlsSettings />, { wrapper: createWrapper() });
    const input = screen.getByDisplayValue('letsencrypt-production');
    expect(input).toBeInTheDocument();
  });

  it('shows auto TLS toggle', () => {
    render(<TlsSettings />, { wrapper: createWrapper() });
    expect(screen.getByText('Automatic TLS')).toBeInTheDocument();
  });

  it('shows save button', () => {
    render(<TlsSettings />, { wrapper: createWrapper() });
    expect(screen.getAllByText('Save Settings').length).toBeGreaterThanOrEqual(1);
  });

  it('shows ingress settings section', () => {
    render(<TlsSettings />, { wrapper: createWrapper() });
    expect(screen.getByText('Ingress Routing')).toBeInTheDocument();
  });
});
