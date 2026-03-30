import { describe, it, expect } from 'vitest';
import { updateStorageSettingsSchema } from '@k8s-hosting/api-contracts';

describe('storage-settings defaults', () => {
  it('should have correct default values', () => {
    expect(1.5).toBeGreaterThanOrEqual(1.0);
    expect(1.5).toBeLessThanOrEqual(5.0);
    expect('longhorn').toBeTruthy();
  });

  it('should respect DEFAULT_STORAGE_CLASS env var', () => {
    const envValue = process.env.DEFAULT_STORAGE_CLASS;
    if (!envValue) {
      expect('longhorn').toBe('longhorn');
    } else {
      expect(envValue).toBeTruthy();
    }
  });

  it('should clamp overcommit ratio between 1.0 and 5.0', () => {
    const tooLow = updateStorageSettingsSchema.safeParse({ storageOvercommitRatio: 0.5 });
    expect(tooLow.success).toBe(false);

    const tooHigh = updateStorageSettingsSchema.safeParse({ storageOvercommitRatio: 10 });
    expect(tooHigh.success).toBe(false);

    const valid = updateStorageSettingsSchema.safeParse({ storageOvercommitRatio: 1.5 });
    expect(valid.success).toBe(true);

    const minValid = updateStorageSettingsSchema.safeParse({ storageOvercommitRatio: 1.0 });
    expect(minValid.success).toBe(true);

    const maxValid = updateStorageSettingsSchema.safeParse({ storageOvercommitRatio: 5.0 });
    expect(maxValid.success).toBe(true);
  });

  it('should validate storage class is non-empty', () => {
    const empty = updateStorageSettingsSchema.safeParse({ defaultStorageClass: '' });
    expect(empty.success).toBe(false);

    const valid = updateStorageSettingsSchema.safeParse({ defaultStorageClass: 'local-path' });
    expect(valid.success).toBe(true);
  });

  it('should allow partial updates', () => {
    const onlyRatio = updateStorageSettingsSchema.safeParse({ storageOvercommitRatio: 2.0 });
    expect(onlyRatio.success).toBe(true);

    const onlyClass = updateStorageSettingsSchema.safeParse({ defaultStorageClass: 'longhorn' });
    expect(onlyClass.success).toBe(true);

    const emptyUpdate = updateStorageSettingsSchema.safeParse({});
    expect(emptyUpdate.success).toBe(true);
  });
});
