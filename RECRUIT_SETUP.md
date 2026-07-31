# Recruit / BOP Guests — setup for the Appointment 15 Logger

This wires the new **Recruit** tab to the Google Sheet. Three parts, in order.

## 1. Google Sheet — tabs

You already added these. Confirm the header rows (row 1) match exactly:

**`BOP Guests`**

| Advisor | Unit | Sr. Unit | Guest Name | Event Name | Event Date | Registration Status | Attendance | Remarks | entryID | lastModified |
|---|---|---|---|---|---|---|---|---|---|---|

**`BOPs`** (the event picker reads this)

| Event Name | Event Date | Registered | Show-Up | Remarks |
|---|---|---|---|---|

`Registered` / `Show-Up` can be formulas counting the `BOP Guests` tab (e.g.
`COUNTIFS`), or plain numbers — the app only reads them, it never writes them.
The app writes **only** to `BOP Guests`.

## 2. Apps Script — add `bop.gs` and wire the routes

1. In the Sheet: **Extensions ▸ Apps Script**.
2. Add a new script file (the **＋** next to *Files*), name it `bop`, and paste
   the full contents of [`bop.gs`](./bop.gs). Save.
3. In your **existing** `Code.gs`, add the routes below to `doGet` and `doPost`.

Inside **`doGet(e)`** (near your other `path` checks):

```js
if (e && e.parameter && e.parameter.path === 'bops')
  return bop_json_(bopsGet_());
if (e && e.parameter && e.parameter.path === 'bopguests')
  return bop_json_(bopGuestsGet_(e.parameter));
```

Inside **`doPost(e)`**, after you have parsed the body into `data` and read
`path` (the request arrives as `?path=bop`):

```js
if (path === 'bop')
  return bop_json_(bopPost_(data));
```

> If your `doGet`/`doPost` already build responses with your own JSON helper,
> call `bopsGet_()` / `bopGuestsGet_(...)` / `bopPost_(...)` and pass the result
> to that helper instead of `bop_json_`.

4. **Deploy ▸ Manage deployments ▸ Edit ▸ Deploy** to publish the new version
   (Apps Script serves the *deployed* version to the proxy, not the editor).

## 3. Vercel proxy

`api/sync.js` already forwards the new paths (`bops`, `bopguests` on GET; `bop`
on POST) with the validated advisor. No env-var changes are needed — it reuses
`APPS_SCRIPT_URL` and `ADVISOR_KEYS`. Redeploy the site so the updated
`api/sync.js` ships.

## How it works

- **Recruit tab** loads events from `BOPs` (filtered to roughly ±1 month) and
  the signed-in advisor's rows from `BOP Guests`.
- **Register** upserts one `BOP Guests` row (`Registration Status = Registered`);
  offline registrations queue and retry like meetings/prospecting.
- **Attendance** is display-only in the app — a guest shows a green check once
  their `Attendance` cell reads `Yes` (set on the Sheet / by admin).
