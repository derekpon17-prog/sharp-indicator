/* ═══════════════════════════════════════════════════════════
   api/poly-wallet-buys.js
   Added 2026-11-20 (per Derek): the existing api/polymarket.js only ever
   returns recent buys for the top-20 OVERALL/SPORTS leaderboard wallets.
   It has no way to ask "what has THIS specific wallet bought recently" --
   which is exactly what's needed to check whether one of our classified
   HOT wallets (wallets branch, wallets.json confirmed_sharp per sport) is
   on one of tonight's SharpFlow sides. This is that lookup, built as its
   own stateless endpoint so it carries no dependency on the Upstash KV
   store (archived as of 2026-11-18 - see api/trader-records.js) and no
   dependency on api/polymarket.js's own leaderboard fetch.

   GET /api/poly-wallet-buys?wallets=0xabc,0xdef&limit=25
     -> { results: [{ wallet, ok, buys: [...], error? }], fetchedAt }

   Each buy: { title, slug, eventSlug, outcome, side, size, price, usdValue,
               timestamp, conditionId, transactionHash }

   Matching tonight's games against these buys (team name <-> market title)
   is NOT done here -- this endpoint only fetches and normalizes. Matching
   is done by the caller, same separation as api/kalshi.js's matchGame()
   being a separate step from fetchSeries().
═══════════════════════════════════════════════════════════ */

const DATA_API = 'https://data-api.polymarket.com';
const DEFAULT_LIMIT = 25;
const MAX_WALLETS = 40;   // guardrail so a bad ?wallets= list can't fan out unbounded
const BATCH = 6;          // small concurrency batches, same reasoning as kalshi.js detectBigTrades

async function fetchWalletBuys(wallet, limit) {
  const url = `${DATA_API}/trades?user=${wallet}&side=BUY&takerOnly=true&limit=${limit}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, status: r.status, body: body.slice(0, 300), buys: [] };
    }
    const data = await r.json();
    if (!Array.isArray(data)) return { ok: false, status: r.status, body: 'response was not an array', buys: [] };
    const buys = data.map(t => ({
      title:        t.title || null,
      slug:         t.slug || null,
      eventSlug:    t.eventSlug || null,
      outcome:      t.outcome || null,
      side:         t.side || null,
      size:         t.size,
      price:        t.price,
      usdValue:     (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0),
      timestamp:    t.timestamp,
      conditionId:  t.conditionId || null,
      transactionHash: t.transactionHash || null,
    }));
    return { ok: true, status: r.status, buys };
  } catch (err) {
    return { ok: false, networkError: err.message, buys: [] };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const raw = String(req.query.wallets || '').trim();
    if (!raw) return res.status(400).json({ error: 'missing ?wallets=0xabc,0xdef (comma-separated)' });

    const wallets = raw.split(',').map(w => w.trim()).filter(Boolean).slice(0, MAX_WALLETS);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

    const results = [];
    for (let i = 0; i < wallets.length; i += BATCH) {
      const batch = wallets.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(w => fetchWalletBuys(w, limit)));
      batch.forEach((w, j) => {
        const r = batchResults[j];
        results.push({ wallet: w, ok: r.ok, buys: r.buys, ...(r.ok ? {} : { error: r.networkError || `HTTP ${r.status}: ${r.body}` }) });
      });
    }

    res.status(200).json({ results, walletsRequested: wallets.length, fetchedAt: Date.now() });
  } catch (err) {
    console.error('poly-wallet-buys error:', err.message);
    res.status(200).json({ results: [], error: err.message });
  }
};
