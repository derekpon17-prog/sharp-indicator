/* =========================================================
   api/polymarket-notify.js  v6
   
   Sends three types of alerts:
   1. POLY SIGNAL  — profitable Polymarket trader buys
   2. LINE SIGNAL  — Sharp.idx SI >= 65 (Pinnacle gap + exchange)
   3. SHARP SCORE  — both signals agree, combined >= 70
   
   All three auto-track to /api/polymarket-alerts for the dashboard.
   sentThisSession prevents repeat pushes across warm cron cycles.
   ========================================================= */

const DATA_API    = 'https://data-api.polymarket.com';
const SITE_URL    = 'https://sharp-indicator-a34j.vercel.app';
const sentThisSession = new Set(); // persists across warm invocations

/* ─── SPORT WHITELIST ─────────────────────────────────── */
const MLB_TEAMS = ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies',
  'padres','giants','cardinals','brewers','guardians','royals','twins','orioles','rays',
  'blue jays','mariners','rangers','angels','athletics','tigers','white sox','reds',
  'pirates','rockies','marlins','nationals','diamondbacks'];
const BLOCKED = ['dota','valorant','cs2','counter-strike','league of legends','lol:',
  'esports','starcraft','overwatch','fortnite','bitcoin','ethereum','crypto','trump',
  'biden','president','prime minister','politics','election','premier league','la liga',
  'serie a','bundesliga','champions league','ufc','boxing','mma','wnba','rugby','cricket'];

function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (BLOCKED.some(k => t.includes(k))) return false;
  if (t.includes('mlb') || MLB_TEAMS.some(x => t.includes(x))) return true;
  if (t.includes('nba') || t.includes('nfl') || t.includes('nhl')) return true;
  if (t.includes('ncaaf') || t.includes('ncaab') || t.includes('march madness')) return true;
  if (t.includes('pga') || t.includes('masters ') || t.includes('ryder cup')) return true;
  if (t.includes('fifa world cup') || t.includes('copa america') || t.includes('gold cup')) return true;
  if (t.includes('wimbledon') || t.includes('us open tennis') || t.includes('grand slam')) return true;
  if (t.includes('olympic')) return true;
  return false;
}

function marketSport(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('mlb') || MLB_TEAMS.some(x => t.includes(x))) return 'MLB';
  if (t.includes('nba') || t.includes('basketball')) return 'NBA';
  if (t.includes('nfl') || t.includes('super bowl')) return 'NFL';
  if (t.includes('nhl') || t.includes('hockey')) return 'NHL';
  if (t.includes('pga') || t.includes('golf')) return 'GOLF';
  if (t.includes('wimbledon') || t.includes('tennis') || t.includes('grand slam')) return 'TENNIS';
  if (t.includes('world cup') || t.includes('copa america')) return 'SOCCER';
  if (t.includes('olympic')) return 'OLYMPICS';
  return 'SPORTS';
}

