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
    return (d.plays || []).filter(p => !p.noSignal && parseInt(p.siScore || 0) >= 70); // Quality threshold
  } catch (e) {
    console.warn('[LINE] fetch failed:', e.message);
    return [];
  }
}

/* ─── MATCH LINE PLAY TO POLY ALERT ──────────────────── */
// BUGFIX: this was a separate, stale copy of the matching logic — no date-gate (would
// happily attach yesterday's already-settled alert to tonight's game, same team playing
// back-to-back) and no side-agreement check (any alert on the same GAME counted as a
// "match" regardless of which side it was actually on). Ported the exact fixes already
// tested and shipped on the dashboard hours ago — nothing new or untested here.
function normTeam(s) {
  return (s || '').toLowerCase().replace(/\b(new york|los angeles|san francisco|san diego|kansas city|st\.?\s*louis|tampa bay|chicago)\b/gi, '').replace(/[^a-z]/g, '').trim();
}
function extractSlugDate(a) {
  const s = (a && (a.eventSlug || a.slug)) || '';
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function gameEasternDate(line) {
  if (!line || !line.commenceTime) return null;
  try { return new Date(line.commenceTime).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); } catch { return null; }
}
function sameSharpSide(lineSide, polyOutcome) {
  const a = normTeam(lineSide || ''), b = normTeam(polyOutcome || '');
  return !!a && !!b && a === b;
}
function matchLineToAlert(linPlay, polyAlerts) {
  const away = normTeam(linPlay.away || ''), home = normTeam(linPlay.home || '');
  const gameDate = gameEasternDate(linPlay);
  return polyAlerts.find(a => {
    const t = normTeam(a.title || '');
    const nameMatch = (away.length > 2 && t.includes(away)) || (home.length > 2 && t.includes(home));
    if (!nameMatch) return false;
    const alertDate = extractSlugDate(a);
    if (gameDate && alertDate && alertDate !== gameDate) return false;
    return true;
  }) || null;
}

// BUGFIX: was a plain weighted average (Line*60% + Poly*40%) — dilutes a genuinely strong
// single source (a real Poly 100 next to a quiet Line day became a mediocre 44). Replaced
// with the exact max+agreement-bonus formula already tested and shipped on the dashboard.
function calcCombined(lineScore, polyScore, sameSide) {
  const hasLine = typeof lineScore === 'number' && lineScore > 0;
  const hasPoly = typeof polyScore === 'number' && polyScore > 0;
  const base = Math.max(hasLine ? lineScore : 0, hasPoly ? polyScore : 0);
  const bonus = (hasLine && hasPoly && sameSide) ? 15 : 0;
  return Math.min(100, Math.round(base + bonus));
}

// BUGFIX: was uncapped with no buyer dedup at all — a single wallet buying the same
// position twice could count as "2 buyers" and inflate the score. Ported the exact
// uniqueBuyerCount + signalScore logic already tested and shipped on the dashboard.
// (Kept intentionally uncapped here, same as the dashboard's own combined-score call
// sites — a genuine Line agreement is itself a second, independent confirming source,
// so the single-buyer cap that applies to Poly-only display doesn't apply in this context.)
function uniqueBuyerCount(group) {
  return new Set(group.buys.map(b => (b.wallet || b.traderName || '').toLowerCase())).size;
}
function polyScore(alert) {
  if (!alert) return 0;
  const group = { totalVol: alert.usdValue || 0, buys: [alert] };
  const vol = group.totalVol, buyers = uniqueBuyerCount(group);
  const base = vol <= 500 ? 5 : Math.min(Math.round(Math.log10(vol / 500) * 38) + 15, 90);
  let bestRank = 999;
  group.buys.forEach(b => (b.categories || []).forEach(c => { const r = parseInt(c.rank) || 999; if (r < bestRank) bestRank = r; }));
  const rm = bestRank <= 5 ? 1.6 : bestRank <= 15 ? 1.4 : bestRank <= 30 ? 1.2 : bestRank <= 75 ? 1.0 : 0.85;
  const conv = buyers >= 4 ? 28 : buyers >= 3 ? 20 : buyers >= 2 ? 12 : 0;
  return Math.min(Math.round(base * rm) + conv, 100);
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
  // Strip non-ASCII from headers — ntfy requires ASCII only
  const asciiTitle = title.replace(/[^\x00-\x7F]/g, '').trim();
  try {
    const r = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Title': asciiTitle, 'Priority': priority, 'Tags': 'money_bag' },
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
  const cutoff = now - 93600;  // 26 hours — catches same-day buys
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
    const linePlays = await fetchSharpLinePlays('MLB'); // Only SI >= 70 returned (raised from 65)
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

      const sameSide = sameSharpSide(play.sharpSide, match.outcome);
      if (!sameSide) continue; // this category specifically means both signals agree on the same side, not just the same game

      const ps       = polyScore(match);
      const combined = calcCombined(parseInt(play.siScore || 0), ps, sameSide);
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
