/****************************************************************************
 * Appointment 15 Logger: Monday Reports and Gameplans backend (Apps Script)
 * ------------------------------------------------------------------------
 * Add this as a NEW script file in the Apps Script project that is bound to
 * the Appointment 15 Logger Google Sheet (Extensions > Apps Script > +), and
 * name it `gameplan`. Every helper is prefixed `gp_` so it will not clash
 * with the functions already in Code.gs. See GAMEPLAN_SETUP.md.
 *
 * What it stores (tabs are created on first use, headers included):
 *   'Gameplans'  one row per advisor per Monday ACE:
 *       Week | Advisor | Locked At | Report | Worksheet | Answers | Answers Updated
 *     Report and Worksheet are JSON written by the Spartan ACE Dashboard when it
 *     locks the Monday reports (9:00 AM, or on demand with Resend). Answers is
 *     JSON written from the advisor's Logger.
 *   'Settings'   Key | Value | Updated   (holds the team benchmarks)
 *
 * Every request must carry the shared secret (Script Property GAMEPLAN_SECRET,
 * set once in Project Settings > Script Properties). The Logger's server proxy
 * and the Spartan ACE Dashboard hold it; browsers never see it. A request
 * without it gets { ok: false, error: 'forbidden' }.
 *
 * WIRING: add these blocks to your EXISTING doGet / doPost.
 *
 *   // inside doGet(e):
 *   if (e && e.parameter && e.parameter.path === 'gameplans')
 *     return gp_json_(gameplansGet_(e.parameter));
 *   if (e && e.parameter && e.parameter.path === 'gpsettings')
 *     return gp_json_(gpSettingsGet_(e.parameter));
 *
 *   // inside doPost(e), after you parse `data` and read `path`:
 *   if (path === 'gameplanlock') return gp_json_(gameplanLock_(data));
 *   if (path === 'gameplananswers') return gp_json_(gameplanAnswers_(data));
 *   if (path === 'gpsettings') return gp_json_(gpSettingsPost_(data));
 ****************************************************************************/

var GP_SPREADSHEET_ID = '';            // blank = the bound spreadsheet
var GP_SHEET = 'Gameplans';
var GP_SETTINGS = 'Settings';
var GP_HEADERS = ['Week', 'Advisor', 'Locked At', 'Report', 'Worksheet', 'Answers', 'Answers Updated'];
var GP_SETTINGS_HEADERS = ['Key', 'Value', 'Updated'];
var GP_HISTORY = 26;                   // weeks of history returned to an advisor

function gp_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function gp_ss_() {
  return GP_SPREADSHEET_ID ? SpreadsheetApp.openById(GP_SPREADSHEET_ID) : SpreadsheetApp.getActive();
}

function gp_sheet_(name, headers) {
  var ss = gp_ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function gp_authorized_(secret) {
  var want = PropertiesService.getScriptProperties().getProperty('GAMEPLAN_SECRET');
  return !!want && String(secret || '') === want;
}

function gp_key_(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function gp_weekStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Manila', 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function gp_parse_(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

function gp_rowObj_(r) {
  return {
    week: gp_weekStr_(r[0]),
    advisor: String(r[1] || ''),
    lockedAt: r[2] instanceof Date ? r[2].toISOString() : String(r[2] || ''),
    report: gp_parse_(r[3], null),
    worksheet: gp_parse_(r[4], []),
    answers: gp_parse_(r[5], {}),
    answersUpdated: r[6] instanceof Date ? r[6].toISOString() : String(r[6] || ''),
  };
}

function gp_rows_() {
  var sh = gp_sheet_(GP_SHEET, GP_HEADERS);
  var last = sh.getLastRow();
  if (last < 2) return { sh: sh, values: [] };
  return { sh: sh, values: sh.getRange(2, 1, last - 1, GP_HEADERS.length).getValues() };
}

/* ---------- GET ---------- */

// ?path=gameplans&secret=..&advisor=Name   -> that advisor's recent weeks, newest first
// ?path=gameplans&secret=..&week=YYYY-MM-DD -> everyone's row for that week (leaders' view)
function gameplansGet_(p) {
  if (!gp_authorized_(p.secret)) return { ok: false, error: 'forbidden' };
  var rows = gp_rows_().values.map(gp_rowObj_);
  if (p.advisor) {
    var k = gp_key_(p.advisor);
    rows = rows.filter(function (r) { return gp_key_(r.advisor) === k; });
    rows.sort(function (a, b) { return a.week < b.week ? 1 : -1; });
    return { ok: true, items: rows.slice(0, GP_HISTORY) };
  }
  if (p.week) {
    return { ok: true, items: rows.filter(function (r) { return r.week === p.week; }) };
  }
  var weeks = {};
  rows.forEach(function (r) { weeks[r.week] = true; });
  return { ok: true, weeks: Object.keys(weeks).sort().reverse() };
}

function gpSettingsGet_(p) {
  if (!gp_authorized_(p.secret)) return { ok: false, error: 'forbidden' };
  var sh = gp_sheet_(GP_SETTINGS, GP_SETTINGS_HEADERS);
  var last = sh.getLastRow();
  var vals = last < 2 ? [] : sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(p.key)) return { ok: true, value: gp_parse_(vals[i][1], null) };
  }
  return { ok: true, value: null };
}

