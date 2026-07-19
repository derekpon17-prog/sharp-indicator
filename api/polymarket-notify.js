/* =========================================================
   api/polymarket-notify.js  — v4 FIXED
   
   ROOT CAUSE ANALYSIS (from debug output):
   1. Sport-specific LB categories (MLB/NFL/etc) don't exist on Polymarket API
      → All LB calls returned 0 → profitableWallets = 0 → all 1000 trades rejected
   2. Global trade scan: 1000 trades = only 44 seconds of data
      → Polymarket processes ~80k trades/hour, we were seeing <0.1%
   3. Global stream dominated by crypto/prediction markets
      → Sports trades buried, baseballBuys = []

   FIXES:
   1. Leaderboard: use SPORTS + OVERALL only (the categories that work)
   2. Trade scan: try sports-tagged endpoint first (500 sports-only trades)
      + per-wallet scan for each tracked wallet's recent buys
   3. MLB threshold: $400 (MLB buys run smaller than other sports)

   ENV VARS: NTFY_TOPIC, PM_THRESHOLD (default 749), PM_CATEGORY (all/MLB/etc)
   ========================================================= */

const DATA_API   = 'https://data-api.polymarket.com';
const VERCEL_URL = 'https://sharp-indicator-a34j.vercel.app';

// Only SPORTS and OVERALL are valid Polymarket leaderboard categories
const LB_CONFIG = [
  { category: 'SPORTS',  limit: 500 },
  { category: 'OVERALL', limit: 500 },
];

const posAlertedKeys = new Set();
// Persists across warm invocations — prevents re-alerting same trade in next cron cycle
const globalAlertedTxns = new Set();

