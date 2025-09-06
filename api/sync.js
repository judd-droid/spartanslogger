// api/sync.js  (Vercel Serverless Function, CommonJS)
module.exports = async (req, res) => {
  const { since = "", advisor = "" } = req.query;
  const gasUrl = process.env.GAS_SYNC_URL; // set this in Vercel → Settings → Environment Variables

  if (!gasUrl) {
    res.status(500).json({ ok: false, error: "Missing GAS_SYNC_URL env var" });
    return;
  }

  const url = `${gasUrl}?since=${encodeURIComponent(since)}&advisor=${encodeURIComponent(advisor)}`;

  try {
    // Node 18+ on Vercel has global fetch
    const r = await fetch(url, { method: "GET" });
    const text = await r.text(); // pass through GAS response verbatim (JSON)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.status(r.ok ? 200 : r.status || 502).send(text);
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ ok: false, error: String(err) });
  }
};
