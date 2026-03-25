import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Domains Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible({ timeout: 5000 });
  });

  test('domains page loads after login', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible();
    await expect(page.getByTestId('add-domain-button')).toBeVisible();
  });

  test('shows client selector dropdown', async ({ page }) => {
    const selector = page.getByTestId('client-selector');
    await expect(selector).toBeVisible();
    await expect(selector).toBeEnabled();
  });

  test('shows "Select a client" prompt when no client selected', async ({ page }) => {
    await expect(page.getByTestId('select-client-prompt')).toBeVisible();
    await expect(page.getByTestId('select-client-prompt')).toContainText('Select a client');
  });

  test('search input is present', async ({ page }) => {
    const searchInput = page.getByTestId('domain-search');
    await expect(searchInput).toBeVisible();
  });

  test('add domain button is disabled when no client selected', async ({ page }) => {
    const addButton = page.getByTestId('add-domain-button');
    await expect(addButton).toBeVisible();
    await expect(addButton).toBeDisabled();
  });
});
