import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from '../lib/api-client';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('adds Authorization header when token exists', async () => {
    localStorage.setItem('auth_token', 'test-token');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/test');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-token');
  });

  it('does not add Authorization header when no token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/test');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('throws ApiError on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({
        error: { code: 'MISSING_BEARER_TOKEN', message: 'Missing auth token' },
      }),
    }));

    await expect(apiFetch('/api/test')).rejects.toThrow(ApiError);
    await expect(apiFetch('/api/test')).rejects.toMatchObject({
      status: 401,
      code: 'MISSING_BEARER_TOKEN',
    });
  });

  it('returns undefined for 204 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    }));

    const result = await apiFetch('/api/test');
    expect(result).toBeUndefined();
  });

  it('parses JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: '123', name: 'Test' } }),
    }));

    const result = await apiFetch<{ data: { id: string; name: string } }>('/api/test');
    expect(result.data.id).toBe('123');
    expect(result.data.name).toBe('Test');
  });
});
