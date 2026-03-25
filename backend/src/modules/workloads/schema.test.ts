import { describe, it, expect } from 'vitest';
import { createWorkloadSchema, updateWorkloadSchema } from './schema.js';

describe('createWorkloadSchema', () => {
  const validInput = {
    name: 'my-workload',
    image_id: '550e8400-e29b-41d4-a716-446655440000',
  };

  it('should accept valid input with defaults', () => {
    const result = createWorkloadSchema.safeParse(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('my-workload');
      expect(result.data.replica_count).toBe(1);
      expect(result.data.cpu_request).toBe('0.25');
      expect(result.data.memory_request).toBe('256Mi');
    }
  });

  it('should accept custom replica_count', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, replica_count: 5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replica_count).toBe(5);
    }
  });

  it('should reject replica_count less than 1', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, replica_count: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject replica_count greater than 10', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, replica_count: 11 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer replica_count', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, replica_count: 1.5 });
    expect(result.success).toBe(false);
  });

  it('should reject missing name', () => {
    const result = createWorkloadSchema.safeParse({ image_id: validInput.image_id });
    expect(result.success).toBe(false);
  });

  it('should reject empty name', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, name: '' });
    expect(result.success).toBe(false);
  });

  it('should reject name longer than 255 characters', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, name: 'a'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('should reject missing image_id', () => {
    const result = createWorkloadSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(false);
  });

  it('should reject non-UUID image_id', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, image_id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('should accept custom cpu_request', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, cpu_request: '1.0' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cpu_request).toBe('1.0');
    }
  });

  it('should accept custom memory_request', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, memory_request: '1Gi' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory_request).toBe('1Gi');
    }
  });

  it('should reject cpu_request longer than 20 characters', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, cpu_request: 'a'.repeat(21) });
    expect(result.success).toBe(false);
  });

  it('should reject memory_request longer than 20 characters', () => {
    const result = createWorkloadSchema.safeParse({ ...validInput, memory_request: 'a'.repeat(21) });
    expect(result.success).toBe(false);
  });
});

describe('updateWorkloadSchema', () => {
  it('should accept empty object (all fields optional)', () => {
    const result = updateWorkloadSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept valid name update', () => {
    const result = updateWorkloadSchema.safeParse({ name: 'new-name' });
    expect(result.success).toBe(true);
  });

  it('should accept valid status update', () => {
    const result = updateWorkloadSchema.safeParse({ status: 'running' });
    expect(result.success).toBe(true);
  });

  it('should accept stopped status', () => {
    const result = updateWorkloadSchema.safeParse({ status: 'stopped' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid status', () => {
    const result = updateWorkloadSchema.safeParse({ status: 'paused' });
    expect(result.success).toBe(false);
  });

  it('should reject non-UUID image_id', () => {
    const result = updateWorkloadSchema.safeParse({ image_id: 'bad-id' });
    expect(result.success).toBe(false);
  });

  it('should accept valid image_id', () => {
    const result = updateWorkloadSchema.safeParse({
      image_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('should reject replica_count out of range', () => {
    expect(updateWorkloadSchema.safeParse({ replica_count: 0 }).success).toBe(false);
    expect(updateWorkloadSchema.safeParse({ replica_count: 11 }).success).toBe(false);
  });
});
