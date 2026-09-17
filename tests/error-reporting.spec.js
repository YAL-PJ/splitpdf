// index.html used to install its own global error/unhandledrejection listeners
// alongside the ones error-tracker.js installs, so every uncaught error produced
// two rows in the Errors sheet. That doubled the `count` the daily triage job
// uses to rank bugs, and the extra row was the poorer of the two (no sessionId,
// no cross-origin filtering).
const { test, expect } = require('@playwright/test');
const { openApp } = require('./helpers/app');

const PROBE = 'duplicate-report-probe';
const isProbe = (r) =>
  r && typeof r === 'object' &&
  r.action === 'error_report' &&
  String(r.message || '').includes(PROBE);

test.describe('uncaught errors are reported once', () => {
  test('a thrown error produces exactly one report', async ({ page }) => {
    const { reports } = await openApp(page);
    reports.length = 0;

    await page.evaluate((probe) => {
      setTimeout(() => { throw new Error(probe); }, 0);
    }, PROBE);

    await expect.poll(() => reports.filter(isProbe).length).toBe(1);
    // Settle: a second handler would post at roughly the same time, so the
    // count staying at 1 is the actual assertion.
    await page.waitForTimeout(500);

    const matching = reports.filter(isProbe);
    expect(matching).toHaveLength(1);
    // The survivor must be error-tracker.js's handler, not index.html's.
    expect(matching[0].feature).toBe('window.error');
    expect(matching[0].sessionId).toBeTruthy();
  });

  test('a rejected promise produces exactly one report', async ({ page }) => {
    const { reports } = await openApp(page);
    reports.length = 0;

    await page.evaluate((probe) => {
      Promise.reject(new Error(probe));
    }, PROBE);

    await expect.poll(() => reports.filter(isProbe).length).toBe(1);
    await page.waitForTimeout(500);

    const matching = reports.filter(isProbe);
    expect(matching).toHaveLength(1);
    expect(matching[0].feature).toBe('unhandledrejection');
    expect(matching[0].sessionId).toBeTruthy();
  });
});
