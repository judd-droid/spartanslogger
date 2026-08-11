/****************************************************************************
 * Appointment 15 Logger — Telethon / Prospecting history backend (Apps Script)
 * ------------------------------------------------------------------------
 * Add this as a NEW script file in the Apps Script project bound to the
 * Appointment 15 Logger Google Sheet (Extensions ▸ Apps Script ▸ +).
 * Self-contained: every helper is prefixed `psh_` so it won't clash with the
 * functions already in Code.gs / bop.gs / calendar.gs.
 *
 * READ-ONLY. This only returns the signed-in advisor's own prospecting rows so
 * the Telethon page can show an Approach / Set History below the counters. The
 * app already WRITES prospecting rows through your existing `path=prospecting`
 * handler in Code.gs — this file does not touch writes.
 *
 * Identity model: the Vercel proxy validates the advisor + sync key and
 * forwards a trusted `advisor` (query param on GET). This handler reads that
 * advisor directly and returns only that advisor's rows.
 *
 * ONE TAB REQUIRED — the tab your `path=prospecting` POST already writes to.
 * Set PSH_SHEET below to that tab's exact name (default 'Prospecting'). Only
 * the header NAMES matter, not their order — the handler matches by header
 * text and tolerates extra columns. Recognised headers (any subset):
 *   Advisor | Unit | Week Ending | Approaches | Set Appointments | Timestamp
 *
 * Header aliases accepted (case-insensitive):
 *   Week Ending      → 'Week Ending', 'WeekEnding', 'Week'
 *   Approaches       → 'Approaches', 'Approach'
 *   Set Appointments → 'Set Appointments', 'SetAppointments', 'Set Apps',
 *                      'Appointments Set', 'Set'
 *   Timestamp        → 'Timestamp', 'lastModified', 'Date Logged', 'Logged At'
 *
 * WIRING — add this one block to your EXISTING doGet(e):
 *
 *   if (e && e.parameter && e.parameter.path === 'prospectinghistory')
 *     return psh_json_(prospectingHistoryGet_(e.parameter));
 *
 * (`psh_json_` just wraps ContentService — reuse your own JSON helper if you
 * prefer and keep only prospectingHistoryGet_.)
 ****************************************************************************/

// Leave blank to use the bound spreadsheet (recommended for a container-bound
// script). Set an ID only if this script is standalone.
var PSH_SPREADSHEET_ID = '';

// The tab your existing `path=prospecting` POST writes to. Confirm this name
// matches your Sheet exactly.
var PSH_SHEET = 'Prospecting';

// Prospecting rows are authored/summarised in Philippine time. Format any raw
// Date cells in this zone so output never drifts with the project timezone.
var PSH_TZ = 'Asia/Manila';

// Header text (lower-cased) → canonical field. First match wins.
var PSH_ALIASES = {
  advisor:          ['advisor'],
  unit:             ['unit'],
  weekEnding:       ['week ending', 'weekending', 'week'],
  approaches:       ['approaches', 'approach'],
  setAppointments:  ['set appointments', 'setappointments', 'set apps',
                     'appointments set', 'set'],
  timestamp:        ['timestamp', 'lastmodified', 'date logged', 'logged at'],
};

/* ---------- small helpers (all psh_ prefixed) ---------- */

function psh_ss_() {
  return PSH_SPREADSHEET_ID
    ? SpreadsheetApp.openById(PSH_SPREADSHEET_ID)
    : SpreadsheetApp.getActive();
}

function psh_sheet_(name) {
  var sh = psh_ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet/tab: "' + name + '"');
  return sh;
}

// Build { field: colIndex } by matching row-1 headers against PSH_ALIASES.
function psh_fieldCols_(sh) {
  var lastCol = Math.max(1, sh.getLastColumn());
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });
  var cols = {};
  Object.keys(PSH_ALIASES).forEach(function (field) {
    var names = PSH_ALIASES[field];
    for (var i = 0; i < header.length; i++) {
      if (names.indexOf(header[i]) !== -1) { cols[field] = i; break; }
    }
  });
  return { cols: cols, width: lastCol };
}

// Normalise a date cell to ISO yyyy-MM-dd, matching calendar.gs behaviour.
function psh_fmtDateISO_(v) {
  if (v instanceof Date && !isNaN(v)) {
    return Utilities.formatDate(v, PSH_TZ, 'yyyy-MM-dd');
  }
  var s = String(v == null ? '' : v).trim();
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return iso[1] + '-' + psh_pad2_(iso[2]) + '-' + psh_pad2_(iso[3]);
  var us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return us[3] + '-' + psh_pad2_(us[1]) + '-' + psh_pad2_(us[2]);
  return s;
}

function psh_pad2_(n) { return String(n).length < 2 ? '0' + n : String(n); }

function psh_json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- handler ---------- */

/**
 * Return one advisor's prospecting rows for the Telethon history, newest
 * first. `params.advisor` comes from the proxy (trusted). Rows with neither an
 * approach nor a set appointment are skipped.
 */
function prospectingHistoryGet_(params) {
  var advisor = String((params && params.advisor) || '').trim();
  var sh = psh_sheet_(PSH_SHEET);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, rows: [] };

  var info = psh_fieldCols_(sh);
  var cols = info.cols;
  var vals = sh.getRange(2, 1, lastRow - 1, info.width).getDisplayValues();
  var raw  = sh.getRange(2, 1, lastRow - 1, info.width).getValues();
  var af = advisor.toLowerCase();
  var num = function (v) { var n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };

  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (af && cols.advisor !== undefined &&
        String(row[cols.advisor] || '').trim().toLowerCase() !== af) continue;

    var approaches = cols.approaches !== undefined ? num(row[cols.approaches]) : 0;
    var setApps    = cols.setAppointments !== undefined ? num(row[cols.setAppointments]) : 0;
    if (approaches === 0 && setApps === 0) continue;

    // Prefer the raw value for dates (real Date objects format cleanly); fall
    // back to displayed text when the cell is plain text.
    var weRaw = cols.weekEnding !== undefined ? raw[i][cols.weekEnding] : '';
    var tsRaw = cols.timestamp  !== undefined ? raw[i][cols.timestamp]  : '';

    out.push({
      advisor:         cols.advisor !== undefined ? String(row[cols.advisor] || '').trim() : advisor,
      unit:            cols.unit !== undefined ? String(row[cols.unit] || '').trim() : '',
      weekEnding:      psh_fmtDateISO_(weRaw),
      approaches:      approaches,
      setAppointments: setApps,
      timestamp:       tsRaw instanceof Date ? psh_fmtDateISO_(tsRaw) : String(tsRaw || '').trim(),
    });
  }

  // Newest first: by weekEnding, then timestamp.
  out.sort(function (a, b) {
    return String(b.weekEnding + ' ' + b.timestamp)
      .localeCompare(String(a.weekEnding + ' ' + a.timestamp));
  });

  return { ok: true, rows: out };
}
