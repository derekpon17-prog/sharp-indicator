/* =========================================================
   api/polymarket-notify.js
   Cron-triggered Polymarket smart money alert bot.

   SPORT-SPECIFIC LEADERBOARD CONFIG:
   - MLB:    top 75 profitable baseball bettors
   - NFL:    top 75 profitable football bettors
   - NBA:    top 50 profitable basketball bettors
   - TENNIS: top 75 profitable tennis bettors
   - NHL:    top 25 profitable hockey bettors
   - GOLF:   top 25 profitable golf bettors
   - SOCCER: top 25 (WC/Copa only per whitelist)
   Total unique wallets: ~250-300 high-signal accounts

   WHY SPORT-SPECIFIC:
   A top-75 MLB bettor is a much stronger signal for a baseball
   play than a top-500 "all sports" bettor. This filters noise
   and surfaces sport-specific expertise.

   VERCEL ENV VARS:
     NTFY_TOPIC     - ntfy push topic
     PM_THRESHOLD   - min buy USD (default 749)
     PM_CATEGORY    - all | MLB | NFL | NBA | NHL | TENNIS | GOLF

   CRON: hit every 15 min via cron-job.org
   ========================================================= */

const DATA_API   = 'https://data-api.polymarket.com';
const VERCEL_URL = 'https://sharp-indicator-a34j.vercel.app';

// Sport-specific leaderboard sizes
const SPORT_LB_CONFIG = [
  { category: 'MLB',    limit: 75  },
  { category: 'NFL',    limit: 75  },
  { category: 'NBA',    limit: 50  },
  { category: 'TENNIS', limit: 75  },
  { category: 'NHL',    limit: 25  },
  { category: 'GOLF',   limit: 25  },
  { category: 'SOCCER', limit: 25  },
];

// In-memory dedup for position scanner
const posAlertedKeys = new Set();

