/* =========================================================
   api/polymarket-notify.js  v5 — SIMPLIFIED
   
   Architecture: scan profitable wallets ONLY.
   No global stream needed — if a wallet is in our 67,
   we fetch their trades directly. Clean, simple, debuggable.
   
   Window: 20 hours (covers full game day)
   Threshold: $749 default, $300 for MLB
   Dedup: transactionHash only, one alert per wallet+market
   ========================================================= */

const DATA_API = 'https://data-api.polymarket.com';
const sentThisSession = new Set(); // persists across warm cron invocations

/* ── LEADERBOARD: SPORTS + OVERALL (only categories that work) ── */
async function fetchLeaderboard(category, limit) {
  try {
    const r = await fetch(`${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/* ── WALLET TRADES: fetch recent buys for each profitable wallet ── */
async function fetchWalletTrades(wallets, limit = 30) {
  const results = [];
  // Fetch all in parallel — Vercel handles concurrent requests well
  await Promise.all(wallets.map(async w => {
    try {
      const r = await fetch(`${DATA_API}/trades?user=${w.wallet}&side=BUY&takerOnly=true&limit=${limit}`);
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d)) {
        d.forEach(t => { t._wallet = w.wallet; t._walletName = w.name; }); // tag with wallet info
        results.push(...d);
      }
    } catch {}
  }));
  return results;
}

/* ── SPORT WHITELIST ── */
const MLB_TEAMS = ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies','padres','giants','cardinals','brewers','guardians','royals','twins','orioles','rays','blue jays','mariners','rangers','angels','athletics','tigers','white sox','reds','pirates','rockies','marlins','nationals','diamondbacks'];
const BLOCKED   = ['dota','valorant','cs2','counter-strike','league of legends','lol:','esports','starcraft','overwatch','fortnite','bitcoin','ethereum','crypto','trump','biden','president','prime minister','politics','election','premier league','la liga','serie a','bundesliga','champions league','ufc','boxing','mma','wnba','rugby','cricket'];

function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (BLOCKED.some(k => t.includes(k))) return false;
  if (t.includes('mlb') || t.includes('world baseball classic') || t.includes('wbc') || MLB_TEAMS.some(x => t.includes(x))) return true;
  if (t.includes('nba') || t.includes('nba finals')) return true;
  if (t.includes('nfl') || t.includes('super bowl')) return true;
  if (t.includes('nhl') || t.includes('stanley cup')) return true;
  if (t.includes('ncaaf') || t.includes('college football playoff') || t.includes('cfp')) return true;
  if (t.includes('ncaab') || t.includes('march madness') || t.includes('ncaa tournament') || t.includes('final four')) return true;
  if (t.includes('pga') || t.includes('masters ') || t.includes('ryder cup') || t.includes('the open championship') || t.includes('pga championship')) return true;
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
  if (t.includes('pga') || t.includes('golf') || t.includes('masters ')) return 'GOLF';
  if (t.includes('wimbledon') || t.includes('atp ') || t.includes('wta ') || t.includes('tennis') || t.includes('grand slam')) return 'TENNIS';
  if (t.includes('fifa world cup') || t.includes('copa america') || t.includes('gold cup')) return 'SOCCER';
  if (t.includes('olympic')) return 'OLYMPICS';
  return 'SPORTS';
}

async function sendAlert(topic, buy) {
  const usd      = Math.round(buy.usdValue).toLocaleString();
  const price    = (parseFloat(buy.price || 0) * 100).toFixed(1);
  const sport    = buy.sport || marketSport(buy.title || '');
  const rankInfo = (buy.categories || []).map(c => `${c.category} #${c.rank}`).join(' / ');

  const body = [
    `$${usd} BUY [${sport}] — ${buy.traderName || 'Anon'}`,
    rankInfo ? `Rank: ${rankInfo}` : null,
    `Market: ${(buy.title || 'Unknown').slice(0, 80)}`,
    `Side: ${buy.outcome || '—'} @ ${price}¢`,
    buy.eventSlug ? `polymarket.com/event/${buy.eventSlug}` : null,
  ].filter(Boolean).join('\n');

  // Log to alert history
  try {
    const VERCEL_URL = 'https://sharp-indicator-a34j.vercel.app';
    await fetch(`${VERCEL_URL}/api/polymarket-alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...buy, loggedAt: Date.now() }),
    });
  } catch {}

  // Push ntfy
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
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

  if (!topic) return res.status(200).json({ ok: false, message: 'NTFY_TOPIC not set' });

  const now    = Math.floor(Date.now() / 1000);
  const cutoff = now - 72000;  // 20 hours — covers full game day
  const winMax = now - 30;     // ignore very fresh trades (not yet settled)

  try {
    // ── Step 1: Get profitable leaderboard wallets ──
    const [sportsLB, overallLB] = await Promise.all([
      fetchLeaderboard('SPORTS',  500),
      fetchLeaderboard('OVERALL', 500),
    ]);

    const walletMap = {};
    const walletList = [];

    overallLB.forEach(t => {
      if (parseFloat(t.pnl || 0) <= 0) return;
      const w = t.proxyWallet;
      if (!walletMap[w]) { walletMap[w] = { wallet: w, name: t.userName || t.pseudonym, categories: [] }; walletList.push(walletMap[w]); }
      walletMap[w].categories.push({ category: 'OVERALL', rank: t.rank, pnl: parseFloat(t.pnl) });
    });
    sportsLB.forEach(t => {
      if (parseFloat(t.pnl || 0) <= 0) return;
      const w = t.proxyWallet;
      if (!walletMap[w]) { walletMap[w] = { wallet: w, name: t.userName || t.pseudonym, categories: [], wallet: w }; walletList.push(walletMap[w]); }
      walletMap[w].categories.push({ category: 'SPORTS', rank: t.rank, pnl: parseFloat(t.pnl) });
    });

    const profitableWallets = walletList.length;

    // ── Step 2: Fetch recent trades for all profitable wallets ──
    const rawTrades = await fetchWalletTrades(walletList, 30);

    // ── Step 3: Deduplicate by transactionHash + wallet+time+title ──
    const seen = new Set();
    const trades = rawTrades.filter(t => {
      const key = t.transactionHash || `${t.proxyWallet||t._wallet}|${t.timestamp}|${t.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── Step 4: Filter and build alerts ──
    let failedWindow = 0, failedThresh = 0, failedSports = 0;
    const baseballBuys = [];
    const walletMarketBest = new Map(); // wallet+market → best (largest) buy
    const allFiltered = [];

    trades.forEach(t => {
      const wallet = t.proxyWallet || t._wallet || t.maker;
      const ts     = parseInt(t.timestamp) || 0;
      const usd    = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
      const sport  = marketSport(t.title);

      // Debug: collect all baseball buys
      if ((sport === 'MLB') && usd >= 50) {
        baseballBuys.push({
          title:       (t.title || '').slice(0, 60),
          usd:         Math.round(usd),
          wallet:      wallet ? wallet.slice(0, 10) : 'unknown',
          inWalletMap: !!walletMap[wallet],
          ts,
          tsAge:       `${Math.round((now - ts) / 3600)}h ago`,
          passWindow:  ts >= cutoff && ts <= winMax,
        });
      }

      // Time window: 20 hours
      if (ts < cutoff || ts > winMax) { failedWindow++; return; }

      // Sports whitelist
      if (!isSportsMarket(t.title)) { failedSports++; return; }

      // Sport-specific threshold
      const sportThreshold = sport === 'MLB' ? Math.min(threshold, 300) : threshold;
      if (usd < sportThreshold) { failedThresh++; return; }

      // Wallet must be profitable
      const traderInfo = walletMap[wallet];
      if (!traderInfo) return; // shouldn't happen since we only scan wallet list

      allFiltered.push({ wallet, ts, usd, sport, traderInfo, t });
    });

    // ── Step 5: Keep only BEST (largest) buy per wallet per market ──
    allFiltered.forEach(item => {
      const key = `${item.wallet}||${item.t.title}`;
      const existing = walletMarketBest.get(key);
      if (!existing || item.usd > existing.usd) {
        walletMarketBest.set(key, item);
      }
    });

    const toAlert = [...walletMarketBest.values()].map(({ wallet, usd, sport, traderInfo, t }) => ({
      wallet,
      traderName:      t.name || t.pseudonym || traderInfo.name || wallet.slice(0,6)+'...'+wallet.slice(-4),
      profileImage:    t.profileImageOptimized || t.profileImage || null,
      categories:      traderInfo.categories,
      sport,
      title:           t.title,
      slug:            t.slug,
      eventSlug:       t.eventSlug,
      outcome:         t.outcome,
      price:           t.price,
      usdValue:        usd,
      timestamp:       parseInt(t.timestamp),
      loggedAt:        Date.now(),
      transactionHash: t.transactionHash,
    })).sort((a, b) => b.usdValue - a.usdValue);

    // ── Step 6: Send alerts ──
    let sent = 0;
    const ntfyResults = [];
    // Module-level set persists across warm invocations — prevents repeat ntfy pushes
    // (resets on cold start — cold starts are rare on active Vercel functions)
    for (const buy of toAlert) {
      const alertKey = buy.transactionHash || `${buy.wallet}|${buy.title}|${buy.outcome}`;
      if (sentThisSession.has(alertKey)) {
        ntfyResults.push({ trader: buy.traderName, sport: buy.sport, usd: Math.round(buy.usdValue), result: { ok: false, reason: 'already sent this session' } });
        continue;
      }
      const result = await sendAlert(topic, buy);
      if (result?.ok) { sent++; sentThisSession.add(alertKey); }
      ntfyResults.push({ trader: buy.traderName, sport: buy.sport, usd: Math.round(buy.usdValue), result });
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      ok:               true,
      profitableWallets,
      tradesScanned:    rawTrades.length,
      uniqueAfterDedup: trades.length,
      passedWindow:     allFiltered.length,
      buysInWindow:     toAlert.length,
      alertsSent:       sent,
      threshold,
      ntfyTopic:        topic,
      window: {
        from:    new Date(cutoff * 1000).toISOString(),
        to:      new Date(winMax * 1000).toISOString(),
        hours:   20,
      },
      debug: {
        lbCoverage:   { overall: overallLB.length, sports: sportsLB.length, profitable: profitableWallets },
        failedWindow,
        failedThresh,
        failedSports,
        baseballBuys: baseballBuys.slice(0, 15),
        ntfyResults,
        newestTrade: trades.length ? new Date(Math.max(...trades.map(t=>parseInt(t.timestamp)||0))*1000).toISOString() : null,
      },
    });

  } catch (err) {
    console.error('notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
