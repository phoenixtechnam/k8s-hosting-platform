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

  // Regression guard for the "wrong rclone key" bug — the implementation
  // shipped with an incorrect last 8 bytes of the cryptKey, causing
  // round-trips through OUR code to succeed (both sides used the wrong
  // key) but real rclone to fail with "logon invalid" against SMB,
  // FTP, and any other backend that uses RCLONE_CONFIG_*_PASS. These
  // fixtures are pre-computed by `rclone obscure <plaintext>` against
  // upstream v1.66; their reveal MUST match the documented plaintext.
  it('reveals upstream-rclone-produced fixtures correctly', () => {
    const fixtures: Array<{ obscured: string; plain: string }> = [
      // generated via: kubectl run o --rm -it --image=rclone/rclone:1.66 \
      //   --command -- rclone obscure smb-dev-password-1234
      { obscured: 'UIQYM1XhG5kjOxglarAfZhH7RFWNli_frWfXgwp6IHecaSplTQ', plain: 'smb-dev-password-1234' },
    ];
    for (const { obscured, plain } of fixtures) {
      expect(rcloneReveal(obscured)).toEqual(plain);
    }
  });
});
