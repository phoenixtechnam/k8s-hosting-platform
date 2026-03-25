import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import Storage from '../pages/Storage';

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

describe('Storage page', () => {
  it('renders page heading "Storage & DB"', () => {
    render(<Storage />, { wrapper: createWrapper() });
    expect(screen.getByText('Storage & DB')).toBeInTheDocument();
  });

  it('shows stat cards', () => {
    render(<Storage />, { wrapper: createWrapper() });
    expect(screen.getByText('Total Storage')).toBeInTheDocument();
    expect(screen.getByText('Storage Used')).toBeInTheDocument();
    const statCards = screen.getAllByTestId('stat-card');
    expect(statCards).toHaveLength(4);
    expect(screen.getByText('1.2 TB')).toBeInTheDocument();
    expect(screen.getByText('31%')).toBeInTheDocument();
  });

  it('renders Overview tab by default', () => {
    render(<Storage />, { wrapper: createWrapper() });
    const overviewTab = screen.getByTestId('tab-overview');
    expect(overviewTab).toHaveClass('border-brand-500');
  });

  it('shows ResourceBar components in Overview', () => {
    render(<Storage />, { wrapper: createWrapper() });
    const bars = screen.getAllByTestId('resource-bar');
    expect(bars.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Block Storage')).toBeInTheDocument();
    expect(screen.getByText('Database Storage')).toBeInTheDocument();
    expect(screen.getByText('Backup Storage')).toBeInTheDocument();
  });

  it('switches to Databases tab', () => {
    render(<Storage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-databases'));
    expect(screen.getByTestId('tab-databases')).toHaveClass('border-brand-500');
    expect(screen.getByTestId('client-selector')).toBeInTheDocument();
  });

  it('switches to Backups tab', () => {
    render(<Storage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-backups'));
    expect(screen.getByTestId('tab-backups')).toHaveClass('border-brand-500');
    expect(screen.getByTestId('client-selector')).toBeInTheDocument();
  });

  it('shows select-client prompt when no client is selected on Databases tab', () => {
    render(<Storage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-databases'));
    expect(screen.getByTestId('select-client-prompt')).toBeInTheDocument();
    expect(screen.getByText('Select a client to view their data.')).toBeInTheDocument();
  });

  it('renders the tab bar with three tabs', () => {
    render(<Storage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
    expect(screen.getByTestId('tab-overview')).toBeInTheDocument();
    expect(screen.getByTestId('tab-databases')).toBeInTheDocument();
    expect(screen.getByTestId('tab-backups')).toBeInTheDocument();
  });
});
