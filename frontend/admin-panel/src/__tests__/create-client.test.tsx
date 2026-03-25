import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import CreateClientModal from '../components/CreateClientModal';

function renderModal(open = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CreateClientModal open={open} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, onClose };
}

describe('CreateClientModal', () => {
  it('renders nothing when closed', () => {
    renderModal(false);
    expect(screen.queryByTestId('create-client-modal')).not.toBeInTheDocument();
  });

  it('renders form when open', () => {
    renderModal(true);
    expect(screen.getByTestId('create-client-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create Client' })).toBeInTheDocument();
  });

  it('has required form fields', () => {
    renderModal(true);
    expect(screen.getByTestId('company-name-input')).toBeRequired();
    expect(screen.getByTestId('company-email-input')).toBeRequired();
    expect(screen.getByTestId('plan-select')).toBeRequired();
    expect(screen.getByTestId('region-select')).toBeRequired();
  });

  it('has optional contact email field', () => {
    renderModal(true);
    expect(screen.getByTestId('contact-email-input')).not.toBeRequired();
  });

  it('has submit and cancel buttons', () => {
    renderModal(true);
    expect(screen.getByTestId('submit-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows plan and region dropdowns', () => {
    renderModal(true);
    expect(screen.getByTestId('plan-select')).toBeInTheDocument();
    expect(screen.getByText('Select plan...')).toBeInTheDocument();
    expect(screen.getByTestId('region-select')).toBeInTheDocument();
    expect(screen.getByText('Select region...')).toBeInTheDocument();
  });
});
