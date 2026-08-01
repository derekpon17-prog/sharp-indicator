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
// Per-sport trader PnL gate. Lives in its own module so it is testable in isolation
// and reusable by the dashboard's trader panels.
const traderStats = require('./trader-stats.js');
// Bottom-up discovered wallets — profitable IN A SPORT, not merely rich overall.
const discover = require('./discover.js');

const sentThisSession = new Set(); // fast in-process check; survives WARM invocations only

/* ── DURABLE ALERT DEDUP (bugfix 2026-07-26) ──────────────────────────
   sentThisSession is a module-level Set, so it is wiped on every COLD start. Vercel
   recycles instances routinely between 15-minute cron runs, which meant the same alert
   re-pushed to ntfy on each new instance — observed live: three consecutive invocations
   landed on three different instances (x-vercel-id differed) and all three re-sent the
   identical five KC/DET pushes. Over a 20-hour window that is dozens of duplicate
   notifications for a single play, and it is the larger half of the "too many
   notifications" problem — bigger than the live-play leak.

   Fix: claim each alert in KV with SET NX before sending, exactly as odds.js already
   does for mlv:seen. First claim wins; every later instance sees the key and skips.
   On KV failure we fall back to in-memory rather than going silent, because a total
   notification blackout is a worse failure than an occasional duplicate — and
   dedupSource in the debug payload makes the degraded mode visible. */
const KV_ON = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const dedupDiag = { source: KV_ON ? 'kv' : 'memory', kvErrors: 0, kvSkips: 0 };

async function upstashPost(body) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, result: null };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, result: null };
    const d = await r.json();
    return { ok: true, result: d.result ?? null };
  } catch { return { ok: false, result: null }; }
}

// Returns true if THIS invocation may send the alert. 48h TTL comfortably outstrips the
// 20h scan window, so an alert cannot re-fire as it ages out.
async function claimAlert(key) {
  if (sentThisSession.has(key)) return false;
  if (KV_ON) {
    const res = await upstashPost(['SET', 'ntfy:sent:' + key, '1', 'NX', 'EX', '172800']);
    if (res.ok) {
      if (res.result !== 'OK') { dedupDiag.kvSkips++; return false; } // another run already claimed it
    } else {
      dedupDiag.kvErrors++;
      dedupDiag.source = 'memory-fallback';
    }
  }
  sentThisSession.add(key);
  return true;
}

/* ─── SPORT WHITELIST ─────────────────────────────────
   Restricted 2026-07-24 per directive to: MLB, NFL, NHL, NBA, WNBA, NCAAF,
   NCAAB. Dropped golf, tennis, soccer (incl. World Cup / Olympics). WNBA moved
   off the BLOCKED denylist, where it had been actively suppressed.

   Slug prefix is now the PRIMARY signal, replacing title keyword matching.
   Slugs are structured and unambiguous ("mlb-col-mil-2026-07-24" vs
   "arg-rac-gim-...", "atp-...", "cs2-..."); titles are not. MLB_TEAMS contains
   'rangers' and 'giants', which also match Glasgow Rangers and the Yomiuri
   Giants — a Scottish soccer match would have been tagged MLB and alerted.
   Title matching survives only as a fallback for entries carrying no slug.
   The BLOCKED denylist is gone: with a closed allowlist it is redundant, and a
   denylist can only ever block what someone remembered to enumerate. */
const LEAGUE_BY_SLUG = {
  mlb:'MLB', nfl:'NFL', nhl:'NHL', nba:'NBA', wnba:'WNBA',
  ncaaf:'NCAAF', ncaafb:'NCAAF', cfb:'NCAAF',
  ncaab:'NCAAB', ncaamb:'NCAAB', ncaawb:'NCAAB', cbb:'NCAAB',
};
const MLB_TEAMS = ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies',
  'padres','giants','cardinals','brewers','guardians','royals','twins','orioles','rays',
  'blue jays','mariners','rangers','angels','athletics','tigers','white sox','reds',
  'pirates','rockies','marlins','nationals','diamondbacks'];

