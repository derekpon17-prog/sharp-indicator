const DATA_API = 'https://data-api.polymarket.com';
const LEADERBOARD_SIZE = 20;

async function fetchLeaderboard(category) {
  try {
    const r = await fetch(
      `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${LEADERBOARD_SIZE}`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function fetchWalletBuys(wallet) {
  try {
    const r = await fetch(
      `${DATA_API}/trades?user=${wallet}&side=BUY&takerOnly=true&limit=20`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function sendAlert(topic, buy) {
  const usd = Math.round(buy.usdValue).toLocaleString();
  const price = (buy.price * 100).toFixed(1);
  const body =
    `💰 $${usd} BUY — ${buy.traderName}\n` +
    `Market: ${buy.title || 'Unknown'}\n` +
    `Outcome: ${buy.outcome} @ ${price}¢\n` +
    `${buy.eventSlug ? 'polymarket.com/event/' + buy.eventSlug : ''}`;
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      mode: 'no-cors',
      body,
    });
    return true;
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const topic     = process.env.NTFY_TOPIC;
  const threshold = parseInt(process.env.PM_THRESHOLD || '5000');
  const category  = (process.env.PM_CATEGORY || 'all').toUpperCase();

  if (!topic) {
    return res.status(200).json({
      ok: false,
      message: 'NTFY_TOPIC not set in Vercel environment variables',
    });
  }

  const now    = Math.floor(Date.now() / 1000);
  const winMin = now - 300;
  const winMax = now - 30;

  try {
    const [overallLB, sportsLB] = await Promise.all([
      fetchLeaderboard('OVERALL'),
      fetchLeaderboard('SPORTS'),
    ]);

    const walletMap = {};
    overallLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] ||
        { wallet: t.proxyWallet, name: t.userName || t.pseudonym, categories: [] };
      walletMap[t.proxyWallet].categories.push({ cat: 'OVERALL', rank: t.rank, pnl: t.pnl });
    });
    sportsLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] ||
        { wallet: t.proxyWallet, name: t.userName || t.pseudonym, categories: [] };
      walletMap[t.proxyWallet].categories.push({ cat: 'SPORTS', rank: t.rank, pnl: t.pnl });
    });

    const wallets = Object.values(walletMap).filter(w => {
      if (category === 'ALL') return true;
      return w.categories.some(c => c.cat === category);
    });

    const results = await Promise.all(wallets.map(w => fetchWalletBuys(w.wallet)));

    const toAlert = [];
    wallets.forEach((w, i) => {
      (results[i] || []).forEach(t => {
        const ts  = parseInt(t.timestamp) || 0;
        const usd = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
        if (ts < winMin || ts > winMax) return;
        if (usd < threshold) return;
        toAlert.push({
          wallet: w.wallet,
          traderName: t.name || t.pseudonym || w.name || w.wallet.slice(0, 8),
          categories: w.categories,
          title: t.title,
          eventSlug: t.eventSlug,
          outcome: t.outcome,
          price: t.price,
          usdValue: usd,
          timestamp: ts,
        });
      });
    });

    toAlert.sort((a, b) => b.usdValue - a.usdValue);

    let sent = 0;
    for (const buy of toAlert) {
      const ok = await sendAlert(topic, buy);
      if (ok) sent++;
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      ok: true,
      walletsChecked: wallets.length,
      buysInWindow: toAlert.length,
      alertsSent: sent,
      threshold,
      category,
    });

  } catch (err) {
    console.error('polymarket-notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
