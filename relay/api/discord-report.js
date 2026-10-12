/* nfl-props-relay: posts Derek's NFL props model report card to Discord.
   A scheduled Claude run (using Derek's Chrome) opens this site's home page and, from that same origin,
   POSTs {parts: ["NFL Props ...", "..."]} here. Each part goes to the Discord webhook in the
   `nflreports` env var; the webhook URL never appears in any request.
   Guards: POST only; same-origin browser request (Origin = this host, Sec-Fetch-Site = same-origin);
   1-6 parts of up to 1,990 chars, first part must start "NFL Props"; at most 2 posts per 10 minutes
   per instance. */
const recent = [];

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const origin = req.headers.origin || '';
    const site = req.headers['sec-fetch-site'] || '';
    if (origin !== `https://${req.headers.host}` || site !== 'same-origin') return res.status(403).json({ error: 'forbidden' });

    const hook = process.env.nflreports;
    if (!hook) return res.status(500).json({ error: 'missing nflreports env var' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const parts = (Array.isArray(body.parts) ? body.parts : []).map(p => String(p).slice(0, 1990)).filter(Boolean);
    if (!parts.length || parts.length > 6) return res.status(400).json({ error: 'need 1-6 parts' });
    if (!parts[0].startsWith('NFL Props')) return res.status(400).json({ error: 'first part must start with "NFL Props"' });

    const now = Date.now();
    while (recent.length && now - recent[0] > 600000) recent.shift();
    if (recent.length >= 2) return res.status(429).json({ error: 'rate limited: 2 posts per 10 minutes' });
    recent.push(now);

    for (const content of parts) {
      const d = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, username: 'Sharp Props Model', allowed_mentions: { parse: [] } }),
      });
      if (!d.ok) return res.status(502).json({ error: `discord returned ${d.status}` });
      await new Promise(s => setTimeout(s, 700));
    }
    return res.status(200).json({ posted: parts.length });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
