/****************************************************************************
 * Appointment 15 Logger — Recruit / BOP Guests backend (Apps Script)
 * ------------------------------------------------------------------------
 * Add this as a NEW script file in the Apps Script project that is bound to
 * the Appointment 15 Logger Google Sheet (Extensions ▸ Apps Script ▸ +).
 * It is self-contained: every helper is prefixed `bop_` so it will not clash
 * with the functions already in your Code.gs.
 *
 * Identity model: the Vercel proxy validates the advisor + sync key and
 * forwards a trusted `advisor` (query param on GET, body field on POST).
 * These handlers read that advisor directly — there is NO email/Users tab.
 *
 * TWO SHEETS/TABS ARE REQUIRED (you said you already created them):
 *   'BOP Guests' — one row per guest per event. Headers (row 1):
 *       Advisor | Unit | Sr. Unit | Guest Name | Event Name | Event Date |
 *       Registration Status | Attendance | Remarks | entryID | lastModified
 *   'BOPs' — one row per event (the picker reads this). Headers (row 1):
 *       Event Name | Event Date | Registered | Show-Up | Remarks
 *   (Registered / Show-Up are typically Sheet formulas that count 'BOP Guests'.)
 *
 * WIRING — add these three blocks to your EXISTING doGet / doPost.
 * See RECRUIT_SETUP.md for copy-paste snippets. In short:
 *
 *   // inside doGet(e):
 *   if (e && e.parameter && e.parameter.path === 'bops')
 *     return bop_json_(bopsGet_());
 *   if (e && e.parameter && e.parameter.path === 'bopguests')
 *     return bop_json_(bopGuestsGet_(e.parameter));
 *
 *   // inside doPost(e), after you parse `data` and read `path`:
 *   if (path === 'bop') return bop_json_(bopPost_(data));
 *
 * If you prefer, `bop_json_` just wraps ContentService — use your own JSON
 * helper instead and only keep the *Get_/*Post_ calls.
 ****************************************************************************/

// Leave blank to use the bound spreadsheet (recommended for a container-bound
// script). Set an ID only if this script is standalone.
var BOP_SPREADSHEET_ID = '';

var BOP_SHEET_GUESTS = 'BOP Guests';
var BOP_SHEET_EVENTS = 'BOPs';

var BOP_GUEST_HEADERS = [
  'Advisor', 'Unit', 'Sr. Unit',
  'Guest Name',
  'Event Name', 'Event Date',
  'Registration Status', 'Attendance',
  'Remarks',
  'entryID', 'lastModified',
];

// Optional Unit -> Sr. Unit mapping (kept in sync with the meetings backend).
var BOP_SR_UNIT_MAP = {
  'Aquila Direct': 'Aquila',
  'Stellar Direct': 'Stellar',
  'Aurora': 'Stellar',
  'Supernova Direct': 'Direct',
  'Alphara': 'Aquila',
};

/* ---------- small helpers (all bop_ prefixed) ---------- */

function bop_ss_() {
  return BOP_SPREADSHEET_ID
    ? SpreadsheetApp.openById(BOP_SPREADSHEET_ID)
    : SpreadsheetApp.getActive();
}

function bop_sheet_(name) {
  var sh = bop_ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet/tab: "' + name + '"');
  return sh;
}

// Return { header:[...], map:{ 'Header': colIndex } } for row 1.
function bop_headerInfo_(sh) {
  var lastCol = Math.max(1, sh.getLastColumn());
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var map = {};
  header.forEach(function (h, i) { if (h) map[h] = i; });
  return { header: header, map: map };
}

// Ensure a column exists; append it to row 1 if missing. Returns fresh info.
function bop_ensureColumn_(sh, header, map, name) {
  if (map[name] !== undefined) return { header: header, map: map };
  sh.getRange(1, header.length + 1).setValue(name);
  return bop_headerInfo_(sh);
}

function bop_setIf_(header, row, map, name, value) {
  if (map[name] !== undefined) row[map[name]] = value;
}

function bop_srUnit_(data) {
  if (data['Sr. Unit']) return data['Sr. Unit'];
  var u = String(data.unit || '').trim();
  return BOP_SR_UNIT_MAP[u] || '';
}

