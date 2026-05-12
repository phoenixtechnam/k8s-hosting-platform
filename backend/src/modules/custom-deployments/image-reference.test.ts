import { describe, it, expect } from 'vitest';
import {
  parseImageReference,
  isPinnedReference,
  formatImageReference,
} from './image-reference.js';

describe('parseImageReference', () => {
  it('parses bare names as docker.io/library/*', () => {
    const r = parseImageReference('nginx');
    expect(r).toEqual({
      registryHost: 'docker.io',
      repository: 'library/nginx',
      tag: null,
      digest: null,
    });
  });

  it('parses bare name + tag', () => {
    const r = parseImageReference('nginx:1.27');
    expect(r?.repository).toBe('library/nginx');
    expect(r?.tag).toBe('1.27');
  });

  it('parses owner/app as docker.io/owner/app', () => {
    const r = parseImageReference('phoenix/api:v2.1');
    expect(r?.registryHost).toBe('docker.io');
    expect(r?.repository).toBe('phoenix/api');
    expect(r?.tag).toBe('v2.1');
  });

  it('parses ghcr.io references', () => {
    const r = parseImageReference('ghcr.io/owner/app:edge');
    expect(r?.registryHost).toBe('ghcr.io');
    expect(r?.repository).toBe('owner/app');
    expect(r?.tag).toBe('edge');
  });

  it('parses host:port style', () => {
    const r = parseImageReference('registry.example.com:5000/team/svc:v1');
    expect(r?.registryHost).toBe('registry.example.com:5000');
    expect(r?.repository).toBe('team/svc');
    expect(r?.tag).toBe('v1');
  });

  it('parses digest-only references', () => {
    const r = parseImageReference('nginx@sha256:' + 'a'.repeat(64));
    expect(r?.tag).toBe(null);
    expect(r?.digest).toBe('sha256:' + 'a'.repeat(64));
  });

  it('parses tag + digest references', () => {
    const ref = `ghcr.io/owner/app:edge@sha256:${'b'.repeat(64)}`;
    const r = parseImageReference(ref);
    expect(r?.tag).toBe('edge');
    expect(r?.digest).toBe(`sha256:${'b'.repeat(64)}`);
  });

  it('parses localhost as a registry host', () => {
    const r = parseImageReference('localhost/dev/app:wip');
    expect(r?.registryHost).toBe('localhost');
    expect(r?.repository).toBe('dev/app');
  });

  it('rejects empty input', () => {
    expect(parseImageReference('')).toBe(null);
  });

  it('rejects malformed digest', () => {
    expect(parseImageReference('nginx@sha256:short')).toBe(null);
    expect(parseImageReference('nginx@sha512:' + 'a'.repeat(128))).toBe(null);
  });

  it('rejects malformed tag', () => {
    expect(parseImageReference('nginx:has spaces')).toBe(null);
    expect(parseImageReference('nginx:-leading-dash')).toBe(null);
  });

  it('rejects malformed repo segments', () => {
    expect(parseImageReference('Nginx')).toBe(null); // uppercase
    expect(parseImageReference('owner//app')).toBe(null); // double slash
  });

  it('rejects over-long input', () => {
    expect(parseImageReference('a' + '/b'.repeat(300))).toBe(null);
  });
});

describe('isPinnedReference', () => {
  it('treats digest references as pinned', () => {
    const ref = parseImageReference('nginx@sha256:' + '1'.repeat(64))!;
    expect(isPinnedReference(ref)).toBe(true);
  });
  it('treats explicit version tags as pinned', () => {
    expect(isPinnedReference(parseImageReference('nginx:1.27.3')!)).toBe(true);
  });
  it('treats :latest as UNPINNED', () => {
    expect(isPinnedReference(parseImageReference('nginx:latest')!)).toBe(false);
  });
  it('treats missing tag as UNPINNED', () => {
    expect(isPinnedReference(parseImageReference('nginx')!)).toBe(false);
  });
});

describe('formatImageReference', () => {
  it('round-trips a tagged reference', () => {
    const parsed = parseImageReference('ghcr.io/owner/app:edge')!;
    expect(formatImageReference(parsed)).toBe('ghcr.io/owner/app:edge');
  });
  it('round-trips a digest reference', () => {
    const ref = `ghcr.io/owner/app@sha256:${'c'.repeat(64)}`;
    const parsed = parseImageReference(ref)!;
    expect(formatImageReference(parsed)).toBe(ref);
  });
  it('normalises bare names to docker.io/library/*', () => {
    expect(formatImageReference(parseImageReference('nginx')!)).toBe('docker.io/library/nginx');
  });
});