/* ─── LEADERBOARD ─────────────────────────────────────── */
async function fetchLeaderboard(category, limit) {
  try {
    const r = await fetch(`${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/* ─── WALLET TRADES ───────────────────────────────────── */
async function fetchWalletTrades(wallets, limit = 30) {
  const results = [];
  await Promise.all(wallets.map(async w => {
    try {
      const r = await fetch(`${DATA_API}/trades?user=${w.wallet}&side=BUY&takerOnly=true&limit=${limit}`);
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d)) {
        d.forEach(t => { t._wallet = w.wallet; t._walletName = w.name; });
        results.push(...d);
      }
    } catch {}
  }));
  return results;
}

/* ─── SHARP LINE SIGNAL from /api/odds ───────────────── */
async function fetchSharpLinePlays(sport = 'MLB') {
  try {
    const r = await fetch(`${SITE_URL}/api/odds?sport=${sport}`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.plays || []).filter(p => !p.noSignal && parseInt(p.siScore || 0) >= 65);
  } catch (e) {
    console.warn('[LINE] fetch failed:', e.message);
    return [];
  }
}

/* ─── MATCH LINE PLAY TO POLY ALERT ──────────────────── */
function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z]/g, '').trim();
}
function matchLineToAlert(linPlay, polyAlerts) {
  const away = normName(linPlay.away || '');
  const home = normName(linPlay.home || '');
  return polyAlerts.find(a => {
    const t = normName(a.title || '');
    return (away.length > 3 && t.includes(away)) || (home.length > 3 && t.includes(home));
  }) || null;
}

function calcCombined(siScore, polyScore) {
  return Math.min(Math.round(siScore * 0.60 + polyScore * 0.40), 100);
}

function polyScore(alert) {
  if (!alert) return 0;
  const usd = alert.usdValue || 0;
  const rank = (alert.categories || []).reduce((min, c) => Math.min(min, c.rank || 999), 999);
  const base = Math.min(Math.log10(Math.max(usd, 500) / 500) * 38 + 15, 90);
  const mult = rank <= 5 ? 1.6 : rank <= 15 ? 1.4 : rank <= 30 ? 1.2 : rank <= 75 ? 1.0 : 0.85;
  return Math.min(Math.round(base * mult), 100);
}

/* ─── STORE ALERT (auto-track) ────────────────────────── */
async function storeAlert(payload) {
  try {
    await fetch(`${SITE_URL}/api/polymarket-alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, loggedAt: Date.now() }),
    });
  } catch {}
}

