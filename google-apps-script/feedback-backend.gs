/**
 * Shared backend for all 4 of Yanis L.'s PDF tools.
 *
 *   freemergepdf.com         -> APP_ID "freemergepdf"
 *   splitpdffree.com         -> APP_ID "splitpdf"
 *   converttopdffree.com     -> APP_ID "converttopdf"
 *   www.freecompresspdf.com  -> APP_ID "compresspdf"
 *
 * Handles two kinds of POSTs (routed by JSON body):
 *   1. Feedback   -> { app, name, email, message, isPrivate }                -> "Feedback" tab
 *   2. Error rpt  -> { type: 'error', app, feature, message, stack, ... }    -> "Errors" tab
 *
 * GET ?app=<id>           -> public feedback list (private rows are masked)
 * GET ?errors=1&app=<id>  -> NOT exposed publicly. Read the Errors tab in the sheet directly.
 *
 * ============================================================================
 * ONE-TIME SETUP
 * ============================================================================
 *  1. Same sheet as before. The "Feedback" tab is unchanged.
 *  2. Add a new tab named "Errors". Row 1, exact spelling, in this order
 *     (one column per name; "|" is just a separator here):
 *
 *       id | timestamp | app | feature | code | message | stack | url | userAgent | sessionId | fileName | userNote | status
 *
 *  3. Replace the Apps Script contents with this whole file.
 *  4. Deploy -> Manage deployments -> edit the existing one -> New version -> Deploy.
 *     (The /exec URL stays the same, no client-side change needed.)
 *
 * ============================================================================
 * TRIAGING ERRORS
 * ============================================================================
 *  Filter the "Errors" tab by the `app` column to see one product at a time.
 *  Use the `status` column for your own workflow ("new", "looking", "fixed",
 *  "ignored", whatever). The frontend never reads from this tab.
 *
 *  Private feedback / error data: the public GET endpoint never returns rows
 *  from the Errors tab and never returns the email column from Feedback.
 */

const SHEET_FEEDBACK = 'Feedback';
const FEEDBACK_HEADERS = ['id', 'timestamp', 'app', 'name', 'email', 'message', 'isPrivate', 'ownerReply', 'ownerReplyDate'];

const SHEET_ERRORS = 'Errors';
const ERROR_HEADERS = ['id', 'timestamp', 'app', 'feature', 'code', 'message', 'stack', 'url', 'userAgent', 'sessionId', 'fileName', 'userNote', 'status'];

const KNOWN_APPS = ['freemergepdf', 'splitpdf', 'converttopdf', 'compresspdf'];

const MAX_MESSAGE = 2000;
const MAX_NAME = 80;
const MAX_EMAIL = 120;
const MAX_STACK = 3000;
const MAX_URL = 500;
const MAX_UA = 400;
const MAX_FEATURE = 100;
const MAX_CODE = 80;
const MAX_SESSION = 80;
const MAX_FILENAME = 200;
const MAX_NOTE = 500;

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const wantedApp = params.app ? String(params.app).toLowerCase() : null;

    const sheet = getFeedbackSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return json_([]);

    const idx = mapHeaders_(values[0], FEEDBACK_HEADERS, SHEET_FEEDBACK);
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

    // pdf-compress-new's existing payload uses { error: {...} } envelope.
    // Accept either { type: 'error', ... } or a top-level { error: {...}, app }.
    if (body && body.error && typeof body.error === 'object') {
      const inner = body.error;
      inner.app = body.app || inner.app;
      inner.type = 'error';
      return handleError_(inner);
    }

    const type = String(body.type || 'feedback').toLowerCase();
    if (type === 'error') return handleError_(body);
    return handleFeedback_(body);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function handleFeedback_(body) {
  const app = String(body.app || '').toLowerCase().trim();
  if (KNOWN_APPS.indexOf(app) === -1) return json_({ ok: false, error: 'invalid app' });

  const name = String(body.name || '').slice(0, MAX_NAME).trim();
  const email = String(body.email || '').slice(0, MAX_EMAIL).trim();
  const message = String(body.message || '').slice(0, MAX_MESSAGE).trim();
  const isPrivate = toBool_(body.isPrivate);

  if (!message) return json_({ ok: false, error: 'message required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json_({ ok: false, error: 'valid email required' });
  }

  const sheet = getFeedbackSheet_();
  const id = Utilities.getUuid().slice(0, 8);
  sheet.appendRow([id, new Date(), app, name, email, message, isPrivate, '', '']);
  return json_({ ok: true, id: id });
}

function handleError_(body) {
  const app = String(body.app || '').toLowerCase().trim();
  if (KNOWN_APPS.indexOf(app) === -1) return json_({ ok: false, error: 'invalid app' });

  const message = String(body.message || '').slice(0, MAX_MESSAGE).trim();
  if (!message) return json_({ ok: false, error: 'message required' });

  const sheet = getErrorsSheet_();
  const id = Utilities.getUuid().slice(0, 8);
  sheet.appendRow([
    id,
    new Date(),
    app,
    String(body.feature || body.context || '').slice(0, MAX_FEATURE),
    String(body.code || '').slice(0, MAX_CODE),
    message,
    String(body.stack || '').slice(0, MAX_STACK),
    String(body.url || body.pageUrl || '').slice(0, MAX_URL),
    String(body.userAgent || '').slice(0, MAX_UA),
    String(body.sessionId || '').slice(0, MAX_SESSION),
    String(body.fileName || '').slice(0, MAX_FILENAME),
    String(body.userNote || '').slice(0, MAX_NOTE),
    '' // status — owner fills in
  ]);
  return json_({ ok: true, id: id });
}

function getFeedbackSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_FEEDBACK);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_FEEDBACK);
    sheet.appendRow(FEEDBACK_HEADERS);
  }
  return sheet;
}

function getErrorsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_ERRORS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_ERRORS);
    sheet.appendRow(ERROR_HEADERS);
  }
  return sheet;
}

function mapHeaders_(row, expected, sheetName) {
  const map = {};
  row.forEach(function (h, i) { map[String(h).trim()] = i; });
  expected.forEach(function (h) {
    if (!(h in map)) {
      throw new Error('Sheet "' + sheetName + '" is missing column "' + h + '". Row 1 must be: ' + expected.join(' | '));
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
