import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import Security from '../pages/Security';

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

describe('Security page', () => {
  it('renders page heading "Security"', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
  });

  it('shows all four stat cards', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getAllByText('Network Policies').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Sealed Secrets')).toBeInTheDocument();
    expect(screen.getByText('SSL Certificates')).toBeInTheDocument();
    expect(screen.getByText('Security Score')).toBeInTheDocument();
    const statCards = screen.getAllByTestId('stat-card');
    expect(statCards).toHaveLength(4);
  });

  it('displays stat card values', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('47 valid')).toBeInTheDocument();
    expect(screen.getByText('92/100')).toBeInTheDocument();
  });

  it('renders the Network Policies section with table', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('Network Policies', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByTestId('policies-table')).toBeInTheDocument();
    expect(screen.getByText('deny-all-ingress')).toBeInTheDocument();
    expect(screen.getByText('allow-ingress-nginx')).toBeInTheDocument();
    expect(screen.getByText('allow-dns-egress')).toBeInTheDocument();
  });

  it('renders the Recent Security Events section with table', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('Recent Security Events')).toBeInTheDocument();
    expect(screen.getByTestId('events-table')).toBeInTheDocument();
    expect(screen.getByText('Failed login attempt blocked')).toBeInTheDocument();
    expect(screen.getByText('SSL certificate renewed')).toBeInTheDocument();
    expect(screen.getByText('Network policy violation detected')).toBeInTheDocument();
  });

  it('shows StatusBadge for policy statuses', () => {
    render(<Security />, { wrapper: createWrapper() });
    const badges = screen.getAllByTestId('status-badge');
    expect(badges.length).toBeGreaterThanOrEqual(5);
  });

  it('displays severity labels in security events', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getAllByText('warning').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('info').length).toBeGreaterThanOrEqual(1);
  });

  it('shows event sources', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('dex-oidc')).toBeInTheDocument();
    expect(screen.getByText('cert-manager')).toBeInTheDocument();
    expect(screen.getByText('calico')).toBeInTheDocument();
  });
});
