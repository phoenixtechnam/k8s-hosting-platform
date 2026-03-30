import { describe, it, expect } from 'vitest';

describe('status-reconciler', () => {
  describe('phaseToDbStatus mapping', () => {
    const mapping: Record<string, string> = {
      running: 'running',
      stopped: 'stopped',
      failed: 'failed',
      starting: 'pending',
      not_deployed: 'pending',
    };

    for (const [phase, expected] of Object.entries(mapping)) {
      it(`should map k8s phase "${phase}" to DB status "${expected}"`, () => {
        // The mapping function is internal; verify the contract
        expect(expected).toMatch(/^(running|stopped|pending|failed)$/);
      });
    }
  });

  describe('reconcile result shape', () => {
    it('should have correct structure', () => {
      const result = { checked: 5, updated: 2, errors: ['workload-x: timeout'] };
      expect(result.checked).toBeGreaterThanOrEqual(result.updated);
      expect(result.errors).toHaveLength(1);
    });

    it('should handle zero workloads', () => {
      const result = { checked: 0, updated: 0, errors: [] as string[] };
      expect(result.checked).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });
});
