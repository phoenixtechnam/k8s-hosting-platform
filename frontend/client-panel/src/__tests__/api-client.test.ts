import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, ApiError } from '../lib/api-client';

// NB: apiFetch reads localStorage on every call, so we clear it in beforeEach
// to prevent cross-test state leakage.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(response: Response) {
  globalThis.fetch = vi.fn().mockResolvedValue(response);
}

describe('apiFetch', () => {
  describe('empty-body handling', () => {
    it('returns undefined for HTTP 204', async () => {
      mockFetch(new Response(null, { status: 204 }));
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });

    it('returns undefined for HTTP 200 with an empty body', async () => {
      mockFetch(new Response('', { status: 200 }));
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });

    it('returns undefined for HTTP 201 with an empty body', async () => {
      mockFetch(new Response('', { status: 201 }));
      const result = await apiFetch<void>('/api/v1/test', { method: 'POST' });
      expect(result).toBeUndefined();
    });

    it('returns undefined for HTTP 202 with an empty body', async () => {
      mockFetch(new Response('', { status: 202 }));
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });

    it('returns undefined when Content-Length is 0', async () => {
      mockFetch(
        new Response('', {
          status: 200,
          headers: { 'Content-Length': '0' },
        }),
      );
      const result = await apiFetch<void>('/api/v1/test');
      expect(result).toBeUndefined();
    });
  });

  describe('JSON parsing', () => {
    it('parses JSON body for 200 responses', async () => {
      mockFetch(
        new Response(JSON.stringify({ data: { id: 'abc' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await apiFetch<{ data: { id: string } }>('/api/v1/test');
      expect(result.data.id).toBe('abc');
    });

    it('parses JSON body for 201 responses', async () => {
      mockFetch(
        new Response(JSON.stringify({ data: { id: 'new' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await apiFetch<{ data: { id: string } }>('/api/v1/test', { method: 'POST' });
      expect(result.data.id).toBe('new');
    });

    it('throws descriptive ApiError when JSON parsing fails on a 2xx response', async () => {
      // Use a fresh Response per call because Response bodies can only be
      // consumed once.
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response('<<not json>>', {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '12',
            },
          }),
        ),
      );
      await expect(apiFetch<unknown>('/api/v1/broken')).rejects.toThrow(ApiError);
      await expect(apiFetch<unknown>('/api/v1/broken')).rejects.toThrow(/\/api\/v1\/broken/);
    });
  });

  describe('error handling', () => {
    it('throws ApiError for 4xx responses', async () => {
      mockFetch(
        new Response(
          JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'nope' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(apiFetch<unknown>('/api/v1/test')).rejects.toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
    });

    it('throws ApiError for 5xx responses with empty body', async () => {
      mockFetch(new Response('', { status: 500 }));
      await expect(apiFetch<unknown>('/api/v1/test')).rejects.toMatchObject({
        status: 500,
        code: 'UNKNOWN',
      });
    });
  });
});
