import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import EditTenantModal from '../components/EditTenantModal';
import DeleteConfirmDialog from '../components/DeleteConfirmDialog';
import type { Tenant } from '../types/api';

const mockTenant: Tenant = {
  id: 'tenant-001',
  name: 'Acme Corp',
  contactName: 'Jane Doe',
  primaryEmail: 'admin@acme.com',
  secondaryEmail: 'support@acme.com',
  phoneE164: '+14155552671',
  billingAddress: {
    streetAddress: '123 Main St',
    postalAddress: 'P.O. Box 456',
    city: 'San Francisco',
    country: 'US',
  },
  kubernetesNamespace: 'tenant-acme-001',
  status: 'active',
  planId: 'plan-001',
  regionId: 'region-001',
  isSystem: false,
  cpuLimitOverride: null,
  memoryLimitOverride: null,
  storageLimitOverride: null,
  maxSubUsersOverride: null,
  monthlyPriceOverride: null,
  createdBy: 'admin-001',
  subscriptionExpiresAt: null,
  provisioningStatus: 'unprovisioned',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function renderEditModal(open = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <EditTenantModal open={open} onClose={onClose} tenant={mockTenant} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, onClose };
}

function renderDeleteDialog(open = true) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const result = render(
    <DeleteConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      tenantName="Acme Corp"
      isPending={false}
    />,
  );
  return { ...result, onClose, onConfirm };
}

describe('EditTenantModal', () => {
  it('renders nothing when closed', () => {
    renderEditModal(false);
    expect(screen.queryByTestId('edit-tenant-modal')).not.toBeInTheDocument();
  });

  it('renders form with heading when open', () => {
    renderEditModal(true);
    expect(screen.getByTestId('edit-tenant-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit Tenant' })).toBeInTheDocument();
  });

  it('pre-fills fields with current tenant data', () => {
    renderEditModal(true);
    expect(screen.getByTestId('edit-company-name-input')).toHaveValue('Acme Corp');
    expect(screen.getByTestId('edit-company-email-input')).toHaveValue('admin@acme.com');
    expect(screen.getByTestId('edit-contact-email-input')).toHaveValue('support@acme.com');
  });

  it('has required company name and email fields', () => {
    renderEditModal(true);
    expect(screen.getByTestId('edit-company-name-input')).toBeRequired();
    expect(screen.getByTestId('edit-company-email-input')).toBeRequired();
  });

  it('has optional contact email field', () => {
    renderEditModal(true);
    expect(screen.getByTestId('edit-contact-email-input')).not.toBeRequired();
  });

  it('has submit and cancel buttons', () => {
    renderEditModal(true);
    expect(screen.getByTestId('edit-submit-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('submit button says Save Changes', () => {
    renderEditModal(true);
    expect(screen.getByTestId('edit-submit-button')).toHaveTextContent('Save Changes');
  });
});

describe('DeleteConfirmDialog', () => {
  it('renders nothing when closed', () => {
    renderDeleteDialog(false);
    expect(screen.queryByTestId('delete-confirm-dialog')).not.toBeInTheDocument();
  });

  it('renders warning text with tenant name', () => {
    renderDeleteDialog(true);
    expect(screen.getByTestId('delete-confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('delete-warning-text')).toHaveTextContent(
      'Are you sure you want to delete Acme Corp? This cannot be undone.',
    );
  });

  it('has delete and cancel buttons', () => {
    renderDeleteDialog(true);
    expect(screen.getByTestId('delete-confirm-button')).toBeInTheDocument();
    expect(screen.getByTestId('delete-cancel-button')).toBeInTheDocument();
  });

  it('delete button has correct text', () => {
    renderDeleteDialog(true);
    expect(screen.getByTestId('delete-confirm-button')).toHaveTextContent('Delete');
  });
});
