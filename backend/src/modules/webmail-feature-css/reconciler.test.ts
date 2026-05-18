import { describe, it, expect, vi } from 'vitest';
import {
  renderBulwarkOverrideCss,
  renderRoundcubeOverrideCss,
  computeFeatureCssHash,
  reconcileWebmailFeatureCss,
  WEBMAIL_FEATURE_CM_NAME,
  WEBMAIL_FEATURE_CM_NAMESPACE,
  WEBMAIL_FEATURE_HASH_ANNOTATION,
  WEBMAIL_FEATURE_CM_BULWARK_KEY,
  WEBMAIL_FEATURE_CM_ROUNDCUBE_KEY,
  BULWARK_DEPLOY_NAME,
  ROUNDCUBE_DEPLOY_NAME,
} from './reconciler.js';

// ─── Mock visibility flags ───────────────────────────────────────
vi.mock('../webmail-settings/service.js', () => ({
  getWebmailFeatureVisibility: vi.fn(),
}));
import { getWebmailFeatureVisibility } from '../webmail-settings/service.js';
const mockedGet = vi.mocked(getWebmailFeatureVisibility);

// ─── CSS rendering ───────────────────────────────────────────────

describe('renderBulwarkOverrideCss', () => {
  it('returns empty string when all features are visible', () => {
    expect(
      renderBulwarkOverrideCss({
        webmailShowContacts: true,
        webmailShowCalendar: true,
        webmailShowFiles: true,
      }),
    ).toBe('');
  });

  it('hides all three features when all flags are false (default)', () => {
    const css = renderBulwarkOverrideCss({
      webmailShowContacts: false,
      webmailShowCalendar: false,
      webmailShowFiles: false,
    });
    expect(css).toContain('a[href$="/contacts"]');
    expect(css).toContain('a[href$="/calendar"]');
    expect(css).toContain('a[href$="/files"]');
    expect(css).toContain('display: none !important');
  });

  it('hides only contacts when calendar+files are enabled', () => {
    const css = renderBulwarkOverrideCss({
      webmailShowContacts: false,
      webmailShowCalendar: true,
      webmailShowFiles: true,
    });
    expect(css).toContain('a[href$="/contacts"]');
    expect(css).not.toContain('a[href$="/calendar"]');
    expect(css).not.toContain('a[href$="/files"]');
  });

  it('uses ends-with selector so locale-prefixed routes are also hidden', () => {
    const css = renderBulwarkOverrideCss({
      webmailShowContacts: false,
      webmailShowCalendar: false,
      webmailShowFiles: false,
    });
    // [href$="/contacts"] matches /contacts AND /en/contacts AND
    // /de-DE/contacts — that's the whole point.
    expect(css).toMatch(/\[href\$="\/contacts"\]/);
  });
});

describe('renderRoundcubeOverrideCss', () => {
  it('returns empty string when contacts is visible', () => {
    expect(renderRoundcubeOverrideCss({ webmailShowContacts: true })).toBe('');
  });

  it('hides Address Book taskbar when contacts is disabled', () => {
    const css = renderRoundcubeOverrideCss({ webmailShowContacts: false });
    expect(css).toContain('a.button.contacts');
    expect(css).toContain('display: none !important');
  });

  it('ignores calendar/files (Roundcube has no such plugins installed)', () => {
    // Calendar / Files plugins aren't installed in our Roundcube image
    // (CI guard rejects them); the renderer doesn't take those flags.
    const css = renderRoundcubeOverrideCss({ webmailShowContacts: false });
    expect(css).not.toMatch(/calendar/i);
    expect(css).not.toMatch(/files/i);
  });
});

