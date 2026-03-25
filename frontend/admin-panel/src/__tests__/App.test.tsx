import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import Layout from '../components/layout/Layout';
import Placeholder from '../pages/Placeholder';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement, route = '/') {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Layout', () => {
  it('renders sidebar and header', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('menu-button')).toBeInTheDocument();
  });

  it('shows sidebar nav items', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows brand name', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByText('K8s Hosting')).toBeInTheDocument();
  });
});

describe('Placeholder', () => {
  it('renders with provided title', () => {
    renderWithProviders(<Placeholder title="Domains" />);
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('This page is under construction.')).toBeInTheDocument();
  });
});
