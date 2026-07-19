/* =========================================================
   api/polymarket-alerts.js
   
   Stores alerts in Vercel KV so they persist across devices,
   browsers, and sessions. No more localStorage-only data.
   
   GET  /api/polymarket-alerts        → returns stored alerts
   POST /api/polymarket-alerts        → stores a new alert
   
   Vercel KV setup (one-time, 2 minutes):
   1. vercel.com → your project → Storage tab
   2. Create KV database → name it "sharp-alerts"
   3. Connect to project → auto-adds KV env vars
   4. Redeploy → done
   ========================================================= */

import { kv } from '@vercel/kv';

const ALERTS_KEY   = 'pm:alerts';
const MAX_ALERTS   = 200;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      // Return stored alerts
      const alerts = await kv.lrange(ALERTS_KEY, 0, MAX_ALERTS - 1);
      return res.status(200).json({ alerts: alerts || [], count: (alerts || []).length });
    }

    if (req.method === 'POST') {
      const alert = req.body;
      if (!alert || !alert.wallet) {
        return res.status(400).json({ error: 'Missing alert data' });
      }

      // Deduplicate: check if this transaction already stored
      const txKey = `pm:tx:${alert.transactionHash || alert.wallet + alert.timestamp}`;
      const exists = await kv.get(txKey);
      if (exists) {
        return res.status(200).json({ ok: true, duplicate: true });
      }

      // Mark transaction as stored (expires in 7 days)
      await kv.set(txKey, 1, { ex: 604800 });

      // Prepend to alert list
      alert.loggedAt = alert.loggedAt || Date.now();
      await kv.lpush(ALERTS_KEY, alert);

      // Trim to max
      await kv.ltrim(ALERTS_KEY, 0, MAX_ALERTS - 1);

      return res.status(200).json({ ok: true, stored: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    // KV not configured — graceful fallback
    if (err.message?.includes('KV') || err.message?.includes('kv')) {
      if (req.method === 'GET') return res.status(200).json({ alerts: [], error: 'KV not configured — set up Vercel KV Storage' });
      return res.status(200).json({ ok: false, error: 'KV not configured — see setup instructions' });
    }
    console.error('alerts error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
