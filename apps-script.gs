/**
 * SplitPDF — Feedback & Error-tracking backend (Google Apps Script)
 *
 * One-time setup:
 *  1. Create a new Google Sheet.
 *  2. Extensions → Apps Script. Replace the default code with this file's contents.
 *  3. Click Deploy → New deployment → Type: Web app.
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  4. Copy the Web app URL (ends with /exec).
 *  5. In index.html, set:   const FEEDBACK_ENDPOINT = 'PASTE_URL_HERE';
 *
 * The script creates two tabs automatically:
 *   "Feedback" — user ratings and messages
 *   "Errors"   — client-side errors logged by the app
 *
 * When you change this script, redeploy ("Manage deployments" → edit → New version).
 */

const SHEET_NAME       = 'Feedback';
const ERROR_SHEET_NAME = 'Errors';
const MAX_MESSAGE  = 1000;
const MAX_NAME     = 60;
const MAX_ERR_MSG  = 2000;
const MAX_CONTEXT  = 100;
const MAX_UA       = 500;

function doGet(e) {
  try {
    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return json_([]);
    const headers = values[0].map(h => String(h).trim().toLowerCase());
    const items = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = row[idx]; });
      if (obj.timestamp instanceof Date) obj.timestamp = obj.timestamp.toISOString();
      items.push(obj);
    }
    return json_(items);
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (body.action === 'log_error') {
      return handleError_(body);
    }

    // --- feedback ---
    const name      = String(body.name || 'Anonymous').slice(0, MAX_NAME);
    const rating    = Math.max(1, Math.min(5, parseInt(body.rating, 10) || 0));
    const message   = String(body.message || '').slice(0, MAX_MESSAGE);
    const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();

    if (!rating || !message) {
      return json_({ ok: false, error: 'rating and message are required' });
    }

    const sheet = getSheet_();
    sheet.appendRow([timestamp, name, rating, message]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function handleError_(body) {
  try {
    const timestamp   = body.timestamp ? new Date(body.timestamp) : new Date();
    const context     = String(body.context   || '').slice(0, MAX_CONTEXT);
    const message     = String(body.message   || '').slice(0, MAX_ERR_MSG);
    const stack       = String(body.stack     || '').slice(0, MAX_ERR_MSG);
    const url         = String(body.url       || '').slice(0, MAX_UA);
    const userAgent   = String(body.userAgent || '').slice(0, MAX_UA);

    const sheet = getErrorSheet_();
    sheet.appendRow([timestamp, context, message, stack, url, userAgent]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['timestamp', 'name', 'rating', 'message']);
  }
  return sheet;
}

function getErrorSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ERROR_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ERROR_SHEET_NAME);
    sheet.appendRow(['timestamp', 'context', 'message', 'stack', 'url', 'userAgent']);
  }
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
