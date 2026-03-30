import { describe, it, expect } from 'vitest';
import { updateEolSettingsSchema, eolSettingsResponseSchema, eolScanResultSchema } from '@k8s-hosting/api-contracts';

describe('eol-scanner schemas', () => {
  it('should validate EOL settings response', () => {
    const result = eolSettingsResponseSchema.safeParse({
      graceDays: 30,
      warningDays: 60,
      autoUpgradeEnabled: false,
    });
    expect(result.success).toBe(true);
  });

  it('should validate update input with partial fields', () => {
    const onlyGrace = updateEolSettingsSchema.safeParse({ graceDays: 14 });
    expect(onlyGrace.success).toBe(true);

    const onlyWarning = updateEolSettingsSchema.safeParse({ warningDays: 90 });
    expect(onlyWarning.success).toBe(true);

    const onlyAuto = updateEolSettingsSchema.safeParse({ autoUpgradeEnabled: true });
    expect(onlyAuto.success).toBe(true);

    const empty = updateEolSettingsSchema.safeParse({});
    expect(empty.success).toBe(true);
  });

  it('should reject invalid grace days', () => {
    const tooLow = updateEolSettingsSchema.safeParse({ graceDays: 0 });
    expect(tooLow.success).toBe(false);

    const tooHigh = updateEolSettingsSchema.safeParse({ graceDays: 500 });
    expect(tooHigh.success).toBe(false);

    const float = updateEolSettingsSchema.safeParse({ graceDays: 14.5 });
    expect(float.success).toBe(false);
  });

  it('should reject invalid warning days', () => {
    const tooLow = updateEolSettingsSchema.safeParse({ warningDays: 0 });
    expect(tooLow.success).toBe(false);

    const tooHigh = updateEolSettingsSchema.safeParse({ warningDays: 400 });
    expect(tooHigh.success).toBe(false);
  });

  it('should validate scan result schema', () => {
    const result = eolScanResultSchema.safeParse({
      warningsSent: 3,
      forcedUpgradesTriggered: 1,
      errors: ['No upgrade target found'],
    });
    expect(result.success).toBe(true);
  });

  it('should validate scan result with empty arrays', () => {
    const result = eolScanResultSchema.safeParse({
      warningsSent: 0,
      forcedUpgradesTriggered: 0,
      errors: [],
    });
    expect(result.success).toBe(true);
  });
});
