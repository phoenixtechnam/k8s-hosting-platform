import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, apiFetch } from '@/lib/api-client';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // Remove any overlay from previous tests
  document.getElementById('token-expired-overlay')?.remove();
});

afterEach(() => {
  document.getElementById('token-expired-overlay')?.remove();
});

describe('apiFetch 401 handling', () => {
  it('should throw ApiError with INVALID_TOKEN on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { code: 'INVALID_TOKEN', message: 'Token expired' } }),
    });

    await expect(apiFetch('/api/v1/admin/dashboard')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_TOKEN',
    });
  });

  it('should include INVALID_TOKEN code in the thrown error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired' } }),
    });

    try {
      await apiFetch('/api/v1/admin/clients');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('INVALID_TOKEN');
      expect((err as ApiError).message).toBe('Token is invalid or expired');
      return;
    }
    expect.fail('Should have thrown');
  });

  it('should NOT trigger expiry handler for login endpoint', async () => {
    localStorage.setItem('auth_token', 'some-token');

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { code: 'INVALID_TOKEN', message: 'Bad credentials' } }),
    });

    try { await apiFetch('/api/v1/auth/login', { method: 'POST', body: '{}' }); } catch {}

    // Token should NOT be cleared for login failures
    expect(localStorage.getItem('auth_token')).toBe('some-token');
  });

  it('should handle non-401 errors normally', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: () => Promise.resolve({ error: { code: 'FORBIDDEN', message: 'Not allowed' } }),
    });

    await expect(apiFetch('/api/v1/admin/clients')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('should handle successful responses normally', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: '1' } }),
    });

    const result = await apiFetch('/api/v1/admin/status');
    expect(result).toEqual({ data: { id: '1' } });
  });
});

describe('ApiError', () => {
  it('should have status, code, and message', () => {
    const err = new ApiError(401, 'INVALID_TOKEN', 'Token expired');
    expect(err.status).toBe(401);
    expect(err.code).toBe('INVALID_TOKEN');
    expect(err.message).toBe('Token expired');
    expect(err.name).toBe('ApiError');
  });
});
