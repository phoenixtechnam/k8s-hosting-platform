import { describe, it, expect, vi } from 'vitest';
import {
  STRATEGIC_MERGE_PATCH,
  MERGE_PATCH,
  JSON_PATCH,
  buildContentTypeOverride,
} from './k8s-patch.js';

type Override = {
  middleware: Array<{
    pre(ctx: { setHeaderParam: (k: string, v: string) => void }): {
      toPromise(): Promise<unknown>;
      pipe(): undefined;
    };
    post(ctx: { setHeaderParam: (k: string, v: string) => void }): {
      toPromise(): Promise<unknown>;
      pipe(): undefined;
    };
  }>;
};

function captureContentType(override: unknown): string | undefined {
  const setHeaderParam = vi.fn<(k: string, v: string) => void>();
  const fakeCtx = { setHeaderParam };
  const ovr = override as Override;
  ovr.middleware[0].pre(fakeCtx);
  const call = setHeaderParam.mock.calls.find((c) => c[0] === 'Content-Type');
  return call?.[1];
}

describe('shared/k8s-patch middleware shims', () => {
  it('STRATEGIC_MERGE_PATCH overrides Content-Type to strategic-merge-patch+json', () => {
    expect(captureContentType(STRATEGIC_MERGE_PATCH)).toBe(
      'application/strategic-merge-patch+json',
    );
  });

  it('MERGE_PATCH overrides Content-Type to merge-patch+json (RFC 7396)', () => {
    expect(captureContentType(MERGE_PATCH)).toBe('application/merge-patch+json');
  });

  it('JSON_PATCH overrides Content-Type to json-patch+json (RFC 6902)', () => {
    expect(captureContentType(JSON_PATCH)).toBe('application/json-patch+json');
  });

  it('shims expose _expectedContentType tag for the CI guard', () => {
    expect((STRATEGIC_MERGE_PATCH as { _expectedContentType: string })._expectedContentType)
      .toBe('application/strategic-merge-patch+json');
    expect((MERGE_PATCH as { _expectedContentType: string })._expectedContentType)
      .toBe('application/merge-patch+json');
    expect((JSON_PATCH as { _expectedContentType: string })._expectedContentType)
      .toBe('application/json-patch+json');
  });

  it('post() and pre() return Observable-like stubs with toPromise + pipe', async () => {
    const ovr = buildContentTypeOverride('application/json-patch+json');
    const ctx = { setHeaderParam: vi.fn() };
    const pre = ovr.middleware[0].pre(ctx);
    const post = ovr.middleware[0].post(ctx);
    expect(typeof pre.toPromise).toBe('function');
    expect(typeof pre.pipe).toBe('function');
    expect(typeof post.toPromise).toBe('function');
    expect(typeof post.pipe).toBe('function');
    await expect(pre.toPromise()).resolves.toBe(ctx);
    await expect(post.toPromise()).resolves.toBe(ctx);
  });

  it('buildContentTypeOverride sets the Content-Type header verbatim on pre()', () => {
    const ovr = buildContentTypeOverride('application/apply-patch+yaml');
    const setHeaderParam = vi.fn();
    ovr.middleware[0].pre({ setHeaderParam });
    expect(setHeaderParam).toHaveBeenCalledWith(
      'Content-Type',
      'application/apply-patch+yaml',
    );
  });
});
