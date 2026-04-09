import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useCreateMailbox,
  useDeleteMailbox,
  useEnableEmailDomain,
} from '../hooks/use-email';

// Mock apiFetch so we don't hit the network but still exercise the real
// useMutation / invalidation logic from the hooks.
vi.mock('../lib/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({ data: { id: 'mb-1' } }),
  ApiError: class ApiError extends Error {},
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.setItem('auth_token', 'test-token');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
  vi.clearAllMocks();
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient, invalidateSpy };
}

describe('useCreateMailbox', () => {
  it('invalidates both mailboxes and mailbox-usage query keys on success', async () => {
    const { wrapper, invalidateSpy } = createWrapper();
    const { result } = renderHook(() => useCreateMailbox('c1', 'ed1'), { wrapper });

    await result.current.mutateAsync({ local_part: 'a', password: 'x' });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('"mailboxes"'))).toBe(true);
      expect(calls.some((c) => c.includes('"mailbox-usage"'))).toBe(true);
    });
  });
});

describe('useDeleteMailbox', () => {
  it('invalidates both mailboxes and mailbox-usage query keys on success', async () => {
    const { wrapper, invalidateSpy } = createWrapper();
    const { result } = renderHook(() => useDeleteMailbox('c1'), { wrapper });

    await result.current.mutateAsync('mb-1');

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('"mailboxes"'))).toBe(true);
      expect(calls.some((c) => c.includes('"mailbox-usage"'))).toBe(true);
    });
  });
});

describe('useEnableEmailDomain', () => {
  it('invalidates both email-domains and mailbox-usage query keys on success', async () => {
    const { wrapper, invalidateSpy } = createWrapper();
    const { result } = renderHook(() => useEnableEmailDomain('c1'), { wrapper });

    await result.current.mutateAsync({ domainId: 'd1', input: {} });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('"email-domains"'))).toBe(true);
      expect(calls.some((c) => c.includes('"mailbox-usage"'))).toBe(true);
    });
  });
});
