# Monday Reports and Gameplans: setup

Every Monday at 9:00 AM, the Spartan ACE Dashboard locks each Spartan's Advisor Report for last week and this week's worksheet. Each advisor reads theirs in the Logger's **Reports** tab and fills the worksheet in on the phone. Leaders read every gameplan in the Dashboard's **Gameplans** view (leader login), and can **Resend** to everyone or one advisor at any time.

Everything is stored in this Google Sheet, in two tabs the script creates on first use: **Gameplans** and **Settings** (the team benchmarks).

## 1. Apps Script: add `gameplan.gs` and wire the routes

1. In the Sheet: **Extensions ▸ Apps Script**.
2. Add a new script file (the **＋** next to *Files*), name it `gameplan`, and paste the full contents of [`gameplan.gs`](./gameplan.gs). Save.
3. In your existing `Code.gs`, add these routes.

Inside **`doGet(e)`**, next to your other `path` checks:

```js
if (e && e.parameter && e.parameter.path === 'gameplans')
  return gp_json_(gameplansGet_(e.parameter));
if (e && e.parameter && e.parameter.path === 'gpsettings')
  return gp_json_(gpSettingsGet_(e.parameter));
```

Inside **`doPost(e)`**, after you have parsed the body into `data` and read `path`:

```js
if (path === 'gameplanlock') return gp_json_(gameplanLock_(data));
if (path === 'gameplananswers') return gp_json_(gameplanAnswers_(data));
if (path === 'gpsettings') return gp_json_(gpSettingsPost_(data));
```

4. **Project Settings ▸ Script Properties ▸ Add script property**:
   `GAMEPLAN_SECRET` = a long random value (for example, 40 random letters and numbers). Every request must carry it.
5. **Deploy ▸ Manage deployments ▸ Edit ▸ Version: New version ▸ Deploy.** The /exec URL stays the same.

## 2. Vercel: the Logger (this project)

| Name | Value |
|---|---|
| `GAMEPLAN_SECRET` | The same value as the script property |

## 3. Vercel: the Spartan ACE Dashboard

| Name | Value |
|---|---|
| `GAS_URL` | The Apps Script /exec URL (the same as this project's `APPS_SCRIPT_URL`) |
| `GAMEPLAN_SECRET` | The same value as the script property |
| `LEADER_PASSWORD` | The password that opens the leader views (Gameplans) |
| `CRON_SECRET` | Any long random value. Vercel sends it with the Monday 9:00 AM lock |

Redeploy both projects after adding the values.

## How it behaves

- **Monday, 9:00 AM Manila.** Reports and worksheets lock for every Spartan on the Dashboard's advisor list. Vercel may run the job a few minutes into the hour.
- **Resend** (Gameplans view) rebuilds this week's report and worksheet from the latest numbers. Answers already written are kept for every worksheet section that is still there.
- **Reports tab.** The latest week is editable all week and saves as the advisor types. Earlier weeks are read-only. A red dot shows while this week's gameplan is still blank.
- **Team benchmarks.** When a leader adjusts them on the Dashboard, they are saved to the Settings tab and used by every Dashboard and by the Monday reports.
