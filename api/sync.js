// api/sync.js  (Vercel Serverless Function, CommonJS)

// ---- Agency calendar (public Google Calendars via the Calendar API) --------
// Which calendars to surface and how each maps to the app's color bucket.
// `type` drives the color: a value starting with "AIA" shows pink/red, any
// other value shows purple (an Agency event).
// Override in Vercel with a GCAL_SOURCES env var holding a JSON array, e.g.
//   [{"id":"abc@group.calendar.google.com","type":"Agency"},
//    {"id":"def@group.calendar.google.com","type":"AIA"}]
const CAL_DEFAULT_SOURCES = [
  {
    id: "0289f7036999854c823877496fe767abae0b1c9d02a787ed8356fb8b3fc22627@group.calendar.google.com",
    type: "Agency", // Supernova 3.1 - Spartans (internal agency events -> purple)
  },
];
const CAL_TZ = "Asia/Manila";     // render dates/times in Philippine time
const CAL_BACK_DAYS = 31;         // rolling window: ~1 month of history
const CAL_FWD_DAYS = 365;         // ...and ~12 months ahead

function calSources() {
  try {
    const raw = process.env.GCAL_SOURCES;
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch { /* fall back to defaults */ }
  return CAL_DEFAULT_SOURCES;
}

const _calDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const _calTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CAL_TZ, hour: "numeric", minute: "2-digit", hour12: true,
});
const calFmtDateISO = (d) => _calDateFmt.format(d);            // 2026-09-23
const calFmtTime = (d) => _calTimeFmt.format(d).toUpperCase(); // 9:00 AM