/* ─── SEND NTFY ───────────────────────────────────────── */
async function sendNtfy(topic, title, body, priority = 'high') {
  try {
    const r = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Tags': 'money_bag' },
      body,
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════
   MAIN HANDLER
═══════════════════════════════════════════════════════ */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const topic     = process.env.NTFY_TOPIC;
  const threshold = parseInt(process.env.PM_THRESHOLD || '749');
  if (!topic) return res.status(200).json({ ok: false, message: 'NTFY_TOPIC not set' });

  const now    = Math.floor(Date.now() / 1000);
  const cutoff = now - 72000;  // 20 hours
  const winMax = now - 30;

  const results = {
    poly:  { scanned: 0, sent: 0, alerts: [] },
    line:  { scanned: 0, sent: 0, alerts: [] },
    sharp: { scanned: 0, sent: 0, alerts: [] },
  };

  try {
    /* ── STEP 1: Polymarket — profitable wallet scan ── */
    const [sportsLB, overallLB] = await Promise.all([
      fetchLeaderboard('SPORTS', 500),
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
      if (!walletMap[w]) { walletMap[w] = { wallet: w, name: t.userName || t.pseudonym, categories: [] }; walletList.push(walletMap[w]); }
      walletMap[w].categories.push({ category: 'SPORTS', rank: t.rank, pnl: parseFloat(t.pnl) });
    });

    const rawTrades = await fetchWalletTrades(walletList, 30);

    // Dedup
    const seen = new Set();
    const trades = rawTrades.filter(t => {
      const key = t.transactionHash || `${t.proxyWallet||t._wallet}|${t.timestamp}|${t.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Filter and best-per-wallet-market
    const walletMarketBest = new Map();
    const baseballBuys = [];

    trades.forEach(t => {
      const wallet = t.proxyWallet || t._wallet || t.maker;
      const ts     = parseInt(t.timestamp) || 0;
      const usd    = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
      const sport  = marketSport(t.title);

      if (sport === 'MLB' && usd >= 50) {
        baseballBuys.push({
          title: (t.title || '').slice(0, 60), usd: Math.round(usd),
          wallet: wallet ? wallet.slice(0, 10) : 'unknown',
          inWalletMap: !!walletMap[wallet], ts,
          tsAge: `${Math.round((now - ts) / 3600)}h ago`,
          passWindow: ts >= cutoff && ts <= winMax,
        });
      }

      if (ts < cutoff || ts > winMax) return;
      if (!isSportsMarket(t.title)) return;
      const sportThresh = sport === 'MLB' ? Math.min(threshold, 300) : threshold;
      if (usd < sportThresh) return;
      if (!walletMap[wallet]) return;

      const key = `${wallet}||${t.title}`;
      const ex  = walletMarketBest.get(key);
      if (!ex || usd > ex.usd) walletMarketBest.set(key, { wallet, usd, sport, t, traderInfo: walletMap[wallet] });
    });

    const polyAlerts = [...walletMarketBest.values()].map(({ wallet, usd, sport, t, traderInfo }) => ({
      type:       'POLY',
      wallet,
      traderName: t.name || t.pseudonym || traderInfo.name || wallet.slice(0,6)+'...'+wallet.slice(-4),
      profileImage: t.profileImageOptimized || t.profileImage || null,
      categories: traderInfo.categories,
      sport, title: t.title, slug: t.slug, eventSlug: t.eventSlug,
      outcome: t.outcome, price: t.price, usdValue: usd,
      timestamp: parseInt(t.timestamp), loggedAt: Date.now(),
      transactionHash: t.transactionHash,
    })).sort((a, b) => b.usdValue - a.usdValue);

    results.poly.scanned = rawTrades.length;

    // Send Poly alerts
    for (const alert of polyAlerts) {
      const sessionKey = `poly:${alert.transactionHash || alert.wallet + alert.title}`;
      if (sentThisSession.has(sessionKey)) continue;

      const usd      = Math.round(alert.usdValue).toLocaleString();
      const price    = (parseFloat(alert.price || 0) * 100).toFixed(1);
      const rankInfo = (alert.categories || []).map(c => `${c.category} #${c.rank}`).join(' / ');
      const body     = [
        `$${usd} BUY [${alert.sport}] — ${alert.traderName}`,
        rankInfo ? `Rank: ${rankInfo}` : null,
        `Market: ${(alert.title || '').slice(0, 80)}`,
        `Side: ${alert.outcome || '—'} @ ${price}¢`,
      ].filter(Boolean).join('\n');

      const r = await sendNtfy(topic, `⚡ $${usd} ${alert.sport} Smart Money`, body);
      if (r.ok) { sentThisSession.add(sessionKey); results.poly.sent++; }
      results.poly.alerts.push({ title: alert.title, usd: Math.round(alert.usdValue), result: r });
      await storeAlert(alert);
      if (polyAlerts.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    /* ── STEP 2: Sharp Line Signal — from /api/odds ── */
    const linePlays = await fetchSharpLinePlays('MLB');
    results.line.scanned = linePlays.length;

    for (const play of linePlays) {
      const sessionKey = `line:${play.id}:${play.sharpSide}`;
      if (sentThisSession.has(sessionKey)) continue;

      const si   = parseInt(play.siScore || 0);
      const gap  = parseFloat(play.gapPP || 0).toFixed(1);
      const ex   = play.exConfirms || 0;
      const pin  = play.pillars?.pinnacle || 0;
      const mon  = play.pillars?.money || 0;

      const title = `📊 Sharp Line: ${play.away} vs ${play.home}`;
      const body  = [
        `SI Score: ${si} — ${play.signalType}`,
        `Sharp Side: ${play.sharpSide}`,
        `Pinnacle: ${play.lines?.pinnacle || '—'} | Soft avg: ${play.lines?.softAvg || '—'}`,
        `Gap: +${gap}pp | Exchange confirms: ${ex}`,
        `Pillars — Pin: ${pin} | Money: ${mon} | RLM: ${play.pillars?.rlm || 35}`,
        play.pillars?.rlmIsReal ? '✓ Real line velocity data' : '⚠ RLM inferred (building baseline)',
      ].join('\n');

      const priority = si >= 80 ? 'urgent' : 'high';
      const r = await sendNtfy(topic, title, body, priority);
      if (r.ok) { sentThisSession.add(sessionKey); results.line.sent++; }
      results.line.alerts.push({ game: `${play.away} vs ${play.home}`, si, side: play.sharpSide, result: r });

      // Auto-track: store as line play
      await storeAlert({
        type:        'LINE',
        title:       `${play.away} vs ${play.home}`,
        sharpSide:   play.sharpSide,
        siScore:     si,
        signalType:  play.signalType,
        gapPP:       gap,
        exConfirms:  ex,
        pinnacleGap: gap,
        sport:       'MLB',
        lines:       play.lines,
        pillars:     play.pillars,
        gameTime:    play.commenceTime,
        status:      'OPEN',
        loggedAt:    Date.now(),
        transactionHash: `line:${play.id}:${play.sharpSide}`,
      });

      if (linePlays.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    /* ── STEP 3: Combined Sharp Score ────────────────── */
    for (const play of linePlays) {
      const match = matchLineToAlert(play, polyAlerts);
      if (!match) continue;

      const ps       = polyScore(match);
      const combined = calcCombined(parseInt(play.siScore || 0), ps);
      if (combined < 70) continue;

      const sessionKey = `sharp:${play.id}:${play.sharpSide}`;
      if (sentThisSession.has(sessionKey)) continue;

      results.sharp.scanned++;

      const title = `🎯 SHARP SCORE ${combined}: ${play.away} vs ${play.home}`;
      const body  = [
        `Combined Score: ${combined}/100`,
        `━━ LINE SIGNAL (${play.siScore}) ━━`,
        `Sharp Side: ${play.sharpSide}`,
        `Pinnacle +${play.gapPP}pp | ${play.signalType}`,
        `━━ POLY SIGNAL (${ps}) ━━`,
        `${match.traderName} bought ${match.outcome} @ ${(parseFloat(match.price||0)*100).toFixed(1)}¢`,
        `Size: $${Math.round(match.usdValue).toLocaleString()}`,
        `Both signals pointing same direction ↑`,
      ].join('\n');

      const r = await sendNtfy(topic, title, body, 'urgent');
      if (r.ok) { sentThisSession.add(sessionKey); results.sharp.sent++; }
      results.sharp.alerts.push({
        game: `${play.away} vs ${play.home}`, combined,
        lineSI: play.siScore, polyScore: ps, result: r
      });

      // Auto-track combined play
      await storeAlert({
        type:        'SHARP_SCORE',
        title:       `${play.away} vs ${play.home}`,
        sharpSide:   play.sharpSide,
        combined,
        siScore:     play.siScore,
        polyScore:   ps,
        signalType:  play.signalType,
        polyTitle:   match.title,
        polyOutcome: match.outcome,
        polyTrader:  match.traderName,
        sport:       'MLB',
        lines:       play.lines,
        gameTime:    play.commenceTime,
        status:      'OPEN',
        loggedAt:    Date.now(),
        transactionHash: `sharp:${play.id}:${play.sharpSide}`,
      });
    }

    return res.status(200).json({
      ok: true,
      profitableWallets: walletList.length,
      ntfyTopic: topic,
      window: { from: new Date(cutoff*1000).toISOString(), to: new Date(winMax*1000).toISOString(), hours: 20 },
      results: {
        poly:  { scanned: results.poly.scanned,  sent: results.poly.sent,  alerts: results.poly.alerts },
        line:  { scanned: results.line.scanned,  sent: results.line.sent,  alerts: results.line.alerts },
        sharp: { scanned: results.sharp.scanned, sent: results.sharp.sent, alerts: results.sharp.alerts },
      },
      debug: {
        lbCoverage:  { overall: overallLB.length, sports: sportsLB.length, profitable: walletList.length },
        baseballBuys: baseballBuys.slice(0, 10),
      },
    });

  } catch (err) {
    console.error('notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
