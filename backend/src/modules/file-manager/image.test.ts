import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { getFileManagerImage } from './image.js';

describe('getFileManagerImage', () => {
  const originalEnv = process.env.FILE_MANAGER_IMAGE;

  beforeEach(() => {
    delete process.env.FILE_MANAGER_IMAGE;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FILE_MANAGER_IMAGE;
    } else {
      process.env.FILE_MANAGER_IMAGE = originalEnv;
    }
  });

  it('returns the env var when set to a registry-qualified path', () => {
    process.env.FILE_MANAGER_IMAGE = 'ghcr.io/phoenixtechnam/hosting-platform/file-manager-sidecar:latest';
    expect(getFileManagerImage()).toBe('ghcr.io/phoenixtechnam/hosting-platform/file-manager-sidecar:latest');
  });

  it('returns the env var verbatim — does not validate the form (defense lives at deploy time)', () => {
    // This is the local-dev case: scripts/local.sh imports the bare-tagged
    // image into containerd, so the env var can be the bare name too.
    process.env.FILE_MANAGER_IMAGE = 'file-manager-sidecar:dev-abc123';
    expect(getFileManagerImage()).toBe('file-manager-sidecar:dev-abc123');
  });

  it('falls back to the bare local-dev tag when env is unset', () => {
    expect(getFileManagerImage()).toBe('file-manager-sidecar:latest');
  });

  it('falls back when env is explicitly empty string (?? semantics: only nullish triggers fallback)', () => {
    // ?? falls back ONLY on null/undefined. Empty string is preserved.
    // This documents the contract — callers that explicitly set
    // FILE_MANAGER_IMAGE="" get the empty string back (and downstream
    // kubectl apply will reject the empty image, which is the loud
    // failure we want for misconfig).
    process.env.FILE_MANAGER_IMAGE = '';
    expect(getFileManagerImage()).toBe('');
  });

  it('re-reads the env on every call (no module-level caching)', () => {
    process.env.FILE_MANAGER_IMAGE = 'first:tag';
    expect(getFileManagerImage()).toBe('first:tag');
    process.env.FILE_MANAGER_IMAGE = 'second:tag';
    expect(getFileManagerImage()).toBe('second:tag');
  });
});
