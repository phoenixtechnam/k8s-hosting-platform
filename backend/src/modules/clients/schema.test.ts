import { describe, it, expect } from 'vitest';
import { createClientSchema, updateClientSchema } from './schema.js';

describe('createClientSchema', () => {
  const validInput = {
    company_name: 'Acme Corp',
    company_email: 'admin@acme.com',
    plan_id: '550e8400-e29b-41d4-a716-446655440000',
    region_id: '550e8400-e29b-41d4-a716-446655440001',
  };

  it('should accept valid input', () => {
    const result = createClientSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should reject missing company_name', () => {
    const { company_name, ...rest } = validInput;
    const result = createClientSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should reject invalid email', () => {
    const result = createClientSchema.safeParse({ ...validInput, company_email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('should reject non-UUID plan_id', () => {
    const result = createClientSchema.safeParse({ ...validInput, plan_id: 'not-uuid' });
    expect(result.success).toBe(false);
  });

  it('should accept optional contact_email', () => {
    const result = createClientSchema.safeParse({ ...validInput, contact_email: 'contact@acme.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contact_email).toBe('contact@acme.com');
    }
  });

  it('should accept optional subscription_expires_at', () => {
    const result = createClientSchema.safeParse({
      ...validInput,
      subscription_expires_at: '2026-12-31T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('updateClientSchema', () => {
  it('should accept empty object (no updates)', () => {
    const result = updateClientSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept partial updates', () => {
    const result = updateClientSchema.safeParse({ company_name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('should validate status enum', () => {
    expect(updateClientSchema.safeParse({ status: 'active' }).success).toBe(true);
    expect(updateClientSchema.safeParse({ status: 'suspended' }).success).toBe(true);
    expect(updateClientSchema.safeParse({ status: 'archived' }).success).toBe(true);
    expect(updateClientSchema.safeParse({ status: 'cancelled' }).success).toBe(false);
    expect(updateClientSchema.safeParse({ status: 'invalid' }).success).toBe(false);
  });
});
