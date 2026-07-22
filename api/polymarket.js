/* ═══════════════════════════════════════════════════════════
   api/polymarket.js  (updated)
   Now returns leaderboard data alongside buys so the site
   can render the HOT section and full leaderboard without
   extra API calls.
═══════════════════════════════════════════════════════════ */

const DATA_API = 'https://data-api.polymarket.com';
const TRADES_PER_WALLET = 15;
const LEADERBOARD_SIZE = 20;

async function fetchLeaderboard(category) {
  const url = `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${LEADERBOARD_SIZE}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
      fetchedAt: Date.now(),
    });

  } catch (err) {
    console.error('polymarket error:', err.message);
    res.status(200).json({ buys: [], error: err.message });
  }
};
