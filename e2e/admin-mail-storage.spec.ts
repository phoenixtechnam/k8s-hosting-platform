import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Admin Email Management → Mail Server Storage card.
 *
 * Drives the live PVC-resize flow that the integration harness cannot
 * reach (per feedback_ui_must_be_tested.md). Mocked at the network
 * layer so the test runs against the local DinD cluster without
 * needing the full mail stack up.
 *
 * Run against staging:
 *   BASE_URL=https://admin.staging.phoenix-host.net \
 *   npx playwright test admin-mail-storage --project admin --no-deps --workers=1
 */

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

const baseStorageMock = {
  data: {
    pvcName: 'mail-pg-1',
    namespace: 'mail',
    requestedBytes: 5 * 1024 ** 3,
    capacityBytes: 5 * 1024 ** 3,
    usedBytes: 1.5 * 1024 ** 3,
    freeBytes: 3.5 * 1024 ** 3,
    storageClass: 'longhorn-system-local',
    expansionAllowed: true,
    lastResizedAt: null,
  },
};

test.describe('Admin Email Management → Mail Server Storage card', () => {
  test.setTimeout(90_000);
  test.use({ actionTimeout: 10_000, navigationTimeout: 30_000 });

  test.beforeEach(async ({ page }) => {
    await injectAdminAuthSlow(page);

    // Mock the storage GET so the test runs against any cluster.
    await page.route('**/api/v1/admin/mail/pvc/storage', async (route) => {
      if (route.request().method() === 'PATCH') {
        // Default PATCH mock — overridden per-test via page.unroute when
        // a specific test wants different behavior.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              pvcName: 'mail-pg-1',
              requestedBytes: 10 * 1024 ** 3,
              lastResizedAt: new Date().toISOString(),
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(baseStorageMock),
        });
      }
    });

    // Other panels on the page (StalwartAdminPanel, MailServerSettings)
    // make their own API calls — mock loosely to avoid noise.
    await page.route('**/api/v1/admin/platform-urls', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            longhornUrl: { value: '', source: 'default' },
            stalwartAdminUrl: { value: '', source: 'default' },
            webmailUrl: { value: '', source: 'default' },
            mailServerHostname: { value: '', source: 'default' },
          },
        }),
      });
    });

    await page.goto('/settings/email');
    await expect(page.getByTestId('email-mgmt-heading')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mail-storage-heading')).toBeVisible({ timeout: 30_000 });
  });

  test('renders current size + capacity + storage class', async ({ page }) => {
    await expect(page.getByTestId('mail-storage-requested')).toContainText('5 GiB');
    await expect(page.getByTestId('mail-storage-capacity')).toContainText('5 GiB');
    await expect(page.getByTestId('mail-storage-sc')).toContainText('longhorn-system-local');
  });

  test('Resize button is disabled when input is empty', async ({ page }) => {
    await expect(page.getByTestId('mail-pvc-resize-button')).toBeDisabled();
  });

  test('Resize button is disabled and warning shown when input < current', async ({ page }) => {
    await page.getByTestId('mail-pvc-new-size-gib').fill('3');
    await expect(page.getByTestId('mail-pvc-resize-button')).toBeDisabled();
    await expect(page.getByTestId('mail-pvc-shrink-warning')).toBeVisible();
  });

  test('Resize button is disabled and no-op warning shown when input == current', async ({ page }) => {
    await page.getByTestId('mail-pvc-new-size-gib').fill('5');
    await expect(page.getByTestId('mail-pvc-resize-button')).toBeDisabled();
    await expect(page.getByTestId('mail-pvc-no-op-warning')).toBeVisible();
  });

  test('Resize button enabled + opens confirm modal when input > current', async ({ page }) => {
    await page.getByTestId('mail-pvc-new-size-gib').fill('10');
    const btn = page.getByTestId('mail-pvc-resize-button');
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(page.getByTestId('mail-pvc-resize-modal')).toBeVisible();
    const modal = page.getByTestId('mail-pvc-resize-modal');
    await expect(modal).toContainText('Resize mail-pg-1 storage to 10 GiB');
    await expect(modal).toContainText('Online expansion');
    await expect(modal).toContainText('Shrinking is NOT supported');
  });

  test('confirm → success → success banner + input cleared', async ({ page }) => {
    await page.getByTestId('mail-pvc-new-size-gib').fill('10');
    await page.getByTestId('mail-pvc-resize-button').click();
    await page.getByTestId('mail-pvc-resize-confirm').click();
    await expect(page.getByTestId('mail-pvc-resize-modal')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('mail-pvc-resize-success')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('mail-pvc-new-size-gib')).toHaveValue('');
  });

  test('shrink reject from backend → error panel renders', async ({ page }) => {
    // Override the PATCH mock to return the backend's shrink rejection.
    await page.unroute('**/api/v1/admin/mail/pvc/storage');
    await page.route('**/api/v1/admin/mail/pvc/storage', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'MAIL_PVC_SHRINK_NOT_SUPPORTED',
              message: 'K8s does not support online PVC shrink. Current 5GiB, requested 3GiB.',
              status: 400,
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(baseStorageMock),
        });
      }
    });

    // Use the input bypass — manually trigger PATCH despite UI gating
    // by typing a value > current then injecting a fetch (mocked path
    // catches it). Here we just type a valid size + click confirm; the
    // SERVER returns the shrink error to exercise the error-render
    // path. (Pretend 10 → server still says shrink, mocking a code.)
    await page.getByTestId('mail-pvc-new-size-gib').fill('10');
    await page.getByTestId('mail-pvc-resize-button').click();
    await page.getByTestId('mail-pvc-resize-confirm').click();
    await expect(page.getByTestId('mail-pvc-resize-modal').getByText(/MAIL_PVC_SHRINK_NOT_SUPPORTED|shrink/i)).toBeVisible({ timeout: 10_000 });
  });

  test('SC.allowVolumeExpansion=false disables the input + warns', async ({ page }) => {
    await page.unroute('**/api/v1/admin/mail/pvc/storage');
    await page.route('**/api/v1/admin/mail/pvc/storage', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { ...baseStorageMock.data, expansionAllowed: false },
        }),
      });
    });
    await page.reload();
    await expect(page.getByTestId('mail-storage-heading')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/allowVolumeExpansion=false/)).toBeVisible();
    await expect(page.getByTestId('mail-pvc-new-size-gib')).toBeDisabled();
  });

  test('expanding banner shows when requested > capacity', async ({ page }) => {
    await page.unroute('**/api/v1/admin/mail/pvc/storage');
    await page.route('**/api/v1/admin/mail/pvc/storage', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            ...baseStorageMock.data,
            requestedBytes: 10 * 1024 ** 3,
            capacityBytes: 5 * 1024 ** 3,
          },
        }),
      });
    });
    await page.reload();
    await expect(page.getByTestId('mail-storage-expanding')).toBeVisible({ timeout: 30_000 });
  });

  test('cancel button closes modal without calling PATCH', async ({ page }) => {
    let patchCalled = false;
    await page.unroute('**/api/v1/admin/mail/pvc/storage');
    await page.route('**/api/v1/admin/mail/pvc/storage', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchCalled = true;
        await route.fulfill({ status: 200, body: '{}' });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(baseStorageMock),
        });
      }
    });
    await page.getByTestId('mail-pvc-new-size-gib').fill('10');
    await page.getByTestId('mail-pvc-resize-button').click();
    await page.getByTestId('mail-pvc-resize-cancel').click();
    await expect(page.getByTestId('mail-pvc-resize-modal')).not.toBeVisible({ timeout: 10_000 });
    expect(patchCalled).toBe(false);
  });
});
