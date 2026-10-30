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
// BOP sessions: the calendars carry the schedule, the 'BOPs' tab keeps the
// sessions already held. Any calendar event with one of these words in its
// title is a BOP. A tab row wins for its day, since guests were logged against
// its name.
const BOP_TITLE = /\b(bop|bfby|odr)\b/i;
const isBopEvent = (ev) => BOP_TITLE.test(ev.eventName);

function mergeCalendarBops(tabEvents, calEvents) {
  const day = (s) => String(s || "").slice(0, 10).replace(/\//g, "-");
  const tabDays = new Set(tabEvents.map((ev) => day(ev.eventDate)));
  const fromCalendar = calEvents
    .filter((ev) => isBopEvent(ev) && !tabDays.has(ev.startDate))
    .map((ev) => ({
      eventName: ev.eventName,
      eventDate: ev.startDate,
      location: ev.location,
      startTime: ev.startTime,
      endTime: ev.endTime,
      registered: 0,
      showUp: 0,
      remarks: ev.details,
    }));
  return tabEvents.concat(fromCalendar);
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

      // The Logger checks a Name and Sync Key pair before it lets a submit
      // through. Reaching this line means the pair passed the check above.
      if (path === "verify") {
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ ok: true, advisor: canonical });
      }

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

      // Playbook tab: the Spartan MDRT Playbook, read-only. The PDF is not in
      // this (public) repo or on this site. It is fetched from Big Board with
      // the server-side key, and only for a caller who passed the advisor/key
      // check above, so there is no open link to it.
      if (path === "playbook") {
        const BB_URL = process.env.BIGBOARD_API_URL;
        const BB_KEY = process.env.LOGGER_API_KEY;
        if (!BB_URL || !BB_KEY) {
          return res.status(500).json({ ok:false, error:"Missing BIGBOARD_API_URL or LOGGER_API_KEY" });
        }
        const pr = await fetch(`${BB_URL.replace(/\/$/, "")}/api/logger/playbook`, {
          headers: { Authorization: `Bearer ${BB_KEY}` },
        });
        if (!pr.ok) {
          return res.status(pr.status === 404 ? 404 : 502).json({ ok:false, error:"Playbook unavailable" });
        }
        const buf = Buffer.from(await pr.arrayBuffer());
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Playbook-Version", pr.headers.get("x-playbook-version") || "");
        res.setHeader("Access-Control-Expose-Headers", "X-Playbook-Version");
        return res.status(200).send(buf);
      }

      // Calendar page: list agency events from public Google Calendars,
      // read live via the Calendar API (read-only, same for everyone).
      if (path === "calendar") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        try {
          // BOPs reach the app through path=bops, so they aren't listed twice.
          const events = (await getCalendarEvents()).filter((ev) => !isBopEvent(ev));
          return res.status(200).json({ ok: true, events });
        } catch (e) {
          return res.status(502).json({ ok: false, error: String(e && e.message || e) });
        }
      }

      // Reports tab: this advisor's Monday reports and gameplans (newest first),
      // read from the Gameplans tab through the Apps Script with the shared
      // secret, which stays on the server.
      if (path === "gameplans") {
        const secret = process.env.GAMEPLAN_SECRET;
        if (!secret) return res.status(500).json({ ok:false, error:"Missing GAMEPLAN_SECRET" });
        const url = `${GAS_URL}?path=gameplans&advisor=${encodeURIComponent(canonical)}&secret=${encodeURIComponent(secret)}`;
        const r = await fetch(url, { method: "GET" });
        const text = await r.text();
        res.setHeader("Cache-Control", "no-store");
        // Name the setup step that is missing rather than failing silently: a reply
        // that isn't a list of items means the Apps Script didn't route path=gameplans.
        let d = null;
        try { d = JSON.parse(text); } catch { /* not JSON */ }
        if (d && d.ok === false && d.error === "forbidden") {
          return res.status(502).json({ ok:false, error:"Apps Script rejected GAMEPLAN_SECRET: the Logger's value doesn't match the script property" });
        }
        if (!d || d.ok !== true || !Array.isArray(d.items)) {
          return res.status(502).json({ ok:false, error: (d && d.error) || "Apps Script doGet has no path=gameplans route, or its new version isn't deployed" });
        }
        return res.status(200).json(d);
      }

      // Recruit page: list BOP events, or this advisor's BOP guests.
      if (path === "bops") {
        const r = await fetch(`${GAS_URL}?path=bops&advisor=${encodeURIComponent(canonical)}`, { method: "GET" });
        const tab = await r.json().catch(() => null);
        const tabEvents = tab && tab.ok && Array.isArray(tab.events) ? tab.events : [];
        let calEvents = [];
        try { calEvents = await getCalendarEvents(); } catch { /* the tab still answers */ }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (!tabEvents.length && !calEvents.length) {
          return res.status(502).json({ ok: false, error: (tab && tab.error) || "Couldn't load BOPs" });
        }
        return res.status(200).json({ ok: true, events: mergeCalendarBops(tabEvents, calEvents) });
      }

      if (path === "bopguests" || path === "prospectinghistory") {
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

      // Reports tab: save this advisor's gameplan answers for one week. Only the
      // verified advisor's own row can be written, and the secret is added here.
      if (path === "gameplananswers") {
        const secret = process.env.GAMEPLAN_SECRET;
        if (!secret) return res.status(500).json({ ok:false, error:"Missing GAMEPLAN_SECRET" });
        const r = await fetch(`${GAS_URL}?path=gameplananswers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ advisor: canonical, week: String(body.week || ""), answers: body.answers || {}, secret }),
        });
        const text = await r.text();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        return res.status(r.ok ? 200 : r.status || 502).send(text);
      }
      // The other Gameplans writes come only from the Spartan ACE Dashboard.
      if (path === "gameplanlock" || path === "gpsettings") {
        return res.status(403).json({ ok:false, error:"Not allowed" });
      }
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
