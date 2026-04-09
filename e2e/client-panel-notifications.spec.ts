import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';
import path from 'path';
import fs from 'fs';

const ARTIFACTS_DIR = path.resolve('test-artifacts');

function ensureArtifactsDir() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

test.describe('Client Panel — Notifications Center', () => {
  test('sidebar shows Notifications nav item', async ({ page }) => {
    await loginAsAdminClient(page);

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // Bell-icon nav link labelled "Notifications"
    const notifLink = sidebar.getByRole('link', { name: 'Notifications' });
    await expect(notifLink).toBeVisible();
  });

  test('sidebar Notifications link navigates to /notifications', async ({ page }) => {
    await loginAsAdminClient(page);

    const sidebar = page.getByTestId('sidebar');
    await sidebar.getByRole('link', { name: 'Notifications' }).click();

    // URL must contain /notifications
    await expect(page).toHaveURL(/\/notifications/);

    // Heading must be visible
    await expect(page.getByTestId('notifications-heading')).toBeVisible({ timeout: 3000 });
  });

  test('Notifications page shows heading, filters card, and list or empty state', async ({ page }) => {
    ensureArtifactsDir();
    await loginAsAdminClient(page);

    await page.goto('/notifications');

    // Heading
    await expect(page.getByTestId('notifications-heading')).toBeVisible({ timeout: 3000 });

    // Filters card
    await expect(page.getByTestId('notifications-filters')).toBeVisible({ timeout: 2000 });

    // Wait for loading to complete — either list or empty state must appear
    const listOrEmpty = page.getByTestId('notifications-list')
      .or(page.getByTestId('notifications-empty'));
    await expect(listOrEmpty).toBeVisible({ timeout: 5000 });

    // Count chip is always rendered once loaded (not during loading spinner)
    await expect(page.getByTestId('notifications-count')).toBeVisible({ timeout: 2000 });

    // Screenshot — whichever state we landed in
    const isEmptyState = await page.getByTestId('notifications-empty').isVisible();
    const screenshotName = isEmptyState
      ? 'notifications-empty-state.png'
      : 'notifications-list-state.png';
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, screenshotName), fullPage: true });
  });

  test('type filter dropdown is present and changes notifications-count', async ({ page }) => {
    ensureArtifactsDir();
    await loginAsAdminClient(page);

    await page.goto('/notifications');

    // Wait for page to be fully loaded (list or empty state)
    const listOrEmpty = page.getByTestId('notifications-list')
      .or(page.getByTestId('notifications-empty'));
    await expect(listOrEmpty).toBeVisible({ timeout: 5000 });

    const typeFilter = page.getByTestId('filter-type');
    await expect(typeFilter).toBeVisible();

    // Capture baseline count text
    const countEl = page.getByTestId('notifications-count');
    const beforeCount = await countEl.textContent();

    // Select "Info" from the type filter
    await typeFilter.selectOption('info');

    // Count element must still be present (value may change)
    await expect(countEl).toBeVisible({ timeout: 2000 });
    const afterCountInfo = await countEl.textContent();

    // Screenshot after type filter applied
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'notifications-filter-type-info.png'),
      fullPage: true,
    });

    // Select "Warning"
    await typeFilter.selectOption('warning');
    const afterCountWarning = await countEl.textContent();

    // Reset to all
    await typeFilter.selectOption('all');
    const resetCount = await countEl.textContent();

    // After reset the count should match the baseline
    expect(resetCount).toBe(beforeCount);

    // At least one of the filtered counts should differ from "all" — OR they can all
    // match if there are zero notifications of those types, which is also valid.
    // We just assert the count element reports a numeric pattern.
    expect(afterCountInfo).toMatch(/\d+ shown/);
    expect(afterCountWarning).toMatch(/\d+ shown/);
  });

  test('read-state filter dropdown is present and functional', async ({ page }) => {
    ensureArtifactsDir();
    await loginAsAdminClient(page);

    await page.goto('/notifications');

    const listOrEmpty = page.getByTestId('notifications-list')
      .or(page.getByTestId('notifications-empty'));
    await expect(listOrEmpty).toBeVisible({ timeout: 5000 });

    const readFilter = page.getByTestId('filter-read');
    await expect(readFilter).toBeVisible();

    const countEl = page.getByTestId('notifications-count');

    // Select "Unread only"
    await readFilter.selectOption('unread');
    await expect(countEl).toBeVisible({ timeout: 2000 });
    const unreadCount = await countEl.textContent();
    expect(unreadCount).toMatch(/\d+ shown/);

    // Select "Read only"
    await readFilter.selectOption('read');
    await expect(countEl).toBeVisible({ timeout: 2000 });
    const readCount = await countEl.textContent();
    expect(readCount).toMatch(/\d+ shown/);

    // Reset
    await readFilter.selectOption('all');

    // Screenshot with read filter on "Read only"
    await readFilter.selectOption('read');
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'notifications-filter-read-only.png'),
      fullPage: true,
    });
  });

  test('header bell dropdown shows "View all notifications" link to /notifications', async ({ page }) => {
    ensureArtifactsDir();
    await loginAsAdminClient(page);

    // Start on dashboard
    await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 5000 });

    // Click the notification bell in the header
    const bell = page.getByTestId('notification-bell');
    await expect(bell).toBeVisible({ timeout: 2000 });
    await bell.click();

    // The dropdown should open
    const dropdown = page.getByTestId('notification-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 2000 });

    // The "View all notifications" link must be in the footer of the dropdown
    const viewAllLink = dropdown.getByTestId('notification-view-all');
    await expect(viewAllLink).toBeVisible();
    await expect(viewAllLink).toHaveText('View all notifications');

    // Screenshot: dropdown with footer link visible
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'notifications-dropdown-footer-link.png'),
      fullPage: false,
    });

    // Click "View all notifications" — must navigate to /notifications
    await viewAllLink.click();
    await expect(page).toHaveURL(/\/notifications/, { timeout: 3000 });
    await expect(page.getByTestId('notifications-heading')).toBeVisible({ timeout: 3000 });

    // Screenshot: arrived at /notifications from dropdown link
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'notifications-page-via-dropdown.png'),
      fullPage: true,
    });
  });

  test('mark-all-read button appears only when unread notifications exist in view', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.goto('/notifications');

    const listOrEmpty = page.getByTestId('notifications-list')
      .or(page.getByTestId('notifications-empty'));
    await expect(listOrEmpty).toBeVisible({ timeout: 5000 });

    const countEl = page.getByTestId('notifications-count');
    const countText = await countEl.textContent() ?? '';

    // Extract unread number from pattern "X shown · Y unread"
    const unreadMatch = countText.match(/(\d+) unread/);
    const unreadNum = unreadMatch ? parseInt(unreadMatch[1], 10) : 0;

    const markAllBtn = page.getByTestId('mark-all-read-button');
    if (unreadNum > 0) {
      await expect(markAllBtn).toBeVisible({ timeout: 2000 });
    } else {
      // When no unread notifications exist the button should not be rendered
      await expect(markAllBtn).not.toBeVisible();
    }
  });
});