function bop_fmtDateISO_(v) {
  if (v instanceof Date && !isNaN(v)) {
    var tz = Session.getScriptTimeZone() || 'Asia/Manila';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  var s = String(v == null ? '' : v).trim();
  return s;
}

// Format a time cell as "5:30 PM". Handles both Date objects (time-typed
// cells) and plain strings like "5:30:00 PM".
function bop_fmtTime_(v) {
  if (v instanceof Date && !isNaN(v)) {
    var tz = Session.getScriptTimeZone() || 'Asia/Manila';
    return Utilities.formatDate(v, tz, 'h:mm a');
  }
  var s = String(v == null ? '' : v).trim();
  // Drop trailing ":00" seconds if present ("5:30:00 PM" -> "5:30 PM").
  return s.replace(/(\d{1,2}:\d{2}):\d{2}(\s*[AaPp][Mm])/, '$1$2');
}

function bop_uuid_() {
  return Utilities.getUuid();
}

// Wrap a value as a JSON ContentService response (use your own if you have one).
function bop_json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- handlers ---------- */

/**
 * Upsert one 'BOP Guests' row by entryID (registration or attendance,
 * last write wins). `data.advisor` / `data.unit` come from the proxy.
 */
function bopPost_(data) {
  data = data || {};
  var sh = bop_sheet_(BOP_SHEET_GUESTS);
  var info = bop_headerInfo_(sh);
  var header = info.header, map = info.map;

  ['Advisor','Unit','Sr. Unit','Guest Name','Event Name','Event Date',
   'Registration Status','Attendance','Remarks','entryID','lastModified']
    .forEach(function (c) { var r = bop_ensureColumn_(sh, header, map, c); header = r.header; map = r.map; });

  var row = new Array(header.length).fill('');
  bop_setIf_(header, row, map, 'Advisor', data.advisor || '');
  bop_setIf_(header, row, map, 'Unit', data.unit || '');
  bop_setIf_(header, row, map, 'Sr. Unit', bop_srUnit_(data));
  bop_setIf_(header, row, map, 'Guest Name', data.guestName || '');
  bop_setIf_(header, row, map, 'Event Name', data.eventName || '');
  bop_setIf_(header, row, map, 'Event Date', data.eventDate || '');
  bop_setIf_(header, row, map, 'Registration Status', data.registrationStatus || 'Registered');
  bop_setIf_(header, row, map, 'Attendance', data.attendance || '');
  bop_setIf_(header, row, map, 'Remarks', data.remarks || '');

  var entryId = data.id || data.entryID || bop_uuid_();
  row[map['entryID']] = entryId;
  row[map['lastModified']] = new Date();

  var lastRow = sh.getLastRow();
  if (lastRow > 1) {
    var idCol = map['entryID'] + 1;
    var ids = sh.getRange(2, idCol, lastRow - 1, 1).getValues().map(function (r) { return String(r[0] || ''); });
    var found = ids.indexOf(String(entryId));
    if (found >= 0) sh.getRange(found + 2, 1, 1, row.length).setValues([row]);
    else sh.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);
  } else {
    sh.getRange(2, 1, 1, row.length).setValues([row]);
  }
  return { ok: true, id: String(entryId) };
}

/** List every event from the 'BOPs' tab for the Recruit picker. */
function bopsGet_() {
  var sh = bop_sheet_(BOP_SHEET_EVENTS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, events: [] };

  var info = bop_headerInfo_(sh);
  var map = info.map, header = info.header;
  var vals = sh.getRange(2, 1, lastRow - 1, header.length).getValues();
  var get = function (row, h) { return map[h] !== undefined ? row[map[h]] : ''; };

  var events = [];
  for (var i = 0; i < vals.length; i++) {
    var name = String(get(vals[i], 'Event Name') || '').trim();
    if (!name) continue;
    events.push({
      eventName: name,
      eventDate: bop_fmtDateISO_(get(vals[i], 'Event Date')),
      location: String(get(vals[i], 'Location') || '').trim(),
      startTime: bop_fmtTime_(get(vals[i], 'Start Time')),
      endTime: bop_fmtTime_(get(vals[i], 'End Time')),
      registered: Number(get(vals[i], 'Registered') || 0),
      showUp: Number(get(vals[i], 'Show-Up') || 0),
      remarks: String(get(vals[i], 'Remarks') || ''),
    });
  }
  return { ok: true, events: events };
}

/** Return one advisor's 'BOP Guests' rows. `params.advisor` from the proxy. */
function bopGuestsGet_(params) {
  var advisor = String((params && params.advisor) || '').trim();
  var sh = bop_sheet_(BOP_SHEET_GUESTS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, guests: [] };

  var info = bop_headerInfo_(sh);
  var map = info.map, header = info.header;
  var vals = sh.getRange(2, 1, lastRow - 1, header.length).getValues();
  var get = function (row, h) { return map[h] !== undefined ? row[map[h]] : ''; };
  var af = advisor.toLowerCase();

  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (af && map['Advisor'] !== undefined &&
        String(row[map['Advisor']] || '').trim().toLowerCase() !== af) continue;
    var name = String(get(row, 'Guest Name') || '').trim();
    if (!name) continue;
    out.push({
      entryID: String(get(row, 'entryID') || ''),
      guestName: name,
      eventName: String(get(row, 'Event Name') || ''),
      eventDate: bop_fmtDateISO_(get(row, 'Event Date')),
      registrationStatus: String(get(row, 'Registration Status') || ''),
      attendance: String(get(row, 'Attendance') || ''),
      remarks: String(get(row, 'Remarks') || ''),
    });
  }
  return { ok: true, guests: out };
}

/** OPTIONAL one-time helper: create the 'BOP Guests' tab with headers. */
function bopSetupGuestsTab() {
  var ss = bop_ss_();
  var sh = ss.getSheetByName(BOP_SHEET_GUESTS) || ss.insertSheet(BOP_SHEET_GUESTS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, BOP_GUEST_HEADERS.length).setValues([BOP_GUEST_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return { ok: true, sheet: BOP_SHEET_GUESTS, headers: BOP_GUEST_HEADERS };
}
