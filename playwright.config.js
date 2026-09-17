// Playwright config for splitpdffree.com.
// The site is plain static files, so we serve the repo root and drive
// index.html in headless Chromium. Browsers are preinstalled in the CI image
// via PLAYWRIGHT_BROWSERS_PATH — do not run `playwright install` here.
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT || 8787);

module.exports = defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./tests/global-setup.js'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