/* ---------- POST ---------- */

// { secret, week, items: [{ advisor, report, worksheet }] }
// Writes or replaces each advisor's locked report and worksheet for the week. Answers already
// written are kept for every worksheet section that is still there (matched by its gapKey).
function gameplanLock_(d) {
  if (!gp_authorized_(d.secret)) return { ok: false, error: 'forbidden' };
  if (!d.week || !d.items || !d.items.length) return { ok: false, error: 'week and items are required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var got = gp_rows_();
    var sh = got.sh, values = got.values;
    var at = {};
    values.forEach(function (r, i) { at[gp_weekStr_(r[0]) + '|' + gp_key_(r[1])] = i; });
    var now = new Date();
    var appended = [];
    var written = 0;
    d.items.forEach(function (it) {
      var key = d.week + '|' + gp_key_(it.advisor);
      var sections = (it.worksheet || []).map(function (s) { return s.gapKey; });
      if (key in at) {
        var i = at[key];
        var answers = gp_parse_(values[i][5], {});
        var kept = {};
        Object.keys(answers).forEach(function (k) {
          if (k === 'notes' || sections.indexOf(k) >= 0) kept[k] = answers[k];
        });
        sh.getRange(i + 2, 3, 1, 4).setValues([[now, JSON.stringify(it.report), JSON.stringify(it.worksheet || []), JSON.stringify(kept)]]);
      } else {
        appended.push([d.week, it.advisor, now, JSON.stringify(it.report), JSON.stringify(it.worksheet || []), '{}', '']);
      }
      written++;
    });
    if (appended.length) sh.getRange(sh.getLastRow() + 1, 1, appended.length, GP_HEADERS.length).setValues(appended);
    return { ok: true, written: written };
  } finally {
    lock.releaseLock();
  }
}

// { secret, advisor, week, answers }   (advisor is the one the Logger proxy verified)
function gameplanAnswers_(d) {
  if (!gp_authorized_(d.secret)) return { ok: false, error: 'forbidden' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var got = gp_rows_();
    var k = d.week + '|' + gp_key_(d.advisor);
    for (var i = 0; i < got.values.length; i++) {
      var r = got.values[i];
      if (gp_weekStr_(r[0]) + '|' + gp_key_(r[1]) === k) {
        got.sh.getRange(i + 2, 6, 1, 2).setValues([[JSON.stringify(d.answers || {}), new Date()]]);
        return { ok: true };
      }
    }
    return { ok: false, error: 'No report for that week yet' };
  } finally {
    lock.releaseLock();
  }
}

// { secret, key, value }
function gpSettingsPost_(d) {
  if (!gp_authorized_(d.secret)) return { ok: false, error: 'forbidden' };
  var sh = gp_sheet_(GP_SETTINGS, GP_SETTINGS_HEADERS);
  var last = sh.getLastRow();
  var keys = last < 2 ? [] : sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
  var i = keys.indexOf(String(d.key));
  var row = [String(d.key), JSON.stringify(d.value), new Date()];
  if (i >= 0) sh.getRange(i + 2, 1, 1, 3).setValues([row]);
  else sh.getRange(last + 1, 1, 1, 3).setValues([row]);
  return { ok: true };
}