async function fetchLeaderboard(category, limit) {
  try {
    const r = await fetch(`${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

// Fetch sports-specific trades (better than global stream)
async function fetchSportsTrades() {
  const results = [];
  const tried = [];

  // Strategy 1: tag=sports filter
  try {
    const r = await fetch(`${DATA_API}/trades?side=BUY&takerOnly=true&limit=500&tag=sports`);
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length > 0) {
        tried.push({ method: 'tag=sports', count: d.length });
        results.push(...d);
      }
    }
  } catch {}

  // Strategy 2: global stream (fallback / supplement)
  try {
    const r = await fetch(`${DATA_API}/trades?side=BUY&takerOnly=true&limit=500`);
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d)) {
        tried.push({ method: 'global', count: d.length });
        results.push(...d);
      }
    }
  } catch {}

  return { trades: results, tried };
}

// Per-wallet scan: fetch recent buys for each tracked wallet
// Catches plays that happened outside our global scan window
async function fetchWalletTrades(wallets, limit = 30) {
  const results = [];
  // Only scan top 50 by rank to limit API calls
  const top50 = wallets
    .sort((a, b) => Math.min(...(a.categories||[]).map(c=>c.rank)) - Math.min(...(b.categories||[]).map(c=>c.rank)))
    .slice(0, 75); // top 75 profitable wallets by rank

  await Promise.all(top50.map(async w => {
    try {
      const r = await fetch(`${DATA_API}/trades?user=${w.wallet}&side=BUY&takerOnly=true&limit=${limit}`);
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d)) results.push(...d);
    } catch {}
  }));
  return results;
}

// ── APPROVED SPORTS WHITELIST ──
const MLB_TEAMS = ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies','padres','giants','cardinals','brewers','guardians','royals','twins','orioles','rays','blue jays','mariners','rangers','angels','athletics','tigers','white sox','reds','pirates','rockies','marlins','nationals','diamondbacks'];
const BLOCKED   = ['dota','valorant','cs2','counter-strike','league of legends','lol:','esports','starcraft','overwatch','fortnite','pubg','apex','rainbow six','bitcoin','ethereum','crypto','trump','biden','president','prime minister','politics','election','stock market','s&p','nasdaq','inflation','fed rate','premier league','la liga','serie a','bundesliga','champions league','eredivisie','ufc','boxing','mma','wnba','nrl','rugby','cricket'];

function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (BLOCKED.some(k => t.includes(k))) return false;
  if (t.includes('mlb') || t.includes('world baseball classic') || t.includes('wbc') || MLB_TEAMS.some(x => t.includes(x))) return true;
  if (t.includes('nba') || t.includes('nba finals')) return true;
  if (t.includes('nfl') || t.includes('super bowl') || t.includes('afc championship') || t.includes('nfc championship')) return true;
  if (t.includes('nhl') || t.includes('stanley cup')) return true;
  if (t.includes('ncaaf') || t.includes('college football playoff') || t.includes('cfp') || t.includes('bowl game')) return true;
  if (t.includes('ncaab') || t.includes('march madness') || t.includes('ncaa tournament') || t.includes('final four')) return true;
  if (t.includes('pga') || t.includes('masters ') || t.includes('ryder cup') || t.includes('the open championship') || t.includes('us open golf') || t.includes('pga championship')) return true;
  if (t.includes('fifa world cup') || t.includes('world cup winner') || t.includes('gold cup') || t.includes('copa america') || t.includes('concacaf')) return true;
  if (t.includes('olympic') || t.includes('summer games') || t.includes('winter games')) return true;
  if (t.includes('wimbledon') || t.includes('us open tennis') || t.includes('french open') || t.includes('australian open') || t.includes('roland garros') || t.includes('atp ') || t.includes('wta ') || t.includes('grand slam')) return true;
  return false;
}

function marketSport(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('mlb') || MLB_TEAMS.some(x => t.includes(x)) || t.includes('world baseball')) return 'MLB';
  if (t.includes('nba') || t.includes('basketball')) return 'NBA';
  if (t.includes('nfl') || t.includes('super bowl') || t.includes('college football')) return 'NFL';
  if (t.includes('nhl') || t.includes('hockey') || t.includes('stanley cup')) return 'NHL';
  if (t.includes('pga') || t.includes('golf') || t.includes('masters ') || t.includes('ryder cup')) return 'GOLF';
  if (t.includes('wimbledon') || t.includes('atp ') || t.includes('wta ') || t.includes('tennis') || t.includes('grand slam')) return 'TENNIS';
  if (t.includes('fifa world cup') || t.includes('copa america') || t.includes('gold cup')) return 'SOCCER';
  if (t.includes('olympic')) return 'OLYMPICS';
  return 'SPORTS';
}

async function sendAlert(topic, buy) {
  const usd      = Math.round(buy.usdValue).toLocaleString();
  const price    = (parseFloat(buy.price || 0) * 100).toFixed(1);
  const sport    = buy.sport || marketSport(buy.title || '');
  const rankInfo = (buy.categories || [])
    .map(c => `${c.category} #${c.rank}`)
    .join(' / ');

  const body = [
    `$${usd} BUY [${sport}] - ${buy.traderName || 'Anon'}`,
    rankInfo ? `Rank: ${rankInfo}` : null,
    `Market: ${(buy.title || 'Unknown').slice(0, 80)}`,
    `Side: ${buy.outcome || '-'} @ ${price}c`,
    buy.eventSlug ? `polymarket.com/event/${buy.eventSlug}` : null,
  ].filter(Boolean).join('\n');

  try {
    await fetch(`${VERCEL_URL}/api/polymarket-alerts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...buy, loggedAt: Date.now() }),
    });
  } catch (e) { console.error('alert log error:', e.message); }

  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method:  'POST',
      headers: {
        'Title':    `$${usd} ${sport} Smart Money`,
        'Priority': buy.usdValue >= 10000 ? 'urgent' : 'high',
        'Tags':     'money_bag',
      },
      body,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const topic     = process.env.NTFY_TOPIC;
  const threshold = parseInt(process.env.PM_THRESHOLD || '749');
  const catFilter = (process.env.PM_CATEGORY || 'all').toUpperCase();

  if (!topic) return res.status(200).json({ ok: false, message: 'NTFY_TOPIC not set' });

  const now       = Math.floor(Date.now() / 1000);
  const winMin    = now - 900;      // 15 min — for global stream trades
  const winMinWallet = now - 43200; // 12 hours — for per-wallet trades (catches earlier plays)
  const winMax    = now - 30;

  try {
    // ── Step 1: Fetch leaderboards (SPORTS + OVERALL only — what the API supports) ──
    const [sportsLB, overallLB] = await Promise.all([
      fetchLeaderboard('SPORTS',  500),
      fetchLeaderboard('OVERALL', 500),
    ]);

    // Build wallet map — profitable traders only (positive PnL)
    const walletMap = {};
    const walletList = [];

    overallLB.forEach(t => {
      if (parseFloat(t.pnl || 0) <= 0) return;
      const w = t.proxyWallet;
      if (!walletMap[w]) { walletMap[w] = { name: t.userName || t.pseudonym, categories: [], sports: [] }; walletList.push(walletMap[w]); walletMap[w].wallet = w; }
      walletMap[w].categories.push({ category: 'OVERALL', rank: t.rank, pnl: parseFloat(t.pnl) });
    });
    sportsLB.forEach(t => {
      if (parseFloat(t.pnl || 0) <= 0) return;
      const w = t.proxyWallet;
      if (!walletMap[w]) { walletMap[w] = { name: t.userName || t.pseudonym, categories: [], sports: [], wallet: w }; walletList.push(walletMap[w]); }
      walletMap[w].categories.push({ category: 'SPORTS', rank: t.rank, pnl: parseFloat(t.pnl) });
    });

    const profitableWallets = Object.keys(walletMap).length;

    // ── Step 2: Fetch trades via multiple strategies ──
    const { trades: streamTrades, tried: streamMethods } = await fetchSportsTrades();
    const walletTrades = profitableWallets > 0 ? await fetchWalletTrades(walletList) : [];

    // Deduplicate — tag each trade with source so we can apply different time windows
    const seenHash = new Set();
    const allTrades = [
      ...streamTrades.map(t => ({ ...t, _source: 'stream' })),
      ...walletTrades.map(t => ({ ...t, _source: 'wallet' })),
    ].filter(t => {
      const key = t.transactionHash || ((t.proxyWallet||'')+(t.timestamp||'')+(t.title||''));
      if (seenHash.has(key)) return false;
      seenHash.add(key);
      return true;
    });

    // Timestamp range for diagnostics
    const timestamps = allTrades.map(t => parseInt(t.timestamp)||0).filter(Boolean).sort((a,b)=>b-a);
    const newestTrade = timestamps[0] ? new Date(timestamps[0]*1000).toISOString() : null;
    const oldestTrade = timestamps[timestamps.length-1] ? new Date(timestamps[timestamps.length-1]*1000).toISOString() : null;
    const windowSeconds = timestamps.length >= 2 ? timestamps[0] - timestamps[timestamps.length-1] : 0;

    // ── Step 3: Filter and build alert list ──
    let failedTs = 0, failedThresh = 0, failedSports = 0, failedNotProfitable = 0;
    const failedSportsTitles = [];
    const baseballBuys = [];   // ALL MLB buys for diagnosis
    const toAlert = [];
    const alertedKeys = new Set();

    allTrades.forEach(t => {
      const wallet = t.proxyWallet || t.maker || t.transactor;
      const ts     = parseInt(t.timestamp) || 0;
      const usd    = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
      const sport  = marketSport(t.title);

      // Collect all MLB buys for debug regardless of other filters
      if (sport === 'MLB' && usd >= 50) {
        baseballBuys.push({
          title:       (t.title || '').slice(0, 70),
          usd:         Math.round(usd),
          wallet:      wallet ? wallet.slice(0, 10) : 'unknown',
          inWalletMap: !!walletMap[wallet],
          ts,
        });
      }

      // Apply window based on source: stream=15min, wallet scan=12hr
      const effectiveWinMin = t._source === 'wallet' ? winMinWallet : winMin;
      if (ts < effectiveWinMin || ts > winMax) { failedTs++; return; }

      const traderInfo = wallet ? walletMap[wallet] : null;
      if (!traderInfo) { failedNotProfitable++; return; }

      if (!isSportsMarket(t.title)) {
        failedSports++;
        if (failedSportsTitles.length < 5) failedSportsTitles.push({ title: t.title, usd: Math.round(usd) });
        return;
      }

      // Sport-specific threshold: MLB runs smaller than other sports
      const sportThreshold = sport === 'MLB' ? Math.min(threshold, 400) : threshold;
      if (usd < sportThreshold) { failedThresh++; return; }

      const alertKey = t.transactionHash || ((wallet||'') + (t.title||'') + ts);
      if (alertedKeys.has(alertKey)) return;
      if (globalAlertedTxns.has(alertKey)) return; // already alerted in a prior cron cycle
      alertedKeys.add(alertKey);
      globalAlertedTxns.add(alertKey);

      if (catFilter !== 'ALL' && !traderInfo.categories.some(c => (c.category||c.cat) === catFilter)) return;

      toAlert.push({
        wallet,
        traderName:      t.name || t.pseudonym || traderInfo.name || (wallet ? wallet.slice(0,6)+'...'+wallet.slice(-4) : 'Anon'),
        profileImage:    t.profileImageOptimized || t.profileImage || null,
        categories:      traderInfo.categories,
        sports:          traderInfo.sports || [],
        sport,
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

    // ── Step 4: Send alerts ──
    let sent = 0;
    const ntfyResults = [];
    for (const buy of toAlert) {
      const result = await sendAlert(topic, buy);
      if (result?.ok) sent++;
      ntfyResults.push({ trader: buy.traderName, sport: buy.sport, usd: Math.round(buy.usdValue), result });
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      ok:               true,
      profitableWallets,
      tradesScanned:    allTrades.length,
      uniqueAfterDedup: allTrades.length,
      buysInWindow:     toAlert.length,
      alertsSent:       sent,
      threshold,
      ntfyTopic:        topic,
      window: {
        from:          new Date(winMin * 1000).toISOString(),
        to:            new Date(winMax * 1000).toISOString(),
        tradeSpanSecs: windowSeconds,
      },
      debug: {
        streamMethods,          // which fetch strategies worked
        lbCoverage: {
          overall: overallLB.length,
          sports:  sportsLB.length,
          profitable: profitableWallets,
        },
        walletScanCount:     walletList.length,
        streamTrades:        streamTrades.length,
        walletTrades:        walletTrades.length,
        failedTs,
        failedTs_detail: `${failedTs} trades outside window (stream=15min, wallet=12hr)`,
        failedThresh,
        failedSports,
        failedNotProfitable,
        failedSportsTitles,
        baseballBuys:        baseballBuys.slice(0, 15),
        newestTrade,
        oldestTrade,
        ntfyResults,
      },
    });

  } catch (err) {
    console.error('polymarket-notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message, stack: err.stack?.slice(0,300) });
  }
};
