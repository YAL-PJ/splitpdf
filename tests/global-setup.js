// Runs once before the suite: cache the CDN libraries index.html depends on.
// After the first run the suite needs no network at all.
const { ensureVendorCache } = require('./helpers/app');

module.exports = async () => {
  await ensureVendorCache();
};
