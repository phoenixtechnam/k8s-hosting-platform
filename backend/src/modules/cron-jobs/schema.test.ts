import { describe, it, expect } from 'vitest';
import { createCronJobSchema, updateCronJobSchema } from './schema.js';

describe('createCronJobSchema', () => {
  const validWebcron = {
    name: 'Daily ping',
    type: 'webcron' as const,
    schedule: '0 3 * * *',
    url: 'https://example.com/cron',
  };

  const validDeployment = {
    name: 'Daily cleanup',
    type: 'deployment' as const,
    schedule: '0 3 * * *',
    command: '/usr/bin/php /var/www/html/cron.php',
    deployment_id: '550e8400-e29b-41d4-a716-446655440000',
  };

  it('should accept valid webcron input', () => {
    expect(createCronJobSchema.safeParse(validWebcron).success).toBe(true);
  });

  it('should accept valid deployment input', () => {
    expect(createCronJobSchema.safeParse(validDeployment).success).toBe(true);
  });

  it('should reject missing name', () => {
    const { name, ...rest } = validWebcron;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject missing type', () => {
    const { type, ...rest } = validWebcron;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject missing schedule', () => {
    const { schedule, ...rest } = validWebcron;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject webcron without url', () => {
    const { url, ...rest } = validWebcron;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject deployment without command', () => {
    const { command, ...rest } = validDeployment;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject deployment without deployment_id', () => {
    const { deployment_id, ...rest } = validDeployment;
    expect(createCronJobSchema.safeParse(rest).success).toBe(false);
  });

  it('should reject invalid cron schedule', () => {
    expect(createCronJobSchema.safeParse({ ...validWebcron, schedule: 'not-cron' }).success).toBe(false);
  });

  it('should default enabled to true', () => {
    const result = createCronJobSchema.safeParse(validWebcron);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(true);
  });

  it('should accept enabled=false', () => {
    const result = createCronJobSchema.safeParse({ ...validWebcron, enabled: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(false);
  });

  it('should default http_method to GET for webcron', () => {
    const result = createCronJobSchema.safeParse(validWebcron);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.http_method).toBe('GET');
  });

  it('should accept http_method POST', () => {
    const result = createCronJobSchema.safeParse({ ...validWebcron, http_method: 'POST' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.http_method).toBe('POST');
  });

  it('should reject invalid url for webcron', () => {
    expect(createCronJobSchema.safeParse({ ...validWebcron, url: 'not-a-url' }).success).toBe(false);
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

  it('should accept url update', () => {
    expect(updateCronJobSchema.safeParse({ url: 'https://example.com/new' }).success).toBe(true);
  });

  it('should accept http_method update', () => {
    expect(updateCronJobSchema.safeParse({ http_method: 'PUT' }).success).toBe(true);
  });

  it('should accept command update', () => {
    expect(updateCronJobSchema.safeParse({ command: 'echo new' }).success).toBe(true);
  });

  it('should accept deployment_id update', () => {
    expect(updateCronJobSchema.safeParse({ deployment_id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true);
  });

  it('should reject invalid cron schedule on update', () => {
    expect(updateCronJobSchema.safeParse({ schedule: 'bad' }).success).toBe(false);
  });

  it('should reject invalid url on update', () => {
    expect(updateCronJobSchema.safeParse({ url: 'not-a-url' }).success).toBe(false);
  });
});
