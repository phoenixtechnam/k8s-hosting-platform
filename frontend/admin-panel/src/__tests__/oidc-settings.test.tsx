import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OidcSettings from '../pages/OidcSettings';
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

function setupMockApi(providers: unknown[] = []) {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/oidc/providers')) {
      return Promise.resolve({ data: providers });
    }
    if (url.includes('/oidc/settings')) {
      return Promise.resolve({
        data: { disableLocalAuthAdmin: false, disableLocalAuthClient: false, hasBreakGlassSecret: false },
      });
    }
    return Promise.resolve({ data: null });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OidcSettings page', () => {
  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<OidcSettings />, { wrapper: createWrapper() });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders page heading and description', async () => {
    setupMockApi();
    render(<OidcSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('OIDC / SSO Configuration')).toBeInTheDocument();
    });
    expect(screen.getByText('Configure identity providers and authentication settings.')).toBeInTheDocument();
  });

  it('shows providers section', async () => {
    setupMockApi();
    render(<OidcSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('providers-section')).toBeInTheDocument();
    });
    expect(screen.getByText('OIDC Providers')).toBeInTheDocument();
  });

  it('shows global settings section', async () => {
    setupMockApi();
    render(<OidcSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('auth-ingress-section')).toBeInTheDocument();
    });
    expect(screen.getByText(/Authentication.*Ingress Protection/)).toBeInTheDocument();
  });

  it('shows add provider button', async () => {
    setupMockApi();
    render(<OidcSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-provider-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Provider')).toBeInTheDocument();
  });

  it('shows empty state when no providers exist', async () => {
    setupMockApi();
    render(<OidcSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No OIDC providers configured.')).toBeInTheDocument();
    });
  });

  it('shows auth toggles in combined section', async () => {
    setupMockApi();
    render(<OidcSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('disable-local-client-toggle')).toBeInTheDocument();
    });
    expect(screen.getByTestId('disable-local-admin-toggle')).toBeInTheDocument();
  });

  it('renders provider rows when data is returned', async () => {
    setupMockApi([
      {
        id: 'prov-1',
        displayName: 'Corporate SSO',
        issuerUrl: 'https://dex.example.com',
        clientId: 'my-client',
        panelScope: 'admin',
        enabled: true,
        backchannelLogoutEnabled: false,
        displayOrder: 0,
        discoveryMetadata: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    render(<OidcSettings />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('provider-prov-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Corporate SSO')).toBeInTheDocument();
  });
});
