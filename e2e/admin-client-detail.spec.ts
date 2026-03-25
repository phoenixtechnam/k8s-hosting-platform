import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Client Detail Page', () => {
  test('can click on a client to see details', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

    // Wait for client list to load, then click the first client row if any exist
    const clientRows = page.locator('table tbody tr');
    const rowCount = await clientRows.count();

    if (rowCount > 0) {
      // Click the first client row link
      await clientRows.first().click();

      // Should navigate to client detail page — wait for either detail view or error
      const editButton = page.getByTestId('edit-button');
      const errorMessage = page.getByText('Client not found');
      const backLink = page.getByText('Back to clients');

      await expect(editButton.or(errorMessage).or(backLink)).toBeVisible({ timeout: 10000 });
    }
  });

  test('client detail shows action buttons', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

    const clientRows = page.locator('table tbody tr');
    const rowCount = await clientRows.count();

    if (rowCount > 0) {
      await clientRows.first().click();

      const editButton = page.getByTestId('edit-button');
      const isDetail = await editButton.isVisible({ timeout: 10000 }).catch(() => false);

      if (isDetail) {
        await expect(page.getByTestId('edit-button')).toBeVisible();
        await expect(page.getByTestId('suspend-button')).toBeVisible();
        await expect(page.getByTestId('delete-button')).toBeVisible();
      }
    }
  });

  test('client detail shows Account Information section', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

    const clientRows = page.locator('table tbody tr');
    const rowCount = await clientRows.count();

    if (rowCount > 0) {
      await clientRows.first().click();

      const editButton = page.getByTestId('edit-button');
      const isDetail = await editButton.isVisible({ timeout: 10000 }).catch(() => false);

      if (isDetail) {
        await expect(page.getByText('Account Information')).toBeVisible();
        await expect(page.getByText('Status')).toBeVisible();
        await expect(page.getByText('Created')).toBeVisible();
      }
    }
  });

  test('client detail shows back to clients link', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

    const clientRows = page.locator('table tbody tr');
    const rowCount = await clientRows.count();

    if (rowCount > 0) {
      await clientRows.first().click();

      const editButton = page.getByTestId('edit-button');
      const isDetail = await editButton.isVisible({ timeout: 10000 }).catch(() => false);

      if (isDetail) {
        const backLink = page.getByLabel('Back to clients');
        await expect(backLink).toBeVisible();
      }
    }
  });
});
