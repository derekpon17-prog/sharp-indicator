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
    // FEATURE 2026-08-19 (per Derek): "let ALL activity for him come in, just for his
    // account" -- a per-wallet exception to the normal sport allowlist (the site-wide
    // "no soccer/tennis/UFC" rule stays in place for everyone else). ?setAllSports=0x...
    // sets the flag directly for one wallet, bypassing the client entirely. BUGFIX:
    // this must come BEFORE the general GET handler below -- it was originally placed
    // after, so any GET request (including one with ?setAllSports=) was being
    // intercepted by the general handler first and returning early, never reaching this.
    if ((req.method === 'POST' || req.method === 'GET') && req.query && req.query.setAllSports) {
      const targetWallet = String(req.query.setAllSports);
      const raw = await upstash(['GET', WALLETS_KEY]);
      let wallets = [];
      if (raw) { try { wallets = JSON.parse(raw); } catch {} }
      const idx = wallets.findIndex(w => w.wallet === targetWallet);
      if (idx === -1) return res.status(404).json({ ok: false, error: 'Wallet not found in watched list' });
      wallets[idx].allSports = true;
      await upstash(['SET', WALLETS_KEY, JSON.stringify(wallets)]);
      return res.status(200).json({ ok: true, wallet: targetWallet, allSports: true });
    }

    // FEATURE 2026-08-19 (per Derek): standalone Discord ping when a specifically-flagged
    // wallet makes any real play, regardless of whether anyone else is on it -- same
    // pattern as setAllSports (preserved across client syncs, set directly here).
    // ?setAlwaysAlert=0x...
    if ((req.method === 'POST' || req.method === 'GET') && req.query && req.query.setAlwaysAlert) {
      const targetWallet = String(req.query.setAlwaysAlert);
      const raw = await upstash(['GET', WALLETS_KEY]);
      let wallets = [];
      if (raw) { try { wallets = JSON.parse(raw); } catch {} }
      const idx = wallets.findIndex(w => w.wallet === targetWallet);
      if (idx === -1) return res.status(404).json({ ok: false, error: 'Wallet not found in watched list' });
      wallets[idx].alwaysAlert = true;
      await upstash(['SET', WALLETS_KEY, JSON.stringify(wallets)]);
      return res.status(200).json({ ok: true, wallet: targetWallet, alwaysAlert: true });
    }

    // FIX 2026-08-27 (per Derek, real request): the flip side of setAllSports/
    // setAlwaysAlert above -- those two could turn a flag ON, nothing could turn one
    // back OFF. Needed for laozishudaosan specifically: was pinging standalone for
    // every sport regardless of what Sharp Money actually tracks. This routes it back
    // through the exact same gates every other watched wallet already goes through.
    if ((req.method === 'POST' || req.method === 'GET') && req.query && req.query.clearAllSports) {
      const targetWallet = String(req.query.clearAllSports);
      const raw = await upstash(['GET', WALLETS_KEY]);
      let wallets = [];
      if (raw) { try { wallets = JSON.parse(raw); } catch {} }
      const idx = wallets.findIndex(w => w.wallet === targetWallet);
      if (idx === -1) return res.status(404).json({ ok: false, error: 'Wallet not found in watched list' });
      wallets[idx].allSports = false;
      await upstash(['SET', WALLETS_KEY, JSON.stringify(wallets)]);
      return res.status(200).json({ ok: true, wallet: targetWallet, allSports: false });
    }
    if ((req.method === 'POST' || req.method === 'GET') && req.query && req.query.clearAlwaysAlert) {
      const targetWallet = String(req.query.clearAlwaysAlert);
      const raw = await upstash(['GET', WALLETS_KEY]);
      let wallets = [];
      if (raw) { try { wallets = JSON.parse(raw); } catch {} }
      const idx = wallets.findIndex(w => w.wallet === targetWallet);
      if (idx === -1) return res.status(404).json({ ok: false, error: 'Wallet not found in watched list' });
      wallets[idx].alwaysAlert = false;
      await upstash(['SET', WALLETS_KEY, JSON.stringify(wallets)]);
      return res.status(200).json({ ok: true, wallet: targetWallet, alwaysAlert: false });
    }

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
      // The client is authoritative for wallet/name, but has no concept of allSports --
      // without preserving it here, the NEXT time the client syncs its own list (which
      // happens on every page load), this flag would silently get wiped back out, since
      // the client would send a payload that simply never mentions it.
      const existingRaw = await upstash(['GET', WALLETS_KEY]);
      let existing = [];
      if (existingRaw) { try { existing = JSON.parse(existingRaw); } catch {} }
      const existingByWallet = {};
      existing.forEach(w => { existingByWallet[w.wallet] = w; });

      // Shape guard — only keep entries that look like a real wallet, so a malformed
      // client payload can't corrupt what the cron reads back.
      const clean = body.wallets
        .filter(w => w && typeof w.wallet === 'string' && w.wallet.startsWith('0x'))
        .map(w => ({
          wallet: w.wallet,
          name: typeof w.name === 'string' ? w.name : null,
          allSports: (existingByWallet[w.wallet] && existingByWallet[w.wallet].allSports) === true,
          alwaysAlert: (existingByWallet[w.wallet] && existingByWallet[w.wallet].alwaysAlert) === true,
        }));
      await upstash(['SET', WALLETS_KEY, JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, stored: clean.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
};
