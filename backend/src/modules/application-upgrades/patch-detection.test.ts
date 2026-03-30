import { describe, it, expect } from 'vitest';
import { detectPatchChange, isPatchUpgrade } from './patch-detection.js';

describe('detectPatchChange', () => {
  it('should detect when component images changed within same version', () => {
    const oldComponents = [
      { name: 'wordpress', image: 'wordpress:6.9.4-php8.4-apache' },
      { name: 'mariadb', image: 'mariadb:11.8' },
    ];
    const newComponents = [
      { name: 'wordpress', image: 'wordpress:6.9.5-php8.4-apache' },
      { name: 'mariadb', image: 'mariadb:11.8' },
    ];

    const result = detectPatchChange(oldComponents, newComponents);
    expect(result.isPatch).toBe(true);
    expect(result.changedImages).toHaveLength(1);
    expect(result.changedImages[0]).toEqual({
      component: 'wordpress',
      oldImage: 'wordpress:6.9.4-php8.4-apache',
      newImage: 'wordpress:6.9.5-php8.4-apache',
    });
  });

  it('should return isPatch false when no changes', () => {
    const components = [
      { name: 'app', image: 'app:1.0.0' },
    ];
    const result = detectPatchChange(components, components);
    expect(result.isPatch).toBe(false);
    expect(result.changedImages).toHaveLength(0);
  });

  it('should return isPatch true when multiple images changed', () => {
    const old = [
      { name: 'server', image: 'ghcr.io/app/server:v2.6.3' },
      { name: 'ml', image: 'ghcr.io/app/ml:v2.6.3' },
    ];
    const updated = [
      { name: 'server', image: 'ghcr.io/app/server:v2.6.4' },
      { name: 'ml', image: 'ghcr.io/app/ml:v2.6.4' },
    ];
    const result = detectPatchChange(old, updated);
    expect(result.isPatch).toBe(true);
    expect(result.changedImages).toHaveLength(2);
  });

  it('should handle null/undefined components gracefully', () => {
    expect(detectPatchChange(null, null).isPatch).toBe(false);
    expect(detectPatchChange(undefined, undefined).isPatch).toBe(false);
    expect(detectPatchChange([], []).isPatch).toBe(false);
  });
});

describe('isPatchUpgrade', () => {
  it('should return true for same version with different components', () => {
    expect(isPatchUpgrade('6.9', '6.9')).toBe(true);
  });

  it('should return false for different versions', () => {
    expect(isPatchUpgrade('6.8', '6.9')).toBe(false);
  });

  it('should return false for null versions', () => {
    expect(isPatchUpgrade(null, '6.9')).toBe(false);
    expect(isPatchUpgrade('6.9', null)).toBe(false);
  });

  it('should return true when versions match exactly', () => {
    expect(isPatchUpgrade('stable-10741', 'stable-10741')).toBe(true);
  });
});
