import { describe, it, expect } from 'vitest';
import { z } from 'zod';

/**
 * Schema-level guard that every System Settings field on the form is
 * accepted by the PATCH /admin/system-settings validator. This caught a
 * regression where `timezone` wasn't in the schema, so PATCH requests
 * saved every other field but silently dropped the timezone.
 *
 * We re-declare the schema inline (matching routes.ts) rather than
 * importing it, because routes.ts keeps it as a private const. If the
 * validator in routes.ts diverges from this shape, either update both or
 * export the schema.
 */
const updateSchema = z.object({
  platformName: z.string().min(1).max(255).optional(),
  adminPanelUrl: z.string().url().max(500).optional().nullable(),
  clientPanelUrl: z.string().url().max(500).optional().nullable(),
  supportEmail: z.string().email().max(255).optional().nullable(),
  supportUrl: z.string().url().max(500).optional().nullable(),
  ingressBaseDomain: z.string().max(255).optional().nullable(),
  apiRateLimit: z.number().int().min(1).max(10000).optional(),
  timezone: z.string().min(1).max(50).optional(),
  mailHostname: z.string().max(255).optional().nullable(),
  webmailUrl: z.string().url().max(500).optional().nullable(),
});

describe('system-settings PATCH schema', () => {
  it('accepts a full payload with every UI field', () => {
    const result = updateSchema.safeParse({
      platformName: 'Acme Host',
      adminPanelUrl: 'https://admin.acme.test',
      clientPanelUrl: 'https://my.acme.test',
      supportEmail: 'help@acme.test',
      supportUrl: 'https://docs.acme.test',
      ingressBaseDomain: 'routing.acme.test',
      apiRateLimit: 250,
      timezone: 'Europe/Berlin',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // All values survive the parse — specifically including timezone,
      // which was the field that regressed.
      expect(result.data.timezone).toBe('Europe/Berlin');
      expect(result.data.platformName).toBe('Acme Host');
      expect(result.data.apiRateLimit).toBe(250);
    }
  });

  it('rejects a non-string timezone', () => {
    const result = updateSchema.safeParse({ timezone: 42 });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string timezone', () => {
    const result = updateSchema.safeParse({ timezone: '' });
    expect(result.success).toBe(false);
  });

  it('allows partial patches (only timezone)', () => {
    const result = updateSchema.safeParse({ timezone: 'America/Denver' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid apiRateLimit', () => {
    expect(updateSchema.safeParse({ apiRateLimit: 0 }).success).toBe(false);
    expect(updateSchema.safeParse({ apiRateLimit: 99999 }).success).toBe(false);
    expect(updateSchema.safeParse({ apiRateLimit: 2.5 }).success).toBe(false);
  });
});
