import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Admin Email Management → Stalwart Mail Server card.
 *
 * Drives the three operator-facing flows that the integration harness
 * cannot reach (per feedback_ui_must_be_tested.md, harness only hits
 * HTTP routes, never opens a browser):
 *
 *   1. Rotate admin password — button → confirm modal → click confirm
 *      → reveal credentials. Mocked at the network layer so the test
 *      doesn't actually rotate Stalwart's admin secret on every run.
 *   2. Rotate webmail master password — button → confirm modal → click
 *      confirm → reveal card with copy buttons + dismiss.
 *   3. Open Stalwart — button enabled when platform-urls resolves →
 *      click → iframe modal opens with the resolved subdomain as src.
 *
 * Network mocks: the rotation endpoints + platform-urls + iframe target
 * are intercepted via page.route so the spec runs without mutating the
 * cluster. Cluster-shape verification stays in scripts/integration-
 * staging.sh:scenario_mail.
 *
 * Run against staging:
 *   BASE_URL=https://admin.staging.phoenix-host.net \
 *   npx playwright test admin-mail-settings --project admin --no-deps --workers=1
 *
 * Run against local DinD: default config; needs admin-setup project.
 */

// Inline replacement for helpers.ts:injectAdminAuth that uses longer
// timeouts (the helper hardcodes a 5s dashboard-heading wait that is
// too short for staging's 5-15s cold-paint over public WAN).
async function injectAdminAuthSlow(page: import('@playwright/test').Page) {
  const authPath = path.join(__dirname, '.auth/admin-auth.json');
  const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  await page.goto('/login');
  await page.evaluate((data) => {
    if (data.token) localStorage.setItem('auth_token', data.token);
    if (data.user) localStorage.setItem('auth_user', data.user);
  }, authData);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('Admin Email Management → Stalwart Mail Server card', () => {
  // Bumped per-test + navigation timeouts — staging admin panel takes
  // 5-15s to first-paint over public WAN vs the playwright.config.ts
  // defaults (10s test / 5s nav / 2s actions) tuned for local DinD.
  test.setTimeout(90_000);
  test.use({
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  });

  test.beforeEach(async ({ page }) => {
    await injectAdminAuthSlow(page);

    // Mock platform-urls so the iframe button is enabled regardless of
    // whether the underlying cluster has STALWART_ADMIN_URL configured.
    await page.route('**/api/v1/admin/platform-urls', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            longhornUrl: { value: 'https://longhorn.example.test/', source: 'default' },
            stalwartAdminUrl: { value: 'https://stalwart.example.test/', source: 'default' },
            webmailUrl: { value: 'https://webmail.example.test/', source: 'default' },
            mailServerHostname: { value: 'mail.example.test', source: 'default' },
          },
        }),
      });
    });

    // Mock stalwart-credentials reveal so the panel renders cleanly even
    // if the live cluster's secret is missing.
    await page.route('**/api/v1/admin/mail/stalwart-credentials', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { username: 'admin', password: 'old-admin-pw-1234' } }),
      });
    });

    await page.goto('/settings/email');
    await expect(page.getByTestId('email-mgmt-heading')).toBeVisible({ timeout: 30_000 });
  });

  test('Stalwart panel renders with all three action buttons', async ({ page }) => {
    await expect(page.getByTestId('stalwart-show-credentials')).toBeVisible();
    await expect(page.getByTestId('stalwart-open')).toBeVisible();
    await expect(page.getByTestId('stalwart-rotate')).toBeVisible();
    await expect(page.getByTestId('stalwart-rotate-webmail-master')).toBeVisible();
  });

  test('rotate admin password: confirm modal → confirm → credentials revealed', async ({ page }) => {
    await page.route('**/api/v1/admin/mail/rotate-stalwart-password', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            username: 'admin',
            password: 'new-admin-pw-after-rotation',
            rotatedAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.getByTestId('stalwart-rotate').click();
    await expect(page.getByTestId('stalwart-rotate-modal')).toBeVisible();
    await expect(page.getByTestId('stalwart-rotate-modal')).toContainText(
      'Rotate Stalwart admin password?'
    );
    await page.getByTestId('stalwart-rotate-confirm').click();
    await expect(page.getByTestId('stalwart-rotate-modal')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('stalwart-username')).toContainText('admin', { timeout: 10_000 });
    await expect(page.getByTestId('stalwart-password')).toContainText('new-admin-pw-after-rotation', {
      timeout: 10_000,
    });
  });

  test('rotate admin password: cancel button closes modal without rotating', async ({ page }) => {
    let rotateCalled = false;
    await page.route('**/api/v1/admin/mail/rotate-stalwart-password', async (route) => {
      rotateCalled = true;
      await route.fulfill({ status: 200, body: '{}' });
    });
    await page.getByTestId('stalwart-rotate').click();
    await expect(page.getByTestId('stalwart-rotate-modal')).toBeVisible();
    await page.getByTestId('stalwart-rotate-modal').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('stalwart-rotate-modal')).not.toBeVisible({ timeout: 10_000 });
    expect(rotateCalled).toBe(false);
  });

  test('rotate webmail master: confirm modal explains the three-step flow', async ({ page }) => {
    await page.getByTestId('stalwart-rotate-webmail-master').click();
    const modal = page.getByTestId('stalwart-rotate-webmail-master-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Rotate webmail master password?');
    await expect(modal).toContainText('x:Account/set');
    await expect(modal).toContainText('STALWART_MASTER_PASSWORD');
    await expect(modal).toContainText('Roundcube');
    await expect(modal).toContainText('shown');
    await expect(modal).toContainText('once');
  });

  test('rotate webmail master: confirm → reveal card with copy buttons', async ({ page }) => {
    await page.route('**/api/v1/admin/mail/rotate-webmail-master-password', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            username: 'master',
            password: 'new-master-secret-value',
            rotatedAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.getByTestId('stalwart-rotate-webmail-master').click();
    await expect(page.getByTestId('stalwart-rotate-webmail-master-modal')).toBeVisible();
    await page.getByTestId('stalwart-rotate-webmail-master-confirm').click();
    await expect(page.getByTestId('stalwart-rotate-webmail-master-modal')).not.toBeVisible({
      timeout: 10_000,
    });
    const revealCard = page.getByTestId('webmail-master-reveal');
    await expect(revealCard).toBeVisible({ timeout: 10_000 });
    await expect(revealCard).toContainText('Webmail master password rotated — capture now');
    await expect(page.getByTestId('webmail-master-username')).toContainText('master');
    await expect(page.getByTestId('webmail-master-password')).toContainText('new-master-secret-value');
    await expect(page.getByTestId('webmail-master-username-copy')).toBeVisible();
    await expect(page.getByTestId('webmail-master-password-copy')).toBeVisible();
    await page.getByTestId('webmail-master-reveal-dismiss').click();
    await expect(page.getByTestId('webmail-master-reveal')).not.toBeVisible({ timeout: 10_000 });
  });

  test('rotate webmail master: error shows in the modal, reveal card not shown', async ({ page }) => {
    await page.route('**/api/v1/admin/mail/rotate-webmail-master-password', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'WEBMAIL_MASTER_ROTATION_FAILED', message: 'simulated failure' },
        }),
      });
    });
    await page.getByTestId('stalwart-rotate-webmail-master').click();
    await page.getByTestId('stalwart-rotate-webmail-master-confirm').click();
    const modal = page.getByTestId('stalwart-rotate-webmail-master-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('simulated failure', { timeout: 10_000 });
    await expect(page.getByTestId('webmail-master-reveal')).not.toBeVisible();
  });

  test('Open Stalwart: button enables once URL resolves + click opens iframe modal', async ({ page }) => {
    await page.route('https://stalwart.example.test/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Stalwart Web Admin (mocked)</h1></body></html>',
      });
    });
    const openBtn = page.getByTestId('stalwart-open');
    await expect(openBtn).toBeEnabled({ timeout: 10_000 });
    await openBtn.click();
    const iframeModal = page.getByTestId('stalwart-iframe-modal');
    await expect(iframeModal).toBeVisible();
    const iframe = page.getByTestId('stalwart-iframe');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('src', 'https://stalwart.example.test/');
    await expect(iframe).toHaveAttribute(
      'sandbox',
      /allow-scripts.*allow-same-origin.*allow-forms/
    );
    await page.getByTestId('stalwart-iframe-close').click();
    await expect(iframeModal).not.toBeVisible({ timeout: 10_000 });
  });

  test('Open Stalwart "in new tab" link points at the resolved URL', async ({ page }) => {
    const newTabLink = page.getByTestId('stalwart-open-tab');
    await expect(newTabLink).toBeVisible({ timeout: 10_000 });
    await expect(newTabLink).toHaveAttribute('href', 'https://stalwart.example.test/');
    await expect(newTabLink).toHaveAttribute('target', '_blank');
    await expect(newTabLink).toHaveAttribute('rel', /noreferrer.*noopener|noopener.*noreferrer/);
  });
});
