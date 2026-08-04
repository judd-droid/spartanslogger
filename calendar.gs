/****************************************************************************
 * Appointment 15 Logger — Agency Calendar backend (Apps Script)
 * ------------------------------------------------------------------------
 * Add this as a NEW script file in the Apps Script project bound to the
 * Appointment 15 Logger Google Sheet (Extensions ▸ Apps Script ▸ +).
 * Self-contained: every helper is prefixed `cal_` so it won't clash with
 * the functions already in Code.gs / bop.gs.
 *
 * READ-ONLY. The app never writes here — you manage all events directly in
 * the Sheet. Identity is still validated by the Vercel proxy (advisor+key),
 * but the handler doesn't filter by advisor: everyone sees the same agency
 * calendar.
 *
 * ONE TAB REQUIRED — 'Calendar'. Headers (row 1), only the first two are
 * required, the rest are optional:
 *   Event Name | Start Date | End Date | Start Time | End Time |
 *   Type | Location | Audience | Details
 *
 *   • Type drives the color in the app. Two buckets:
 *       "AIA"  → pink/red   (anything starting with "AIA")
 *       else   → purple     (treated as an Agency event)
 *   • End Date is only needed for multi-day events (defaults to Start Date).
 *
 * WIRING — add this one block to your EXISTING doGet(e):
 *
 *   if (e && e.parameter && e.parameter.path === 'calendar')
 *     return cal_json_(calendarGet_());
 *
 * (`cal_json_` just wraps ContentService — reuse your own JSON helper if you
 * prefer and keep only calendarGet_.)
 ****************************************************************************/

// Leave blank to use the bound spreadsheet (recommended for a container-bound
// script). Set an ID only if this script is standalone.
var CAL_SPREADSHEET_ID = '';

var CAL_SHEET = 'Calendar';

var CAL_HEADERS = [
  'Event Name', 'Start Date', 'End Date', 'Start Time', 'End Time',
  'Type', 'Location', 'Audience', 'Details',
];

/* ---------- small helpers (all cal_ prefixed) ---------- */

function cal_ss_() {
  return CAL_SPREADSHEET_ID
    ? SpreadsheetApp.openById(CAL_SPREADSHEET_ID)
    : SpreadsheetApp.getActive();
}

function cal_sheet_(name) {
  var sh = cal_ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet/tab: "' + name + '"');
  return sh;
}

// Return { header:[...], map:{ 'Header': colIndex } } for row 1.
function cal_headerInfo_(sh) {
  var lastCol = Math.max(1, sh.getLastColumn());
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var map = {};
  header.forEach(function (h, i) { if (h) map[h] = i; });
  return { header: header, map: map };
}

function cal_fmtDateISO_(v) {
  if (v instanceof Date && !isNaN(v)) {
    var tz = Session.getScriptTimeZone() || 'Asia/Manila';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v == null ? '' : v).trim();
}

// Render a time cell as a short string. A Date (Sheets stores times as dates)
// becomes "h:mm a"; anything else is passed through as text.
function cal_fmtTime_(v) {
  if (v instanceof Date && !isNaN(v)) {
    var tz = Session.getScriptTimeZone() || 'Asia/Manila';
    return Utilities.formatDate(v, tz, 'h:mm a');
  }
  return String(v == null ? '' : v).trim();
}

function cal_json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- handler ---------- */

/** List every row of the 'Calendar' tab, newest-relevant first (the app sorts). */
function calendarGet_() {
  var sh = cal_sheet_(CAL_SHEET);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, events: [] };

  var info = cal_headerInfo_(sh);
  var map = info.map, header = info.header;
  var vals = sh.getRange(2, 1, lastRow - 1, header.length).getValues();
  var get = function (row, h) { return map[h] !== undefined ? row[map[h]] : ''; };

  var events = [];
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var name = String(get(row, 'Event Name') || '').trim();
    var start = cal_fmtDateISO_(get(row, 'Start Date'));
    if (!name || !start) continue;   // skip blank / undated rows
    events.push({
      eventName: name,
      startDate: start,
      endDate: cal_fmtDateISO_(get(row, 'End Date')) || start,
      startTime: cal_fmtTime_(get(row, 'Start Time')),
      endTime: cal_fmtTime_(get(row, 'End Time')),
      type: String(get(row, 'Type') || '').trim(),
      location: String(get(row, 'Location') || '').trim(),
      audience: String(get(row, 'Audience') || '').trim(),
      details: String(get(row, 'Details') || '').trim(),
    });
  }
  return { ok: true, events: events };
}

/** OPTIONAL one-time helper: create the 'Calendar' tab with headers. */
function calSetupTab() {
  var ss = cal_ss_();
  var sh = ss.getSheetByName(CAL_SHEET) || ss.insertSheet(CAL_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, CAL_HEADERS.length).setValues([CAL_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return { ok: true, sheet: CAL_SHEET, headers: CAL_HEADERS };
}
