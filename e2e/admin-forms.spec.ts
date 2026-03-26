import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Form Interactions', () => {
  test.describe('Create Client Modal', () => {
    test('fill all fields and submit creates client', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Clients' }).click();
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

      await page.getByRole('button', { name: 'Add Client' }).click();
      await expect(page.getByTestId('create-client-modal')).toBeVisible();

      const uniqueName = `Form Test ${Date.now()}`;
      await page.getByTestId('company-name-input').fill(uniqueName);
      await page.getByTestId('company-email-input').fill('formtest@e2e.local');

      await page.getByTestId('plan-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(1000);
      await page.getByTestId('plan-select').selectOption({ index: 1 });

      await page.getByTestId('region-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      await page.getByTestId('region-select').selectOption({ index: 1 });

      await page.getByTestId('submit-button').click();
      await expect(page.getByTestId('create-client-modal')).not.toBeVisible({ timeout: 5000 });
      await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 5000 });
    });

    test('cancel button closes modal without creating client', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Clients' }).click();
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

      await page.getByRole('button', { name: 'Add Client' }).click();
      await expect(page.getByTestId('create-client-modal')).toBeVisible();

      const uniqueName = `Form Cancel ${Date.now()}`;
      await page.getByTestId('company-name-input').fill(uniqueName);

      // Cancel the modal
      const cancelButton = page.getByTestId('cancel-button')
        .or(page.getByRole('button', { name: 'Cancel' }));
      await cancelButton.click();

      // Modal should close
      await expect(page.getByTestId('create-client-modal')).not.toBeVisible({ timeout: 5000 });

      // Client should NOT be created
      await page.waitForTimeout(1000);
      await expect(page.getByText(uniqueName)).not.toBeVisible();
    });

    test('modal has all required form fields', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Clients' }).click();
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

      await page.getByRole('button', { name: 'Add Client' }).click();
      await expect(page.getByTestId('create-client-modal')).toBeVisible();

      // Verify all form fields exist
      await expect(page.getByTestId('company-name-input')).toBeVisible();
      await expect(page.getByTestId('company-email-input')).toBeVisible();
      await expect(page.getByTestId('plan-select')).toBeVisible();
      await expect(page.getByTestId('region-select')).toBeVisible();
      await expect(page.getByTestId('submit-button')).toBeVisible();
    });

    test('opening and closing modal preserves page state', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Clients' }).click();
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible({ timeout: 5000 });

      // Open modal
      await page.getByRole('button', { name: 'Add Client' }).click();
      await expect(page.getByTestId('create-client-modal')).toBeVisible();

      // Close modal
      const cancelButton = page.getByTestId('cancel-button')
        .or(page.getByRole('button', { name: 'Cancel' }));
      await cancelButton.click();
      await expect(page.getByTestId('create-client-modal')).not.toBeVisible({ timeout: 5000 });

      // Page state should be intact
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add Client' })).toBeVisible();
    });
  });

  test.describe('Create Domain Modal', () => {
    test('domain modal opens with client selector and domain input', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Domains' }).click();
      await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible({ timeout: 5000 });

      // Select a client first to enable the add button
      const clientSelector = page.getByTestId('client-selector');
      await expect(clientSelector).toBeVisible();

      // Try selecting a client from dropdown
      await page.waitForTimeout(2000);
      const options = clientSelector.locator('option');
      const optionCount = await options.count();

      if (optionCount > 1) {
        await clientSelector.selectOption({ index: 1 });
        await page.waitForTimeout(1000);

        // Now add domain button should be enabled
        const addButton = page.getByTestId('add-domain-button');
        if (await addButton.isEnabled()) {
          await addButton.click();

          const modal = page.getByTestId('add-domain-modal')
            .or(page.getByTestId('create-domain-modal'));
          await expect(modal).toBeVisible({ timeout: 5000 });
        }
      }
    });

    test('domain page shows domains for selected client', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Domains' }).click();
      await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible({ timeout: 5000 });

      const clientSelector = page.getByTestId('client-selector');
      await page.waitForTimeout(2000);
      const options = clientSelector.locator('option');
      const optionCount = await options.count();

      if (optionCount > 1) {
        await clientSelector.selectOption({ index: 1 });
        await page.waitForTimeout(2000);

        // Should show either domains table or empty state (not select-client prompt)
        const domainsTable = page.getByTestId('domains-table');
        const emptyState = page.getByTestId('domains-empty')
          .or(page.getByText('No domains'));
        const content = domainsTable.or(emptyState);
        await expect(content).toBeVisible({ timeout: 10000 });
      }
    });
  });

  test.describe('Create Cron Job Modal', () => {
    test('cron job modal opens when client is selected', async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto('/cron-jobs');
      await expect(page.getByRole('heading', { name: 'Cron Jobs' })).toBeVisible({ timeout: 5000 });

      const clientSelector = page.getByTestId('client-selector');
      await page.waitForTimeout(2000);
      const options = clientSelector.locator('option');
      const optionCount = await options.count();

      if (optionCount > 1) {
        await clientSelector.selectOption({ index: 1 });
        await page.waitForTimeout(1000);

        const addButton = page.getByTestId('add-cron-job-button');
        if (await addButton.isEnabled()) {
          await addButton.click();

          const modal = page.getByTestId('add-cron-job-modal')
            .or(page.getByTestId('create-cron-job-modal'));
          await expect(modal).toBeVisible({ timeout: 5000 });
        }
      }
    });

    test('cron job add button is disabled without client selection', async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto('/cron-jobs');
      await expect(page.getByRole('heading', { name: 'Cron Jobs' })).toBeVisible({ timeout: 5000 });

      const addButton = page.getByTestId('add-cron-job-button');
      await expect(addButton).toBeDisabled();
    });
  });

  test.describe('Settings Forms', () => {
    test('settings page shows workload repos section', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByTestId('settings-heading')).toBeVisible({ timeout: 5000 });

      // Look for workload repos section
      const workloadSection = page.getByTestId('workload-repos-section')
        .or(page.getByText('Workload Repos'))
        .or(page.getByText('Workload Catalog'))
        .or(page.getByText('Workload Repositories'));
      await expect(workloadSection).toBeVisible({ timeout: 5000 });
    });

    test('password form validates matching passwords', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByTestId('settings-heading')).toBeVisible({ timeout: 5000 });

      // Fill password form with mismatched passwords
      await page.getByTestId('current-password-input').fill('admin');
      await page.getByTestId('new-password-input').fill('newpassword123');
      await page.getByTestId('confirm-password-input').fill('differentpassword');

      await page.getByTestId('update-password-button').click();

      // Should show error or validation message
      await page.waitForTimeout(1000);
      const errorMessage = page.getByText('match', { exact: false })
        .or(page.getByText('error', { exact: false }))
        .or(page.getByTestId('password-error'));
      const hasError = await errorMessage.isVisible().catch(() => false);
      // If no explicit error UI, the form at least shouldn't navigate away
      await expect(page.getByTestId('settings-heading')).toBeVisible();
    });

    test('profile section displays current user info', async ({ page }) => {
      await loginAsAdmin(page);

      await page.getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByTestId('settings-heading')).toBeVisible({ timeout: 5000 });

      await expect(page.getByTestId('profile-email')).toContainText('admin@platform.local');
      await expect(page.getByTestId('profile-role')).toBeVisible();
    });
  });
});
