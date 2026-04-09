import { test, expect } from '@playwright/test';
import path from 'path';
import { injectAdminAuth } from './helpers';

const CLIENT_ID = 'd15b6d68-4fdb-4ed1-84cc-f8035596f289';
const CLIENT_DETAIL_URL = `/clients/${CLIENT_ID}`;
const ARTIFACTS_DIR = path.join(__dirname, '..', 'test-artifacts');

test.describe('Admin Panel — Client Users Tab (Phase 5)', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto(CLIENT_DETAIL_URL);
    // Wait for the page to settle — the client detail page has multiple tabs
    await expect(page.getByTestId('resource-tabs')).toBeVisible({ timeout: 5000 });
  });

  test('Users tab is present in the tab bar and navigates to the users view', async ({ page }) => {
    const usersTabBtn = page.getByTestId('tab-users');
    await expect(usersTabBtn).toBeVisible();
    await expect(usersTabBtn).toContainText('Users');

    await usersTabBtn.click();

    // The ClientUsersTab wrapper must appear
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-tab-loaded.png'),
      fullPage: false,
    });
  });

  test('users table renders with existing users', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    // The client has 3+ users from prior phase testing — table must be visible
    const table = page.getByTestId('client-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    // At least one row should exist in tbody
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-table-populated.png'),
      fullPage: false,
    });
  });

  test('Add User button is visible on the Users tab', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    const addButton = page.getByTestId('client-users-add-button');
    await expect(addButton).toBeVisible();
    await expect(addButton).toContainText('Add User');
  });

  test('clicking Add User opens the create form with all required fields', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    await page.getByTestId('client-users-add-button').click();

    const form = page.getByTestId('client-users-create-form');
    await expect(form).toBeVisible({ timeout: 2000 });

    // All required inputs must be present
    await expect(page.getByTestId('client-users-name-input')).toBeVisible();
    await expect(page.getByTestId('client-users-email-input')).toBeVisible();
    await expect(page.getByTestId('client-users-password-input')).toBeVisible();
    await expect(page.getByTestId('client-users-role-select')).toBeVisible();
    await expect(page.getByTestId('client-users-submit')).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-create-form-open.png'),
      fullPage: false,
    });
  });

  test('clicking the Add User toggle button again (Cancel) closes the create form', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    // Open the form
    await page.getByTestId('client-users-add-button').click();
    await expect(page.getByTestId('client-users-create-form')).toBeVisible({ timeout: 2000 });

    // The button now acts as a Cancel toggle — clicking it again closes the form
    await page.getByTestId('client-users-add-button').click();
    await expect(page.getByTestId('client-users-create-form')).not.toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-create-form-closed.png'),
      fullPage: false,
    });
  });

  test('edit button on first user opens the edit modal with pre-filled name', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    // Wait for the table to be populated
    const table = page.getByTestId('client-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    // Get the id from the first edit button via its data-testid attribute
    const firstEditBtn = table.locator('[data-testid^="client-users-edit-"]').first();
    await expect(firstEditBtn).toBeVisible();

    // Read the user's name from the table row for cross-check
    const firstRow = table.locator('tbody tr').first();
    const userName = await firstRow.locator('td').first().textContent();

    await firstEditBtn.click();

    const editModal = page.getByTestId('client-users-edit-modal');
    await expect(editModal).toBeVisible({ timeout: 2000 });

    // The name input should be pre-filled with the user's current name
    const nameInput = page.getByTestId('client-users-edit-name-input');
    await expect(nameInput).toBeVisible();
    if (userName) {
      await expect(nameInput).toHaveValue(userName.trim());
    }

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-edit-modal-open.png'),
      fullPage: false,
    });
  });

  test('Cancel button in the edit modal closes it without submitting', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('client-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    await table.locator('[data-testid^="client-users-edit-"]').first().click();
    const editModal = page.getByTestId('client-users-edit-modal');
    await expect(editModal).toBeVisible({ timeout: 2000 });

    // Click Cancel inside the modal (the button labelled "Cancel")
    await editModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(editModal).not.toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-edit-modal-closed.png'),
      fullPage: false,
    });
  });

  test('reset password button opens the reset modal for the correct user', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('client-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    const firstResetBtn = table.locator('[data-testid^="client-users-reset-"]').first();
    await expect(firstResetBtn).toBeVisible();
    await firstResetBtn.click();

    const resetModal = page.getByTestId('client-users-reset-modal');
    await expect(resetModal).toBeVisible({ timeout: 2000 });

    // Modal should contain the password inputs
    await expect(page.getByTestId('client-users-reset-new-input')).toBeVisible();
    await expect(page.getByTestId('client-users-reset-confirm-input')).toBeVisible();
    await expect(page.getByTestId('client-users-reset-save')).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-reset-modal-open.png'),
      fullPage: false,
    });
  });

  test('Cancel button in the reset modal closes it without submitting', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('client-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    await table.locator('[data-testid^="client-users-reset-"]').first().click();
    const resetModal = page.getByTestId('client-users-reset-modal');
    await expect(resetModal).toBeVisible({ timeout: 2000 });

    await resetModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(resetModal).not.toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'client-users-reset-modal-closed.png'),
      fullPage: false,
    });
  });

  test('each table row shows edit, reset-password, toggle, and delete action buttons', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('client-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('client-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    const firstRow = table.locator('tbody tr').first();
    const editBtn = firstRow.locator('[data-testid^="client-users-edit-"]');
    const resetBtn = firstRow.locator('[data-testid^="client-users-reset-"]');
    const toggleBtn = firstRow.locator('[data-testid^="client-users-toggle-"]');
    const deleteBtn = firstRow.locator('[data-testid^="client-users-delete-"]');

    await expect(editBtn).toBeVisible();
    await expect(resetBtn).toBeVisible();
    await expect(toggleBtn).toBeVisible();
    await expect(deleteBtn).toBeVisible();
  });
});
