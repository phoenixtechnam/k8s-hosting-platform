import { describe, it, expect } from 'vitest';
import { rcloneObscure, rcloneReveal } from './rclone-obscure.js';

describe('rclone-obscure', () => {
  it('round-trips a plaintext password', () => {
    const plain = 'hunter2-rclone-smb';
    const obscured = rcloneObscure(plain);
    expect(obscured).not.toEqual(plain);
    expect(rcloneReveal(obscured)).toEqual(plain);
  });

  it('produces distinct output on repeated calls (random IV)', () => {
    const plain = 'same-password';
    const a = rcloneObscure(plain);
    const b = rcloneObscure(plain);
    expect(a).not.toEqual(b);
    expect(rcloneReveal(a)).toEqual(plain);
    expect(rcloneReveal(b)).toEqual(plain);
  });

  it('handles empty string as no-op', () => {
    expect(rcloneObscure('')).toEqual('');
    expect(rcloneReveal('')).toEqual('');
  });

  it('handles unicode', () => {
    const plain = 'pässwörd-with-🔐';
    const obscured = rcloneObscure(plain);
    expect(rcloneReveal(obscured)).toEqual(plain);
  });

  it('handles long passwords (256 chars)', () => {
    const plain = 'x'.repeat(256);
    const obscured = rcloneObscure(plain);
    expect(rcloneReveal(obscured)).toEqual(plain);
  });

  it('rcloneReveal rejects malformed input', () => {
    expect(() => rcloneReveal('a')).toThrow(/too short/);
  });

  it('produces base64-url output (no +/= chars)', () => {
    const obscured = rcloneObscure('test-no-padding-chars');
    expect(obscured).not.toMatch(/[+/=]/);
  });
});
