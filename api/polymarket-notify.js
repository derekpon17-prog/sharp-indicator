/* ═══════════════════════════════════════════════════════════
   api/polymarket-notify.js
   Cron-triggered smart money alert endpoint.

   EFFICIENT APPROACH — 3 API calls total (not 30):
   1. Fetch OVERALL leaderboard  → get top wallet addresses
   2. Fetch SPORTS leaderboard   → get top wallet addresses
   3. Fetch global recent trades → filter by tracked wallets

   VERCEL ENV VARS:
     NTFY_TOPIC    — ntfy topic name
     PM_THRESHOLD  — min buy USD (default 1000)
     PM_CATEGORY   — all | OVERALL | SPORTS (default all)

   CRON: every 15 minutes on cron-job.org
═══════════════════════════════════════════════════════════ */

const DATA_API   = 'https://data-api.polymarket.com';
const VERCEL_URL = 'https://sharp-indicator-a34j.vercel.app';
const LB_SIZE    = 50;

/* ── Leaderboard ── */
async function fetchLeaderboard(category) {
  try {
    const r = await fetch(
      `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${LB_SIZE}`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/* ── Global recent trades — one call gets everything ── */
async function fetchRecentTrades(limit = 200) {
  try {
    const r = await fetch(
      `${DATA_API}/trades?side=BUY&takerOnly=true&limit=${limit}`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/* ── Sports filter ── */
const SPORT_KEYWORDS = [
  'nba','wnba','mlb','nfl','nhl',
  'ncaa','college football','college basketball',
  'basketball','baseball','football','hockey',
  'nba finals','world series','super bowl',
  'stanley cup','march madness','cfp','championship',
  'playoffs','world cup',
];
function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return SPORT_KEYWORDS.some(k => t.includes(k));
}

/* ── Send alert + log history ── */
async function sendAlert(topic, buy) {
  const usd   = Math.round(buy.usdValue).toLocaleString();
  const price = (parseFloat(buy.price || 0) * 100).toFixed(1);
  const topTraderLine = buy.isTopTrader
    ? `⭐ Top Trader: ${(buy.categories||[]).map(c=>c.category==='OVERALL'?'Overall #'+c.rank:'Sports #'+c.rank).join(' · ')}\n`
    : '';
  const body  =
    `💰 $${usd} BUY — ${buy.traderName}\n` +
    topTraderLine +
    `Market: ${buy.title || 'Unknown'}\n` +
    `Outcome: ${buy.outcome || '—'} @ ${price}¢\n` +
    `${buy.eventSlug ? 'polymarket.com/event/' + buy.eventSlug : ''}`;

  // Log to alert history
  try {
    await fetch(`${VERCEL_URL}/api/polymarket-alerts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(buy),
    });
  } catch (e) { console.error('alert log error:', e.message); }

  // Push to phone
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method:  'POST',
      headers: {
        'Title':        `💰 $${usd} Smart Money Buy`,
        'Priority':     buy.usdValue >= 10000 ? 'urgent' : 'high',
        'Tags':         'money_bag,chart_with_upwards_trend',
        'Content-Type': 'text/plain',
      },
      body,
    });
    return true;
  } catch { return false; }
}

/* ── Main handler ── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const topic     = process.env.NTFY_TOPIC;
  const threshold = parseInt(process.env.PM_THRESHOLD || '1000');
  const category  = (process.env.PM_CATEGORY || 'all').toUpperCase();

  if (!topic) {
    return res.status(200).json({
      ok: false,
      message: 'NTFY_TOPIC not set in Vercel environment variables',
    });
  }

  // 15-minute dedup window
  const now    = Math.floor(Date.now() / 1000);
  const winMin = now - 900;
  const winMax = now - 30;

  try {
    // 3 parallel calls — leaderboards + global trades
    const [overallLB, sportsLB, recentTrades] = await Promise.all([
      fetchLeaderboard('OVERALL'),
      fetchLeaderboard('SPORTS'),
      fetchRecentTrades(500),
    ]);

    // Build tracked wallet map
    const walletMap = {};
    overallLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] || {
        name: t.userName || t.pseudonym,
        image: t.profileImageOptimized || t.profileImage,
        categories: [],
      };
      walletMap[t.proxyWallet].categories.push({ category: 'OVERALL', rank: t.rank });
    });
    sportsLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] || {
        name: t.userName || t.pseudonym,
        image: t.profileImageOptimized || t.profileImage,
        categories: [],
      };
      walletMap[t.proxyWallet].categories.push({ category: 'SPORTS', rank: t.rank });
    });

    const walletsTracked = Object.keys(walletMap).length;

    // Option 3: Scan ALL sports buys above threshold — no wallet filter needed
    // Tag known traders with their leaderboard rank for extra context
    const toAlert = [];
    recentTrades.forEach(t => {
      const wallet     = t.maker || t.transactor || t.proxyWallet;
      const ts         = parseInt(t.timestamp) || 0;
      const usd        = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);

      if (ts < winMin || ts > winMax) return;   // outside 15-min window
      if (usd < threshold)            return;   // below dollar threshold
      if (!isSportsMarket(t.title))   return;   // not a sports market

      // Check if this is a known top trader (adds rank badges in alert)
      const traderInfo  = wallet ? walletMap[wallet] : null;
      const isTopTrader = !!traderInfo;

      // Apply category filter — only restrict if category set AND trader is known
      if (category !== 'ALL' && isTopTrader) {
        if (!traderInfo.categories.some(c => c.category === category)) return;
      }

      toAlert.push({
        wallet:          wallet || 'unknown',
        traderName:      t.name || t.pseudonym || (traderInfo && traderInfo.name) || (wallet ? wallet.slice(0,6)+'…'+wallet.slice(-4) : 'Anon'),
        profileImage:    t.profileImageOptimized || t.profileImage || (traderInfo && traderInfo.image) || null,
        categories:      traderInfo ? traderInfo.categories : [],
        isTopTrader,     // flagged in alert if known leaderboard trader
        title:           t.title,
        slug:            t.slug,
        eventSlug:       t.eventSlug,
        outcome:         t.outcome,
        price:           t.price,
        usdValue:        usd,
        timestamp:       ts,
        loggedAt:        Date.now(),
        transactionHash: t.transactionHash,
      });
    });

    // Sort biggest first
    toAlert.sort((a, b) => b.usdValue - a.usdValue);

    // Fire alerts
    let sent = 0;
    for (const buy of toAlert) {
      const ok = await sendAlert(topic, buy);
      if (ok) sent++;
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    // Debug: find timestamp range of returned trades
    const timestamps = recentTrades
      .map(t => parseInt(t.timestamp) || 0)
      .filter(Boolean)
      .sort((a,b) => b-a);
    const newestTrade = timestamps[0] || 0;
    const oldestTrade = timestamps[timestamps.length-1] || 0;

    // Count how many trades failed each filter
    let failedTimestamp=0, failedThreshold=0, failedSports=0, passedAll=0;
    recentTrades.forEach(t => {
      const ts  = parseInt(t.timestamp) || 0;
      const usd = (parseFloat(t.size)||0) * (parseFloat(t.price)||0);
      if(ts < winMin || ts > winMax){ failedTimestamp++; return; }
      if(usd < threshold){ failedThreshold++; return; }
      if(!isSportsMarket(t.title)){ failedSports++; return; }
      passedAll++;
    });

    // Sample of what the first trade looks like
    const sampleTrade = recentTrades[0] ? {
      keys: Object.keys(recentTrades[0]).join(', '),
      timestamp: recentTrades[0].timestamp,
      title: recentTrades[0].title,
      size: recentTrades[0].size,
      price: recentTrades[0].price,
      proxyWallet: recentTrades[0].proxyWallet,
    } : null;

    return res.status(200).json({
      ok:             true,
      walletsTracked,
      tradesScanned:  recentTrades.length,
      buysInWindow:   toAlert.length,
      alertsSent:     sent,
      threshold,
      category,
      window: {
        from: new Date(winMin * 1000).toISOString(),
        to:   new Date(winMax * 1000).toISOString(),
      },
      debug: {
        newestTradeTime:  newestTrade ? new Date(newestTrade * 1000).toISOString() : 'none',
        oldestTradeTime:  oldestTrade ? new Date(oldestTrade * 1000).toISOString() : 'none',
        failedTimestamp,
        failedThreshold,
        failedSports,
        passedAll,
        sampleTrade,
      },
    });

  } catch (err) {
    console.error('polymarket-notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
