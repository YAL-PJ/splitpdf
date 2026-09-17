// Guards the privacy boundary of the safe-metadata extractor in
// error-tracker.js: the useful structural fields must be there, and the PDF
// Info fields that carry real user data (/Title, /Author, /Subject, /Keywords)
// must never appear. If one of these tests fails, assume the leak is real.
const { test, expect } = require('@playwright/test');
const { openApp, uploadPdf } = require('./helpers/app');
const { makePdf } = require('./helpers/make-pdf');

const SECRET_TITLE = 'Divorce Settlement FINAL';
const SECRET_AUTHOR = 'Jane Q. Doe';

/** Run the extractor inside the page on bytes generated in Node. */
async function extract(page, buffer, hints) {
  return page.evaluate(
    ([bytes, h]) => window.__errorTrackerPdfMeta.fromBytes(new Uint8Array(bytes), h || {}),
    [Array.from(buffer), hints || null]
  );
}

test('captures the safe structural fields', async ({ page }) => {
  await openApp(page);
  const pdf = makePdf({
    pages: 5,
    version: '1.7',
    acroForm: true,
    title: SECRET_TITLE,
    author: SECRET_AUTHOR,
    producer: 'Acrobat Distiller 9.0',
    creator: 'ScannerSoft 2.1',
  });

  const meta = await extract(page, pdf);

  expect(meta.pdfVersion).toBe('1.7');
  expect(meta.fileSize).toBe(pdf.length);
  expect(meta.pageCount).toBe(5);
  expect(meta.isEncrypted).toBe(false);
  expect(meta.isLinearized).toBe(false);
  expect(meta.hasAcroForm).toBe(true);
  expect(meta.objectCount).toBeGreaterThan(5);
  expect(meta.producer).toBe('Acrobat Distiller 9.0');
  expect(meta.creator).toBe('ScannerSoft 2.1');
});

test('never captures Title, Author, Subject, Keywords or file bytes', async ({ page }) => {
  await openApp(page);
  const pdf = makePdf({ pages: 2, title: SECRET_TITLE, author: SECRET_AUTHOR });

  const meta = await extract(page, pdf);
  const serialized = JSON.stringify(meta);

  expect(serialized).not.toContain(SECRET_TITLE);
  expect(serialized).not.toContain(SECRET_AUTHOR);
  for (const key of ['title', 'author', 'subject', 'keywords', 'text', 'bytes', 'data', 'content']) {
    expect(Object.keys(meta).map((k) => k.toLowerCase())).not.toContain(key);
  }
  // Only the documented keys are ever emitted.
  expect(Object.keys(meta).sort()).toEqual(
    expect.arrayContaining(['fileSize', 'pageCount', 'pdfVersion'])
  );
  const allowed = new Set([
    'pdfVersion', 'fileSize', 'pageCount', 'objectCount',
    'isEncrypted', 'isLinearized', 'hasAcroForm', 'producer', 'creator', 'truncated',
  ]);
  for (const key of Object.keys(meta)) expect(allowed.has(key)).toBe(true);

  // Page text is drawn as `(Page 1) Tj` in the fixture — must not surface.
  expect(serialized).not.toContain('Page 1');
});

test('the breadcrumb is a userNote-shaped key=value string', async ({ page }) => {
  await openApp(page);
  const pdf = makePdf({ pages: 3, title: SECRET_TITLE, producer: 'pdf-lib 1.17' });

  const crumb = await page.evaluate(
    ([bytes]) => {
      const api = window.__errorTrackerPdfMeta;
      return api.breadcrumb(api.fromBytes(new Uint8Array(bytes)));
    },
    [Array.from(pdf)]
  );

  expect(crumb).toMatch(/pdfVersion=1\.4/);
  expect(crumb).toMatch(/pageCount=3/);
  expect(crumb).toMatch(/isEncrypted=0/);
  expect(crumb).toMatch(/hasAcroForm=0/);
  expect(crumb).toContain('producer=pdf-lib 1.17');
  expect(crumb).not.toContain(SECRET_TITLE);
  expect(crumb.split(';').every((p) => /^[a-zA-Z]+=.+$/.test(p))).toBe(true);
});

test('never throws on garbage, empty or non-PDF input', async ({ page }) => {
  await openApp(page);

  const results = await page.evaluate(() => {
    const api = window.__errorTrackerPdfMeta;
    const random = new Uint8Array(512);
    for (let i = 0; i < random.length; i++) random[i] = (i * 37) % 256;
    return [
      api.fromBytes(random),
      api.fromBytes(new Uint8Array(0)),
      api.fromBytes(null),
      api.fromBytes(undefined),
      api.fromBytes('not bytes at all'),
      api.fromBytes({ nope: true }),
      api.breadcrumb(null),
      api.breadcrumb('junk'),
    ];
  });

  // No exception escaped, and nothing invented for an unreadable file.
  expect(results).toHaveLength(8);
  expect(results[0].pdfVersion).toBeUndefined();
  expect(results[1]).toEqual({});
  expect(results[6]).toBe('');
});

test('a real upload records exact page count from pdf.js', async ({ page }) => {
  await openApp(page);
  await uploadPdf(page, makePdf({ pages: 7, producer: 'Acrobat Distiller 9.0' }), 'seven.pdf');
  await expect(page.locator('.page-card')).toHaveCount(7);

  const meta = await page.evaluate(() => window.__lastPdfMeta);
  expect(meta.pageCount).toBe(7);
  expect(meta.producer).toBe('Acrobat Distiller 9.0');
  expect(meta.isEncrypted).toBe(false);
});
