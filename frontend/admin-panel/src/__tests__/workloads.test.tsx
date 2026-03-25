import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import Workloads from '../pages/Workloads';

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

describe('Workloads page', () => {
  it('renders page heading "Workloads"', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Workloads' })).toBeInTheDocument();
  });

  it('shows all three stat cards', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByText('Total Images')).toBeInTheDocument();
    expect(screen.getByText('Active Workloads')).toBeInTheDocument();
    expect(screen.getByText('Deployments Today')).toBeInTheDocument();
    const statCards = screen.getAllByTestId('stat-card');
    expect(statCards).toHaveLength(3);
  });

  it('displays stat card values', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders the container images table with all 5 images', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('images-table')).toBeInTheDocument();
    expect(screen.getByText('NGINX + PHP 8.4')).toBeInTheDocument();
    expect(screen.getByText('Apache + PHP 8.4')).toBeInTheDocument();
    expect(screen.getByText('WordPress (PHP 8.4)')).toBeInTheDocument();
    expect(screen.getByText('Static Site (NGINX)')).toBeInTheDocument();
    expect(screen.getByText('Node.js 22')).toBeInTheDocument();
  });

  it('shows search input for filtering images', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByTestId('image-search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search images...')).toBeInTheDocument();
  });

  it('filters images based on search input', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    const searchInput = screen.getByTestId('image-search');

    fireEvent.change(searchInput, { target: { value: 'WordPress' } });

    expect(screen.getByText('WordPress (PHP 8.4)')).toBeInTheDocument();
    expect(screen.queryByText('NGINX + PHP 8.4')).not.toBeInTheDocument();
    expect(screen.queryByText('Node.js 22')).not.toBeInTheDocument();
  });

  it('shows empty state when no images match search', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    const searchInput = screen.getByTestId('image-search');

    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    expect(screen.getByText('No images found matching your search.')).toBeInTheDocument();
  });

  it('displays StatusBadge for each image status', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    const badges = screen.getAllByTestId('status-badge');
    expect(badges.length).toBeGreaterThanOrEqual(5);
  });

  it('shows image count footer', () => {
    render(<Workloads />, { wrapper: createWrapper() });
    expect(screen.getByText('5 images')).toBeInTheDocument();
  });
});
