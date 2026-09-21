/****************************************************************************
 * Appointment 15 Logger — Agency Calendar backend (Apps Script)
 * ------------------------------------------------------------------------
 * Add this as a NEW script file in the Apps Script project bound to the
 * Appointment 15 Logger Google Sheet (Extensions ▸ Apps Script ▸ +).
 * Self-contained: every helper is prefixed `cal_` so it won't clash with
 * the functions already in Code.gs / bop.gs.
 *
 * READ-ONLY. The app never writes here — you manage all events directly in
 * Google Calendar. Identity is still validated by the Vercel proxy
 * (advisor+key), but the handler doesn't filter by advisor: everyone sees
 * the same agency calendar.
 *
 * SOURCE — one or more Google Calendars (see CAL_SOURCES below). This
 * replaces the old 'Calendar' sheet tab. Recurring events are expanded to
 * individual instances automatically by CalendarApp.getEvents().
 *
 * ACCESS — the account that OWNS this Apps Script project must be able to
 * read every calendar in CAL_SOURCES (share it as "See all event details",
 * or subscribe to it in that account's Google Calendar). Reading calendars
 * adds an OAuth scope, so after adding this file you must re-run any
 * function once from the editor, approve the Calendar permission, then
 * re-deploy the web app (Deploy ▸ Manage deployments ▸ Edit ▸ New version).
 * The /exec URL stays the same unless you create a brand-new deployment.
 *
 * WIRING — add this one block to your EXISTING doGet(e):
 *
 *   if (e && e.parameter && e.parameter.path === 'calendar')
 *     return cal_json_(calendarGet_());
 *
 * (`cal_json_` just wraps ContentService — reuse your own JSON helper if you
 * prefer and keep only calendarGet_.)
 ****************************************************************************/

// The calendars to surface, each mapped to a color bucket the app already
// understands. `type` drives the color in the app:
//   • a value starting with "AIA" → pink/red (AIA / company events)
//   • anything else                → purple  (treated as an Agency event)
// Add more { id, type } entries here to fold in additional calendars.
var CAL_SOURCES = [
  {
    id: '0289f7036999854c823877496fe767abae0b1c9d02a787ed8356fb8b3fc22627@group.calendar.google.com',
    type: 'Agency', // Supernova 3.1 - Spartans (internal agency events → purple)
  },
];

// Event date/times are rendered in Philippine time so they never drift with
// whatever the Apps Script project's timezone happens to be set to.
var CAL_TZ = 'Asia/Manila';

// Rolling window to pull. Calendar (unlike the old sheet) needs an explicit
// range; recurring series are expanded to instances inside it.
var CAL_WINDOW_BACK_DAYS = 31;    // ~1 month of history
var CAL_WINDOW_FWD_DAYS  = 365;   // ~12 months ahead

// Short server-side cache so opening the Calendar tab doesn't hit Google
// Calendar on every request. Bump the version to bust it after code changes.
var CAL_CACHE_KEY = 'cal_events_v1';
var CAL_CACHE_SECS = 300;         // 5 minutes
var CAL_CACHE_MAX_BYTES = 95000;  // CacheService caps a value at 100 KB

/* ---------- small helpers (all cal_ prefixed) ---------- */

function cal_json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function cal_fmtDateISO_(d) {
  return Utilities.formatDate(d, CAL_TZ, 'yyyy-MM-dd');
}

function cal_fmtTime_(d) {
  // Short wall-clock time in Philippine time, e.g. "9:00 AM".
  return Utilities.formatDate(d, CAL_TZ, 'h:mm a');
}

// Map one CalendarEvent to the app's event object. Keeps the exact shape the
// front-end and proxy already expect from the old sheet-backed handler.
function cal_mapEvent_(ev, type) {
  var start = ev.getStartTime();
  var end = ev.getEndTime();
  var allDay = ev.isAllDayEvent();

  var startISO = cal_fmtDateISO_(start);
  var endISO;
  if (allDay) {
    // Google's all-day end is EXCLUSIVE (midnight of the day after the last
    // day). Step back one day so a single all-day event ends on its own day
    // and multi-day spans read inclusively.
    var endInclusive = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    endISO = cal_fmtDateISO_(endInclusive);
    if (endISO < startISO) endISO = startISO;
  } else {
    endISO = cal_fmtDateISO_(end);
  }

  return {
    eventName: String(ev.getTitle() || '').trim(),
    startDate: startISO,
    endDate: endISO || startISO,
    startTime: allDay ? '' : cal_fmtTime_(start),
    endTime: allDay ? '' : cal_fmtTime_(end),
    type: type,
    location: String(ev.getLocation() || '').trim(),
    audience: '',
    details: String(ev.getDescription() || '').trim(),
  };
}

/* ---------- handler ---------- */

/** List every event across CAL_SOURCES within the rolling window. */
function calendarGet_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CAL_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  var now = new Date();
  var from = new Date(now.getTime() - CAL_WINDOW_BACK_DAYS * 24 * 60 * 60 * 1000);
  var to = new Date(now.getTime() + CAL_WINDOW_FWD_DAYS * 24 * 60 * 60 * 1000);

  var events = [];
  for (var i = 0; i < CAL_SOURCES.length; i++) {
    var src = CAL_SOURCES[i];
    var cal = CalendarApp.getCalendarById(src.id);
    if (!cal) continue; // not shared with this account / bad id — skip quietly
    var found = cal.getEvents(from, to);
    for (var j = 0; j < found.length; j++) {
      var mapped = cal_mapEvent_(found[j], src.type);
      if (mapped.eventName && mapped.startDate) events.push(mapped);
    }
  }

  // Sort by day, then time-of-day (blank all-day times sort first).
  events.sort(function (a, b) {
    if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
    return (a.startTime || '') < (b.startTime || '') ? -1 : 1;
  });

  var result = { ok: true, events: events };

  var payload = JSON.stringify(result);
  if (payload.length <= CAL_CACHE_MAX_BYTES) {
    try { cache.put(CAL_CACHE_KEY, payload, CAL_CACHE_SECS); } catch (e) { /* ignore */ }
  }
  return result;
}

/** OPTIONAL: clear the cached calendar so the next request re-pulls live. */
function calFlushCache() {
  CacheService.getScriptCache().remove(CAL_CACHE_KEY);
  return { ok: true };
}
