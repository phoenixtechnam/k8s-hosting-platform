import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import Domains from '../pages/Domains';
import CreateDomainModal from '../components/CreateDomainModal';

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

describe('Domains page', () => {
  it('renders with client selector', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-selector')).toBeInTheDocument();
    expect(screen.getByText('Select a client...')).toBeInTheDocument();
  });

  it('shows prompt to select client when none selected', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('select-client-prompt')).toBeInTheDocument();
    expect(screen.getByText('Select a client to view and manage their domains.')).toBeInTheDocument();
  });

  it('disables add domain button when no client selected', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-domain-button')).toBeDisabled();
  });

  it('has a search input', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('domain-search')).toBeInTheDocument();
  });
});

describe('CreateDomainModal', () => {
  it('renders form fields when open', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('create-domain-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add Domain' })).toBeInTheDocument();
    expect(screen.getByTestId('domain-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('dns-mode-select')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={false} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByTestId('create-domain-modal')).not.toBeInTheDocument();
  });

  it('has required domain name field', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('domain-name-input')).toBeRequired();
  });

  it('has required dns mode field', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('dns-mode-select')).toBeRequired();
  });

  it('defaults dns mode to cname', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    const select = screen.getByTestId('dns-mode-select') as HTMLSelectElement;
    expect(select.value).toBe('cname');
  });

  it('has submit and cancel buttons', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('submit-domain-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});
