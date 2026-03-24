import { describe, it, expect } from 'vitest';
import { createCronJobSchema, updateCronJobSchema } from './schema.js';

describe('createCronJobSchema', () => {
  const valid = {
    name: 'Daily cleanup',
    schedule: '0 3 * * *',
    command: '/usr/bin/php /var/www/html/cron.php',
  };

  it('should accept valid input', () => {
    expect(createCronJobSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject missing name', () => {
    const { name, ...rest } = valid;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject missing schedule', () => {
    const { schedule, ...rest } = valid;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject missing command', () => {
    const { command, ...rest } = valid;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject invalid cron schedule', () => {
    expect(createCronJobSchema.safeParse({ ...valid, schedule: 'not-cron' }).success).toBe(false);
  });

  it('should default enabled to true', () => {
    const result = createCronJobSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(true);
  });

  it('should accept enabled=false', () => {
    const result = createCronJobSchema.safeParse({ ...valid, enabled: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(false);
  });
});

describe('updateCronJobSchema', () => {
  it('should accept empty object', () => {
    expect(updateCronJobSchema.safeParse({}).success).toBe(true);
  });

  it('should accept partial update', () => {
    expect(updateCronJobSchema.safeParse({ name: 'New name' }).success).toBe(true);
    expect(updateCronJobSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateCronJobSchema.safeParse({ schedule: '*/5 * * * *' }).success).toBe(true);
  });

  it('should reject invalid cron schedule on update', () => {
    expect(updateCronJobSchema.safeParse({ schedule: 'bad' }).success).toBe(false);
  });
});
