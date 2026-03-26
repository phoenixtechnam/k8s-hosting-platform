import { describe, it, expect, vi } from 'vitest';
import { getHostingSettings, updateHostingSettings } from './service.js';
import { ApiError } from '../../shared/errors.js';

const DOMAIN = { id: 'd1', clientId: 'c1', domainName: 'example.com' };
const SETTINGS = {
  id: 'hs1', domainId: 'd1', redirectWww: 0, redirectHttps: 1,
  forwardExternal: null, webrootPath: '/var/www/html', hostingEnabled: 1,
  createdAt: new Date(), updatedAt: new Date(),
};

describe('getHostingSettings', () => {
  it('should return existing settings with boolean conversion', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([SETTINGS]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Parameters<typeof getHostingSettings>[0];
    const result = await getHostingSettings(db, 'c1', 'd1');

    expect(result.redirectWww).toBe(false);
    expect(result.redirectHttps).toBe(true);
    expect(result.hostingEnabled).toBe(true);
  });

  it('should auto-create defaults on first access', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]); // domain ownership
      if (callCount === 2) return Promise.resolve([]); // no settings exist
      return Promise.resolve([SETTINGS]); // after insert
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const db = { select: selectFn, insert: insertFn } as unknown as Parameters<typeof getHostingSettings>[0];
    const result = await getHostingSettings(db, 'c1', 'd1');

    expect(insertFn).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should throw DOMAIN_NOT_FOUND for invalid domain', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof getHostingSettings>[0];

    await expect(getHostingSettings(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateHostingSettings', () => {
  it('should convert booleans to integers for storage', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return Promise.resolve([DOMAIN]); // domain checks
      return Promise.resolve([SETTINGS]); // settings
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof updateHostingSettings>[0];

    await updateHostingSettings(db, 'c1', 'd1', {
      redirect_www: true,
      redirect_https: false,
      hosting_enabled: false,
    });

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      redirectWww: 1,
      redirectHttps: 0,
      hostingEnabled: 0,
    }));
  });
});
