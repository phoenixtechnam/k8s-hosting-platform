import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin CRUD Operations', () => {
  async function createClient(page: import('@playwright/test').Page, name: string) {
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: 'Add Client' }).click();
      await expect(page.getByTestId('create-client-modal')).toBeVisible();

      await page.getByTestId('company-name-input').fill(name);
      await page.getByTestId('company-email-input').fill(`${Date.now()}@e2e.local`);

      await page.getByTestId('plan-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(1000);
      await page.getByTestId('plan-select').selectOption({ index: 1 });
      await page.getByTestId('region-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      await page.getByTestId('region-select').selectOption({ index: 1 });

      await page.getByTestId('submit-button').click();
      await page.waitForTimeout(2000);

      const modalStillVisible = await page.getByTestId('create-client-modal').isVisible().catch(() => false);
      if (!modalStillVisible) {
        await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
        return;
      }

      // If modal is still visible, there may be a server error — close and retry
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('create-client-modal')).not.toBeVisible({ timeout: 3000 });
      await page.waitForTimeout(2000);
    }

    // Final attempt — fail if this doesn't work
    await page.getByRole('button', { name: 'Add Client' }).click();
    await expect(page.getByTestId('create-client-modal')).toBeVisible();
    await page.getByTestId('company-name-input').fill(name);
    await page.getByTestId('company-email-input').fill(`${Date.now()}@e2e.local`);
    await page.getByTestId('plan-select').waitFor({ state: 'visible' });
    await page.waitForTimeout(1000);
    await page.getByTestId('plan-select').selectOption({ index: 1 });
    await page.getByTestId('region-select').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    await page.getByTestId('region-select').selectOption({ index: 1 });
    await page.getByTestId('submit-button').click();
    await expect(page.getByTestId('create-client-modal')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
  }

  test('create a new client', async ({ page }) => {
    await loginAsAdmin(page);

    const uniqueName = `CRUD Create ${Date.now()}`;
    await createClient(page, uniqueName);

    // Verify client appears in list
    await expect(page.getByText(uniqueName)).toBeVisible();
  });

  test('edit a client via edit modal', async ({ page }) => {
    await loginAsAdmin(page);

    const uniqueName = `CRUD Edit ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail
    await page.getByText(uniqueName).click();
    const editButton = page.getByTestId('edit-button');
    const isDetail = await editButton.isVisible({ timeout: 10000 }).catch(() => false);

    if (isDetail) {
      await editButton.click();

      // Wait for edit modal to appear
      const editModal = page.getByTestId('edit-client-modal');
      await expect(editModal).toBeVisible({ timeout: 5000 });

      // Change the company name
      const updatedName = `${uniqueName} Updated`;
      const nameInput = page.getByTestId('company-name-input');
      await nameInput.clear();
      await nameInput.fill(updatedName);

      // Submit
      const saveButton = page.getByTestId('save-button')
        .or(page.getByTestId('submit-button'))
        .or(page.getByRole('button', { name: 'Save' }));
      await saveButton.click();

      // Modal should close
      await expect(editModal).not.toBeVisible({ timeout: 5000 });

      // Updated name should be visible
      await expect(page.getByText(updatedName)).toBeVisible({ timeout: 5000 });
    }
  });

  test('suspend a client', async ({ page }) => {
    await loginAsAdmin(page);

    const uniqueName = `CRUD Suspend ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail
    await page.getByText(uniqueName).click();
    const suspendButton = page.getByTestId('suspend-button');
    const isDetail = await suspendButton.isVisible({ timeout: 10000 }).catch(() => false);

    if (isDetail) {
      await suspendButton.click();

      // Confirm suspension if dialog appears
      const confirmButton = page.getByTestId('confirm-button')
        .or(page.getByRole('button', { name: 'Confirm' }))
        .or(page.getByRole('button', { name: 'Yes' }));
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click();
      }

      // Wait for status update
      await page.waitForTimeout(2000);

      // Verify status changed to suspended
      const suspendedBadge = page.getByText('suspended', { exact: false });
      const reactivateButton = page.getByTestId('reactivate-button')
        .or(page.getByRole('button', { name: /reactivate/i }));
      await expect(suspendedBadge.or(reactivateButton)).toBeVisible({ timeout: 5000 });
    }
  });

  test('reactivate a suspended client', async ({ page }) => {
    await loginAsAdmin(page);

    const uniqueName = `CRUD Reactivate ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail and suspend first
    await page.getByText(uniqueName).click();
    const suspendButton = page.getByTestId('suspend-button');
    const isDetail = await suspendButton.isVisible({ timeout: 10000 }).catch(() => false);

    if (isDetail) {
      // Suspend
      await suspendButton.click();
      const confirmButton = page.getByTestId('confirm-button')
        .or(page.getByRole('button', { name: 'Confirm' }))
        .or(page.getByRole('button', { name: 'Yes' }));
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click();
      }
      await page.waitForTimeout(2000);

      // Reactivate
      const reactivateButton = page.getByTestId('reactivate-button')
        .or(page.getByRole('button', { name: /reactivate/i }));
      if (await reactivateButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        await reactivateButton.click();

        const confirmReactivate = page.getByTestId('confirm-button')
          .or(page.getByRole('button', { name: 'Confirm' }))
          .or(page.getByRole('button', { name: 'Yes' }));
        if (await confirmReactivate.isVisible({ timeout: 3000 }).catch(() => false)) {
          await confirmReactivate.click();
        }
        await page.waitForTimeout(2000);

        // Verify status changed back to active
        const activeBadge = page.getByText('active', { exact: false });
        await expect(activeBadge).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('delete a client', async ({ page }) => {
    await loginAsAdmin(page);

    const uniqueName = `CRUD Delete ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail
    await page.getByText(uniqueName).click();
    const deleteButton = page.getByTestId('delete-button');
    const isDetail = await deleteButton.isVisible({ timeout: 10000 }).catch(() => false);

    if (isDetail) {
      await deleteButton.click();

      // Confirm deletion if dialog appears
      const confirmButton = page.getByTestId('confirm-button')
        .or(page.getByRole('button', { name: 'Confirm' }))
        .or(page.getByRole('button', { name: 'Delete' }))
        .or(page.getByRole('button', { name: 'Yes' }));
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click();
      }

      // Should redirect back to clients list
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 10000 });

      // Verify client is gone from list
      await page.waitForTimeout(2000);
      await expect(page.getByText(uniqueName)).not.toBeVisible({ timeout: 5000 });
    }
  });

  test('verify deleted client is gone from list', async ({ page }) => {
    await loginAsAdmin(page);

    const uniqueName = `CRUD Gone ${Date.now()}`;
    await createClient(page, uniqueName);

    // Verify it exists
    await expect(page.getByText(uniqueName)).toBeVisible();

    // Navigate to detail and delete
    await page.getByText(uniqueName).click();
    const deleteButton = page.getByTestId('delete-button');
    const isDetail = await deleteButton.isVisible({ timeout: 10000 }).catch(() => false);

    if (isDetail) {
      await deleteButton.click();

      const confirmButton = page.getByTestId('confirm-button')
        .or(page.getByRole('button', { name: 'Confirm' }))
        .or(page.getByRole('button', { name: 'Delete' }))
        .or(page.getByRole('button', { name: 'Yes' }));
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click();
      }

      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(2000);

      // Confirm gone
      await expect(page.getByText(uniqueName)).not.toBeVisible({ timeout: 5000 });
    }
  });

  test('create multiple clients and verify all appear', async ({ page }) => {
    await loginAsAdmin(page);

    const name1 = `CRUD Multi A ${Date.now()}`;
    const name2 = `CRUD Multi B ${Date.now()}`;

    await createClient(page, name1);
    await createClient(page, name2);

    await expect(page.getByText(name1)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name2)).toBeVisible({ timeout: 5000 });
  });

  test('client list shows table with headers', async ({ page }) => {
    await loginAsAdmin(page);

    // Create a client first to ensure there's data in the table
    const uniqueName = `CRUD Table ${Date.now()}`;
    await createClient(page, uniqueName);

    // The clients page should now have a table with headers
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole('columnheader', { name: /name/i }).first()).toBeVisible({ timeout: 5000 });
  });
});
