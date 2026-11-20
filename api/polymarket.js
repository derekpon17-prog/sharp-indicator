/* ═══════════════════════════════════════════════════════════
   api/polymarket.js
   Returns leaderboard data alongside buys so the site can render the
   HOT section and full leaderboard without extra API calls.

   FIX 2026-11-20 (per Derek, found live while building the per-wallet
   lookup below - a real, confirmed-live bug, not a guess): Polymarket's
   Data API v1 was retired on 2026-10-24. Every call this file made
   (/v1/leaderboard, /trades) has been returning HTTP 410 since that date
   - "walletsTracked: 0" and an empty leaderboard were NOT this file
   failing, they were the v1 diag fix from Nov 18 correctly reporting a
   real external failure that nobody had looked at since. Confirmed via
   docs.polymarket.com/migrate/data-api-v1-to-v2 and the v2 endpoint pages
   (get-leaderboard, get-trades). Migrated both calls to v2:
     - /v1/leaderboard?category=X&timePeriod=ALL&orderBy=PNL -> /v2/leaderboard?category=x&time_period=all&sort_by=PNL
       (category is lowercase in v2: overall/sports, not OVERALL/SPORTS)
     - /trades?user=X&side=BUY&takerOnly=true -> /v2/trades?user=X&side=BUY&taker_only=true
     - Response shape changed too: both now wrap rows in {data, pagination}
       instead of returning a bare array, and trade/leaderboard field names
       moved from camelCase to snake_case (proxyWallet -> proxy_wallet,
       userName -> user_name, eventSlug -> event_slug, etc). v2 leaderboard
       rows also dropped `pseudonym` entirely - user_name is now the only
       name field (falls back to a shortened wallet elsewhere in this file).
═══════════════════════════════════════════════════════════ */

const DATA_API = 'https://data-api.polymarket.com';
const TRADES_PER_WALLET = 15;
const LEADERBOARD_SIZE = 20;

// (2026-11-18) fetchLeaderboard/fetchWalletBuys used to swallow every failure as a bare
// [] - that's why the leaderboard going empty could never be told apart from Polymarket
// itself having nothing to show. Now each one records what actually happened (HTTP
// status, non-JSON body, network error) on the array it returns, via a non-enumerable
// _err/_status so it doesn't leak into the JSON responses that iterate these arrays.
function tag(arr, info) { Object.defineProperty(arr, '_diag', { value: info, enumerable: false }); return arr; }

async function fetchLeaderboard(category) {
  // v2: category is lowercase (overall/sports), param is time_period/sort_by not
  // timePeriod/orderBy, response is {data, pagination} not a bare array.
  const url = `${DATA_API}/v2/leaderboard?category=${category.toLowerCase()}&time_period=all&sort_by=PNL&limit=${LEADERBOARD_SIZE}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return tag([], { ok: false, status: r.status, body: body.slice(0, 300) });
    }
    const json = await r.json();
    const data = json && Array.isArray(json.data) ? json.data : null;
    if (!data) return tag([], { ok: false, status: r.status, body: 'response had no data[] array', shape: typeof json });
    return tag(data, { ok: true, count: data.length });
  } catch (err) {
    return tag([], { ok: false, networkError: err.message });
  }
}

async function fetchWalletBuys(wallet) {
  const url = `${DATA_API}/v2/trades?user=${wallet}&side=BUY&taker_only=true&limit=${TRADES_PER_WALLET}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const json = await r.json();
    return json && Array.isArray(json.data) ? json.data : [];
  } catch { return []; }
}

function formatLeaderboard(lb, category) {
  return lb.map(t => ({
    rank:    t.rank,
    wallet:  t.user_id,
    name:    t.user_name || null,
    image:   t.profile_image || null,
    pnl:     parseFloat(t.pnl) || 0,
    vol:     parseFloat(t.volume) || 0,
    category,
  }));
}

// FEATURE 2026-11-20 (per Derek): folded in here rather than a new api/ file, because
// the Hobby plan caps Vercel at 12 Serverless Functions per deployment and this repo's
// api/ directory was already at exactly 12 - a 13th file (api/poly-wallet-buys.js,
// tried first) made every deploy error with exceeded_serverless_functions_per_deployment.
// That is also the likely real cause behind main sitting un-deployed for several prior
// commits.
//
// WHY. The leaderboard-based fetchWalletBuys above only ever covers the top-20
// OVERALL/SPORTS wallets. There was no way to ask "what has THIS SPECIFIC wallet
// bought recently" - needed to check whether one of our classified HOT wallets
// (wallets branch, wallets.json confirmed_sharp per sport) is on one of tonight's
// SharpFlow sides.
//
// GET /api/polymarket?wallets=0xabc,0xdef&limit=25
//   -> { results: [{ wallet, ok, buys: [...], error? }], fetchedAt }
// Each buy: { title, slug, eventSlug, outcome, side, size, price, usdValue, timestamp,
//             conditionId, transactionHash }. Matching these against SharpFlow team
// names is the caller's job, not this endpoint's - same split as api/kalshi.js's
// matchGame() being separate from fetchSeries().
const MAX_WALLETS_LOOKUP = 40;
const WALLET_BATCH = 6;

