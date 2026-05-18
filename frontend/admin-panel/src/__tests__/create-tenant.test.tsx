import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import CreateTenantModal from '../components/CreateTenantModal';

function renderModal(open = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CreateTenantModal open={open} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, onClose };
}

describe('CreateTenantModal', () => {
  it('renders nothing when closed', () => {
    renderModal(false);
    expect(screen.queryByTestId('create-tenant-modal')).not.toBeInTheDocument();
  });

  it('renders form when open', () => {
    renderModal(true);
    expect(screen.getByTestId('create-tenant-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create Client' })).toBeInTheDocument();
  });

  it('has required form fields', () => {
    renderModal(true);
    // Updated to match the post-tenant-rename test ids in
    // CreateTenantModal.tsx (tenant-*-input not company-*-input).
    // Region is no longer surfaced in the form — auto-assigned to
    // the platform-apex region server-side, so dropped from the test.
    expect(screen.getByTestId('tenant-name-input')).toBeRequired();
    expect(screen.getByTestId('primary-email-input')).toBeRequired();
    expect(screen.getByTestId('plan-select')).toBeRequired();
  });

  it('renders contact name field (UI-required, optional at API)', () => {
    renderModal(true);
    // The form enforces contact-name via HTML `required`, but the API
    // contract treats it as optional (see api-contracts/tenants.ts
    // CreateTenantInput — contact_name is .optional()). The UI is the
    // stricter source of truth for human operators; integration tests
    // and scripted creates can omit and backfill later.
    expect(screen.getByTestId('contact-name-input')).toBeRequired();
  });

  it('has submit and cancel buttons', () => {
    renderModal(true);
    expect(screen.getByTestId('submit-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows plan dropdown', () => {
    renderModal(true);
    expect(screen.getByTestId('plan-select')).toBeInTheDocument();
    expect(screen.getByText('Select plan...')).toBeInTheDocument();
  });
});
