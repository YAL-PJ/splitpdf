# Browser tests for splitpdffree.com

The site is static HTML/JS with no build step. These tests serve the repo root
with `python3 -m http.server` and drive `index.html` in headless Chromium via
Playwright, so a fix can be *proved* in a browser before a PR is opened.

## Run

```bash
npm install     # only @playwright/test; browsers are preinstalled in CI images
npm test        # == playwright test
```

- Do **not** run `playwright install` in the CI image: Chromium is already
  there and `PLAYWRIGHT_BROWSERS_PATH` points at it. `@playwright/test` is
  pinned to the version that matches the preinstalled browser build — if you
  bump it and see "Executable doesn't exist", that pin is why.
- Single test: `npx playwright test -g "corrupt"`. Watch it happen:
  `npm run test:headed`. Debug a failure: `npx playwright show-trace
  test-results/<dir>/trace.zip`.
- First run downloads pdf-lib, pdf.js and JSZip into `tests/.cache`
  (gitignored). After that the suite needs no network: all third-party traffic
  is intercepted, and the Apps Script error endpoint is answered locally, so a
  test run can never write a row into the production error sheet.

## Layout

| File | What it does |
| --- | --- |
| `helpers/make-pdf.js` | Generates PDF fixtures in code (`makePdf`, `makeCorruptPdf`) — no committed binaries |
| `helpers/app.js` | `openApp(page)` opens index.html offline and returns `{errors, reports}`; `uploadPdf(page, buffer, name)` feeds the file input |
| `split.spec.js` | Happy paths (split to one PDF, split ranges to a ZIP) and the corrupt-file failure path |
| `pdf-metadata.spec.js` | The safe-metadata extractor in `error-tracker.js`: correct structural fields, and never `/Title` or `/Author` |

`openApp` returns two collectors worth knowing about:

- `errors` — console errors and uncaught page errors. Assert
  `errors.filter(e => e.startsWith('pageerror:'))` is empty to prove a failure
  was handled instead of thrown at the user.
- `reports` — the error-report payloads the app *would* have posted to the
  Google Sheet, already JSON-parsed. Assert on `feature`, `userNote`,
  `fileName` here — and assert that nothing sensitive is in them.

## Adding a regression case for a new bug

1. Describe the file in code. Most sheet rows give you a shape, not a sample:
   `makePdf({ pages: 12, version: '1.7', acroForm: true, producer: 'Scanner X' })`.
   If the bug needs a structure `makePdf` cannot express, extend it there
   (keep it dependency-free) rather than committing a `.pdf`.
2. Add a test named after the symptom, not the fix:

   ```js
   test('12-page scan with a form splits without an error toast', async ({ page }) => {
     const { errors } = await openApp(page);
     await uploadPdf(page, makePdf({ pages: 12, acroForm: true }), 'scan.pdf');
     await expect(page.locator('.page-card')).toHaveCount(12);
     const download = await Promise.all([
       page.waitForEvent('download'),
       page.click('#splitBtn'),
     ]).then(([d]) => d);
     expect(download.suggestedFilename()).toMatch(/\.pdf$/);
     expect(errors.filter((e) => e.startsWith('pageerror:'))).toEqual([]);
   });
   ```

3. Run it **before** the fix and confirm it fails for the reported reason, then
   fix `index.html` / `error-tracker.js` and confirm it passes. Paste that
   before/after output into the PR.
4. If a reported crash cannot be reproduced from the metadata in the sheet
   (`userNote` holds `pdfVersion`, `fileSize`, `pageCount`, `objectCount`,
   `isEncrypted`, `isLinearized`, `hasAcroForm`, `producer`, `creator`), say so
   in the PR instead of guessing. Never ask for the user's file, and never add
   a field that could carry its contents — see the privacy note at the top of
   the metadata section in `error-tracker.js`.
