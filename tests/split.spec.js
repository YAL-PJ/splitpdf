// End-to-end behaviour of the splitter: the happy path must produce a file,
// and a broken file must produce a message rather than a hang or a crash.
const { test, expect } = require('@playwright/test');
const { openApp, uploadPdf } = require('./helpers/app');
const { makePdf, makeCorruptPdf } = require('./helpers/make-pdf');

test('happy path: a multi-page PDF loads, splits and downloads', async ({ page }) => {
  const { errors } = await openApp(page);

  await uploadPdf(page, makePdf({ pages: 4 }), 'four-pages.pdf');

  await expect(page.locator('#workspace')).toHaveClass(/visible/);
  await expect(page.locator('#filePages')).toHaveText('4 pages');
  await expect(page.locator('.page-card')).toHaveCount(4);
  // Default mode selects every page.
  await expect(page.locator('#selectionCount')).toContainText('4 of 4 pages selected');

  const downloadPromise = page.waitForEvent('download');
  await page.click('#splitBtn');
  const download = await downloadPromise;

  // <= 5 pages are listed individually in the name; more are counted.
  expect(download.suggestedFilename()).toBe('four-pages_pages_1_2_3_4.pdf');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const out = Buffer.concat(chunks);
  expect(out.length).toBeGreaterThan(400);
  expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  await expect(page.locator('#toast')).toContainText('PDF saved');
  // Blocked analytics/avatar requests show up as console "Failed to load
  // resource" lines, so only uncaught page errors are a real failure here.
  expect(errors.filter((e) => e.startsWith('pageerror:'))).toEqual([]);
});

test('happy path: split into ranges produces a ZIP', async ({ page }) => {
  await openApp(page);
  await uploadPdf(page, makePdf({ pages: 6 }), 'six-pages.pdf');
  await expect(page.locator('.page-card')).toHaveCount(6);

  await page.click('.split-mode-tab[data-mode="ranges"]');
  await page.fill('#rangeFrom', '1');
  await page.fill('#rangeTo', '2');
  await page.click('#splitPanel .btn');
  await page.fill('#rangeFrom', '3');
  await page.fill('#rangeTo', '6');
  await page.click('#splitPanel .btn');
  await expect(page.locator('.range-chip')).toHaveCount(2);

  const downloadPromise = page.waitForEvent('download');
  await page.click('#splitBtn');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('six-pages_split.zip');
});

test('failure path: a corrupt PDF gets a message, not a hang or a crash', async ({ page }) => {
  const { errors, reports } = await openApp(page);

  const corrupt = makeCorruptPdf({ title: 'Q3 Layoff List', author: 'Jane Employee' });
  await uploadPdf(page, corrupt, 'broken.pdf');

  // User-facing, graceful, and the app stays usable.
  await expect(page.locator('#toast')).toHaveClass(/visible/);
  await expect(page.locator('#toast')).toContainText('Could not open PDF');
  await expect(page.locator('#workspace')).not.toHaveClass(/visible/);
  await expect(page.locator('#uploadZone')).toBeVisible();
  await expect(page.locator('.page-card')).toHaveCount(0);

  // The only console noise allowed is the app's own console.error(err) in the
  // catch block. An uncaught pageerror means the failure was not handled.
  expect(errors.filter((e) => e.startsWith('pageerror:'))).toEqual([]);

  // A report is sent, and it describes the file without carrying its contents.
  await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
  const report = reports.find((r) => r && r.action === 'error_report');
  expect(report).toBeTruthy();
  expect(report.feature).toBe('loadFile');
  expect(report.userNote).toContain('step=loadFile');
  expect(report.userNote).toContain('kind=open-failed');
  expect(report.userNote).toMatch(/pdfVersion=1\.4/);
  expect(report.userNote).toMatch(/fileSize=\d+/);

  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain('Q3 Layoff List');
  expect(serialized).not.toContain('Jane Employee');
  // And certainly no file bytes.
  expect(serialized).not.toContain('garbage garbage');
});

test('the app still works after a corrupt file is rejected', async ({ page }) => {
  await openApp(page);
  await uploadPdf(page, makeCorruptPdf(), 'broken.pdf');
  await expect(page.locator('#toast')).toContainText('Could not open PDF');

  await uploadPdf(page, makePdf({ pages: 2 }), 'good.pdf');
  await expect(page.locator('#workspace')).toHaveClass(/visible/);
  await expect(page.locator('.page-card')).toHaveCount(2);
});