// Shift a plain yyyy-MM-dd string by N days without timezone drift.
function calShiftDateStr(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Map one Calendar API event resource to the app's event shape.
function calMapEvent(ev, type) {
  const name = String(ev.summary || "").trim();
  const allDay = !!(ev.start && ev.start.date);   // date (not dateTime) => all-day
  let startDate, endDate, startTime = "", endTime = "";

  if (allDay) {
    startDate = ev.start.date;
    // Calendar's all-day end date is EXCLUSIVE; step back a day so a 1-day
    // event ends on its own day and multi-day spans read inclusively.
    const rawEnd = (ev.end && ev.end.date) || ev.start.date;
    endDate = calShiftDateStr(rawEnd, -1);
    if (endDate < startDate) endDate = startDate;
  } else {
    const s = new Date(ev.start.dateTime);
    const e = new Date((ev.end && ev.end.dateTime) || ev.start.dateTime);
    startDate = calFmtDateISO(s);
    endDate = calFmtDateISO(e);
    startTime = calFmtTime(s);
    endTime = calFmtTime(e);
  }

  return {
    eventName: name,
    startDate,
    endDate: endDate || startDate,
    startTime,
    endTime,
    type,
    location: String(ev.location || "").trim(),
    audience: "",
    details: String(ev.description || "").trim(),
  };
}

// Fetch + merge events across all configured calendars, sorted by day/time.
async function getCalendarEvents() {
  const KEY = process.env.GCAL_API_KEY;
  if (!KEY) throw new Error("Missing GCAL_API_KEY env var");

  const now = Date.now();
  const timeMin = new Date(now - CAL_BACK_DAYS * 864e5).toISOString();
  const timeMax = new Date(now + CAL_FWD_DAYS * 864e5).toISOString();

  const out = [];
  for (const src of calSources()) {
    let pageToken = "";
    do {
      const qs = new URLSearchParams({
        key: KEY,
        singleEvents: "true",      // expand recurring series to instances
        orderBy: "startTime",
        maxResults: "2500",
        timeMin, timeMax,
      });
      if (pageToken) qs.set("pageToken", pageToken);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(src.id)}/events?${qs}`;
      const r = await fetch(url);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error((data && data.error && data.error.message) || `Calendar API ${r.status}`);
      }
      for (const ev of (data.items || [])) {
        if (ev.status === "cancelled") continue;
        const mapped = calMapEvent(ev, src.type);
        if (mapped.eventName && mapped.startDate) out.push(mapped);
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
  }

  out.sort((a, b) =>
    a.startDate !== b.startDate
      ? (a.startDate < b.startDate ? -1 : 1)
      : ((a.startTime || "") < (b.startTime || "") ? -1 : 1)
  );
  return out;
}
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  const ORIGIN  = process.env.ALLOWED_ORIGIN || "*";
  const GAS_URL = process.env.APPS_SCRIPT_URL;        // web app URL ending in /exec
  const RAW_KEYS = process.env.ADVISOR_KEYS || "{}";  // e.g. {"Jen":"abc","Judd":"def"}

  // CORS
  const setCORS = () => {
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  };
  if (req.method === "OPTIONS") { setCORS(); return res.status(204).end(); }
  setCORS();

  if (!GAS_URL) return res.status(500).json({ ok:false, error:"Missing APPS_SCRIPT_URL env var" });

  // Parse key map
  let keyMap;
  try { keyMap = JSON.parse(RAW_KEYS); }
  catch { return res.status(500).json({ ok:false, error:"Invalid ADVISOR_KEYS JSON" }); }

  // Safely read JSON body (Next/Vercel usually parses for us)
  let body = {};
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch { body = {}; }

  // Accept advisor from query (GET) or body (POST)
  const advisorRaw =
    (req.query.advisor || body.advisor || "").toString().trim();

  // Accept key via Authorization: Bearer <key> OR ?key=...
  const authHeader = (req.headers.authorization || "").trim();
  const headerKey = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const keyProvided = (headerKey || req.query.key || "").toString();

  // Validate advisor/key
  const canonical = Object.keys(keyMap).find(
    (name) => name.toLowerCase() === advisorRaw.toLowerCase()
  );
  if (!canonical) {
    return res.status(401).json({ ok:false, error:"Unknown advisor" });
  }
  if (String(keyMap[canonical]) !== String(keyProvided)) {
    return res.status(401).json({ ok:false, error:"Invalid key" });
  }

  try {
    if (req.method === "GET") {
      const path = (req.query.path || "").toString();

      if (path === "bigboard") {
        const BB_URL = process.env.BIGBOARD_API_URL;
        const BB_KEY = process.env.LOGGER_API_KEY;
        if (!BB_URL || !BB_KEY) {
          return res.status(500).json({ ok:false, error:"Missing BIGBOARD_API_URL or LOGGER_API_KEY" });
        }

        const resolveUrl = `${GAS_URL}?path=resolveAdvisor&advisor=${encodeURIComponent(canonical)}`;
        const rr = await fetch(resolveUrl);
        const resolved = await rr.json().catch(() => ({}));
        const fullName = resolved && resolved.fullName;
        if (!fullName) return res.status(404).json({ ok:false, error:"No Logger Name match in Roster" });

        const bbUrl = `${BB_URL.replace(/\/$/, "")}/api/logger/summary?advisor=${encodeURIComponent(fullName)}`;
        const br = await fetch(bbUrl, { headers: { Authorization: `Bearer ${BB_KEY}` } });
        const text = await br.text();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        return res.status(br.ok ? 200 : br.status || 502).send(text);
      }

      // Calendar page: list agency events from public Google Calendars,
      // read live via the Calendar API (read-only, same for everyone).
      if (path === "calendar") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        try {
          const events = await getCalendarEvents();
          return res.status(200).json({ ok: true, events });
        } catch (e) {
          return res.status(502).json({ ok: false, error: String(e && e.message || e) });
        }
      }

      // Recruit page: list BOP events, or this advisor's BOP guests.
      if (path === "bops" || path === "bopguests" || path === "prospectinghistory") {
        const url = `${GAS_URL}?path=${encodeURIComponent(path)}&advisor=${encodeURIComponent(canonical)}`;
        const r = await fetch(url, { method: "GET" });
        const text = await r.text();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        return res.status(r.ok ? 200 : r.status || 502).send(text);
      }

      // forward pulls
      const since = (req.query.since || "").toString();
      const url = `${GAS_URL}?since=${encodeURIComponent(since)}&advisor=${encodeURIComponent(canonical)}`;
      const r = await fetch(url, { method:"GET" });
      const text = await r.text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.status(r.ok ? 200 : r.status || 502).send(text);
    }

    if (req.method === "POST") {
      // forward pushes (meetings or prospecting)
      const path = (req.query.path || "").toString(); // e.g. "prospecting"
      // Don’t pass the key through to GAS
      const target = path
        ? `${GAS_URL}?path=${encodeURIComponent(path)}`
        : GAS_URL;

      // Ensure canonical advisor is forwarded
      const forwardBody = { ...body, advisor: canonical };

      const r = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwardBody),
      });
      const text = await r.text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.status(r.ok ? 200 : r.status || 502).send(text);
    }

    // Any other method
    return res.status(405).json({ ok:false, error:"Method not allowed" });
  } catch (err) {
    return res.status(500).json({ ok:false, error:String(err) });
  }
};
