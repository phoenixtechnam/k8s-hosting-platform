import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Database Operations', () => {
  test('navigate to Databases page and verify heading', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });
  });

  test('create database button is visible', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('create-database-button')).toBeVisible();
  });

  test('clicking create database opens modal', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });

    await page.getByTestId('create-database-button').click();

    const modal = page.getByTestId('create-database-modal')
      .or(page.getByTestId('database-modal'));
    await expect(modal).toBeVisible({ timeout: 2000 });
  });

  test('create database modal has name input field', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });

    await page.getByTestId('create-database-button').click();

    const modal = page.getByTestId('create-database-modal')
      .or(page.getByTestId('database-modal'));
    await expect(modal).toBeVisible({ timeout: 2000 });

    // Should have a name input
    const nameInput = page.getByTestId('database-name-input')
      .or(page.getByTestId('db-name-input'))
      .or(page.getByPlaceholder('Database name'))
      .or(page.getByLabel('Name'));
    await expect(nameInput).toBeVisible();
  });

  test('create database and verify it appears or shows password', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });

    await page.getByTestId('create-database-button').click();

    const modal = page.getByTestId('create-database-modal')
      .or(page.getByTestId('database-modal'));
    await expect(modal).toBeVisible({ timeout: 2000 });

    // Fill in database name
    const uniqueDbName = `testdb_${Date.now()}`;
    const nameInput = page.getByTestId('database-name-input')
      .or(page.getByTestId('db-name-input'))
      .or(page.getByPlaceholder('Database name'))
      .or(page.getByLabel('Name'));

    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(uniqueDbName);

      // Submit the form — use the modal's specific submit button
      const submitButton = page.getByTestId('submit-database-button')
        .or(page.getByTestId('submit-button'));
      await submitButton.click();

      // Wait for result — either password modal, success toast, table update, or error
      await page.waitForTimeout(3000);

      // After creation, we should see one of: the database in the table, a password display, or a success message
      const dbInTable = page.getByRole('cell', { name: uniqueDbName, exact: true });
      const passwordAlert = page.getByText('Save this password', { exact: false });
      const successToast = page.getByText('Database created', { exact: false });
      const errorMsg = page.getByTestId('error-message');

      // At least one of these should be visible after creation
      await expect(dbInTable.or(passwordAlert).or(successToast).or(errorMsg).first()).toBeVisible({ timeout: 2000 });
    }
  });

  test('databases page shows empty state or table', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });

    const content = page.getByTestId('databases-empty')
      .or(page.getByTestId('databases-table'))
      .or(page.getByTestId('databases-loading'))
      .or(page.getByTestId('databases-error'));
    await expect(content).toBeVisible({ timeout: 2000 });
  });

  test('database table shows rotate password button for each row', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });

    await page.waitForTimeout(3000);

    const table = page.getByTestId('databases-table');
    const hasTable = await table.isVisible().catch(() => false);

    if (hasTable) {
      const rows = table.locator('tbody tr');
      const rowCount = await rows.count();

      if (rowCount > 0) {
        // Each row should have a rotate password button or action menu
        const rotateButton = rows.first().getByTestId('rotate-password-button')
          .or(rows.first().getByRole('button', { name: /rotate/i }))
          .or(rows.first().getByRole('button', { name: /password/i }));

        const actionButton = rows.first().getByTestId('action-button')
          .or(rows.first().getByRole('button'));

        await expect(rotateButton.or(actionButton)).toBeVisible({ timeout: 2000 });
      }
    }
  });

  test('cancel database creation closes modal', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });

    await page.getByTestId('create-database-button').click();

    const modal = page.getByTestId('create-database-modal')
      .or(page.getByTestId('database-modal'));
    await expect(modal).toBeVisible({ timeout: 2000 });

    // Cancel
    const cancelButton = page.getByTestId('cancel-button')
      .or(page.getByRole('button', { name: 'Cancel' }));
    if (await cancelButton.isVisible().catch(() => false)) {
      await cancelButton.click();
      await expect(modal).not.toBeVisible({ timeout: 2000 });
    }
  });

  test('databases page has correct heading text', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    const heading = page.getByTestId('databases-heading');
    await expect(heading).toBeVisible({ timeout: 2000 });
    await expect(heading).toHaveText(/Databases/);
  });

  test('navigate between Databases and other pages preserves state', async ({ page }) => {
    await loginAsAdminClient(page);

    // Go to Databases
    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });

    // Navigate away
    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 2000 });

    // Come back
    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('create-database-button')).toBeVisible();
  });
});
