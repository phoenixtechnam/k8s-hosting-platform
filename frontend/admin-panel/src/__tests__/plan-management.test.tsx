import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PlanManagement from '../pages/PlanManagement';
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

describe('PlanManagement page', () => {
  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<PlanManagement />, { wrapper: createWrapper() });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders page heading and description', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlanManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('Hosting Plans')).toBeInTheDocument();
    });
    expect(screen.getByText('Manage hosting plans and resource limits.')).toBeInTheDocument();
  });

  it('shows empty state when no plans exist', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlanManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No hosting plans configured.')).toBeInTheDocument();
    });
  });

  it('shows add plan button', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlanManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-plan-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Plan')).toBeInTheDocument();
  });

  it('shows add form when button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlanManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-plan-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-plan-button'));
    expect(screen.getByTestId('add-plan-form')).toBeInTheDocument();
    expect(screen.getByTestId('plan-code-input')).toBeInTheDocument();
    expect(screen.getByTestId('plan-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('plan-price-input')).toBeInTheDocument();
  });

  it('renders plan rows when data is returned', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: 'plan-1',
          code: 'starter',
          name: 'Starter',
          description: 'Entry level plan',
          cpuLimit: '0.50',
          memoryLimit: '1.00',
          storageLimit: '10.00',
          monthlyPriceUsd: '5.00',
          maxSubUsers: 3,
          status: 'active',
        },
      ],
    });
    render(<PlanManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('plan-plan-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.getByText('starter')).toBeInTheDocument();
    expect(screen.getByText('$5.00/mo')).toBeInTheDocument();
  });
});
