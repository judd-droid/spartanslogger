# Telethon — Approach / Set History setup

This wires the **Approach / Set History** list on the Telethon page to the
Google Sheet. It is **read-only**: the app already writes prospecting rows via
your existing `path=prospecting` POST — this only reads those rows back so each
advisor can see their own weekly totals below the counters. Three parts.

## 1. Google Sheet — confirm the tab the POST writes to

Your existing `path=prospecting` handler in `Code.gs` already appends one row
per submit with the advisor, unit, week-ending Sunday, approaches, and set
appointments. Open that tab and confirm its **name** and header row (row 1).

- Set `PSH_SHEET` in [`prospecting.gs`](./prospecting.gs) to that tab's exact
  name (default is `Prospecting`).
- Header **order** doesn't matter — the handler matches by header text and
  tolerates extra columns. It recognises these names (case-insensitive), any
  subset:

| Advisor | Unit | Week Ending | Approaches | Set Appointments | Timestamp |
|---|---|---|---|---|---|

  Accepted aliases: `Week Ending` also matches `WeekEnding`/`Week`;
  `Set Appointments` also matches `SetAppointments`/`Set Apps`/`Appointments
  Set`/`Set`; `Timestamp` also matches `lastModified`/`Date Logged`/`Logged At`.

If your columns already use different names, either rename them to one of the
above or add the name to `PSH_ALIASES` in `prospecting.gs`.

## 2. Apps Script — add `prospecting.gs` and wire the route

1. In the Sheet: **Extensions ▸ Apps Script**.
2. Add a new script file (the **＋** next to *Files*), name it `prospecting`,
   and paste the full contents of [`prospecting.gs`](./prospecting.gs). Save.
3. In your **existing** `Code.gs`, add the route below to `doGet`, near your
   other `path` checks:

   ```js
   if (e && e.parameter && e.parameter.path === 'prospectinghistory')
     return psh_json_(prospectingHistoryGet_(e.parameter));
   ```

   > If your `doGet` builds responses with your own JSON helper, call
   > `prospectingHistoryGet_(e.parameter)` and pass the result to that helper
   > instead of `psh_json_`.

4. **Deploy ▸ Manage deployments ▸ Edit ▸ Deploy** to publish the new version
   (Apps Script serves the *deployed* version to the proxy, not the editor).

## 3. Vercel proxy

`api/sync.js` already forwards the new `prospectinghistory` path on GET with the
validated advisor. No env-var changes are needed — it reuses `APPS_SCRIPT_URL`
and `ADVISOR_KEYS`. Redeploy the site so the updated `api/sync.js` ships.

## How it works

- The Telethon page loads the signed-in advisor's prospecting rows on open (and
  after each successful submit), caching them in `localStorage` so the list
  renders instantly offline.
- Rows are returned **newest first** (by week-ending, then timestamp), and rows
  with neither an approach nor a set appointment are skipped.
- The list shows all-time totals plus one card per week with that week's
  approaches and set-appointment counts. Only the advisor's own rows are ever
  returned — the proxy forwards the validated advisor and the handler filters
  on it.
