import { describe, it, expect } from 'vitest';
import { updateSubscriptionSchema } from './schema.js';

describe('updateSubscriptionSchema', () => {
  it('should accept empty object', () => {
    expect(updateSubscriptionSchema.safeParse({}).success).toBe(true);
  });

  it('should accept valid plan_id', () => {
    const result = updateSubscriptionSchema.safeParse({
      plan_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-UUID plan_id', () => {
    expect(updateSubscriptionSchema.safeParse({ plan_id: 'not-uuid' }).success).toBe(false);
  });

  it('should accept valid status', () => {
    expect(updateSubscriptionSchema.safeParse({ status: 'active' }).success).toBe(true);
    expect(updateSubscriptionSchema.safeParse({ status: 'cancelled' }).success).toBe(true);
  });

  it('should reject invalid status', () => {
    expect(updateSubscriptionSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });

  it('should accept datetime for subscription_expires_at', () => {
    const result = updateSubscriptionSchema.safeParse({
      subscription_expires_at: '2026-12-31T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });
});
