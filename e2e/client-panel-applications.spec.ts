import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Applications', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminClient(page);
    await page.getByRole('link', { name: 'Applications' }).click();
    await expect(page.getByTestId('applications-heading')).toBeVisible({ timeout: 2000 });
  });

  test('applications page loads with heading', async ({ page }) => {
    await expect(page.getByTestId('applications-heading')).toHaveText('Applications');
  });

  test('shows Available and Installed tabs', async ({ page }) => {
    await expect(page.getByTestId('tab-catalog')).toBeVisible();
    await expect(page.getByTestId('tab-installed')).toBeVisible();
  });

  test('can switch between tabs', async ({ page }) => {
    await page.getByTestId('tab-installed').click();
    await expect(page.getByTestId('tab-installed')).toBeVisible();

    await page.getByTestId('tab-catalog').click();
    await expect(page.getByTestId('tab-catalog')).toBeVisible();
  });
});
