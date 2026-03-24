import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, parsePaginationParams } from './pagination.js';

describe('cursor encoding/decoding', () => {
  it('should round-trip encode and decode', () => {
    const data = { resource: 'client', sort: '2026-01-15T10:30:00Z', id: 'abc-123' };
    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(data);
  });

  it('should produce base64url string', () => {
    const encoded = encodeCursor({ resource: 'test', sort: '2026-01-01', id: '1' });
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    // base64url: no +, /, or = padding
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('should reject invalid cursor', () => {
    expect(() => decodeCursor('not-valid-base64!!')).toThrow();
  });

  it('should reject cursor missing required fields', () => {
    const incomplete = Buffer.from(JSON.stringify({ resource: 'test' })).toString('base64url');
    expect(() => decodeCursor(incomplete)).toThrow('invalid or expired');
  });

  it('should reject empty string', () => {
    expect(() => decodeCursor('')).toThrow();
  });
});

describe('parsePaginationParams', () => {
  it('should return defaults for empty query', () => {
    const result = parsePaginationParams({});
    expect(result.limit).toBe(20);
    expect(result.cursor).toBeUndefined();
    expect(result.sort).toEqual({ field: 'created_at', direction: 'desc' });
  });

  it('should respect limit', () => {
    expect(parsePaginationParams({ limit: '5' }).limit).toBe(5);
  });

  it('should cap limit at 100', () => {
    expect(parsePaginationParams({ limit: '500' }).limit).toBe(100);
  });

  it('should use default for zero or negative limit', () => {
    expect(parsePaginationParams({ limit: '0' }).limit).toBe(20);
    expect(parsePaginationParams({ limit: '-5' }).limit).toBe(20);
  });

  it('should parse sort parameter', () => {
    const result = parsePaginationParams({ sort: 'updated_at:asc' });
    expect(result.sort).toEqual({ field: 'updated_at', direction: 'asc' });
  });

  it('should default sort direction to desc', () => {
    const result = parsePaginationParams({ sort: 'name' });
    expect(result.sort.direction).toBe('desc');
  });

  it('should pass through cursor', () => {
    const result = parsePaginationParams({ cursor: 'abc123' });
    expect(result.cursor).toBe('abc123');
  });
});
