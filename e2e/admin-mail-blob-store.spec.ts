import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Admin Email Management → Stalwart Blob Storage card.
 *
 * Drives the blob-store backend switch flow that the integration
 * harness cannot reach (per feedback_ui_must_be_tested.md).
 *
 * Network-mocked: the GET, PATCH, and Job-status poll endpoints are
 * intercepted via page.route so the test runs without spawning the
 * real cli Job in the cluster.
 *
 * Run against staging:
 *   BASE_URL=https://admin.staging.phoenix-host.net \
 *   npx playwright test admin-mail-blob-store --project admin --no-deps --workers=1
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

test.describe('Admin Email Management → Stalwart Blob Storage card', () => {
  test.setTimeout(90_000);
  test.use({ actionTimeout: 10_000, navigationTimeout: 30_000 });

  test.beforeEach(async ({ page }) => {
    await injectAdminAuthSlow(page);

    // Mock the GET so the card renders without needing a live cluster.
    await page.route('**/api/v1/admin/mail/blob-store', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { id: 'singleton', type: 'Default', lastUpdatedAt: null },
          }),
        });
      } else if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 'singleton',
              type: 'S3',
              jobName: 'stalwart-blob-store-update-abc12345',
              status: 'queued',
              startedAt: new Date().toISOString(),
            },
          }),
        });
      }
    });

    // Mock the storage card alongside (it's on the same page).
    await page.route('**/api/v1/admin/mail/pvc/storage', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            pvcName: 'mail-pg-1',
            namespace: 'mail',
            requestedBytes: 5 * 1024 ** 3,
            capacityBytes: 5 * 1024 ** 3,
            usedBytes: null,
            freeBytes: null,
            storageClass: 'longhorn-system-local',
            expansionAllowed: true,
            lastResizedAt: null,
          },
        }),
      });
    });

    // Mock platform-urls for the StalwartAdminPanel that's also on this page.
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
    await expect(page.getByTestId('blob-store-heading')).toBeVisible({ timeout: 30_000 });
  });

  test('renders current backend type and three radio options', async ({ page }) => {
    await expect(page.getByTestId('blob-store-current-type')).toContainText('Default');
    await expect(page.getByTestId('blob-store-radio-default')).toBeVisible();
    await expect(page.getByTestId('blob-store-radio-s3')).toBeVisible();
    await expect(page.getByTestId('blob-store-radio-filesystem')).toBeVisible();
  });

  test('Apply button disabled until selection differs from current', async ({ page }) => {
    // Default is current; Apply should be disabled.
    await expect(page.getByTestId('blob-store-apply')).toBeDisabled();
    await expect(page.getByText(/No change/)).toBeVisible();
  });

  test('selecting S3 reveals the form fields', async ({ page }) => {
    await page.getByTestId('blob-store-radio-s3').check();
    await expect(page.getByTestId('blob-store-s3-bucket')).toBeVisible();
    await expect(page.getByTestId('blob-store-s3-region')).toBeVisible();
    await expect(page.getByTestId('blob-store-s3-access')).toBeVisible();
    await expect(page.getByTestId('blob-store-s3-secret')).toBeVisible();
  });

  test('selecting FileSystem reveals path + depth fields, hides S3 form', async ({ page }) => {
    await page.getByTestId('blob-store-radio-s3').check();
    await page.getByTestId('blob-store-radio-filesystem').check();
    await expect(page.getByTestId('blob-store-fs-path')).toBeVisible();
    await expect(page.getByTestId('blob-store-fs-depth')).toBeVisible();
    await expect(page.getByTestId('blob-store-s3-bucket')).not.toBeVisible();
  });

  test('S3 Apply button is disabled until all required fields are filled', async ({ page }) => {
    await page.getByTestId('blob-store-radio-s3').check();
    const apply = page.getByTestId('blob-store-apply');
    await expect(apply).toBeDisabled();

    await page.getByTestId('blob-store-s3-bucket').fill('my-bucket');
    await expect(apply).toBeDisabled();
    await page.getByTestId('blob-store-s3-region').fill('us-east-1');
    await expect(apply).toBeDisabled();
    await page.getByTestId('blob-store-s3-access').fill('AKIA');
    await expect(apply).toBeDisabled();
    await page.getByTestId('blob-store-s3-secret').fill('secret');
    await expect(apply).toBeEnabled();
  });

  test('S3 secret-key show/hide toggle flips the input type', async ({ page }) => {
    await page.getByTestId('blob-store-radio-s3').check();
    const secret = page.getByTestId('blob-store-s3-secret');
    await expect(secret).toHaveAttribute('type', 'password');
    await page.getByTestId('blob-store-s3-secret-toggle').click();
    await expect(secret).toHaveAttribute('type', 'text');
  });

  test('confirm modal explains migration consequences + requires MIGRATE typed', async ({ page }) => {
    await page.getByTestId('blob-store-radio-filesystem').check();
    await page.getByTestId('blob-store-apply').click();

    const modal = page.getByTestId('blob-store-confirm-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Switch BlobStore: Default → FileSystem');
    await expect(modal).toContainText('Existing blobs WILL NOT migrate');
    await expect(modal).toContainText('INCOMPATIBLE with multi-replica HA');

    const submit = page.getByTestId('blob-store-confirm-submit');
    await expect(submit).toBeDisabled();
    await page.getByTestId('blob-store-migrate-confirm').fill('migrate'); // wrong case
    await expect(submit).toBeDisabled();
    await page.getByTestId('blob-store-migrate-confirm').fill('MIGRATE');
    await expect(submit).toBeEnabled();
  });

  test('confirm submit kicks off Job + reveals job-status panel', async ({ page }) => {
    // Mock the Job-status poll endpoint to return succeeded immediately.
    await page.route('**/api/v1/admin/mail/blob-store/jobs/*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            jobName: 'stalwart-blob-store-update-abc12345',
            status: 'succeeded',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            podLogTail: '=== AFTER ===\n{"@type":"S3","id":"singleton","bucket":"x"}\nself-verify ok — actual=S3',
            failureReason: null,
          },
        }),
      });
    });

    await page.getByTestId('blob-store-radio-s3').check();
    await page.getByTestId('blob-store-s3-bucket').fill('my-bucket');
    await page.getByTestId('blob-store-s3-region').fill('us-east-1');
    await page.getByTestId('blob-store-s3-access').fill('AKIA');
    await page.getByTestId('blob-store-s3-secret').fill('secret');
    await page.getByTestId('blob-store-apply').click();
    await page.getByTestId('blob-store-migrate-confirm').fill('MIGRATE');
    await page.getByTestId('blob-store-confirm-submit').click();

    await expect(page.getByTestId('blob-store-job-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('blob-store-job-status')).toContainText('succeeded', { timeout: 10_000 });
    await expect(page.getByTestId('blob-store-job-log')).toContainText('self-verify ok', { timeout: 10_000 });
  });

  test('PATCH error renders inline ErrorPanel + leaves form intact', async ({ page }) => {
    await page.unroute('**/api/v1/admin/mail/blob-store');
    await page.route('**/api/v1/admin/mail/blob-store', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { id: 'singleton', type: 'Default', lastUpdatedAt: null } }),
        });
      } else if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'BLOB_STORE_JOB_CREATE_FAILED', message: 'simulated failure' },
          }),
        });
      }
    });

    await page.getByTestId('blob-store-radio-filesystem').check();
    await page.getByTestId('blob-store-apply').click();
    await page.getByTestId('blob-store-migrate-confirm').fill('MIGRATE');
    await page.getByTestId('blob-store-confirm-submit').click();

    // Modal stays open + shows error inline
    const modal = page.getByTestId('blob-store-confirm-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('simulated failure', { timeout: 10_000 });
  });

  test('cancel button closes modal without calling PATCH', async ({ page }) => {
    let patchCalled = false;
    await page.unroute('**/api/v1/admin/mail/blob-store');
    await page.route('**/api/v1/admin/mail/blob-store', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { id: 'singleton', type: 'Default', lastUpdatedAt: null } }),
        });
      } else if (route.request().method() === 'PATCH') {
        patchCalled = true;
        await route.fulfill({ status: 200, body: '{}' });
      }
    });

    await page.getByTestId('blob-store-radio-filesystem').check();
    await page.getByTestId('blob-store-apply').click();
    await page.getByTestId('blob-store-confirm-cancel').click();
    await expect(page.getByTestId('blob-store-confirm-modal')).not.toBeVisible({ timeout: 10_000 });
    expect(patchCalled).toBe(false);
  });
});
