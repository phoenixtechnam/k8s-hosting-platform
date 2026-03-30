import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdminUsers from '../pages/AdminUsers';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdminUsers page', () => {
  it('renders page heading', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<AdminUsers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('admin-users-heading')).toBeInTheDocument();
    });
    expect(screen.getByText('Admin Users')).toBeInTheDocument();
  });

  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<AdminUsers />, { wrapper: createWrapper() });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows add admin user button', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<AdminUsers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-admin-user-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Admin User')).toBeInTheDocument();
  });

  it('shows form when add button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<AdminUsers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-admin-user-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-admin-user-button'));
    expect(screen.getByTestId('admin-user-form')).toBeInTheDocument();
    expect(screen.getByTestId('au-email')).toBeInTheDocument();
    expect(screen.getByTestId('au-name')).toBeInTheDocument();
    expect(screen.getByTestId('au-password')).toBeInTheDocument();
    expect(screen.getByTestId('au-role')).toBeInTheDocument();
  });

  it('shows empty state when no users exist', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<AdminUsers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No admin users found.')).toBeInTheDocument();
    });
  });

  it('renders users table with sortable headers', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<AdminUsers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeInTheDocument();
    });
  });

  it('renders user rows when data is returned', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: 'user-1',
          email: 'admin@example.com',
          fullName: 'Admin User',
          roleName: 'admin',
          status: 'active',
          lastLoginAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    render(<AdminUsers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('Admin User')).toBeInTheDocument();
    });
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });
});