describe('computeFeatureCssHash', () => {
  it('is deterministic for the same content', () => {
    const a = computeFeatureCssHash('foo', 'bar');
    const b = computeFeatureCssHash('foo', 'bar');
    expect(a).toBe(b);
  });

  it('changes when either blob changes', () => {
    const base = computeFeatureCssHash('foo', 'bar');
    expect(computeFeatureCssHash('foo2', 'bar')).not.toBe(base);
    expect(computeFeatureCssHash('foo', 'bar2')).not.toBe(base);
  });

  it('returns a 16-character hex prefix', () => {
    const hash = computeFeatureCssHash('foo', 'bar');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─── reconcileWebmailFeatureCss ──────────────────────────────────

function makeClients(opts: {
  cmExists?: boolean;
  cmData?: Record<string, string>;
  deploymentAnnotations?: { bulwark?: string; roundcube?: string };
  deploymentMissing?: { bulwark?: boolean; roundcube?: boolean };
}) {
  const readCM = vi.fn().mockImplementation(() => {
    if (!opts.cmExists) {
      const err = new Error('Not Found') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    return Promise.resolve({
      metadata: { name: WEBMAIL_FEATURE_CM_NAME, namespace: WEBMAIL_FEATURE_CM_NAMESPACE },
      data: opts.cmData ?? {},
    });
  });
  const createCM = vi.fn().mockResolvedValue({});
  const patchCM = vi.fn().mockResolvedValue({});

  const readDep = vi.fn().mockImplementation((args: { name: string }) => {
    if (
      (args.name === BULWARK_DEPLOY_NAME && opts.deploymentMissing?.bulwark)
      || (args.name === ROUNDCUBE_DEPLOY_NAME && opts.deploymentMissing?.roundcube)
    ) {
      const err = new Error('Not Found') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    const ann = args.name === BULWARK_DEPLOY_NAME
      ? opts.deploymentAnnotations?.bulwark
      : opts.deploymentAnnotations?.roundcube;
    return Promise.resolve({
      spec: { template: { metadata: { annotations: ann ? { [WEBMAIL_FEATURE_HASH_ANNOTATION]: ann } : {} } } },
    });
  });
  const patchDep = vi.fn().mockResolvedValue({});

  const clients = {
    core: {
      readNamespacedConfigMap: readCM,
      createNamespacedConfigMap: createCM,
      patchNamespacedConfigMap: patchCM,
    },
    apps: {
      readNamespacedDeployment: readDep,
      patchNamespacedDeployment: patchDep,
    },
  } as unknown as Parameters<typeof reconcileWebmailFeatureCss>[1];

  return { clients, readCM, createCM, patchCM, readDep, patchDep };
}

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('reconcileWebmailFeatureCss', () => {
  it('creates the ConfigMap + stamps both Deployments when nothing exists', async () => {
    mockedGet.mockResolvedValueOnce({
      webmailShowContacts: false,
      webmailShowCalendar: false,
      webmailShowFiles: false,
    });
    const { clients, createCM, patchCM, patchDep } = makeClients({ cmExists: false });

    const result = await reconcileWebmailFeatureCss(
      {} as never,
      clients,
      noopLog,
    );

    expect(result.cmCreated).toBe(true);
    expect(result.cmUpdated).toBe(false);
    expect(result.bulwarkAnnotated).toBe(true);
    expect(result.roundcubeAnnotated).toBe(true);
    expect(createCM).toHaveBeenCalledTimes(1);
    expect(patchCM).not.toHaveBeenCalled();
    expect(patchDep).toHaveBeenCalledTimes(2);

    const createCall = createCM.mock.calls[0][0] as {
      body: { data: Record<string, string>; metadata: { annotations: Record<string, string> } };
    };
    expect(createCall.body.data[WEBMAIL_FEATURE_CM_BULWARK_KEY]).toContain('a[href$="/contacts"]');
    expect(createCall.body.data[WEBMAIL_FEATURE_CM_ROUNDCUBE_KEY]).toContain('a.button.contacts');
    expect(createCall.body.metadata.annotations[WEBMAIL_FEATURE_HASH_ANNOTATION]).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is a full no-op when ConfigMap content + Deployment annotations already match', async () => {
    mockedGet.mockResolvedValueOnce({
      webmailShowContacts: true,
      webmailShowCalendar: true,
      webmailShowFiles: true,
    });
    // When all features are visible, both CSS bodies are empty
    // strings. Compute the matching hash.
    const expectedHash = computeFeatureCssHash('', '');
    const { clients, createCM, patchCM, patchDep } = makeClients({
      cmExists: true,
      cmData: {
        [WEBMAIL_FEATURE_CM_BULWARK_KEY]: '',
        [WEBMAIL_FEATURE_CM_ROUNDCUBE_KEY]: '',
      },
      deploymentAnnotations: { bulwark: expectedHash, roundcube: expectedHash },
    });

    const result = await reconcileWebmailFeatureCss(
      {} as never,
      clients,
      noopLog,
    );

    expect(result.cmCreated).toBe(false);
    expect(result.cmUpdated).toBe(false);
    expect(result.bulwarkAnnotated).toBe(false);
    expect(result.roundcubeAnnotated).toBe(false);
    expect(createCM).not.toHaveBeenCalled();
    expect(patchCM).not.toHaveBeenCalled();
    expect(patchDep).not.toHaveBeenCalled();
  });

  it('updates ConfigMap + re-stamps Deployments when flags change content', async () => {
    mockedGet.mockResolvedValueOnce({
      webmailShowContacts: false,
      webmailShowCalendar: false,
      webmailShowFiles: false,
    });
    const { clients, createCM, patchCM, patchDep } = makeClients({
      cmExists: true,
      // Live ConfigMap is stale (everything visible) — reconcile should
      // detect drift + patch.
      cmData: {
        [WEBMAIL_FEATURE_CM_BULWARK_KEY]: '',
        [WEBMAIL_FEATURE_CM_ROUNDCUBE_KEY]: '',
      },
      deploymentAnnotations: { bulwark: 'staleHash000000', roundcube: 'staleHash000000' },
    });

    const result = await reconcileWebmailFeatureCss(
      {} as never,
      clients,
      noopLog,
    );

    expect(result.cmCreated).toBe(false);
    expect(result.cmUpdated).toBe(true);
    expect(result.bulwarkAnnotated).toBe(true);
    expect(result.roundcubeAnnotated).toBe(true);
    expect(createCM).not.toHaveBeenCalled();
    expect(patchCM).toHaveBeenCalledTimes(1);
    expect(patchDep).toHaveBeenCalledTimes(2);
  });

  it('treats a missing Deployment (404) as expected — single-engine overlay', async () => {
    mockedGet.mockResolvedValueOnce({
      webmailShowContacts: false,
      webmailShowCalendar: false,
      webmailShowFiles: false,
    });
    const { clients, patchDep } = makeClients({
      cmExists: false,
      deploymentMissing: { roundcube: true },
    });

    const result = await reconcileWebmailFeatureCss(
      {} as never,
      clients,
      noopLog,
    );

    expect(result.bulwarkAnnotated).toBe(true);
    // Missing Roundcube → annotated=false but no throw.
    expect(result.roundcubeAnnotated).toBe(false);
    // Only the Bulwark Deployment patched.
    expect(patchDep).toHaveBeenCalledTimes(1);
  });

  it('does not patch when Deployment already carries the same hash (annotation idempotent)', async () => {
    mockedGet.mockResolvedValueOnce({
      webmailShowContacts: false,
      webmailShowCalendar: false,
      webmailShowFiles: false,
    });
    // Compute the expected hash for "all hidden" so we can pre-stamp it
    // on the bulwark deployment.
    const bulwarkCss = renderBulwarkOverrideCss({
      webmailShowContacts: false,
      webmailShowCalendar: false,
      webmailShowFiles: false,
    });
    const roundcubeCss = renderRoundcubeOverrideCss({ webmailShowContacts: false });
    const expectedHash = computeFeatureCssHash(bulwarkCss, roundcubeCss);

    const { clients, patchDep } = makeClients({
      cmExists: true,
      cmData: {
        [WEBMAIL_FEATURE_CM_BULWARK_KEY]: bulwarkCss,
        [WEBMAIL_FEATURE_CM_ROUNDCUBE_KEY]: roundcubeCss,
      },
      // Roundcube is stale; Bulwark already matches.
      deploymentAnnotations: { bulwark: expectedHash, roundcube: 'staleHash000000' },
    });

    const result = await reconcileWebmailFeatureCss(
      {} as never,
      clients,
      noopLog,
    );

    expect(result.cmUpdated).toBe(false);
    expect(result.bulwarkAnnotated).toBe(false); // already correct
    expect(result.roundcubeAnnotated).toBe(true); // stale → patched
    expect(patchDep).toHaveBeenCalledTimes(1);
  });
});