function titleLeague(title) {
  const t = (title || '').toLowerCase();
  if (!t) return null;
  if (t.includes(' and ')) return null;   // parlay combo — spans several games, not gradable as one play
  if (t.includes('wnba')) return 'WNBA';  // must precede NBA: the string 'wnba' contains 'nba'
  if (t.includes('ncaaf') || t.includes('college football')) return 'NCAAF';
  if (t.includes('ncaab') || t.includes('march madness')) return 'NCAAB';
  if (t.includes('nfl')  || t.includes('super bowl')) return 'NFL';
  if (t.includes('nhl')) return 'NHL';
  if (t.includes('nba')) return 'NBA';
  if (t.includes('mlb') || MLB_TEAMS.some(x => t.includes(x))) return 'MLB';
  return null;
}

/* Returns the league for an allowed market, or null to reject it. */
function marketLeague(tr) {
  const slug   = ((tr && (tr.slug || tr.eventSlug)) || '').toLowerCase();
  const prefix = slug.split('-')[0];
  if (prefix) return LEAGUE_BY_SLUG[prefix] || null;  // slug present: authoritative, no title guessing
  return titleLeague(tr && tr.title);                 // no slug: fall back to the title
}

function isSportsMarket(tr) { return marketLeague(tr) !== null; }
function marketSport(tr)    { return marketLeague(tr) || 'OTHER'; }

/* ─── LEADERBOARD ─────────────────────────────────────── */
/* OUTAGE FIX 2026-07-24: this was hardcoded to limit=500. Polymarket capped the
   leaderboard limit and now returns an EMPTY array for oversized requests instead of
   clamping it — so every fetch came back with 0 rows, the wallet list was empty, and the
   bot scanned nothing for ~19.5h while still reporting ok:true. (api/polymarket.js kept
   working purely because it happened to ask for 20.)
   Ladder down until the API answers, so a future cap change degrades instead of blacking
   out. limitUsed is surfaced in the debug payload to make a silent regression visible. */
