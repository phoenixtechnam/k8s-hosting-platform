import { test, expect } from '@playwright/test';
import path from 'path';
import { injectAdminAuth } from './helpers';

const AUDIT_LOGS_URL = '/monitoring/audit-logs';
const ARTIFACTS_DIR = path.join(__dirname, '..', 'test-artifacts');

test.describe('Admin Panel — Audit Logs page (Phase 7)', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto(AUDIT_LOGS_URL);
    // Wait for the page heading to confirm navigation succeeded
    await expect(page.getByTestId('audit-logs-heading')).toBeVisible({ timeout: 8000 });
  });

  // -----------------------------------------------------------------------
  // 1. Page structure — heading, filter bar, table
  // -----------------------------------------------------------------------

  test('page heading, filter bar, and table are rendered on load', async ({ page }) => {
    // Heading
    const heading = page.getByTestId('audit-logs-heading');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText('Audit Logs');

    // Filter bar wrapper
    await expect(page.getByTestId('audit-logs-filters')).toBeVisible();

    // All eight filter inputs must be present
    await expect(page.getByTestId('filter-action-type')).toBeVisible();
    await expect(page.getByTestId('filter-resource-type')).toBeVisible();
    await expect(page.getByTestId('filter-http-method')).toBeVisible();
    await expect(page.getByTestId('filter-search')).toBeVisible();
    await expect(page.getByTestId('filter-from')).toBeVisible();
    await expect(page.getByTestId('filter-to')).toBeVisible();
    await expect(page.getByTestId('filter-client-id')).toBeVisible();
    await expect(page.getByTestId('filter-actor-id')).toBeVisible();

    // Table should render (real data is present from prior test phases)
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'audit-logs-default-view.png'),
      fullPage: false,
    });
  });

  // -----------------------------------------------------------------------
  // 2. Count badge — "X shown of Y" with non-zero Y
  // -----------------------------------------------------------------------

  test('count badge shows "shown of <total>" with non-zero total', async ({ page }) => {
    // Wait until the table appears (data has loaded)
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    const countEl = page.getByTestId('audit-logs-count');
    await expect(countEl).toBeVisible();

    const text = await countEl.textContent();
    expect(text).toBeTruthy();

    // Pattern: "50 shown of 238"
    const match = text!.match(/(\d+)\s+shown\s+of\s+(\d+)/);
    expect(match).not.toBeNull();
    const shownCount = parseInt(match![1], 10);
    const totalCount = parseInt(match![2], 10);
    expect(shownCount).toBeGreaterThan(0);
    expect(totalCount).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 3. Row expand / collapse
  // -----------------------------------------------------------------------

  test('clicking first row expands the detail drawer; clicking again collapses it', async ({ page }) => {
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    // Find the first row using the data-testid prefix pattern
    const firstRow = page.locator('[data-testid^="audit-log-row-"]').first();
    await expect(firstRow).toBeVisible();

    // Extract the row id from the testid attribute
    const rowTestId = await firstRow.getAttribute('data-testid');
    expect(rowTestId).toBeTruthy();
    const rowId = rowTestId!.replace('audit-log-row-', '');

    const detailsTestId = `audit-log-details-${rowId}`;

    // Before clicking — details should not exist
    await expect(page.getByTestId(detailsTestId)).not.toBeVisible();

    // Click to expand
    await firstRow.click();
    await expect(page.getByTestId(detailsTestId)).toBeVisible({ timeout: 3000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'audit-logs-row-expanded.png'),
      fullPage: false,
    });

    // Click again to collapse
    await firstRow.click();
    await expect(page.getByTestId(detailsTestId)).not.toBeVisible({ timeout: 3000 });
  });

  // -----------------------------------------------------------------------
  // 4. Filter by action_type = "create"
  // -----------------------------------------------------------------------

  test('filtering by action_type=create refreshes table with rows still visible', async ({ page }) => {
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    const actionSelect = page.getByTestId('filter-action-type');
    await actionSelect.selectOption('create');

    // Wait for the table to reflect the filter — either rows remain or empty state shows
    // The "clear-filters" button becomes visible, proving the filter is active
    await expect(page.getByTestId('clear-filters')).toBeVisible({ timeout: 5000 });

    // Table should still render (there are create events in the real data)
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    // At least one row in tbody
    const rows = page.locator('[data-testid^="audit-log-row-"]');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'audit-logs-filtered-create.png'),
      fullPage: false,
    });
  });

  // -----------------------------------------------------------------------
  // 5. Clear filters — resets to full set
  // -----------------------------------------------------------------------

  test('clearing filters removes filter badge and restores full result set', async ({ page }) => {
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    // Capture baseline count text
    const countEl = page.getByTestId('audit-logs-count');
    const baselineText = await countEl.textContent();

    // Apply a filter to reduce the set
    await page.getByTestId('filter-action-type').selectOption('create');
    await expect(page.getByTestId('clear-filters')).toBeVisible({ timeout: 5000 });

    // Clear filters
    await page.getByTestId('clear-filters').click();

    // Clear-filters button must disappear (no active filters)
    await expect(page.getByTestId('clear-filters')).not.toBeVisible({ timeout: 3000 });

    // Table must still be visible
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    // Count text must be restored to the baseline (or at least show a total count)
    const restoredText = await countEl.textContent();
    expect(restoredText).toEqual(baselineText);
  });

  // -----------------------------------------------------------------------
  // 6. Filter by http_method = "DELETE"
  // -----------------------------------------------------------------------

  test('filtering by http_method=DELETE applies and shows count badge', async ({ page }) => {
    await expect(page.getByTestId('audit-logs-table')).toBeVisible({ timeout: 8000 });

    const methodSelect = page.getByTestId('filter-http-method');
    await methodSelect.selectOption('DELETE');

    // Filter is active — clear-filters becomes visible
    await expect(page.getByTestId('clear-filters')).toBeVisible({ timeout: 5000 });

    // Count badge is still rendered
    await expect(page.getByTestId('audit-logs-count')).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'audit-logs-filtered-delete.png'),
      fullPage: false,
    });
  });

  // -----------------------------------------------------------------------
  // 7. "Clear filters" button hidden when no filters are active
  // -----------------------------------------------------------------------

  test('clear-filters button is hidden when no filters are set', async ({ page }) => {
    // On fresh page load no filter is active — button must not be visible
    await expect(page.getByTestId('clear-filters')).not.toBeVisible();
  });

  // -----------------------------------------------------------------------
  // 8. Sidebar navigation link reaches the page
  // -----------------------------------------------------------------------

  test('navigating to the Audit Logs route directly shows the heading', async ({ page }) => {
    // Already on the page from beforeEach — just verify URL and heading
    await expect(page).toHaveURL(/monitoring\/audit-logs/);
    await expect(page.getByTestId('audit-logs-heading')).toBeVisible();
  });
});
