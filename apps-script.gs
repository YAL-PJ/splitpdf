/**
 * SplitPDF — Feedback backend (Google Apps Script)
 *
 * One-time setup:
 *  1. Create a new Google Sheet. Rename the first tab to "Feedback".
 *  2. Add this header row (row 1):  timestamp | name | rating | message
 *  3. Extensions → Apps Script. Replace the default code with this file's contents.
 *  4. Click Deploy → New deployment → Type: Web app.
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  5. Copy the Web app URL (ends with /exec).
 *  6. In index.html, set:   const FEEDBACK_ENDPOINT = 'PASTE_URL_HERE';
 *
 * When you change this script, redeploy ("Manage deployments" → edit → New version).
 */

const SHEET_NAME = 'Feedback';
const MAX_MESSAGE = 1000;
const MAX_NAME = 60;

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
    const name = String(body.name || 'Anonymous').slice(0, MAX_NAME);
    const rating = Math.max(1, Math.min(5, parseInt(body.rating, 10) || 0));
    const message = String(body.message || '').slice(0, MAX_MESSAGE);
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

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['timestamp', 'name', 'rating', 'message']);
  }
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