const LB_LIMITS = [100, 50, 20];
const lbDiag = { limitUsed: null };
async function fetchLeaderboard(category) {
  for (const limit of LB_LIMITS) {
    try {
      const r = await fetch(`${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${limit}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (Array.isArray(d) && d.length) { lbDiag.limitUsed = limit; return d; }
    } catch {}
  }
  return [];
}

/* ─── WALLET TRADES ───────────────────────────────────
   DEPTH FIX 2026-07-24: this used to grab a flat last-30 buys per wallet. For
   normal-paced wallets 30 buys reaches back ~22h, which is why 0x2c33's plays
   always landed. For hyperactive wallets it is nearly blind: swisstony posted
   100 buys in 152 SECONDS, so 30 buys covered ~45s of his timeline and roughly
   95% of his MLB bets were never seen.

   The insight that makes this cheap: lookback does not need to reach the 26h
   window, it only needs to exceed the CRON INTERVAL. At 15-minute cron cadence,
   ~20 minutes of reach gives continuous coverage with overlap, and the existing
   transactionHash dedup absorbs the overlap. 8 pages x 100 = 800 buys, which is
   ~20 min even at swisstony's peak burst rate and days for everyone else.

   Pagination is ADAPTIVE: almost every wallet exits after page 1 because its
   oldest row is already past the cutoff, so this costs ~66 calls, not 528. Only
   the hyperactive few page deep.

   Two things are deliberately instrumented rather than assumed, because today's
   outage was a silent one: offset support is probed (if page 2 repeats page 1,
   pagination is unsupported and we degrade to single-page instead of looping),
   and any wallet still truncated at MAX_PAGES is reported in the debug payload
   with the minutes it actually covered — so a blind spot is visible, not silent. */
const TRADE_PAGE = 100;   // rows per request
const MAX_PAGES  = 8;     // hard cap -> 800 buys/wallet (~20 min at peak burst)
const trDiag = { offsetSupported: null, truncated: [], pages: 0 };

async function fetchWalletTrades(wallets, cutoff) {
  const results = [];
  trDiag.truncated = []; trDiag.pages = 0;
  await Promise.all(wallets.map(async w => {
    let firstHash = null, oldest = null, page = 0;
    for (; page < MAX_PAGES; page++) {
      let d;
      try {
        const r = await fetch(`${DATA_API}/trades?user=${w.wallet}&side=BUY&takerOnly=true&limit=${TRADE_PAGE}&offset=${page * TRADE_PAGE}`);
        if (!r.ok) break;
        d = await r.json();
      } catch { break; }
      if (!Array.isArray(d) || !d.length) break;
      trDiag.pages++;

      if (page === 0) {
        firstHash = d[0] && d[0].transactionHash;
      } else if (d[0] && d[0].transactionHash === firstHash) {
        trDiag.offsetSupported = false;  // offset ignored by API — stop, keep page 1 only
        break;
      } else if (page === 1) {
        trDiag.offsetSupported = true;
      }

      d.forEach(t => { t._wallet = w.wallet; t._walletName = w.name; });
      results.push(...d);
      oldest = parseInt(d[d.length - 1].timestamp) || 0;
      if (d.length < TRADE_PAGE) break;  // wallet history exhausted
      if (oldest <= cutoff) break;       // reached the far edge of the window
    }
    if (page >= MAX_PAGES && oldest && oldest > cutoff) {
      trDiag.truncated.push({
        wallet: w.wallet.slice(0, 10), name: w.name || null,
        coveredMin: Math.round((Math.floor(Date.now() / 1000) - oldest) / 60),
      });
    }
  }));
  return results;
}

/* ─── SHARP LINE SIGNAL + GAME SCHEDULE from /api/odds ─
   LIVE-GAME FILTER 2026-07-24: the notify bot had no idea when a game actually
   started, so an in-game buy (e.g. RN1 middling Under 9.5 / Over 8.5 minutes
   apart, live, on COL/MIL) alerted identically to a pregame conviction bet.
   Directive: no live plays on the dashboard or as phone pushes.

   /api/odds already returns commenceTime for every game on the slate — real
   data from The Odds API, the same source the dashboard itself trusts. Fetch
   it ONCE per sport per run and cache it in oddsRawCache, so this reuses the
   exact network call fetchSharpLinePlays('MLB') already made every 15 minutes
   — zero added Odds-API quota for MLB, the only sport actually in season.
   A sport is only ever fetched if a candidate trade in that sport shows up
   this run, so WNBA/NFL/etc. cost nothing on a quiet day either. */
const oddsPayloadCache = {};
async function fetchOddsPayload(sport) {
  if (oddsPayloadCache[sport]) return oddsPayloadCache[sport];
  try {
    const r = await fetch(`${SITE_URL}/api/odds?sport=${sport}`);
    if (!r.ok) return (oddsPayloadCache[sport] = {});
    return (oddsPayloadCache[sport] = await r.json());
  } catch (e) {
    console.warn('[ODDS] fetch failed:', sport, e.message);
    return (oddsPayloadCache[sport] = {});
  }
}
async function fetchOddsRaw(sport) {
  const d = await fetchOddsPayload(sport);
  return (d && d.plays) || [];
}
/* GATE CHANGE 2026-07-26 (council). Was `!noSignal && siScore >= 70`. Post-devig the
   board's max siScore is 0, so this returned nothing and the LINE alert path was dead.
   `indication` composes all five pillars and tiers honestly.
   DELIBERATELY STRICTER THAN THE DASHBOARD: the dashboard shows tier A and B, but a PUSH
   only fires on tier A — genuine multi-source convergence. Notification volume has been a
   repeated complaint, and the fix for a silent board is not a loud phone. Tier B lands on
   the board and in the daily report; only convergence is worth an interruption. */
async function fetchSharpLinePlays(sport = 'MLB') {
  const raw = await fetchOddsRaw(sport);
  return raw.filter(p => p.indication && p.indication.tier === 'A');
}
/* Reads the dedicated `schedule` array, NOT `plays`. This is the whole bug: /api/odds
   filters plays to ct>now, so an in-progress game is absent from it entirely — the live
   check could never match one, always failed open, and suppressed exactly nothing.
   `schedule` is built from the closing-line store and retains games past first pitch. */
async function getSchedule(sport) {
  const d = await fetchOddsPayload(sport);
  const sched = (d && d.schedule) || [];
  if (sched.length) return sched;
  // Fallback for a deploy skew where the API predates `schedule`: pregame games only,
  // which restores the old (non-functional) behaviour rather than throwing.
  return ((d && d.plays) || []).filter(p => p.commenceTime)
    .map(p => ({ away: p.away, home: p.home, commenceTime: p.commenceTime, started: false }));
}
// Reuses the exact team-substring + date-gate pattern already shipped in matchLineToAlert.
// Requires BOTH teams (stricter than matchLineToAlert's either/or) since here we're
// identifying which specific game a bet belongs to, not just detecting any overlap.
function findGameForTrade(trade, games) {
  const t = normTeam(trade.title || '');
  const tradeDate = extractSlugDate(trade);
  return games.find(g => {
    const away = normTeam(g.away || ''), home = normTeam(g.home || '');
    // OR, not AND: single-team market titles are common in the live feed —
    // "Will Colorado Rockies win on 2026-07-24?" names only one side. Same
    // either/or pattern already proven in matchLineToAlert; the date gate
    // below is what keeps this from cross-matching a doubleheader's other game.
    const nameMatch = (away.length > 2 && t.includes(away)) || (home.length > 2 && t.includes(home));
    if (!nameMatch) return false;
    const gDate = gameEasternDate(g);
    if (tradeDate && gDate && tradeDate !== gDate) return false;
    return true;
  }) || null;
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
// STALE-MARKET FILTER: "today" in ET with a 3-hour grace past midnight, so a late
// West-coast game still in progress at 1 AM ET isn't treated as yesterday's game.
// Mirrors the same constant/logic in polymarket.html — keep the two in sync.
const STALE_GRACE_HOURS = 3;
function effectiveTodayET() {
  try { return new Date(Date.now() - STALE_GRACE_HOURS * 3600000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
  catch { return ''; }
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

/* ─── SEND DISCORD ────────────────────────────────────────
   Webhook URL comes from process.env.DISCORD_WEBHOOK_URL — never hardcode it here. It's a
   credential: anyone holding the URL can post into that channel, and this file is committed
   to a repo. Set it once in Vercel (Project Settings → Environment Variables) and it's
   available to every future deploy without ever touching source. */
async function sendDiscord(webhookUrl, content) {
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
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
    poly:  { scanned: 0, sent: 0, alerts: [], liveSkipped: 0, sportPnlSkipped: 0, sportPnlUnknown: 0, walletsEvaluated: 0, specialistWallets: 0, specSent: 0 },
    line:  { scanned: 0, sent: 0, alerts: [] },
    sharp: { scanned: 0, sent: 0, alerts: [] },
  };

  try {
    /* ── STEP 1: Polymarket — profitable wallet scan ── */
    const [sportsLB, overallLB] = await Promise.all([
      fetchLeaderboard('SPORTS'),
      fetchLeaderboard('OVERALL'),
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

    /* POLY SPECIALIST roster merged in alongside the leaderboard whales.
       Two populations, deliberately kept distinguishable: WHALE wallets are selected by
       all-time PnL across every market Polymarket runs, SPECIALIST wallets by demonstrated
       profit in the specific sport they are betting. They are scanned together (one pass,
       no extra trade fetches for overlaps) but TAGGED separately, because the existing
       Poly record — 27-11 over 38 plays — is the only validated evidence in this system
       and blending an untested cohort into it would destroy the ability to tell which
       population is working. */
    const rosterEntries = await discover.getRoster(null);
    const specialistMap = {};
    rosterEntries.forEach(e => {
      specialistMap[e.wallet] = specialistMap[e.wallet] || { sports: {}, name: e.name };
      specialistMap[e.wallet].sports[e.sport] = e;
      if (!walletMap[e.wallet]) {
        walletMap[e.wallet] = { wallet: e.wallet, name: e.name || e.wallet.slice(0, 6), categories: [] };
        walletList.push(walletMap[e.wallet]);
      }
      walletMap[e.wallet].categories.push({ category: 'SPECIALIST:' + e.sport, rank: null, pnl: e.pnl });
    });
    results.poly.specialistWallets = Object.keys(specialistMap).length;

    const rawTrades = await fetchWalletTrades(walletList, cutoff);

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
    const liveGameChecks = [];  // candidates that passed every cheap filter; resolved below

    trades.forEach(t => {
      const wallet = t.proxyWallet || t._wallet || t.maker;
      const ts     = parseInt(t.timestamp) || 0;
      const usd    = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
      const sport  = marketSport(t);

      /* Diagnostic row is created BEFORE the filters so its rejection reason can be
         recorded as they run. Without this, "94 buys in window but 0 evaluated" required
         inferring which filter ate them by reading timestamps and totals by hand — the
         answer was the stale filter working correctly on yesterday's slate, but the
         payload never said so. Now it does. */
      let dbg = null;
      if (sport === 'MLB' && usd >= 50) {
        dbg = {
          title: (t.title || '').slice(0, 60), usd: Math.round(usd),
          wallet: wallet ? wallet.slice(0, 10) : 'unknown',
          inWalletMap: !!walletMap[wallet], ts,
          tsAge: `${Math.round((now - ts) / 3600)}h ago`,
          passWindow: ts >= cutoff && ts <= winMax,
          reject: null,
        };
        baseballBuys.push(dbg);
      }
      const rej = (why) => { if (dbg) dbg.reject = why; };

      if (ts < cutoff || ts > winMax) { rej(ts < cutoff ? 'older than window' : 'too recent (settling)'); return; }
      if (!isSportsMarket(t)) { rej('sport not whitelisted'); return; }
      // STALE-MARKET FILTER: skip buys on markets whose slug-dated game is already in
      // the past (ET) — e.g. late trading / position-dumping on an old unresolved market
      // (proven: a Jun 25 ARI/STL market took an $18.9K buy on Jul 23 and alerted).
      // Undated slugs (futures) can't be judged and pass through unchanged.
      const slugDate = extractSlugDate(t);
      const todayET = effectiveTodayET();
      if (slugDate && todayET && slugDate < todayET) { rej(`stale: game ${slugDate} < today ${todayET}`); return; }
      const sportThresh = sport === 'MLB' ? Math.min(threshold, 300) : threshold;
      if (usd < sportThresh) { rej(`under $${sportThresh} threshold`); return; }
      if (!walletMap[wallet]) { rej('wallet not tracked'); return; }

      rej(null);   // survived every in-loop filter
      liveGameChecks.push({ wallet, usd, sport, t, traderInfo: walletMap[wallet], dbg });
    });

    // Resolve live-game status in one schedule fetch per distinct sport present this run
    // (not per trade — getSchedule() is itself cached per sport via oddsRawCache, so this
    // is at most a handful of calls regardless of how many candidates there are).
    const sportsToCheck = [...new Set(liveGameChecks.map(c => c.sport))];
    const schedules = {};
    for (const sp of sportsToCheck) schedules[sp] = await getSchedule(sp);

    liveGameChecks.forEach((cand) => {
      const { wallet, usd, sport, t, traderInfo } = cand;
      const game = findGameForTrade(t, schedules[sport] || []);
      if (game && game.commenceTime) {
        const commenceTs = Math.floor(new Date(game.commenceTime).getTime() / 1000);
        const ts = parseInt(t.timestamp) || 0;
        // Two independent grounds for suppression:
        //  - game.started: the API's own verdict, immune to trade-timestamp clock skew
        //  - ts > commenceTs: the bet itself was placed after first pitch
        // Either one is enough. Live plays are suppressed entirely, per directive.
        if (game.started === true || ts > commenceTs) {
          results.poly.liveSkipped++;
          if (cand.dbg) cand.dbg.reject = 'live: game already started';
          return;
        }
      }
      // No matching game found (e.g. schedule fetch failed, or a market our
      // matcher can't parse): fail OPEN rather than silently dropping a real signal.
      const key = `${wallet}||${t.title}`;
      const ex  = walletMarketBest.get(key);
      if (!ex || usd > ex.usd) walletMarketBest.set(key, { wallet, usd, sport, t, traderInfo, dbg: cand.dbg });
    });

    /* SPORT-SPECIFIC PnL GATE.
       Leaderboard presence only proves a wallet made money SOMEWHERE — that board ranks
       all-time PnL across politics, crypto and sports alike, so a wallet up $5M on
       elections and down $40K on baseball passed every MLB alert. This asks the question
       that actually matters: net-positive in the sport it is betting right now, over a
       sample large enough to be evidence rather than variance.
       Fails OPEN on unknown or thin records. A gate that silently suppressed everything
       the moment closed-positions changed shape would be the same invisible blackout that
       cost 19 hours this week — unknowns are counted separately so coverage is visible. */
    const candidates = [...walletMarketBest.values()];
    // Resolve DISTINCT wallets in PARALLEL. Sequential awaits here would be a timeout
    // waiting to happen: one wallet routinely produces several candidates, and a cache
    // miss costs a KV read plus up to four paginated Polymarket fetches. Deduping first
    // means a wallet with five qualifying markets is fetched once, not five times.
    const distinctWallets = [...new Set(candidates.map(c => c.wallet))];
    const statsByWallet = {};
    await Promise.all(distinctWallets.map(async w => {
      try { statsByWallet[w] = await traderStats.getTraderStats(w); }
      catch (e) { statsByWallet[w] = { ok: false, error: e.message }; }
    }));
    results.poly.walletsEvaluated = distinctWallets.length;

    const gated = [];
    candidates.forEach(cand => {
      const gate = traderStats.qualifiesForSport(statsByWallet[cand.wallet], cand.sport);
      if (!gate.pass) {
        results.poly.sportPnlSkipped++;
        if (cand.dbg) cand.dbg.reject = 'sport PnL gate: ' + gate.reason;
        return;
      }
      if (!gate.known) results.poly.sportPnlUnknown++;
      gated.push({ ...cand, gate });
    });

    const polyAlerts = gated.map(({ wallet, usd, sport, t, traderInfo, gate }) => ({
      /* WHALE if the wallet earned its place on the leaderboard; SPECIALIST only if it
         got here purely through discovery. Overlap resolves to WHALE so the validated
         record keeps its meaning and the new cohort's record stays clean. */
      type:       (specialistMap[wallet] && specialistMap[wallet].sports[sport]
                   && !(traderInfo.categories || []).some(c => c.category === 'OVERALL' || c.category === 'SPORTS'))
                  ? 'SPEC' : 'POLY',
      specialistRecord: specialistMap[wallet] && specialistMap[wallet].sports[sport]
                        ? specialistMap[wallet].sports[sport].reason : null,
      wallet,
      traderName: t.name || t.pseudonym || traderInfo.name || wallet.slice(0,6)+'...'+wallet.slice(-4),
      profileImage: t.profileImageOptimized || t.profileImage || null,
      categories: traderInfo.categories,
      sport, title: t.title, slug: t.slug, eventSlug: t.eventSlug,
      outcome: t.outcome, price: t.price, usdValue: usd,
      timestamp: parseInt(t.timestamp), loggedAt: Date.now(),
      transactionHash: t.transactionHash,
      sportRecord: gate && gate.known ? gate.reason : null,   // e.g. "MLB +$12,400 over 84 positions (58.3%)"
    })).sort((a, b) => b.usdValue - a.usdValue);

    results.poly.scanned = rawTrades.length;

    // Send Poly alerts
    for (const alert of polyAlerts) {
      const sessionKey = `poly:${alert.transactionHash || alert.wallet + alert.title}`;
      if (!(await claimAlert(sessionKey))) continue;   // durable dedup — survives cold starts

      const usd      = Math.round(alert.usdValue).toLocaleString();
      const price    = (parseFloat(alert.price || 0) * 100).toFixed(1);
      const rankInfo = (alert.categories || []).map(c => `${c.category} #${c.rank}`).join(' / ');
      const body     = [
        `$${usd} BUY [${alert.sport}] — ${alert.traderName}`,
        rankInfo ? `Rank: ${rankInfo}` : null,
        // Specialists earned their place on an in-sport record — lead with it.
        alert.specialistRecord ? `Specialist: ${alert.specialistRecord}` : null,
        alert.sportRecord ? `Record: ${alert.sportRecord}` : null,
        `Market: ${(alert.title || '').slice(0, 80)}`,
        `Side: ${alert.outcome || '—'} @ ${price}¢`,
      ].filter(Boolean).join('\n');

      // Title names the population so the phone tells you which cohort fired at a glance.
      const tag = alert.type === 'SPEC' ? 'Specialist' : 'Whale';
      const r = await sendNtfy(topic, `⚡ $${usd} ${alert.sport} Poly ${tag}`, body);
      if (r.ok) { results.poly.sent++; if (alert.type === 'SPEC') results.poly.specSent++; }
      results.poly.alerts.push({ title: alert.title, usd: Math.round(alert.usdValue), result: r });
      await storeAlert(alert);
      if (polyAlerts.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    /* ── STEP 1.5: Discord convergence ping — 2+ unique wallets on the same side ──
       This is a server-side port of the client's own convergence grouping (buildTrending's
       title+outcome key). It has to live here rather than in the browser because
       convergence is only meaningful if it fires whether or not anyone has the site open —
       the whole point of a ping to a phone. Runs off the alert log this run's polyAlerts
       were just storeAlert()'d into above, so a convergence that only completes THIS run
       (one buyer already logged, a second one lands in this same batch) is caught
       immediately rather than waiting for the next 15-minute pass.
       Dedup uses the same claimAlert() 48h-NX pattern as every other alert type in this
       file, keyed per group — a still-converged play won't re-ping every cycle, but a
       genuinely new convergence always gets exactly one shot at firing. */
    const discordWebhook = process.env.DISCORD_WEBHOOK_URL;
    results.discord = { scanned: 0, sent: 0, alerts: [] };
    if (discordWebhook) {
      try {
        const histRes = await fetch(`${SITE_URL}/api/polymarket-alerts`);
        const histData = await histRes.json();
        const histAlerts = (histData.alerts || []).filter(a => a.type === 'POLY' || a.type === 'SPEC');
        const convCutoff = now - 86400; // 24h — matches the client's own convergence window
        const groups = {};
        histAlerts.forEach(a => {
          const ts = a.loggedAt ? Math.floor(a.loggedAt / 1000) : a.timestamp;
          if (!ts || ts < convCutoff) return;
          const key = `${a.title || ''}||${a.outcome || ''}`;
          if (!a.title || !a.outcome) return;
          if (!groups[key]) groups[key] = { title: a.title, outcome: a.outcome, wallets: new Map(), totalVol: 0 };
          const w = (a.wallet || '').toLowerCase();
          if (w && !groups[key].wallets.has(w)) groups[key].wallets.set(w, a);
          groups[key].totalVol += (a.usdValue || 0);
        });

        for (const key of Object.keys(groups)) {
          const g = groups[key];
          if (g.wallets.size < 2) continue;
          results.discord.scanned++;

          const dedupKey = `discord:conv:${key}`;
          if (!(await claimAlert(dedupKey))) continue;

          const buyers = [...g.wallets.values()];
          const names = buyers.map(a => a.traderName || (a.wallet || '').slice(0, 6) + '...').join(', ');
          const content = [
            `🎯 **POLY CONVERGENCE** — ${buyers.length} traders on the same side`,
            `**${g.title}**`,
            `Side: **${g.outcome}**`,
            `Traders: ${names}`,
            `Combined volume: $${Math.round(g.totalVol).toLocaleString()}`,
          ].join('\n');

          const r = await sendDiscord(discordWebhook, content);
          if (r.ok) results.discord.sent++;
          results.discord.alerts.push({ title: g.title, outcome: g.outcome, buyers: buyers.length, result: r });
        }
      } catch (e) {
        results.discord.error = e.message;
      }
    }

    /* ── STEP 2: Sharp Line Signal — from /api/odds ── */
    const linePlays = await fetchSharpLinePlays('MLB'); // Only SI >= 70 returned (raised from 65)
    results.line.scanned = linePlays.length;

    for (const play of linePlays) {
      const sessionKey = `line:${play.id}:${play.sharpSide}`;
      if (!(await claimAlert(sessionKey))) continue;   // durable dedup — survives cold starts

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
      if (r.ok) results.line.sent++;
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
      if (!(await claimAlert(sessionKey))) continue;   // durable dedup — survives cold starts

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
      if (r.ok) results.sharp.sent++;
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
        poly:  { scanned: results.poly.scanned,  sent: results.poly.sent,  alerts: results.poly.alerts, liveSkipped: results.poly.liveSkipped,
                 sportPnlSkipped: results.poly.sportPnlSkipped, sportPnlUnknown: results.poly.sportPnlUnknown,
                 walletsEvaluated: results.poly.walletsEvaluated,
                 specialistWallets: results.poly.specialistWallets, specSent: results.poly.specSent },
        line:  { scanned: results.line.scanned,  sent: results.line.sent,  alerts: results.line.alerts },
        sharp: { scanned: results.sharp.scanned, sent: results.sharp.sent, alerts: results.sharp.alerts },
        discord: { scanned: results.discord.scanned, sent: results.discord.sent, alerts: results.discord.alerts, error: results.discord.error || null },
      },
      debug: {
        lbLimitUsed: lbDiag.limitUsed,
        dedup:       { source: dedupDiag.source, kvSkips: dedupDiag.kvSkips, kvErrors: dedupDiag.kvErrors },
        tradeDepth:  { pagesFetched: trDiag.pages, offsetSupported: trDiag.offsetSupported,
                       truncatedWallets: trDiag.truncated },
        lbCoverage:  { overall: overallLB.length, sports: sportsLB.length, profitable: walletList.length },
        /* Sorted NEWEST FIRST. In insertion order this showed ten 52-day-old trades while
           hiding every recent buy, which made it useless for the one question it exists to
           answer: was the slate genuinely quiet, or is a filter over-rejecting? Counts are
           reported alongside so the slice can't hide the shape of the data. */
        baseballBuys: baseballBuys.slice().sort((a, b) => b.ts - a.ts).slice(0, 10),
        rejectCounts: baseballBuys.reduce((a, b) => {
          const k = b.reject || 'passed all filters';
          a[k] = (a[k] || 0) + 1; return a;
        }, {}),
        baseballBuyCounts: {
          total: baseballBuys.length,
          inWindow: baseballBuys.filter(b => b.passWindow).length,
          inWindowTracked: baseballBuys.filter(b => b.passWindow && b.inWalletMap).length,
          survived: baseballBuys.filter(b => !b.reject).length,
          newestAgeH: baseballBuys.length
            ? Math.round((Math.min(...baseballBuys.map(b => now - b.ts))) / 3600) : null,
        },
      },
    });

  } catch (err) {
    console.error('notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
