// Shared browser-side plumbing for the suite.
//
// Two things every test wants:
//  1. No third-party traffic. index.html pulls pdf-lib / pdf.js / JSZip from
//     CDNs and posts errors + analytics to Google. Tests cache the three
//     libraries once under tests/.cache (gitignored) and serve them from
//     there, and hard-block analytics and the error endpoint so a test run can
//     never write a row into the production error sheet.
//  2. A record of console errors and page errors, so a "graceful failure" test
//     can assert the app did not throw an unhandled error at the user.

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_DIR = path.join(__dirname, '..', '.cache');

// URL prefix (as it appears in index.html) -> cache file name.
const VENDOR = {
  'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js': 'pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js': 'pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js': 'pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js': 'jszip.min.js',
};

const BLOCKED = [
  'googletagmanager.com',
  'google-analytics.com',
  'freemergepdf.com',
  'freecompresspdf.com',
];

// The Apps Script endpoint (error reports + feedback). We never let a test
// reach it; we answer it locally and keep the payload so tests can assert on
// exactly what the app would have reported.
const REPORT_HOST = 'script.google.com';

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/** Fetch the vendored libraries once per machine. Call from global setup. */
async function ensureVendorCache() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const [url, name] of Object.entries(VENDOR)) {
    const dest = path.join(CACHE_DIR, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
    fs.writeFileSync(dest, await download(url));
  }
}

/**
 * Open index.html with vendored scripts served locally and all other
 * third-party traffic blocked.
 * @returns {Promise<{errors: string[]}>} collector for console/page errors
 */
async function openApp(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });

  const reports = [];
  await page.route('**/*', (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes(REPORT_HOST)) {
      let body = null;
      try { body = JSON.parse(request.postData() || 'null'); } catch (_) { body = request.postData(); }
      if (body) reports.push(body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    if (BLOCKED.some((host) => url.includes(host))) return route.abort();
    return route.continue();
  });

  // Registered *after* the catch-all on purpose: Playwright tries the most
  // recently added route first, so these specific URLs win over it.
  for (const [url, name] of Object.entries(VENDOR)) {
    await page.route(url, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: fs.readFileSync(path.join(CACHE_DIR, name)),
      })
    );
  }

  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.loadFile === 'function' && !!window.PDFLib);
  // error-tracker.js is deferred; wait for its public API before asserting on it.
  await page.waitForFunction(() => !!window.__errorTrackerPdfMeta);
  // pdf.js fetches its worker from a CDN; point it at the local cache copy,
  // which python -m http.server already serves out of the repo.
  await page.evaluate(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/tests/.cache/pdf.worker.min.js';
  });
  return { errors, reports };
}

/** Feed a generated PDF to the file input, exactly as a real picker would. */
async function uploadPdf(page, buffer, name = 'fixture.pdf') {
  await page.setInputFiles('#fileInput', { name, mimeType: 'application/pdf', buffer });
}

module.exports = { ensureVendorCache, openApp, uploadPdf, CACHE_DIR };
