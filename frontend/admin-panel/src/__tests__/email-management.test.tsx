import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmailManagement from '../pages/EmailManagement';
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

function setupMockApi(domains: unknown[] = [], relays: unknown[] = []) {
  mockApiFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/email/domains')) {
      return Promise.resolve({ data: domains });
    }
    if (typeof url === 'string' && url.includes('/smtp-relays')) {
      return Promise.resolve({ data: relays });
    }
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EmailManagement page', () => {
  it('renders page heading', () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    expect(screen.getByTestId('email-mgmt-heading')).toBeInTheDocument();
    expect(screen.getByText('Email Management')).toBeInTheDocument();
  });

  it('shows stat cards', async () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('Total Mailboxes')).toBeInTheDocument();
    });
    expect(screen.getByText('DKIM Configured')).toBeInTheDocument();
    expect(screen.getByText('Mail Server')).toBeInTheDocument();
    expect(screen.getByText('Stalwart')).toBeInTheDocument();
  });

  it('shows tab bar with domains and relays tabs', () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-domains')).toBeInTheDocument();
    expect(screen.getByTestId('tab-relays')).toBeInTheDocument();
  });

  it('shows email domains table by default', async () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('email-domains-table')).toBeInTheDocument();
    });
  });

  it('shows empty state when no domains exist', async () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No email-enabled domains yet.')).toBeInTheDocument();
    });
  });

  it('switches to SMTP relays tab', async () => {
    setupMockApi([], []);
    render(<EmailManagement />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-relays'));
    await waitFor(() => {
      expect(screen.getByTestId('add-relay-button')).toBeInTheDocument();
    });
  });

  it('renders domain rows when data is returned', async () => {
    setupMockApi([
      {
        id: 'ed-1',
        domainName: 'example.com',
        mailboxCount: 5,
        mxProvisioned: 1,
        spfProvisioned: 1,
        dkimProvisioned: 1,
        dmarcProvisioned: 0,
        spamThresholdJunk: '5.0',
        enabled: 1,
      },
    ]);
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('example.com')).toBeInTheDocument();
    });
    // mailboxCount 5 appears in both the table cell and stat card; just verify domain row rendered
    expect(screen.getByText('Junk: 5.0')).toBeInTheDocument();
  });
});
