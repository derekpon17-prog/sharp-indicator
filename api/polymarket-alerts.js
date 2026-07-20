/* =========================================================
   api/polymarket-alerts.js
   Upstash Redis via REST — no npm packages needed
   GET  → returns stored alerts
   POST → stores a new alert with dedup
   ========================================================= */

const ALERTS_KEY = 'pm:alerts';
const MAX_ALERTS = 200;

async function upstash(body) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_NOT_CONFIGURED');
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const configured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

  try {
    /* ── GET: return stored alerts ── */
    if (req.method === 'GET') {
      if (!configured) return res.status(200).json({ alerts: [], count: 0, configured: false });
      const raw  = await upstash(['LRANGE', ALERTS_KEY, 0, MAX_ALERTS - 1]);
      const alerts = (raw || []).map(item => {
        try { return typeof item === 'string' ? JSON.parse(item) : item; }
        catch { return null; }
      }).filter(Boolean);
      return res.status(200).json({ alerts, count: alerts.length, configured: true });
    }

    /* ── POST: store a new alert ── */
    if (req.method === 'POST') {
      if (!configured) return res.status(200).json({ ok: false, error: 'Upstash not configured' });

      const alert = req.body;
      if (!alert) return res.status(400).json({ error: 'Empty body' });

      // Dedup by transaction hash — 7-day TTL
      const txKey = `pm:tx:${alert.transactionHash || (alert.wallet || '') + (alert.timestamp || '') + (alert.title || '').slice(0, 20)}`;
      const exists = await upstash(['GET', txKey]);
      if (exists) return res.status(200).json({ ok: true, duplicate: true });

      await upstash(['SET', txKey, '1', 'EX', 604800]);

      alert.loggedAt = alert.loggedAt || Date.now();
      await upstash(['LPUSH', ALERTS_KEY, JSON.stringify(alert)]);
      await upstash(['LTRIM', ALERTS_KEY, 0, MAX_ALERTS - 1]);

      return res.status(200).json({ ok: true, stored: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[alerts]', err.message);
    if (err.message === 'UPSTASH_NOT_CONFIGURED') {
      return res.status(200).json({ alerts: [], count: 0, configured: false,
        setup: 'Go to Vercel Storage → Upstash for Redis → Connect to project' });
    }
    return res.status(200).json({ ok: false, error: err.message });
  }
};
