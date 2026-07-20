/* =========================================================
   api/polymarket-alerts.js
   
   Persistent alert storage using Upstash Redis
   (replaces Vercel KV — same functionality, different import)
   
   GET  /api/polymarket-alerts  → returns stored alerts
   POST /api/polymarket-alerts  → stores a new alert
   
   Env vars (auto-added when connecting Upstash in Vercel):
     UPSTASH_REDIS_REST_URL
     UPSTASH_REDIS_REST_TOKEN
   ========================================================= */

const ALERTS_KEY = 'pm:alerts';
const MAX_ALERTS = 200;

// Lightweight Upstash REST client — no npm package needed
// Uses their REST API directly so no package.json changes required
async function redis(command, ...args) {
  const url  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS not configured');
  const r = await fetch(`${url}/${[command, ...args].map(a => encodeURIComponent(typeof a === 'object' ? JSON.stringify(a) : a)).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// Upstash REST requires JSON-encoded values for complex types
async function redisPost(body) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS not configured');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Check config
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    if (req.method === 'GET') return res.status(200).json({ alerts: [], count: 0, error: 'Upstash Redis not configured — connect via Vercel Storage tab' });
    return res.status(200).json({ ok: false, error: 'Upstash Redis not configured' });
  }

  try {
    if (req.method === 'GET') {
      // LRANGE pm:alerts 0 199
      const raw = await redisPost(['LRANGE', ALERTS_KEY, 0, MAX_ALERTS - 1]);
      const alerts = (raw || []).map(item => {
        try { return typeof item === 'string' ? JSON.parse(item) : item; }
        catch { return null; }
      }).filter(Boolean);
      return res.status(200).json({ alerts, count: alerts.length });
    }

    if (req.method === 'POST') {
      const alert = req.body;
      if (!alert || !alert.wallet && !alert.title) {
        return res.status(400).json({ error: 'Missing alert data' });
      }

      // Dedup by transaction hash (7-day TTL)
      const txKey = `pm:tx:${alert.transactionHash || (alert.wallet||'') + (alert.timestamp||'')}`;
      const exists = await redisPost(['GET', txKey]);
      if (exists) return res.status(200).json({ ok: true, duplicate: true });

      // Mark as stored
      await redisPost(['SET', txKey, '1', 'EX', '604800']);

      // Prepend alert and trim
      alert.loggedAt = alert.loggedAt || Date.now();
      await redisPost(['LPUSH', ALERTS_KEY, JSON.stringify(alert)]);
      await redisPost(['LTRIM', ALERTS_KEY, 0, MAX_ALERTS - 1]);

      return res.status(200).json({ ok: true, stored: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('alerts error:', err.message);
    if (err.message.includes('configured')) {
      if (req.method === 'GET') return res.status(200).json({ alerts: [], count: 0, error: err.message });
      return res.status(200).json({ ok: false, error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }
}
