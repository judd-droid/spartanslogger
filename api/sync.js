// api/sync.js  (Vercel Serverless Function, CommonJS)
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
        if (req.query.debug === "1") {
          return res.status(200).json({
            BB_URL,
            BB_KEY_length: BB_KEY.length,
            BB_KEY_first6: BB_KEY.slice(0, 6),
            BB_KEY_last6: BB_KEY.slice(-6),
          });
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
