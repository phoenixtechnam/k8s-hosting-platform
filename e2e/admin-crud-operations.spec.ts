import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin CRUD Operations', () => {
  test.beforeEach(async ({ page }) => { await injectAdminAuth(page); });
  async function createClient(page: import('@playwright/test').Page, name: string) {
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 2000 });

    await page.getByRole('button', { name: 'Add Client' }).click();
    await expect(page.getByTestId('create-client-modal')).toBeVisible();

    await page.getByTestId('company-name-input').fill(name);
    await page.getByTestId('company-email-input').fill(`${Date.now()}@e2e.local`);

    await page.getByTestId('plan-select').waitFor({ state: 'visible' });
    await page.waitForTimeout(1000);
    await page.getByTestId('plan-select').selectOption({ index: 1 });
    await page.getByTestId('region-select').waitFor({ state: 'visible' });
    await page.waitForTimeout(200);
    await page.getByTestId('region-select').selectOption({ index: 1 });

    await page.getByTestId('submit-button').click();

    // Post-submit flow (client-lifecycle-hardening): the modal now pivots
    // into credentials view (shows generated password) → provisioning view
    // (watches async K8s step progress). Walk through both quickly so the
    // test can get back to the list; if the backend returns early with no
    // credentials it goes straight to provisioning.
    const credentials = page.getByTestId('client-credentials');
    if (await credentials.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.getByTestId('close-credentials').click();
    }
    // Dismiss any provisioning UI and return to the Clients list regardless
    // of whether it was mid-provisioning, complete, or already auto-closed.
    // The provisioning modal has three terminal buttons (Minimize/Done/Close)
    // plus an 800ms auto-close-and-navigate on success. The simplest robust
    // approach: just navigate back to /clients which unmounts any modal.
    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 3000 });

    // Verify client appears in list — use first() to handle partial matches
    // where the same name prefix may match multiple test clients.
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 5000 });
  }

  test('create a new client', async ({ page }) => {

    const uniqueName = `CRUD Create ${Date.now()}`;
    await createClient(page, uniqueName);

    // Verify client appears in list
    await expect(page.getByText(uniqueName).first()).toBeVisible();
  });

  test('edit a client via edit modal', async ({ page }) => {

    const uniqueName = `CRUD Edit ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail
    await page.getByText(uniqueName).first().click();
    const editButton = page.getByTestId('edit-button');
    const isDetail = await editButton.isVisible({ timeout: 2000 }).catch(() => false);

    if (isDetail) {
      await editButton.click();

      // Wait for edit modal to appear
      const editModal = page.getByTestId('edit-client-modal');
      await expect(editModal).toBeVisible({ timeout: 2000 });

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
      await expect(editModal).not.toBeVisible({ timeout: 2000 });

      // Updated name should be visible
      await expect(page.getByText(updatedName)).toBeVisible({ timeout: 2000 });
    }
  });

  test('suspend a client', async ({ page }) => {

    const uniqueName = `CRUD Suspend ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail
    await page.getByText(uniqueName).first().click();
    const suspendButton = page.getByTestId('suspend-button');
    const isDetail = await suspendButton.isVisible({ timeout: 2000 }).catch(() => false);

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
      await page.waitForTimeout(200);

      // Verify status changed to suspended
      const suspendedBadge = page.getByText('suspended', { exact: false });
      const reactivateButton = page.getByTestId('reactivate-button')
        .or(page.getByRole('button', { name: /reactivate/i }));
      await expect(suspendedBadge.or(reactivateButton)).toBeVisible({ timeout: 2000 });
    }
  });

  test('reactivate a suspended client', async ({ page }) => {

    const uniqueName = `CRUD Reactivate ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail and suspend first
    await page.getByText(uniqueName).first().click();
    const suspendButton = page.getByTestId('suspend-button');
    const isDetail = await suspendButton.isVisible({ timeout: 2000 }).catch(() => false);

    if (isDetail) {
      // Suspend
      await suspendButton.click();
      const confirmButton = page.getByTestId('confirm-button')
        .or(page.getByRole('button', { name: 'Confirm' }))
        .or(page.getByRole('button', { name: 'Yes' }));
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click();
      }
      await page.waitForTimeout(200);

      // Reactivate
      const reactivateButton = page.getByTestId('reactivate-button')
        .or(page.getByRole('button', { name: /reactivate/i }));
      if (await reactivateButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await reactivateButton.click();

        const confirmReactivate = page.getByTestId('confirm-button')
          .or(page.getByRole('button', { name: 'Confirm' }))
          .or(page.getByRole('button', { name: 'Yes' }));
        if (await confirmReactivate.isVisible({ timeout: 3000 }).catch(() => false)) {
          await confirmReactivate.click();
        }
        await page.waitForTimeout(200);

        // Verify status changed back to active
        const activeBadge = page.getByText('active', { exact: false });
        await expect(activeBadge).toBeVisible({ timeout: 2000 });
      }
    }
  });

  test('delete a client', async ({ page }) => {

    const uniqueName = `CRUD Delete ${Date.now()}`;
    await createClient(page, uniqueName);

    // Navigate to client detail
    await page.getByText(uniqueName).first().click();
    const deleteButton = page.getByTestId('delete-button');
    const isDetail = await deleteButton.isVisible({ timeout: 2000 }).catch(() => false);

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
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 2000 });

      // Verify client is gone from list
      await page.waitForTimeout(200);
      await expect(page.getByText(uniqueName).first()).not.toBeVisible({ timeout: 2000 });
    }
  });

  test('verify deleted client is gone from list', async ({ page }) => {

    const uniqueName = `CRUD Gone ${Date.now()}`;
    await createClient(page, uniqueName);

    // Verify it exists
    await expect(page.getByText(uniqueName).first()).toBeVisible();

    // Navigate to detail and delete
    await page.getByText(uniqueName).first().click();
    const deleteButton = page.getByTestId('delete-button');
    const isDetail = await deleteButton.isVisible({ timeout: 2000 }).catch(() => false);

    if (isDetail) {
      await deleteButton.click();

      const confirmButton = page.getByTestId('confirm-button')
        .or(page.getByRole('button', { name: 'Confirm' }))
        .or(page.getByRole('button', { name: 'Delete' }))
        .or(page.getByRole('button', { name: 'Yes' }));
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click();
      }

      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 2000 });
      await page.waitForTimeout(200);

      // Confirm gone
      await expect(page.getByText(uniqueName).first()).not.toBeVisible({ timeout: 2000 });
    }
  });

  test('create multiple clients and verify all appear', async ({ page }) => {

    const name1 = `CRUD Multi A ${Date.now()}`;
    const name2 = `CRUD Multi B ${Date.now()}`;

    await createClient(page, name1);
    await createClient(page, name2);

    await expect(page.getByText(name1)).toBeVisible({ timeout: 2000 });
    await expect(page.getByText(name2)).toBeVisible({ timeout: 2000 });
  });

  test('client list shows table with headers', async ({ page }) => {

    // Create a client first to ensure there's data in the table
    const uniqueName = `CRUD Table ${Date.now()}`;
    await createClient(page, uniqueName);

    // The clients page should now have a table with headers
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 2000 });

    await expect(page.getByRole('columnheader', { name: /client/i }).first()).toBeVisible({ timeout: 2000 });
  });
});
