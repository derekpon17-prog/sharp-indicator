/* =========================================================
   api/watched-wallets.js
   Upstash Redis — same KV_REST_API_URL / KV_REST_API_TOKEN as everything else.

   PURPOSE (per Derek, 2026-08-14, real incident): laozishudaosan — a real, tracked 7-1
   (+61%) wallet Derek has personally watched — bought Chicago White Sox on the exact
   game a 4-trader Detroit Tigers convergence fired on, and neither the alert nor the
   Discord contrast line ever showed him. Root cause, confirmed directly in the notify
   cron: the entire alert pipeline only ever fetches trades for wallets it already knows
   about — Polymarket's leaderboard, plus the discovered specialist roster. A wallet
   Derek has personally chosen to watch, with a real tracked record already computed
   client-side, was invisible to the server simply because nothing told the server it
   existed. This is that bridge — same shape and same full-snapshot-replace pattern as
   trader-records.js, just for the watched-wallet list instead of the W-L summary.

   GET  → returns the current stored list: { wallets: [{wallet, name}], configured }
   POST → overwrites the whole list. Client always sends its full current pm:traders
          array — same reasoning as trader-records.js: the client is the one
          authoritative source, no cross-device merge logic needed here.
   ========================================================= */

const WALLETS_KEY = 'pm:watched-wallets';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const raw = await upstash(['GET', WALLETS_KEY]);
      let wallets = [];
      if (raw) { try { wallets = JSON.parse(raw); } catch {} }
      return res.status(200).json({ ok: true, wallets, configured: !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) });
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body || !Array.isArray(body.wallets)) {
        return res.status(400).json({ error: 'Expected { wallets: [{wallet, name}] }' });
      }
      // Shape guard — only keep entries that look like a real wallet, so a malformed
      // client payload can't corrupt what the cron reads back.
      const clean = body.wallets
        .filter(w => w && typeof w.wallet === 'string' && w.wallet.startsWith('0x'))
        .map(w => ({ wallet: w.wallet, name: typeof w.name === 'string' ? w.name : null }));
      await upstash(['SET', WALLETS_KEY, JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, stored: clean.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
};
