/**
 * Shared Feedback Backend for Yanis L.'s PDF tools.
 *
 *   freemergepdf.com         -> APP_ID "freemergepdf"
 *   splitpdffree.com         -> APP_ID "splitpdf"
 *   converttopdffree.com     -> APP_ID "converttopdf"
 *   www.freecompresspdf.com  -> APP_ID "compresspdf"
 *
 * ============================================================================
 * ONE-TIME SETUP
 * ============================================================================
 *  1. Create a new Google Sheet. Rename the first tab to "Feedback".
 *  2. In row 1 of that tab, paste exactly these 9 column headers (one per cell,
 *     in this order):
 *
 *       id   timestamp   app   name   email   message   isPrivate   ownerReply   ownerReplyDate
 *
 *  3. Extensions -> Apps Script. Replace the default code with this entire file.
 *  4. Deploy -> New deployment -> Type: Web app.
 *       Execute as:      Me
 *       Who has access:  Anyone
 *  5. Copy the Web app URL (ends with /exec).
 *  6. Paste the URL into the FEEDBACK_ENDPOINT constant inside each app:
 *        - freemergepdf/feedback.js
 *        - splitpdf/index.html               (search for FEEDBACK_ENDPOINT)
 *        - convert-to-pdf/feedback.js
 *        - pdf-compress-new/components/BetaFeedbackBanner.tsx
 *
 *  When you edit this file, redeploy via Manage deployments -> Edit -> New version.
 *
 * ============================================================================
 * REPLYING AS THE OWNER
 * ============================================================================
 *  Open the spreadsheet, find the user's row, type your reply into the
 *  "ownerReply" column. The frontend will render it beneath the user's
 *  message labeled "Reply from Yanis (creator)". Leave ownerReplyDate
 *  blank to auto-stamp it, or fill it in manually.
 *
 * ============================================================================
 * PRIVATE FEEDBACK
 * ============================================================================
 *  Rows where isPrivate = TRUE keep their name and message visible to YOU in
 *  the sheet, but those fields are stripped before being returned to the
 *  public website. Email is never returned by the public GET endpoint.
 *
 *  Filtering tip: add a sheet filter on the "app" column to quickly see one
 *  product at a time.
 */

const SHEET_NAME = 'Feedback';
const HEADERS = ['id', 'timestamp', 'app', 'name', 'email', 'message', 'isPrivate', 'ownerReply', 'ownerReplyDate'];
const KNOWN_APPS = ['freemergepdf', 'splitpdf', 'converttopdf', 'compresspdf'];

const MAX_MESSAGE = 2000;
const MAX_NAME = 80;
const MAX_EMAIL = 120;

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const wantedApp = params.app ? String(params.app).toLowerCase() : null;

    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return json_([]);

    const idx = mapHeaders_(values[0]);
    const items = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const id = String(row[idx.id] || '').trim();
      const message = String(row[idx.message] || '').trim();
      if (!id || !message) continue;

      const app = String(row[idx.app] || '').toLowerCase().trim();
      if (wantedApp && app !== wantedApp) continue;

      const isPrivate = toBool_(row[idx.isPrivate]);
      items.push({
        id: id,
        timestamp: toIso_(row[idx.timestamp]),
        app: app,
        name: isPrivate ? '' : String(row[idx.name] || ''),
        message: isPrivate ? '' : message,
        isPrivate: isPrivate,
        ownerReply: String(row[idx.ownerReply] || ''),
        ownerReplyDate: toIso_(row[idx.ownerReplyDate])
        // email is intentionally never returned
      });
    }
    return json_(items);
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // Honeypot — silently accept and drop obvious bots
    if (body.website) return json_({ ok: true });

    const app = String(body.app || '').toLowerCase().trim();
    if (KNOWN_APPS.indexOf(app) === -1) {
      return json_({ ok: false, error: 'invalid app' });
    }

    const name = String(body.name || '').slice(0, MAX_NAME).trim();
    const email = String(body.email || '').slice(0, MAX_EMAIL).trim();
    const message = String(body.message || '').slice(0, MAX_MESSAGE).trim();
    const isPrivate = toBool_(body.isPrivate);

    if (!message) return json_({ ok: false, error: 'message required' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json_({ ok: false, error: 'valid email required' });
    }

    const sheet = getSheet_();
    const id = Utilities.getUuid().slice(0, 8);
    sheet.appendRow([id, new Date(), app, name, email, message, isPrivate, '', '']);
    return json_({ ok: true, id: id });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function mapHeaders_(row) {
  const map = {};
  row.forEach(function (h, i) { map[String(h).trim()] = i; });
  HEADERS.forEach(function (h) {
    if (!(h in map)) {
      throw new Error('Missing column "' + h + '". Row 1 must be: ' + HEADERS.join(' | '));
    }
  });
  return map;
}

function toIso_(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toBool_(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
