import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExportImport from '../pages/ExportImport';

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

describe('ExportImport page', () => {
  it('renders page heading', () => {
    render(<ExportImport />, { wrapper: createWrapper() });
    expect(screen.getByTestId('export-import-heading')).toBeInTheDocument();
    expect(screen.getByText('Export / Import')).toBeInTheDocument();
  });

  it('shows export section with button', () => {
    render(<ExportImport />, { wrapper: createWrapper() });
    expect(screen.getByText('Export')).toBeInTheDocument();
    expect(screen.getByTestId('export-button')).toBeInTheDocument();
    expect(screen.getByText('Export Data')).toBeInTheDocument();
  });

  it('shows import section with file chooser', () => {
    render(<ExportImport />, { wrapper: createWrapper() });
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByTestId('import-file-button')).toBeInTheDocument();
    expect(screen.getByText('Choose File')).toBeInTheDocument();
  });

  it('has hidden file input for JSON upload', () => {
    render(<ExportImport />, { wrapper: createWrapper() });
    const fileInput = screen.getByTestId('import-file-input');
    expect(fileInput).toBeInTheDocument();
    expect(fileInput).toHaveAttribute('accept', '.json');
  });

  it('shows export description text', () => {
    render(<ExportImport />, { wrapper: createWrapper() });
    expect(screen.getByText('Download all clients, domains, plans, and DNS servers as a JSON file.')).toBeInTheDocument();
  });

  it('shows import description text', () => {
    render(<ExportImport />, { wrapper: createWrapper() });
    expect(screen.getByText('Upload a previously exported JSON file to restore or migrate data.')).toBeInTheDocument();
  });
});
