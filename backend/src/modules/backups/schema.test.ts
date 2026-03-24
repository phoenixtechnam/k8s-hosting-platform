import { describe, it, expect } from 'vitest';
import { createBackupSchema } from './schema.js';

describe('createBackupSchema', () => {
  it('should accept empty object with defaults', () => {
    const result = createBackupSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backup_type).toBe('manual');
      expect(result.data.resource_type).toBe('full');
    }
  });

  it('should accept scheduled backup type', () => {
    const result = createBackupSchema.safeParse({ backup_type: 'scheduled' });
    expect(result.success).toBe(true);
  });

  it('should reject auto backup type (admin only via system)', () => {
    expect(createBackupSchema.safeParse({ backup_type: 'auto' }).success).toBe(false);
  });

  it('should accept optional resource_id', () => {
    const result = createBackupSchema.safeParse({
      resource_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('should accept optional notes', () => {
    const result = createBackupSchema.safeParse({ notes: 'Pre-migration backup' });
    expect(result.success).toBe(true);
  });
});
