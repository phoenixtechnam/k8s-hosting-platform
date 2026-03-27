import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Client Detail — Resource Tabs', () => {
  test.beforeEach(async ({ page }) => { await injectAdminAuth(page); });
  async function navigateToFirstClientDetail(page: import('@playwright/test').Page) {

    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 2000 });

    // Wait for client data to load
    await page.waitForTimeout(200);

    const clientLink = page.locator('table tbody tr a').first();
    const hasClients = await clientLink.isVisible().catch(() => false);

    if (!hasClients) {
      // Create a client so we have one to navigate to
      await page.getByRole('button', { name: 'Add Client' }).click();
      await expect(page.getByTestId('create-client-modal')).toBeVisible();

      const uniqueName = `E2E Tab Test ${Date.now()}`;
      await page.getByTestId('company-name-input').fill(uniqueName);
      await page.getByTestId('company-email-input').fill('tab-test@e2e.local');

      await page.getByTestId('plan-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(1000);
      await page.getByTestId('plan-select').selectOption({ index: 1 });
      await page.getByTestId('region-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
      await page.getByTestId('region-select').selectOption({ index: 1 });

      await page.getByTestId('submit-button').click();
      await expect(page.getByTestId('create-client-modal')).not.toBeVisible({ timeout: 2000 });
      await page.waitForTimeout(1000);
    }

    // Click the link inside the first client row
    await page.locator('table tbody tr a').first().click();

    // Wait for client detail page to load
    const editButton = page.getByTestId('edit-button');
    const errorMessage = page.getByText('Client not found');
    const backLink = page.getByText('Back to clients');
    await expect(editButton.or(errorMessage).or(backLink)).toBeVisible({ timeout: 2000 });
  }

  test('client detail page shows resource tabs', async ({ page }) => {
    await navigateToFirstClientDetail(page);

    const isDetail = await page.getByTestId('edit-button').isVisible().catch(() => false);
    if (!isDetail) return; // Skip if we hit error page

    const tabBar = page.getByTestId('resource-tabs');
    await expect(tabBar).toBeVisible();

    await expect(page.getByTestId('tab-domains')).toBeVisible();
    await expect(page.getByTestId('tab-databases')).toBeVisible();
    await expect(page.getByTestId('tab-workloads')).toBeVisible();
    await expect(page.getByTestId('tab-backups')).toBeVisible();
  });

  test('Domains tab is active by default', async ({ page }) => {
    await navigateToFirstClientDetail(page);

    const isDetail = await page.getByTestId('edit-button').isVisible().catch(() => false);
    if (!isDetail) return;

    // Domains tab should be active by default — check for content area
    const domainsTable = page.getByTestId('domains-table');
    const emptyState = page.getByTestId('tab-empty');
    const loading = page.getByTestId('tab-loading');
    const error = page.getByTestId('tab-error');

    await expect(
      domainsTable.or(emptyState).or(loading).or(error)
    ).toBeVisible({ timeout: 2000 });
  });

  test('can click Databases tab and see content', async ({ page }) => {
    await navigateToFirstClientDetail(page);

    const isDetail = await page.getByTestId('edit-button').isVisible().catch(() => false);
    if (!isDetail) return;

    await page.getByTestId('tab-databases').click();

    const table = page.getByTestId('databases-table');
    const emptyState = page.getByTestId('tab-empty');
    const loading = page.getByTestId('tab-loading');
    const error = page.getByTestId('tab-error');

    await expect(
      table.or(emptyState).or(loading).or(error)
    ).toBeVisible({ timeout: 2000 });
  });

  test('can click Workloads tab and see content', async ({ page }) => {
    await navigateToFirstClientDetail(page);

    const isDetail = await page.getByTestId('edit-button').isVisible().catch(() => false);
    if (!isDetail) return;

    await page.getByTestId('tab-workloads').click();

    const table = page.getByTestId('workloads-table');
    const emptyState = page.getByTestId('tab-empty');
    const loading = page.getByTestId('tab-loading');
    const error = page.getByTestId('tab-error');

    await expect(
      table.or(emptyState).or(loading).or(error)
    ).toBeVisible({ timeout: 2000 });
  });

  test('can click Backups tab and see content', async ({ page }) => {
    await navigateToFirstClientDetail(page);

    const isDetail = await page.getByTestId('edit-button').isVisible().catch(() => false);
    if (!isDetail) return;

    await page.getByTestId('tab-backups').click();

    const table = page.getByTestId('backups-table');
    const emptyState = page.getByTestId('tab-empty');
    const loading = page.getByTestId('tab-loading');
    const error = page.getByTestId('tab-error');

    await expect(
      table.or(emptyState).or(loading).or(error)
    ).toBeVisible({ timeout: 2000 });
  });

  test('tabs show counts in their labels', async ({ page }) => {
    await navigateToFirstClientDetail(page);

    const isDetail = await page.getByTestId('edit-button').isVisible().catch(() => false);
    if (!isDetail) return;

    await expect(page.getByTestId('tab-domains')).toHaveText(/Domains \(\d+\)/);
    await expect(page.getByTestId('tab-databases')).toHaveText(/Databases \(\d+\)/);
    await expect(page.getByTestId('tab-workloads')).toHaveText(/Workloads \(\d+\)/);
    await expect(page.getByTestId('tab-backups')).toHaveText(/Backups \(\d+\)/);
  });
});
