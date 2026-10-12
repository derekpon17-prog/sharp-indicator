/* =========================================================
   api/discord-report.js
   PURPOSE (per Derek, 2026-10-12): post the NFL props model report card to Derek's Discord.
   Flow: a scheduled Claude run (using Derek's Chrome) opens this site and, from a page on this
   same origin, POSTs {parts: ["...", "..."]} here. This function posts each part to the Discord
   webhook stored in the `nflreports` env var. The webhook URL never leaves Vercel.
   Guards (no shared secret needed):
     - POST only, JSON body, 1-6 parts, each trimmed to 1,990 chars, first part must start "NFL Props"
     - browser same-origin check (Origin header + Sec-Fetch-Site)
     - rate limit: at most 2 posts per 10-minute window, counted in the project's existing KV store
   Standalone: touches no other endpoint, env var or alert.
   ========================================================= */
const ORIGIN = 'https://sharp-indicator-a34j.vercel.app';

async function kvIncr(key, ttlSeconds) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return 0; // no KV configured: skip rate limit rather than block
  const h = { Authorization: `Bearer ${token}` };
  const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, { headers: h });
  const j = await r.json().catch(() => ({}));
  if (j.result === 1) await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, { headers: h });
  return Number(j.result || 0);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const origin = req.headers.origin || '';
    const site = req.headers['sec-fetch-site'] || '';
    if (origin !== ORIGIN || site !== 'same-origin') return res.status(403).json({ error: 'forbidden' });

    const hook = process.env.nflreports;
    if (!hook) return res.status(500).json({ error: 'missing nflreports env var' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const parts = (Array.isArray(body.parts) ? body.parts : []).map(p => String(p).slice(0, 1990)).filter(Boolean);
    if (!parts.length || parts.length > 6) return res.status(400).json({ error: 'need 1-6 parts' });
    if (!parts[0].startsWith('NFL Props')) return res.status(400).json({ error: 'first part must start with "NFL Props"' });

    const bucket = Math.floor(Date.now() / 600000);
    const n = await kvIncr(`nflreport:posts:${bucket}`, 900);
    if (n > 2) return res.status(429).json({ error: 'rate limited: 2 posts per 10 minutes' });

    for (const content of parts) {
      const d = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, username: 'Sharp Props Model', allowed_mentions: { parse: [] } }),
      });
      if (!d.ok) return res.status(502).json({ error: `discord returned ${d.status}` });
      await new Promise(s => setTimeout(s, 700)); // stay under Discord rate limits
    }
    return res.status(200).json({ posted: parts.length });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
