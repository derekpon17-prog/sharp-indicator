/* =========================================================
   api/polymarket-alerts.js
   Upstash Redis — uses KV_REST_API_URL / KV_REST_API_TOKEN
   (env vars created by Vercel when connecting Upstash for Redis)
   GET  → returns stored alerts (newest first)
   POST → stores a new alert with tx dedup
   ========================================================= */

const ALERTS_KEY = 'pm:alerts';
// BUGFIX 2026-08-09 (per Derek, real integrity issue): confirmed directly — Formal-
// Cupcake's real Aug 8 Orioles/Diamondbacks losses had scrolled off this log entirely by
// the time client-side auto-tracking tried to catch them, with nothing left to recover.
// 200 wasn't enough headroom, especially on busier days. Raised to 500 for real margin;
// worth revisiting again if this recurs at the new size.
// BUGFIX 2026-08-16 (per Derek, real recurring incident): confirmed directly — 500
// entries got consumed in roughly 3 days during a busy stretch, well under the 7-day
// window buildWatchedTrackingCandidates and the specialist backfill logic depend on.
// This is the SECOND time this exact failure mode has cost a real trader's history
// (Formal-Cupcake earlier, laozishudaosan now) — raised meaningfully rather than
// incrementally this time, to actually clear a full week with real safety margin
// instead of needing another bump the next time volume is high.
const MAX_ALERTS = 2000;

async function upstash(body) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV_NOT_CONFIGURED');
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) {
    if (req.method === 'GET') return res.status(200).json({ alerts: [], count: 0, configured: false });
    return res.status(200).json({ ok: false, error: 'KV not configured' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await upstash(['LRANGE', ALERTS_KEY, 0, MAX_ALERTS - 1]);
      const alerts = (raw || []).map(item => {
        try { return typeof item === 'string' ? JSON.parse(item) : item; }
        catch { return null; }
      }).filter(Boolean);
      return res.status(200).json({ alerts, count: alerts.length, configured: true });
    }

    if (req.method === 'POST') {
      const alert = req.body;
      if (!alert) return res.status(400).json({ error: 'Empty body' });

      const txKey = `pm:tx:${alert.transactionHash || (alert.wallet||'')+(alert.timestamp||'')+(alert.title||'').slice(0,20)}`;
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
    if (err.message === 'KV_NOT_CONFIGURED') {
      if (req.method === 'GET') return res.status(200).json({ alerts: [], count: 0, configured: false });
      return res.status(200).json({ ok: false, error: 'KV not configured' });
    }
    console.error('[alerts]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
