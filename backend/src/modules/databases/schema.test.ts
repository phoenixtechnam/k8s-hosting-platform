import { describe, it, expect } from 'vitest';
import { createDatabaseSchema, updateDatabaseSchema } from './schema.js';

describe('createDatabaseSchema', () => {
  it('should accept valid name with default db_type', () => {
    const result = createDatabaseSchema.safeParse({ name: 'my_database' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('my_database');
      expect(result.data.db_type).toBe('mysql');
    }
  });

  it('should accept postgresql db_type', () => {
    const result = createDatabaseSchema.safeParse({ name: 'pgdb', db_type: 'postgresql' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.db_type).toBe('postgresql');
    }
  });

  it('should accept mysql db_type', () => {
    const result = createDatabaseSchema.safeParse({ name: 'mydb', db_type: 'mysql' });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = createDatabaseSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('should reject missing name', () => {
    const result = createDatabaseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject name with special characters', () => {
    const result = createDatabaseSchema.safeParse({ name: 'my-database!' });
    expect(result.success).toBe(false);
  });

  it('should reject name with spaces', () => {
    const result = createDatabaseSchema.safeParse({ name: 'my database' });
    expect(result.success).toBe(false);
  });

  it('should reject name with hyphens', () => {
    const result = createDatabaseSchema.safeParse({ name: 'my-db' });
    expect(result.success).toBe(false);
  });

  it('should accept name with underscores', () => {
    const result = createDatabaseSchema.safeParse({ name: 'my_db_123' });
    expect(result.success).toBe(true);
  });

  it('should reject name longer than 63 characters', () => {
    const result = createDatabaseSchema.safeParse({ name: 'a'.repeat(64) });
    expect(result.success).toBe(false);
  });

  it('should accept name exactly 63 characters', () => {
    const result = createDatabaseSchema.safeParse({ name: 'a'.repeat(63) });
    expect(result.success).toBe(true);
  });

  it('should reject invalid db_type', () => {
    const result = createDatabaseSchema.safeParse({ name: 'mydb', db_type: 'sqlite' });
    expect(result.success).toBe(false);
  });
});

describe('updateDatabaseSchema', () => {
  it('should accept empty object (all fields optional)', () => {
    const result = updateDatabaseSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept valid name', () => {
    const result = updateDatabaseSchema.safeParse({ name: 'new_name' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid name', () => {
    const result = updateDatabaseSchema.safeParse({ name: 'invalid-name!' });
    expect(result.success).toBe(false);
  });

  it('should reject empty string name', () => {
    const result = updateDatabaseSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});