async function fetchWalletBuysByWallet(wallet, limit) {
  const url = `${DATA_API}/v2/trades?user=${wallet}&side=BUY&taker_only=true&limit=${limit}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, status: r.status, body: body.slice(0, 300), buys: [] };
    }
    const json = await r.json();
    const data = json && Array.isArray(json.data) ? json.data : null;
    if (!data) return { ok: false, status: r.status, body: 'response had no data[] array', buys: [] };
    const buys = data.map(t => ({
      title: t.title || null, slug: t.slug || null, eventSlug: t.event_slug || null,
      outcome: t.outcome || null, side: t.side || null, size: t.size, price: t.price,
      usdValue: (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0),
      timestamp: t.timestamp, conditionId: t.condition_id || null,
      transactionHash: t.transaction_hash || null,
    }));
    return { ok: true, status: r.status, buys };
  } catch (err) {
    return { ok: false, networkError: err.message, buys: [] };
  }
}

async function handleWalletLookup(req, res) {
  const raw = String(req.query.wallets || '').trim();
  const wallets = raw.split(',').map(w => w.trim()).filter(Boolean).slice(0, MAX_WALLETS_LOOKUP);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));

  const results = [];
  for (let i = 0; i < wallets.length; i += WALLET_BATCH) {
    const batch = wallets.slice(i, i + WALLET_BATCH);
    const batchResults = await Promise.all(batch.map(w => fetchWalletBuysByWallet(w, limit)));
    batch.forEach((w, j) => {
      const r = batchResults[j];
      results.push({ wallet: w, ok: r.ok, buys: r.buys, ...(r.ok ? {} : { error: r.networkError || `HTTP ${r.status}: ${r.body}` }) });
    });
  }
  res.status(200).json({ results, walletsRequested: wallets.length, fetchedAt: Date.now() });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.wallets) return handleWalletLookup(req, res);

  try {
    // Pull both leaderboards in parallel
    const [overallLB, sportsLB] = await Promise.all([
      fetchLeaderboard('OVERALL'),
      fetchLeaderboard('SPORTS'),
    ]);

    // Merge + dedupe wallets
    const walletMap = {};
    overallLB.forEach(t => {
      walletMap[t.user_id] = walletMap[t.user_id] ||
        { wallet: t.user_id, name: t.user_name, image: t.profile_image, categories: [] };
      walletMap[t.user_id].categories.push({ category: 'OVERALL', rank: t.rank, pnl: parseFloat(t.pnl)||0 });
    });
    sportsLB.forEach(t => {
      walletMap[t.user_id] = walletMap[t.user_id] ||
        { wallet: t.user_id, name: t.user_name, image: t.profile_image, categories: [] };
      walletMap[t.user_id].categories.push({ category: 'SPORTS', rank: t.rank, pnl: parseFloat(t.pnl)||0 });
    });

    const wallets = Object.values(walletMap);

    // Fetch recent buys for all wallets in parallel
    const buysByWallet = await Promise.all(wallets.map(w => fetchWalletBuys(w.wallet)));

    // Flatten all buys
    const allBuys = [];
    wallets.forEach((w, i) => {
      (buysByWallet[i] || []).forEach(t => {
        const usdValue = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
        allBuys.push({
          wallet:       w.wallet,
          traderName:   t.name || w.name || (w.wallet.slice(0,6)+'…'+w.wallet.slice(-4)),
          profileImage: t.profile_image || w.image || null,
          categories:   w.categories,
          title:        t.title,
          slug:         t.slug,
          eventSlug:    t.event_slug,
          outcome:      t.outcome,
          side:         t.side,
          size:         t.size,
          price:        t.price,
          usdValue,
          timestamp:    t.timestamp,
          transactionHash: t.transaction_hash,
          conditionId:  t.condition_id,
        });
      });
    });

    allBuys.sort((a, b) => b.timestamp - a.timestamp);

    res.status(200).json({
      buys:           allBuys.slice(0, 150),
      walletsTracked: wallets.length,
      // Full leaderboards for the HOT section and leaderboard tab
      leaderboard: {
        overall: formatLeaderboard(overallLB, 'OVERALL'),
        sports:  formatLeaderboard(sportsLB,  'SPORTS'),
      },
      // Diagnostics only (2026-11-18): why each leaderboard pull came back the way it
      // did, so an empty leaderboard is never silently indistinguishable from a real
      // zero. Safe to ignore in normal use.
      leaderboardDiag: {
        overall: overallLB._diag || null,
        sports:  sportsLB._diag || null,
      },
      fetchedAt: Date.now(),
    });

  } catch (err) {
    console.error('polymarket error:', err.message);
    res.status(200).json({ buys: [], error: err.message });
  }
};
