/* =========================================================
   api/polymarket-notify.js
   Cron-triggered Polymarket smart money alert bot.

   VERCEL ENV VARS:
     NTFY_TOPIC     - your ntfy topic (e.g. sharpidx-derek-2026)
     PM_THRESHOLD   - min buy USD (default 1000)
     PM_CATEGORY    - all | OVERALL | SPORTS (default all)

   CRON: hit this endpoint every 15 min via cron-job.org
   ========================================================= */

const DATA_API   = 'https://data-api.polymarket.com';
// In-memory set of position alerts already sent this session (resets on cold start)
const posAlertedKeys = new Set();
const VERCEL_URL = 'https://sharp-indicator-a34j.vercel.app';
const LB_SIZE    = 50;

async function fetchLeaderboard(category) {
  try {
    const r = await fetch(`${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${LB_SIZE}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function fetchRecentTrades(limit = 500) {
  try {
    const r = await fetch(`${DATA_API}/trades?side=BUY&takerOnly=true&limit=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

// Fetch active sports markets from Polymarket
async function fetchActiveSportsMarkets() {
  try {
    const r = await fetch(`${DATA_API}/markets?active=true&closed=false&limit=100&order=volume&ascending=false&tag=sports`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : (d.data ? d.data : []);
  } catch { return []; }
}

// Fetch top position holders for a specific market
async function fetchTopHolders(conditionId, threshold = 500) {
  try {
    const r = await fetch(`${DATA_API}/positions?conditionId=${conditionId}&sizeThreshold=${threshold}&limit=20`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

const SPORT_KEYWORDS = [
  'nba','wnba','mlb','nfl','nhl','mls','ufc','pga',
  'basketball','baseball','football','hockey','soccer',
  'tennis','golf','boxing','mma',
  // Tennis specifics
  'wimbledon','us open','french open','australian open','atp','wta','grand slam',
  'vs','game winner','set winner','match winner',
  // Soccer specifics
  'premier league','la liga','serie a','bundesliga','champions league',
  'copa','eredivisie','ligue 1','mls cup','fifa',
  'ncaa','college football','college basketball','march madness','cfp',
  'nba finals','world series','super bowl','stanley cup',
  'championship','playoffs','world cup','draft',
  'yankees','red sox','dodgers','cubs','mets','astros',
  'braves','phillies','padres','giants','cardinals','brewers',
  'guardians','royals','twins','orioles','rays','blue jays',
  'mariners','rangers','angels','athletics','tigers','white sox',
  'reds','pirates','rockies','marlins','nationals','diamondbacks',
  'run scored','first inning','innings','pitcher','batting',
];

function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return SPORT_KEYWORDS.some(k => t.includes(k));
}

async function sendAlert(topic, buy) {
  const usd   = Math.round(buy.usdValue).toLocaleString();
  const price = (parseFloat(buy.price || 0) * 100).toFixed(1);
  const traderInfo = (buy.categories||[]).map(c => {
    const ct = c.category || c.cat || '';
    return ct === 'OVERALL' ? 'Overall #'+c.rank : 'Sports #'+c.rank;
  }).join(' / ');

  const body = [
    `$${usd} BUY - ${buy.traderName || 'Anon'}`,
    traderInfo ? `Rank: ${traderInfo}` : '',
    `Market: ${(buy.title || 'Unknown').slice(0, 80)}`,
    `Bought: ${buy.outcome || '-'} @ ${price}c`,
    buy.eventSlug ? `polymarket.com/event/${buy.eventSlug}` : '',
  ].filter(Boolean).join('\n');

  // Log to alert history endpoint
  try {
    await fetch(`${VERCEL_URL}/api/polymarket-alerts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...buy, loggedAt: Date.now() }),
    });
  } catch (e) { console.error('alert log error:', e.message); }

  // Send ntfy notification
  try {
    const ntfyRes = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title':    `$${usd} Smart Money Buy`,
        'Priority': buy.usdValue >= 10000 ? 'urgent' : 'high',
        'Tags':     'money_bag',
      },
      body,
    });
    const resText = await ntfyRes.text().catch(() => '');
    if (!ntfyRes.ok) {
      console.error('ntfy send failed:', ntfyRes.status, resText);
      return { ok: false, status: ntfyRes.status, body: resText.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    console.error('ntfy exception:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const topic     = process.env.NTFY_TOPIC;
  const threshold = parseInt(process.env.PM_THRESHOLD || '1000');
  const category  = (process.env.PM_CATEGORY || 'all').toUpperCase();

  if (!topic) {
    return res.status(200).json({ ok: false, message: 'NTFY_TOPIC not set in Vercel env vars' });
  }

  const now    = Math.floor(Date.now() / 1000);
  const winMin = now - 900;  // 15 min ago
  const winMax = now - 30;   // 30 sec buffer

  try {
    const [overallLB, sportsLB, recentTrades] = await Promise.all([
      fetchLeaderboard('OVERALL'),
      fetchLeaderboard('SPORTS'),
      fetchRecentTrades(500),
    ]);

    // Build wallet map for tagging top traders
    const walletMap = {};
    overallLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] || { name: t.userName || t.pseudonym, categories: [] };
      walletMap[t.proxyWallet].categories.push({ category: 'OVERALL', rank: t.rank });
    });
    sportsLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] || { name: t.userName || t.pseudonym, categories: [] };
      walletMap[t.proxyWallet].categories.push({ category: 'SPORTS', rank: t.rank });
    });

    // Debug: show what the trades look like
    const sampleTrade = recentTrades[0] ? {
      fields: Object.keys(recentTrades[0]).join(', '),
      timestamp: recentTrades[0].timestamp,
      title: recentTrades[0].title,
      wallet: recentTrades[0].proxyWallet || recentTrades[0].maker || recentTrades[0].transactor,
      size: recentTrades[0].size,
      price: recentTrades[0].price,
    } : null;

    // Filter trades
    let failedTs = 0, failedThresh = 0, failedSports = 0;
    const failedSportsTitles = [];
    const toAlert = [];

    recentTrades.forEach(t => {
      const wallet = t.proxyWallet || t.maker || t.transactor;
      const ts     = parseInt(t.timestamp) || 0;
      const usd    = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);

      if (ts < winMin || ts > winMax) { failedTs++; return; }
      if (usd < threshold)            { failedThresh++; return; }
      if (!isSportsMarket(t.title))   {
        failedSports++;
        if (failedSportsTitles.length < 5) failedSportsTitles.push({ title: t.title, usd: Math.round(usd) });
        return;
      }

      const traderInfo = wallet ? walletMap[wallet] : null;

      // Category filter (only restrict if known trader)
      if (category !== 'ALL' && traderInfo) {
        if (!traderInfo.categories.some(c => c.category === category)) return;
      }

      toAlert.push({
        wallet:          wallet || 'unknown',
        traderName:      t.name || t.pseudonym || (traderInfo && traderInfo.name) || (wallet ? wallet.slice(0,6)+'...'+wallet.slice(-4) : 'Anon'),
        profileImage:    t.profileImageOptimized || t.profileImage || null,
        categories:      traderInfo ? traderInfo.categories : [],
        isTopTrader:     !!traderInfo,
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

    toAlert.sort((a, b) => b.usdValue - a.usdValue);

    // ── POSITION SCAN: Check top holders on active MLB/NFL/NBA markets ──
    // This catches large existing positions, not just real-time buys
    try {
      const activeMarkets = await fetchActiveSportsMarkets();
      const sportMarkets = activeMarkets
        .filter(m => m.question && isSportsMarket(m.question))
        .slice(0, 15); // Check top 15 by volume

      for (const market of sportMarkets) {
        if (!market.conditionId) continue;
        const holders = await fetchTopHolders(market.conditionId, threshold);
        for (const h of holders) {
          const wallet = h.proxyWallet || h.user;
          const posSize = parseFloat(h.size || h.currentValue || 0);
          if (posSize < threshold) continue;
          // Check if this position was recently established (avoid re-alerting)
          const posKey = `pos_${wallet}_${market.conditionId}`;
          const seen = posAlertedKeys.has(posKey);
          if (seen) continue;
          posAlertedKeys.add(posKey);
          const traderInfo = wallet ? walletMap[wallet] : null;
          toAlert.push({
            wallet:          wallet || 'unknown',
            traderName:      h.name || h.pseudonym || (traderInfo && traderInfo.name) || (wallet ? wallet.slice(0,6)+'...'+wallet.slice(-4) : 'Holder'),
            profileImage:    h.profileImage || null,
            categories:      traderInfo ? traderInfo.categories : [],
            isTopTrader:     !!traderInfo,
            title:           market.question || market.title,
            slug:            market.slug,
            eventSlug:       market.eventSlug || market.slug,
            outcome:         h.outcome || h.side,
            price:           h.averagePrice || h.price,
            usdValue:        posSize,
            timestamp:       Math.floor(Date.now()/1000),
            loggedAt:        Date.now(),
            transactionHash: posKey, // use as dedup key
            isPositionScan:  true,
          });
        }
      }
    } catch (e) {
      console.error('Position scan error:', e.message);
    }

    // Send alerts and collect results
    let sent = 0;
    const ntfyResults = [];
    for (const buy of toAlert) {
      const result = await sendAlert(topic, buy);
      if (result && result.ok) sent++;
      ntfyResults.push({
        trader: buy.traderName,
        usd:    Math.round(buy.usdValue),
        result,
      });
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      ok:             true,
      walletsTracked: Object.keys(walletMap).length,
      tradesScanned:  recentTrades.length,
      buysInWindow:   toAlert.length,
      alertsSent:     sent,
      threshold,
      category,
      ntfyTopic:      topic,
      window: {
        from: new Date(winMin * 1000).toISOString(),
        to:   new Date(winMax * 1000).toISOString(),
      },
      debug: {
        failedTs,
        failedThresh,
        failedSports,
        failedSportsTitles,
        ntfyResults,
        sampleTrade,
        newestTrade: recentTrades[0]?.timestamp
          ? new Date(parseInt(recentTrades[0].timestamp) * 1000).toISOString()
          : null,
      },
    });

  } catch (err) {
    console.error('polymarket-notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
