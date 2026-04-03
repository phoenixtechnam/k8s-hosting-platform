import { describe, it, expect } from 'vitest';
import { parseResourceValue } from './resource-parser.js';

describe('parseResourceValue', () => {
  // ─── CPU ────────────────────────────────────────────────────────────────────

  describe('cpu', () => {
    it('should parse plain cores "0.25" -> 0.25', () => {
      expect(parseResourceValue('0.25', 'cpu')).toBe(0.25);
    });

    it('should parse millicores "250m" -> 0.25', () => {
      expect(parseResourceValue('250m', 'cpu')).toBe(0.25);
    });

    it('should parse whole cores "4" -> 4', () => {
      expect(parseResourceValue('4', 'cpu')).toBe(4);
    });

    it('should parse "1000m" -> 1', () => {
      expect(parseResourceValue('1000m', 'cpu')).toBe(1);
    });

    it('should parse "500m" -> 0.5', () => {
      expect(parseResourceValue('500m', 'cpu')).toBe(0.5);
    });

    it('should parse "1" -> 1', () => {
      expect(parseResourceValue('1', 'cpu')).toBe(1);
    });

    it('should handle whitespace', () => {
      expect(parseResourceValue('  250m  ', 'cpu')).toBe(0.25);
    });
  });

  // ─── Memory ─────────────────────────────────────────────────────────────────

  describe('memory', () => {
    it('should parse "256Mi" -> ~0.25 Gi', () => {
      expect(parseResourceValue('256Mi', 'memory')).toBeCloseTo(0.25, 2);
    });

    it('should parse "1Gi" -> 1', () => {
      expect(parseResourceValue('1Gi', 'memory')).toBe(1);
    });

    it('should parse "512Mi" -> 0.5 Gi', () => {
      expect(parseResourceValue('512Mi', 'memory')).toBe(0.5);
    });

    it('should parse "2Gi" -> 2', () => {
      expect(parseResourceValue('2Gi', 'memory')).toBe(2);
    });

    it('should parse "1024Ki" -> ~0.000976 Gi', () => {
      const result = parseResourceValue('1024Ki', 'memory');
      expect(result).toBeCloseTo(1 / 1024, 5);
    });

    it('should parse raw bytes to Gi', () => {
      const oneGiInBytes = 1024 * 1024 * 1024;
      expect(parseResourceValue(String(oneGiInBytes), 'memory')).toBeCloseTo(1, 5);
    });

    it('should handle whitespace', () => {
      expect(parseResourceValue('  1Gi  ', 'memory')).toBe(1);
    });
  });

  // ─── Storage ────────────────────────────────────────────────────────────────

  describe('storage', () => {
    it('should parse "10Gi" -> 10', () => {
      expect(parseResourceValue('10Gi', 'storage')).toBe(10);
    });

    it('should parse "5120Mi" -> 5 Gi', () => {
      expect(parseResourceValue('5120Mi', 'storage')).toBe(5);
    });

    it('should parse "1Gi" -> 1', () => {
      expect(parseResourceValue('1Gi', 'storage')).toBe(1);
    });

    it('should parse "100Gi" -> 100', () => {
      expect(parseResourceValue('100Gi', 'storage')).toBe(100);
    });

    it('should parse "2048Mi" -> 2 Gi', () => {
      expect(parseResourceValue('2048Mi', 'storage')).toBe(2);
    });
  });
});
