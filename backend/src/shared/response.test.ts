import { describe, it, expect } from 'vitest';
import { success, paginated, errorResponse } from './response.js';

describe('response helpers', () => {
  describe('success', () => {
    it('should wrap data in { data } envelope', () => {
      const result = success({ id: '1', name: 'test' });
      expect(result).toEqual({ data: { id: '1', name: 'test' } });
    });

    it('should handle arrays', () => {
      const result = success([1, 2, 3]);
      expect(result).toEqual({ data: [1, 2, 3] });
    });

    it('should handle null', () => {
      const result = success(null);
      expect(result).toEqual({ data: null });
    });
  });

  describe('paginated', () => {
    it('should include data and pagination', () => {
      const data = [{ id: '1' }, { id: '2' }];
      const pagination = {
        cursor: 'abc123',
        has_more: true,
        page_size: 2,
        total_count: 10,
      };

      const result = paginated(data, pagination);
      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual(pagination);
    });

    it('should handle empty results', () => {
      const result = paginated([], {
        cursor: null,
        has_more: false,
        page_size: 0,
      });
      expect(result.data).toHaveLength(0);
      expect(result.pagination?.has_more).toBe(false);
      expect(result.pagination?.cursor).toBeNull();
    });
  });

  describe('errorResponse', () => {
    it('should produce correct error envelope', () => {
      const result = errorResponse(
        'CLIENT_NOT_FOUND',
        "Client 'abc' not found",
        404,
        'req-123',
        { client_id: 'abc' },
        'Verify client_id',
      );

      expect(result.error.code).toBe('CLIENT_NOT_FOUND');
      expect(result.error.message).toBe("Client 'abc' not found");
      expect(result.error.status).toBe(404);
      expect(result.error.request_id).toBe('req-123');
      expect(result.error.details).toEqual({ client_id: 'abc' });
      expect(result.error.remediation).toBe('Verify client_id');
      expect(result.error.timestamp).toBeDefined();
    });

    it('should omit optional fields when not provided', () => {
      const result = errorResponse('INTERNAL_ERROR', 'Something broke', 500, 'req-456');
      expect(result.error.details).toBeUndefined();
      expect(result.error.remediation).toBeUndefined();
    });
  });
});
