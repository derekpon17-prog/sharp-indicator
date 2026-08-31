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
// This is the THIRD time this exact failure mode has recurred (Formal-Cupcake,
// laozishudaosan, now confirmed live 2026-08-29: the log was sitting at exactly 2000/2000
// -- genuinely full, actively evicting -- during a normal MLB trading day. Real, observed
// consequence: a real cross-side comparison (White Sox 3-trader ELITE alert vs. a later
// Twins 2-trader alert on the same game) never got its "Data lean" contrast line because
// the earlier side's alerts had likely already rolled off, despite being well inside the
// nominal 24h window the comparison logic assumes. The 200->500->2000 jump wasn't
// actually enough in practice. Raised further this time -- 5000, a meaningfully bigger
// jump, not another incremental bump that just delays the next recurrence.
const MAX_ALERTS = 5000;

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
    /* CONVERGE SCORE 2026-08-28 (per Derek + council): real, fetchable Poly convergence
       score per game, for the new unified Converge Score. This is NOT a new formula --
       it's the exact same computeGroupScore math already used to decide Discord
       convergence pings (polymarket-notify.js), pulled out here so other systems
       (odds.js) can read it over HTTP instead of duplicating the logic. Grouped by
       title+eventSlug+outcome (same side, same game), gateFailed alerts excluded (per
       the 2026-08-10 council decision -- context, never counted toward real signal),
       windowed to the last 24h so a score reflects today's board, not stale history. */
    if (req.query && req.query.convergeScores) {
      const raw = await upstash(['LRANGE', ALERTS_KEY, 0, MAX_ALERTS - 1]);
      const alerts = (raw || []).map(item => {
        try { return typeof item === 'string' ? JSON.parse(item) : item; }
        catch { return null; }
      }).filter(Boolean).filter(a => a && !a.gateFailed && a.loggedAt && (Date.now() - a.loggedAt) < 24 * 3600000);

      const groups = {};
      alerts.forEach(a => {
        const key = (a.title || '') + '||' + (a.outcome || '') + '||' + (a.eventSlug || '');
        if (!groups[key]) groups[key] = { title: a.title, outcome: a.outcome, eventSlug: a.eventSlug, sport: a.sport, wallets: new Map(), totalVol: 0 };
        const g = groups[key];
        g.totalVol += a.usdValue || 0;
        if (a.wallet && !g.wallets.has(a.wallet)) g.wallets.set(a.wallet, a);
      });

      // Exact same formula as computeGroupScore in polymarket-notify.js -- kept identical
      // on purpose so a Discord convergence ping and this score can never disagree about
      // the same game.
      const scored = Object.values(groups).map(g => {
        const buyers = [...g.wallets.values()];
        const vol = g.totalVol;
        const base = vol <= 500 ? 5 : Math.min(Math.round(Math.log10(vol / 500) * 38) + 15, 90);
        let bestRank = 999;
        buyers.forEach(b => (b.categories || []).forEach(c => { const r = parseInt(c.rank) || 999; if (r < bestRank) bestRank = r; }));
        const rm = bestRank <= 5 ? 1.6 : bestRank <= 15 ? 1.4 : bestRank <= 30 ? 1.2 : bestRank <= 75 ? 1.0 : 0.85;
        const conv = buyers.length >= 4 ? 28 : buyers.length >= 3 ? 20 : buyers.length >= 2 ? 12 : 0;
        const score = Math.min(Math.round(base * rm) + conv, 100);
        const tier = score >= 80 ? 'ELITE' : score >= 60 ? 'STRONG' : 'MODERATE';
        // FEATURE 2026-08-30 (per Derek, Option A report format): "how many, who" -- was
        // only ever returning a bare count. traderNames added here, not just at the
        // consuming end, since this is the one place real buyer identity already exists
        // before it gets collapsed into a count.
        const traderNames = buyers.map(b => b.traderName || (b.wallet ? b.wallet.slice(0, 8) : 'Unknown'));
        // FEATURE 2026-08-31 (per Derek): report image wants real records + wallet-form
        // icons next to each name, which needs the actual wallet address to look up --
        // traderNames alone (bare strings) can't drive that lookup. Adding the real
        // {wallet, traderName} pairs alongside, not replacing traderNames since other
        // consumers already depend on the plain string array.
        const traders = buyers.map(b => ({ wallet: b.wallet || null, traderName: b.traderName || (b.wallet ? b.wallet.slice(0, 8) : 'Unknown') }));
        return { title: g.title, outcome: g.outcome, eventSlug: g.eventSlug, sport: g.sport, score, tier, buyers: buyers.length, traderNames, traders, totalVol: Math.round(g.totalVol) };
      })
      // FIX 2026-08-31 (per Derek, real incident): a malformed alert record missing its
      // wallet field still incremented totalVol while never entering the wallets Map,
      // producing a phantom group with buyers:0 but real volume -- the score formula
      // still computed a fake floor score (~4) off that volume alone, with zero actual
      // identified traders. computeConvergeScore then blended this phantom score into
      // Converge Score at full 40 percent weight as if it were real Poly backing,
      // artificially dragging down every book-only play's score. A zero-buyer group
      // is not a real signal -- exclude it, matching the real Discord alert paths
      // existing 2+ buyer floor (this endpoint never had an equivalent gate at all).
      .filter(s => s.buyers > 0);

      return res.status(200).json({ ok: true, scores: scored });
    }

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