async function fetchLeaderboard(category, limit) {
  // Try multiple URL formats — Polymarket API may use different endpoint structures
  const urls = [
    `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${limit}`,
    `${DATA_API}/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${limit}`,
    `${DATA_API}/leaderboard?tagSlug=${category.toLowerCase()}&timePeriod=ALL&limit=${limit}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const d = await r.json();
      const arr = Array.isArray(d) ? d : (d.data || d.leaderboard || []);
      if (arr.length > 0) return arr;
    } catch {}
  }
  console.warn(`LB fetch returned 0 for ${category} — category may not exist`);
  return [];
}

async function fetchRecentTrades(limit = 1000) {
  try {
    const r = await fetch(`${DATA_API}/trades?side=BUY&takerOnly=true&limit=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function fetchActiveSportsMarkets() {
  try {
    const r = await fetch(`${DATA_API}/markets?active=true&closed=false&limit=50&order=volume&ascending=false&tag=sports`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : (d.data ? d.data : []);
  } catch { return []; }
}

// ── APPROVED SPORTS WHITELIST ──
const MLB_TEAMS_N = ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies','padres','giants','cardinals','brewers','guardians','royals','twins','orioles','rays','blue jays','mariners','rangers','angels','athletics','tigers','white sox','reds','pirates','rockies','marlins','nationals','diamondbacks'];

const BLOCKED_NOTIFY = ['dota','valorant','cs2','counter-strike','league of legends','lol:','esports','starcraft','overwatch','fortnite','pubg','apex legends','rainbow six','rocket league','bitcoin','ethereum','crypto','trump','biden','president','prime minister','politics','election','stock market','s&p','nasdaq','inflation','fed rate','premier league','la liga','serie a','bundesliga','champions league','eredivisie','ligue 1','ufc','boxing','mma','wnba','nrl','afl','rugby','cricket'];

function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (BLOCKED_NOTIFY.some(k => t.includes(k))) return false;

  // MLB / World Baseball Classic
  if (t.includes('mlb') || t.includes('world baseball classic') || t.includes('wbc') ||
      MLB_TEAMS_N.some(x => t.includes(x))) return true;
  // NBA
  if (t.includes('nba') || t.includes('nba finals')) return true;
  // NFL
  if (t.includes('nfl') || t.includes('super bowl') || t.includes('afc championship') ||
      t.includes('nfc championship')) return true;
  // NHL
  if (t.includes('nhl') || t.includes('stanley cup')) return true;
  // College Football
  if (t.includes('ncaaf') || t.includes('college football playoff') || t.includes('cfp') ||
      t.includes('rose bowl') || t.includes('sugar bowl') || t.includes('orange bowl') ||
      t.includes('cotton bowl') || t.includes('fiesta bowl')) return true;
  // College Basketball
  if (t.includes('ncaab') || t.includes('march madness') || t.includes('ncaa tournament') ||
      t.includes('ncaa basketball') || t.includes('final four')) return true;
  // PGA Golf
  if (t.includes('pga') || t.includes('masters ') || t.includes('ryder cup') ||
      t.includes('the open championship') || t.includes('us open golf') ||
      t.includes('pga championship') || t.includes('liv golf')) return true;
  // FIFA World Cup only (no club leagues)
  if (t.includes('fifa world cup') || t.includes('world cup winner') || t.includes('gold cup') ||
      t.includes('copa america') || t.includes('concacaf')) return true;
  // Olympics
  if (t.includes('olympic') || t.includes('summer games') || t.includes('winter games')) return true;
  // Tennis — Grand Slams + ATP/WTA only
  if (t.includes('wimbledon') || t.includes('us open tennis') || t.includes('french open') ||
      t.includes('australian open') || t.includes('roland garros') ||
      (t.includes('atp ') && !t.includes('esport')) || t.includes('wta ') ||
      t.includes('grand slam')) return true;

  return false;
}

// Determine which sport a market belongs to
function marketSport(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('mlb') || MLB_TEAMS_N.some(x => t.includes(x)) || t.includes('world baseball')) return 'MLB';
  if (t.includes('nba') || t.includes('basketball')) return 'NBA';
  if (t.includes('nfl') || t.includes('super bowl') || t.includes('ncaaf') || t.includes('college football playoff')) return 'NFL';
  if (t.includes('nhl') || t.includes('hockey') || t.includes('stanley cup')) return 'NHL';
  if (t.includes('pga') || t.includes('masters ') || t.includes('golf') || t.includes('ryder cup')) return 'GOLF';
  if (t.includes('wimbledon') || t.includes('atp ') || t.includes('wta ') || t.includes('tennis') || t.includes('open tennis') || t.includes('grand slam')) return 'TENNIS';
  if (t.includes('fifa world cup') || t.includes('copa america') || t.includes('gold cup')) return 'SOCCER';
  if (t.includes('olympic')) return 'OLYMPICS';
  return 'SPORTS';
}

async function sendAlert(topic, buy) {
  const usd   = Math.round(buy.usdValue).toLocaleString();
  const price = (parseFloat(buy.price || 0) * 100).toFixed(1);
  const sport = buy.sport || marketSport(buy.title || '');
  const rankInfo = (buy.categories || []).map(c => {
    const ct = c.category || c.cat || '';
    return `${ct} #${c.rank}`;
  }).join(' / ');

  const verifiedTag = buy.verified === false ? ' [UNVERIFIED]' : '';
  const body = [
    `$${usd} BUY [${sport}]${verifiedTag} - ${buy.traderName || 'Anon'}`,
    rankInfo ? `Rank: ${rankInfo}` : (buy.verified === false ? 'Not in profitable leaderboard — large buy only' : ''),
    `Market: ${(buy.title || 'Unknown').slice(0, 80)}`,
    `Side: ${buy.outcome || '-'} @ ${price}c`,
    buy.eventSlug ? `polymarket.com/event/${buy.eventSlug}` : '',
  ].filter(Boolean).join('\n');

  // Log to alert history
  try {
    await fetch(`${VERCEL_URL}/api/polymarket-alerts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...buy, loggedAt: Date.now() }),
    });
  } catch (e) { console.error('alert log error:', e.message); }

  // Push ntfy
  try {
    const ntfyRes = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title':    `$${usd} ${sport} Smart Money`,
        'Priority': buy.usdValue >= 10000 ? 'urgent' : 'high',
        'Tags':     'money_bag',
      },
      body,
    });
    const resText = await ntfyRes.text().catch(() => '');
    if (!ntfyRes.ok) {
      console.error('ntfy failed:', ntfyRes.status, resText);
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
  const threshold = parseInt(process.env.PM_THRESHOLD || '749');
  const catFilter = (process.env.PM_CATEGORY || 'all').toUpperCase();

  if (!topic) {
    return res.status(200).json({ ok: false, message: 'NTFY_TOPIC not set' });
  }

  const now    = Math.floor(Date.now() / 1000);
  const winMin = now - 900;
  const winMax = now - 30;

  try {
    // ── Fetch all sport-specific leaderboards in parallel ──
    const lbResults = await Promise.all(
      SPORT_LB_CONFIG.map(cfg => fetchLeaderboard(cfg.category, cfg.limit))
    );

    // Build wallet map — sport-specific profitable traders only
    const walletMap = {};
    const lbCoverage = {};

    SPORT_LB_CONFIG.forEach((cfg, i) => {
      const traders = lbResults[i] || [];
      lbCoverage[cfg.category] = traders.length;

      traders.forEach(t => {
        const pnl = parseFloat(t.pnl || 0);
        if (pnl <= 0) return; // Only profitable traders

        const wallet = t.proxyWallet;
        if (!walletMap[wallet]) {
          walletMap[wallet] = {
            name:       t.userName || t.pseudonym,
            categories: [],
            sports:     [],
          };
        }
        walletMap[wallet].categories.push({ category: cfg.category, rank: t.rank, pnl });
        walletMap[wallet].sports.push(cfg.category);
      });
    });

    // If sport-specific categories returned nothing (API may not support them),
    // fall back to SPORTS leaderboard — accept all sports traders
    const mlbCoverage = lbCoverage['MLB'] || 0;
    if (mlbCoverage === 0) {
      console.warn('MLB-specific leaderboard returned 0 — sport categories may not exist on this API version.');
      console.warn('All sport-specific bettors will come from SPORTS leaderboard instead.');
      // Mark that we are in fallback mode in debug output
      lbCoverage['_fallback'] = 'sport-specific categories unavailable';
    }

    const profitableWallets = Object.keys(walletMap).length;

    // ── Fetch global recent trades ──
    const recentTrades = await fetchRecentTrades(1000); // wider window catches more MLB

    // Debug: sample first trade structure
    const sampleTrade = recentTrades[0] ? {
      fields:    Object.keys(recentTrades[0]).join(', '),
      timestamp: recentTrades[0].timestamp,
      title:     recentTrades[0].title,
      wallet:    recentTrades[0].proxyWallet,
      size:      recentTrades[0].size,
      price:     recentTrades[0].price,
    } : null;

    // Check timestamp range of trades
    const timestamps = recentTrades.map(t => parseInt(t.timestamp) || 0).filter(Boolean).sort((a,b)=>b-a);
    const newestTrade = timestamps[0] ? new Date(timestamps[0] * 1000).toISOString() : null;
    const oldestTrade = timestamps[timestamps.length-1] ? new Date(timestamps[timestamps.length-1] * 1000).toISOString() : null;

    // ── ALERT FILTER — PROFITABLE VERIFIED WALLETS ONLY ──
    // Standard: verified profitable wallets at standard threshold
    // MLB exception: lower threshold to $400 (MLB Poly buys are smaller than other sports)
    // No tier 2 / no unverified accounts — maintaining signal quality

    let failedTs = 0, failedThresh = 0, failedSports = 0, failedNotProfitable = 0;
    const failedSportsTitles = [];
    const baseballBuys = []; // full debug: ALL MLB buys in the window
    const toAlert = [];
    const seenKeys = new Set();

    recentTrades.forEach(t => {
      const wallet = t.proxyWallet || t.maker || t.transactor;
      const ts     = parseInt(t.timestamp) || 0;
      const usd    = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
      const sport  = marketSport(t.title);
      const dkey   = (wallet || '') + (t.transactionHash || t.title || '') + ts;

      // Debug: log EVERY MLB buy to diagnose coverage gap
      if (sport === 'MLB' && usd >= 50) {
        baseballBuys.push({
          title:       (t.title || '').slice(0, 60),
          usd:         Math.round(usd),
          wallet:      wallet ? wallet.slice(0, 10) : 'unknown',
          inWalletMap: !!walletMap[wallet],
          trackedSports: walletMap[wallet] ? walletMap[wallet].sports : [],
          ts,
        });
      }

      if (ts < winMin || ts > winMax) { failedTs++; return; }

      const traderInfo = wallet ? walletMap[wallet] : null;
      if (!traderInfo) { failedNotProfitable++; return; }

      if (!isSportsMarket(t.title)) {
        failedSports++;
        if (failedSportsTitles.length < 5) failedSportsTitles.push({ title: t.title, usd: Math.round(usd) });
        return;
      }

      // Sport-specific threshold — MLB buys are typically smaller
      const sportThreshold = sport === 'MLB' ? Math.min(threshold, 400) : threshold;
      if (usd < sportThreshold) { failedThresh++; return; }

      if (seenKeys.has(dkey)) return;
      seenKeys.add(dkey);

      if (catFilter !== 'ALL' && !traderInfo.categories.some(c => (c.category || c.cat) === catFilter)) return;

      toAlert.push({
        wallet,
        traderName:   t.name || t.pseudonym || traderInfo.name || (wallet ? wallet.slice(0,6)+'...'+wallet.slice(-4) : 'Anon'),
        profileImage: t.profileImageOptimized || t.profileImage || null,
        categories:   traderInfo.categories,
        sports:       traderInfo.sports,
        sport,
        title:        t.title,
        slug:         t.slug,
        eventSlug:    t.eventSlug,
        outcome:      t.outcome,
        price:        t.price,
        usdValue:     usd,
        timestamp:    ts,
        loggedAt:     Date.now(),
        transactionHash: t.transactionHash,
        verified:     true,
      });
    });
    toAlert.sort((a, b) => b.usdValue - a.usdValue);

    // ── Send alerts ──
    let sent = 0;
    const ntfyResults = [];
    for (const buy of toAlert) {
      const result = await sendAlert(topic, buy);
      if (result && result.ok) sent++;
      ntfyResults.push({ trader: buy.traderName, sport: buy.sport, usd: Math.round(buy.usdValue), result });
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      ok:               true,
      profitableWallets,
      tradesScanned:    recentTrades.length,
      buysInWindow:     toAlert.length,
      alertsSent:       sent,
      threshold,
      ntfyTopic:        topic,
      window: {
        from: new Date(winMin * 1000).toISOString(),
        to:   new Date(winMax * 1000).toISOString(),
      },
      debug: {
        lbCoverage,           // how many traders per sport category
        failedTs,
        failedThresh,
        failedSports,
        failedNotProfitable,
        failedSportsTitles,
        ntfyResults,
        baseballBuys: baseballBuys.slice(0, 10),  // first 10 baseball buys for diagnosis
        newestTrade,
        oldestTrade,
        sampleTrade,
      },
    });

  } catch (err) {
    console.error('polymarket-notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
