// api/sync.js  (Vercel Serverless Function, CommonJS)
module.exports = async (req, res) => {
  const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
  const GAS_URL = process.env.APPS_SCRIPT_URL;   // set in Vercel env vars
  const RAW_KEYS = process.env.ADVISOR_KEYS || "{}";

  // CORS headers helper
  const setCORS = () => {
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  // Handle preflight
  if (req.method === "OPTIONS") {
    setCORS();
    return res.status(204).end();
  }

  setCORS();

  // Basic env checks
  if (!GAS_URL) {
    return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env var" });
  }

  let keyMap;
  try {
    keyMap = JSON.parse(RAW_KEYS); // { "Judd": "abc...", "Vince Dizon": "def..." }
  } catch {
    return res.status(500).json({ ok: false, error: "Invalid ADVISOR_KEYS JSON" });
  }

  const { since = "", advisor = "", key = "" } = req.query;

  // Find canonical advisor name case-insensitively
  const canonical = Object.keys(keyMap).find(
    (name) => name.toLowerCase() === String(advisor || "").toLowerCase()
  );

  if (!canonical) {
    return res.status(401).json({ ok: false, error: "Unknown advisor" });
  }
  if (String(keyMap[canonical]) !== String(key || "")) {
    return res.status(401).json({ ok: false, error: "Invalid key" });
  }

  // Forward to Apps Script with canonical advisor (do NOT forward the key)
  const url =
    `${GAS_URL}?since=${encodeURIComponent(since)}&advisor=${encodeURIComponent(canonical)}`;

  try {
    const r = await fetch(url, { method: "GET" });
    const text = await r.text(); // pass through GAS response
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(r.ok ? 200 : r.status || 502).send(text);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
