/* ═══════════════════════════════════════════════════════════
   api/polymarket.js  (updated)
   Now returns leaderboard data alongside buys so the site
   can render the HOT section and full leaderboard without
   extra API calls.
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
  const url = `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${LEADERBOARD_SIZE}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return tag([], { ok: false, status: r.status, body: body.slice(0, 300) });
    }
    const data = await r.json();
    if (!Array.isArray(data)) return tag([], { ok: false, status: r.status, body: 'response was not an array', shape: typeof data });
    return tag(data, { ok: true, count: data.length });
  } catch (err) {
    return tag([], { ok: false, networkError: err.message });
  }
}

async function fetchWalletBuys(wallet) {
  const url = `${DATA_API}/trades?user=${wallet}&side=BUY&takerOnly=true&limit=${TRADES_PER_WALLET}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function formatLeaderboard(lb, category) {
  return lb.map(t => ({
    rank:    t.rank,
    wallet:  t.proxyWallet,
    name:    t.userName || t.pseudonym || null,
    image:   t.profileImageOptimized || t.profileImage || null,
    pnl:     parseFloat(t.pnl) || 0,
    vol:     parseFloat(t.volume) || 0,
    category,
  }));
}

// FEATURE 2026-11-20 (per Derek): folded in here rather than a new api/ file, because
// the Hobby plan caps Vercel at 12 Serverless Functions per deployment and this repo's
// api/ directory was already at exactly 12 - a 13th file (api/poly-wallet-buys.js,
// tried first) made every deploy error with exceeded_serverless_functions_per_deployment.
// That is also the likely real cause behind main sitting un-deployed for the last few
// commits (see RUNBOOK_SLATE.md) - worth a from-scratch check once this ships clean.
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
      title: t.title || null, slug: t.slug || null, eventSlug: t.eventSlug || null,
      outcome: t.outcome || null, side: t.side || null, size: t.size, price: t.price,
      usdValue: (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0),
      timestamp: t.timestamp, conditionId: t.conditionId || null,
      transactionHash: t.transactionHash || null,
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
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] ||
        { wallet: t.proxyWallet, name: t.userName || t.pseudonym, image: t.profileImageOptimized || t.profileImage, categories: [] };
      walletMap[t.proxyWallet].categories.push({ category: 'OVERALL', rank: t.rank, pnl: parseFloat(t.pnl)||0 });
    });
    sportsLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] ||
        { wallet: t.proxyWallet, name: t.userName || t.pseudonym, image: t.profileImageOptimized || t.profileImage, categories: [] };
      walletMap[t.proxyWallet].categories.push({ category: 'SPORTS', rank: t.rank, pnl: parseFloat(t.pnl)||0 });
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
          traderName:   t.name || t.pseudonym || w.name || (w.wallet.slice(0,6)+'…'+w.wallet.slice(-4)),
          profileImage: t.profileImageOptimized || t.profileImage || w.image || null,
          categories:   w.categories,
          title:        t.title,
          slug:         t.slug,
          eventSlug:    t.eventSlug,
          outcome:      t.outcome,
          side:         t.side,
          size:         t.size,
          price:        t.price,
          usdValue,
          timestamp:    t.timestamp,
          transactionHash: t.transactionHash,
          conditionId:  t.conditionId,
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
