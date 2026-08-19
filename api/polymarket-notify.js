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

/* BUGFIX 2026-08-04: the original needsNickname check only tested whether t.name /
   t.pseudonym / traderInfo.name were truthy — but Polymarket itself sometimes returns an
   already-truncated address (e.g. "0x547f...2937") AS the pseudonym for a wallet that
   never set a real username. That's a truthy string, so it looked like "this wallet has
   a real name" and nickname assignment got skipped entirely — confirmed directly: wallet
   0x547f...'s alert showed the raw truncated address instead of a nickname. Fix: treat
   an address-shaped string as "not a real name" the same way an empty one is, whether it
   came from Polymarket's own API or from this file's own fallback slice. */
function isAddressLike(str) {
  if (!str) return true;
  const s = String(str).trim();
  if (/^0x[a-fA-F0-9]{2,10}\.\.\.[a-fA-F0-9]{2,10}$/.test(s)) return true; // "0x547f...2937"
  if (/^0x[a-fA-F0-9]{20,}-\d{6,}$/i.test(s)) return true;                 // "0x3DFb...-1722957908185"
  return false;
}
function pickRealName(...candidates) {
  for (const c of candidates) { if (c && !isAddressLike(c)) return c; }
  return null;
}

/* NICKNAMES 2026-08-04 (per Derek): a wallet with no real Polymarket display name (no
   .name, no .pseudonym, no leaderboard profile name) previously fell back to a truncated
   address like "0x076d...8d4c" — technically readable, but hard to recognize or remember
   across Discord pings, the alert feed, and Traders tab. Assigns a distinct, memorable
   name instead (e.g. "BigBob"), stored permanently in KV keyed by wallet address, so the
   SAME wallet always gets the SAME name everywhere it appears — this is the only place
   traderName gets constructed (see polyAlerts below), so fixing it here is enough for
   every consumer, no client-side logic needed.
   Uses an atomic KV INCR as the assignment index rather than anything random, so two
   wallets resolving in parallel (this whole scan runs wallets concurrently) can never
   collide on the same name — Redis guarantees INCR is atomic even under concurrent calls. */
const NICKNAME_POOL = [
  'BigBob','SwiftMike','SharpTony','SteadyNate','QuickMax','IronDave','BoldRick','CalmLuke',
  'FastEddie','ColdSteve','WarmSam','DeepJoe','SlyCarl','LoudMarv','QuietPete','KeenAlex',
  'RapidJack','FirmGreg','SmoothLee','HardyKen','BraveTom','WiseHank','StoutJim','LeanRoy',
  'TallDon','ShortWes','GruffAl','SoftBen','HeavyRon','LightVic','DryFred','WetGus',
  'OldChip','YoungMo','NewGabe','LateChet','EarlyDex','SteadyRex','BriskArt','SharpOtis',
  'BoldNed','CalmOwen','QuickIra','FirmSid','SlyRuss','KeenEli','WiseHugo','HardyCole',
  'BraveJett','LeanNico','TallReid','ShortJude','GruffKirk','SoftEzra','HeavyBrooks','LightFinn',
  'DryLane','WetShane','OldTrent','YoungPaul','NewCyrus','LateWade','EarlyDean','ToughGavin',
  'MildBryce','KeenAaron','SlowBlake','FastEli','GoldSaul','SilverRex','IronMabel','SteelDrew',
  'RoyalDex','CopperJon','StoneKurt','FlashTodd','StormLee','ThunderJay','FrostSam','EmberLuke',
];
async function getWalletNickname(wallet) {
  const key = 'nickname:' + wallet;
  try {
    const existing = await upstashPost(['GET', key]);
    if (existing.ok && existing.result) return existing.result;
  } catch {}
  let idx = 0;
  try {
    const inc = await upstashPost(['INCR', 'nickname:counter']);
    idx = (typeof inc.result === 'number' ? inc.result : parseInt(inc.result) || 1) - 1;
  } catch {}
  const cycle = Math.floor(idx / NICKNAME_POOL.length);
  const name = NICKNAME_POOL[idx % NICKNAME_POOL.length] + (cycle > 0 ? cycle + 1 : '');
  try { await upstashPost(['SET', key, name]); } catch {}
  return name;
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
const ESPN_SPORT_PATH = { MLB: 'baseball/mlb', NBA: 'basketball/nba', NFL: 'football/nfl', NHL: 'hockey/nhl' };

// BUGFIX 2026-08-19 (per Derek, real incident): live MLB games were getting alerted on --
// traced to the Odds API quota running out (confirmed: 19,996/20,000 used). getSchedule
// silently returned no real games once that happened, so the live-game check had nothing
// to compare against and correctly-by-design "failed open" rather than drop a real
// signal -- but that meant live suppression itself silently stopped working. This adds a
// free, quota-independent fallback using ESPN's own scoreboard (same source grade-cron.js
// already uses for grading), so live suppression keeps working even when the paid odds
// feed is exhausted.
async function getScheduleFromESPN(sport) {
  const path = ESPN_SPORT_PATH[sport];
  if (!path) return [];
  try {
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${todayStr}`);
    const j = await r.json();
    return (j.events || []).map(ev => {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) return null;
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      if (!home || !away) return null;
      return {
        away: away.team && (away.team.displayName || away.team.name),
        home: home.team && (home.team.displayName || home.team.name),
        commenceTime: ev.date,
        started: !!(comp.status && comp.status.type && comp.status.type.state !== 'pre'),
      };
    }).filter(Boolean);
  } catch { return []; }
}

async function getSchedule(sport) {
  const d = await fetchOddsPayload(sport);
  const sched = (d && d.schedule) || [];
  if (sched.length) return sched;
  const fromPlays = ((d && d.plays) || []).filter(p => p.commenceTime)
    .map(p => ({ away: p.away, home: p.home, commenceTime: p.commenceTime, started: false }));
  if (fromPlays.length) return fromPlays;
  // Both odds-API paths came back empty (e.g. quota exhausted) -- fall back to ESPN's
  // free scoreboard rather than silently letting live-game suppression stop working.
  return getScheduleFromESPN(sport);
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

/* Some wallets have traderName stored as "0xADDRESS-1722957908185" — a raw wallet address
   with what looks like a discovery timestamp appended, instead of a real display name or
   a clean short address. This isn't something the convergence code introduced; it's
   already sitting in stored alert data (confirmed directly against the live alert log —
   e.g. 0x3dfb153c..., 0xb8c842bc..., 0x2c335066... all carry this pattern). Detect it and
   fall back to a clean short address instead of printing the raw composite string. */
function cleanTraderName(name, wallet) {
  const malformed = name && /^0x[a-fA-F0-9]{20,}-\d{10,}$/.test(name);
  if (!malformed && name) return name;
  const w = wallet || (name ? name.split('-')[0] : '');
  return w ? w.slice(0, 6) + '...' + w.slice(-4) : 'Anon';
}

/* WIN-RATE DISPLAY + INFERRED LEAN 2026-08-05 (per Derek).
   IMPORTANT SCOPE NOTE: this parses Polymarket's own self-reported specialistRecord/
   sportRecord text — it is NOT Derek's own tracked graded record. The server has never
   seen Derek's tracked plays (those live in browser localStorage); giving Discord/ntfy
   access to Derek's real W-L requires the KV-sync migration already scoped separately.
   This is the best real signal available server-side today, clearly labeled as such in
   every message so it's never confused with Derek's own tracked results. */
function parseSpecialistRecord(str) {
  if (!str) return null;
  const m = str.match(/([\d.]+)%\s*ROI\s*on\s*\$[\d,]+\s*staked\s*(?:·|-)\s*([\d.]+)%\s*of\s*(\d+)\s*settled\s*bets\s*won.*?\(([+-][\d.]+)pp\)/);
  if (!m) return null;
  const winPct = parseFloat(m[2]);
  const settled = parseInt(m[3], 10);
  // W-L derived from win% × settled count, rounded — Polymarket doesn't publish the raw
  // integers directly, only the percentage and the sample size.
  const wins = Math.round((winPct / 100) * settled);
  const losses = settled - wins;
  return { roiPct: parseFloat(m[1]), winPct, settled, edgePP: parseFloat(m[4]), wins, losses };
}
// Compact display next to a name, e.g. "wr0ngw4yb3tt0r (27-14)" — a real W-L split, same
// format as the Tracking tab's By Trader section. IMPORTANT: this is Polymarket's own
// self-reported record (settled bets on their platform), NOT Derek's own tracked graded
// record — those can genuinely disagree (confirmed directly this session: SDTrading's
// self-reported stats vs. Derek's own tracked results told two different stories).
//
// BRIDGE 2026-08-05 (per Derek): the Tracking tab now pushes its computed by-trader W-L
// to shared KV (api/trader-records.js) after every grading pass. This function checks
// that FIRST — by wallet, falling back to cleaned name — before ever falling back to
// Polymarket's specialistRecord parse. Records sourced from Polymarket (not Derek's own
// tracking) get a trailing "*" so the source is visible at a glance without a legend.
function getRecordFor(a, tracked) {
  if (tracked) {
    const byWallet = a.wallet && tracked[a.wallet];
    if (byWallet && (byWallet.W + byWallet.L) > 0) {
      return { wins: byWallet.W, losses: byWallet.L, edgePP: 0, roiPct: byWallet.roiPct, source: 'tracked', sportBreakdown: extractSportBreakdown(byWallet, a.sport) };
    }
    const label = cleanTraderName(a.traderName, a.wallet);
    const byName = tracked[label];
    if (byName && (byName.W + byName.L) > 0) {
      return { wins: byName.W, losses: byName.L, edgePP: 0, roiPct: byName.roiPct, source: 'tracked', sportBreakdown: extractSportBreakdown(byName, a.sport) };
    }
  }
  const rec = parseSpecialistRecord(a.specialistRecord);
  if (rec) return { wins: rec.wins, losses: rec.losses, edgePP: rec.edgePP, roiPct: rec.roiPct, source: 'specialist' };
  return null;
}
// FEATURE 2026-08-14 (per Derek): "should also be reflected on...discord alerts" — same
// exact condition as the client side (genuinely cross-sport, this alert's own sport has
// real data), so Discord and the site can never disagree about who counts as cross-sport.
function extractSportBreakdown(trackedEntry, sport) {
  if (!sport || !trackedEntry.bySport) return null;
  const sportsWithData = Object.keys(trackedEntry.bySport).filter(sp => {
    const sb = trackedEntry.bySport[sp];
    return sb && (sb.W + sb.L) > 0;
  });
  if (sportsWithData.length <= 1) return null;
  const sb = trackedEntry.bySport[sport];
  if (!sb || (sb.W + sb.L) === 0) return null;
  return { sport, wins: sb.W, losses: sb.L, roiPct: sb.roiPct };
}
// BUGFIX 2026-08-06 (per Derek): roiPct was being computed and pushed by the client but
// silently discarded here — Discord showed W-L only, never ROI, even though the whole
// point of building the KV bridge was to surface the same picture the Tracking tab has.
// Discord can't render color, so a green/red circle emoji stands in for the Tracking
// tab's green/red ROI coloring — same signal, text-only medium.
function nameWithRecord(a, tracked) {
  const label = cleanTraderName(a.traderName, a.wallet);
  const rec = getRecordFor(a, tracked);
  if (!rec) return label;
  const marker = rec.source === 'specialist' ? '*' : '';
  let roiPart = '';
  if (rec.roiPct !== null && rec.roiPct !== undefined) {
    const dot = rec.roiPct > 0 ? '🟢' : rec.roiPct < 0 ? '🔴' : '⚪';
    roiPart = ` ${dot}${rec.roiPct >= 0 ? '+' : ''}${Math.round(rec.roiPct)}%`;
  }
  let sportPart = '';
  if (rec.sportBreakdown) {
    const sb = rec.sportBreakdown;
    const sbRoi = (sb.roiPct !== null && sb.roiPct !== undefined) ? ` ${sb.roiPct >= 0 ? '+' : ''}${Math.round(sb.roiPct)}%` : '';
    sportPart = ` (${sb.sport}: ${sb.wins}-${sb.losses}${sbRoi})`;
  }
  return `${label} (${rec.wins}-${rec.losses}${marker}${roiPart})${sportPart}`;
}
// Per-side quality score from available records (tracked first, specialist stat as
// fallback — see getRecordFor above): rewards win rate above coinflip, scaled by a
// sample-size confidence factor (capped at 30 for full confidence so one deep-sample
// wallet doesn't get double-counted vs a side with only shallow samples), plus a smaller
// credit for edge over implied odds where that's known (tracked-only records don't carry
// an edge figure, treated as 0 rather than guessed). Wallets with no record at all — from
// either source — don't contribute a score either way.
function sideQualityScore(buyers, tracked) {
  const scored = buyers.map(a => {
    const rec = getRecordFor(a, tracked);
    if (!rec) return null;
    const settled = rec.wins + rec.losses;
    if (settled <= 0) return null;
    return { winPct: (rec.wins / settled) * 100, settled, edgePP: rec.edgePP };
  }).filter(Boolean);
  if (!scored.length) return null;
  const total = scored.reduce((sum, r) => {
    const confidence = Math.min(1, r.settled / 30);
    return sum + (r.winPct - 50) * confidence + r.edgePP * 0.5;
  }, 0);
  return total / scored.length;
}
// Compares two sides and returns a lean line, or '' if too close / not enough data to say
// anything meaningful. Threshold (8) is deliberately conservative — this should stay quiet
// rather than manufacture a confident-sounding lean out of thin data.
function inferLean(sideBuyers, sideOutcome, oppBuyers, oppOutcome, tracked) {
  const sideScore = sideQualityScore(sideBuyers, tracked);
  const oppScore = oppBuyers && oppBuyers.length ? sideQualityScore(oppBuyers, tracked) : null;
  if (sideScore === null && oppScore === null) return '';
  if (oppScore === null) {
    return sideScore > 5 ? `\n📊 *Data lean: ${sideOutcome} — the only side with a real record here, and it's a strong one.*` : '';
  }
  const gap = sideScore - oppScore;
  if (Math.abs(gap) < 8) return `\n📊 *Data lean: too close to call — both sides have comparable records.*`;
  const leaderOutcome = gap > 0 ? sideOutcome : oppOutcome;
  return `\n📊 *Data lean: ${leaderOutcome} — stronger win rate/edge among traders on this side. (* = Polymarket's own stat, no asterisk = Derek's own tracked record.)*`;
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
    // Derek's own tracked W-L, pushed by the client after every grading pass (see
    // api/trader-records.js) — the primary source for nameWithRecord()/inferLean() used
    // in both the ntfy push body below and the Discord convergence block further down.
    // Polymarket's specialistRecord is only a fallback for wallets Derek hasn't graded
    // yet. Fetched once here, before either consumer needs it.
    let trackedRecords = {};
    try {
      const trRes = await fetch(`${SITE_URL}/api/trader-records`);
      const trData = await trRes.json();
      trackedRecords = trData.records || {};
    } catch { /* best-effort — falls back to specialistRecord-only if this fails */ }

    // FEATURE 2026-08-17 (per Derek): "how many units is $X for this trader" -- same
    // inferred-unit-size data (median of a trader's own real stakes, 15+ sample minimum)
    // already wired into the site's Alerts/Watched Wallets/By Trader views. Fetched once
    // here so Discord can show the same context, not a separate computation that could
    // drift from what the site shows.
    let unitSizes = {};
    try {
      const usRes = await fetch(`${SITE_URL}/api/grade-cron?allUnits=1`);
      const usData = await usRes.json();
      unitSizes = usData.units || {};
    } catch { /* best-effort — alert still works without unit context */ }
    function unitsLabel(dollarAmount, wallet) {
      const u = wallet && unitSizes[wallet];
      if (!u || !u.inferredUnitSize) return '';
      const units = dollarAmount / u.inferredUnitSize;
      return units >= 0.1 ? ` (${Math.round(units * 10) / 10}u)` : '';
    }

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

    // FEATURE 2026-08-14 (per Derek, real incident): laozishudaosan — a real, tracked
    // 7-1 (+61%) wallet Derek has personally watched — bought Chicago White Sox on the
    // exact game a 4-trader Detroit Tigers convergence fired on, and neither the alert
    // nor the Discord contrast line ever showed him. Root cause: this whole pipeline
    // only ever fetches trades for wallets it already knows about (leaderboard + roster,
    // above) — a wallet Derek has personally chosen to watch was invisible simply
    // because nothing ever told the server it existed. Tagged WATCHED, its own distinct
    // category — not a whale (no real leaderboard rank), not a specialist (not
    // independently discovered/validated) — so it stays visible as a different kind of
    // evidence, the same way SPECIALIST is kept separate from WHALE above. Still subject
    // to the same sport-PnL gate as anyone else.
    let watchedWallets = [];
    try {
      const wwRes = await fetch(`${SITE_URL}/api/watched-wallets`);
      const wwData = await wwRes.json();
      watchedWallets = Array.isArray(wwData.wallets) ? wwData.wallets : [];
    } catch { /* best-effort — falls back to leaderboard+roster only if this fails */ }
    watchedWallets.forEach(w => {
      if (!w.wallet) return;
      if (!walletMap[w.wallet]) {
        walletMap[w.wallet] = { wallet: w.wallet, name: w.name || w.wallet.slice(0, 6), categories: [] };
        walletList.push(walletMap[w.wallet]);
      }
      walletMap[w.wallet].categories.push({ category: 'WATCHED', rank: null, pnl: null });
    });
    results.poly.watchedWallets = watchedWallets.length;
    // FEATURE 2026-08-19 (per Derek): "let ALL activity for him come in, just for his
    // account" -- a per-wallet exception to the normal sport allowlist, not a site-wide
    // change (everyone else still gets the normal MLB/WNBA/NFL/etc filter). Set via
    // POST /api/watched-wallets?setAllSports=0x...
    const allSportsWalletSet = new Set(watchedWallets.filter(w => w.allSports === true).map(w => w.wallet));

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
      let sport  = marketSport(t);
      // Give allSports wallets' non-whitelisted-league trades a real label instead of
      // the generic "OTHER" -- soccer is the actual case in hand (confirmed real
      // titles: "Will RCD Espanyol de Barcelona win...", "Kalmar FF vs. Hammarby IF").
      if (sport === 'OTHER' && allSportsWalletSet.has(wallet)) {
        const tl = (t.title || '').toLowerCase();
        if (/\bwin on \d{4}-\d{2}-\d{2}\?|\bfk\b| ff | if |soccer|premier league|la liga|serie a|bundesliga/.test(tl)) sport = 'Soccer';
      }

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
      // allSports wallets bypass the sport allowlist entirely -- confirmed real case:
      // laozishudaosan's soccer trades were being rejected here before any other check
      // ever ran, since isSportsMarket() only recognizes the named leagues.
      if (!isSportsMarket(t) && !allSportsWalletSet.has(wallet)) { rej('sport not whitelisted'); return; }
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
    // COUNCIL DECISION 2026-08-10 (per Derek, unanimous): a gate-failed wallet's real
    // activity was being discarded entirely here — never stored, so invisible not just to
    // Discord/ntfy but to almost the whole website (Alerts, Today's Board, Top Signals,
    // Sharp Report all read from the same stored log this candidate never reached; only
    // Watched Wallets cards, which bypass the log via a direct Polymarket fetch, ever
    // showed it). Council's verdict: still worth knowing about — just as visible CONTEXT,
    // not a standalone alert, so it doesn't dilute what counts as validated signal.
    // gateFailed keeps these SEPARATE from gated (real signal) throughout — they get
    // stored and can appear in a contrast line, but never trigger their own ping and
    // never count toward a "2+ wallets converging" threshold on their own.
    const gateFailed = [];
    candidates.forEach(cand => {
      const gate = traderStats.qualifiesForSport(statsByWallet[cand.wallet], cand.sport);
      if (!gate.pass) {
        results.poly.sportPnlSkipped++;
        if (cand.dbg) cand.dbg.reject = 'sport PnL gate: ' + gate.reason;
        // Only worth keeping as context when the gate verdict is a real, known negative —
        // not when it merely failed open on a thin/unavailable sample (that's not
        // information, just missing data, and would just be noise here).
        if (gate.known) gateFailed.push({ ...cand, gate });
        return;
      }
      if (!gate.known) results.poly.sportPnlUnknown++;
      gated.push({ ...cand, gate });
    });

    // Resolve nicknames only for wallets that actually need one — no real name from the
    // trade feed, pseudonym, or leaderboard profile. Parallel, same pattern as
    // statsByWallet above, and getWalletNickname's KV INCR keeps concurrent resolution
    // collision-free.
    const needsNickname = [...new Set(
      [...gated, ...gateFailed].filter(c => !pickRealName(c.t.name, c.t.pseudonym, c.traderInfo.name)).map(c => c.wallet)
    )];
    const nicknameByWallet = {};
    await Promise.all(needsNickname.map(async w => {
      nicknameByWallet[w] = await getWalletNickname(w);
    }));

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
      traderName: pickRealName(t.name, t.pseudonym, traderInfo.name) || nicknameByWallet[wallet] || wallet.slice(0,6)+'...'+wallet.slice(-4),
      profileImage: t.profileImageOptimized || t.profileImage || null,
      categories: traderInfo.categories,
      sport, title: t.title, slug: t.slug, eventSlug: t.eventSlug,
      outcome: t.outcome, price: t.price, usdValue: usd,
      timestamp: parseInt(t.timestamp), loggedAt: Date.now(),
      transactionHash: t.transactionHash,
      sportRecord: gate && gate.known ? gate.reason : null,   // e.g. "MLB +$12,400 over 84 positions (58.3%)"
      gateFailed: false,
    })).sort((a, b) => b.usdValue - a.usdValue);

    // COUNCIL DECISION 2026-08-10: same shape as polyAlerts, stored the same way, but
    // never sent as a ping and marked gateFailed so every consumer knows to treat it as
    // context, not signal — dimmed, not alerted, not counted toward a real convergence.
    const gateFailedAlerts = gateFailed.map(({ wallet, usd, sport, t, traderInfo, gate }) => ({
      type: 'POLY',
      specialistRecord: null,
      wallet,
      traderName: pickRealName(t.name, t.pseudonym, traderInfo.name) || nicknameByWallet[wallet] || wallet.slice(0,6)+'...'+wallet.slice(-4),
      profileImage: t.profileImageOptimized || t.profileImage || null,
      categories: traderInfo.categories,
      sport, title: t.title, slug: t.slug, eventSlug: t.eventSlug,
      outcome: t.outcome, price: t.price, usdValue: usd,
      timestamp: parseInt(t.timestamp), loggedAt: Date.now(),
      transactionHash: t.transactionHash,
      sportRecord: gate.reason,
      gateFailed: true,
    }));
    for (const alert of gateFailedAlerts) await storeAlert(alert); // context only — no ntfy, no Discord ping of its own

    results.poly.scanned = rawTrades.length;

    // Send Poly alerts
    for (const alert of polyAlerts) {
      const sessionKey = `poly:${alert.transactionHash || alert.wallet + alert.title}`;
      if (!(await claimAlert(sessionKey))) continue;   // durable dedup — survives cold starts

      const usd      = Math.round(alert.usdValue).toLocaleString();
      const price    = (parseFloat(alert.price || 0) * 100).toFixed(1);
      const rankInfo = (alert.categories || []).map(c => `${c.category} #${c.rank}`).join(' / ');
      // BUGFIX 2026-08-10 (per Derek): "Specialist: 96.2% of 26 settled bets" was showing
      // unconditionally, even when the name line right above it was already using OUR OWN
      // tracked record (e.g. kkookkoo's real 0-1) instead — two different numbers for the
      // same wallet in the same message, no indication which one actually counts. Same
      // tracked-first principle used everywhere else on the site, just never applied to
      // this specific line before: only show the self-reported stat when actually falling
      // back to it, not alongside a real tracked result.
      const usingTracked = getRecordFor(alert, trackedRecords)?.source === 'tracked';
      const body     = [
        `$${usd}${unitsLabel(alert.usdValue, alert.wallet)} BUY [${alert.sport}] — ${nameWithRecord(alert, trackedRecords)}`,
        rankInfo ? `Rank: ${rankInfo}` : null,
        // Specialists earned their place on an in-sport record — lead with it, but only
        // when it's not redundant with a real tracked number already shown above.
        (alert.specialistRecord && !usingTracked) ? `Specialist: ${alert.specialistRecord}` : null,
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

    /* ── STEP 1.5: Discord convergence ping — 2+ unique wallets on the same TEAM ──
       Server-side port of the client's own convergence grouping. Has to live here rather
       than in the browser because convergence is only meaningful if it fires whether or
       not anyone has the site open — the whole point of a ping to a phone.
       Runs off the alert log this run's polyAlerts were just storeAlert()'d into above.

       GROUPING: groups by eventSlug+outcome ("same team, any bet type").

       SCORING: computes the same 0-100 score and ELITE/STRONG/MODERATE tier the website
       shows for the same play — ported directly from the client's signalScore()/
       sigLabel(), not reinvented, so this number can never disagree with what Top Signals
       or Polymarket Signal would show for the identical convergence.

       LIVE-UPDATING: the dedup key stores walletCount + score/tier to detect what changed
       since last sent. Both kinds of "the situation changed" now POST A NEW MESSAGE
       rather than editing anything in place (changed 2026-08-03, per Derek — he wants
       every real update to show as its own fresh line in Discord, not require scrolling
       back to find an edited message):
         - Wallet count grew (someone else joined) → new message, same "🎯 POLY
           CONVERGENCE" framing plus a "(updated — was X, now Y)" note.
         - Tier improved (e.g. MODERATE → STRONG/ELITE) → new message with its own "🚀
           CONVERGENCE UPGRADE" framing — this is the more important kind of change, and
           reads differently on purpose so it doesn't blend in with a routine update. */
    const discordWebhook = process.env.DISCORD_WEBHOOK_URL;
    results.discord = { scanned: 0, sent: 0, edited: 0, upgraded: 0, alerts: [] };
    if (discordWebhook) {
      try {
        const histRes = await fetch(`${SITE_URL}/api/polymarket-alerts`);
        const histData = await histRes.json();
        const histAlerts = (histData.alerts || []).filter(a => a.type === 'POLY' || a.type === 'SPEC');
        const convCutoff = now - 86400; // 24h — matches the client's own convergence window
        const isTotals = o => /^(over|under)\b/i.test(o || '');
        const tierRank = t => t === 'ELITE' ? 2 : t === 'STRONG' ? 1 : 0;

        const groups = {};
        const slugTitle = {};
        histAlerts.forEach(a => {
          const ts = a.loggedAt ? Math.floor(a.loggedAt / 1000) : a.timestamp;
          if (!ts || ts < convCutoff) return;
          if (!a.eventSlug || !a.outcome) return;
          const key = `${a.eventSlug}||${a.outcome}`;
          if (!groups[key]) groups[key] = { eventSlug: a.eventSlug, outcome: a.outcome, wallets: new Map(), totalVol: 0 };
          const w = (a.wallet || '').toLowerCase();
          if (w && !groups[key].wallets.has(w)) groups[key].wallets.set(w, a);
          groups[key].totalVol += (a.usdValue || 0);
          const t = (a.title || '').trim();
          const isCleanMatchup = /\bvs\.?\s/i.test(t) && !/^spread:/i.test(t);
          if (t && (!slugTitle[a.eventSlug] || (isCleanMatchup && !slugTitle[a.eventSlug].clean))) {
            slugTitle[a.eventSlug] = { text: t.replace(/:\s*O\/U.*$/i, '').trim(), clean: isCleanMatchup };
          }
        });

        // FEATURE 2026-08-11 (per Derek, confirmed real case): the client-side net-out
        // fix (a wallet buying both outcomes of the same market shouldn't count as two
        // independent convergences) was only ever applied to the dashboard — Discord ran
        // entirely separate grouping code and never got it. Confirmed directly: Ferrari
        // fired a real Over convergence at 12pm and a separate Under convergence at 1pm on
        // the exact same Brewers/Padres totals market, while the dashboard correctly
        // netted him to Over only. Grouped by TITLE here, not eventSlug — h2h, spread, and
        // totals markets on the same game all share one eventSlug, and netting a wallet's
        // h2h position against their totals position would be wrong; title is what
        // actually distinguishes one specific market from another, same as the client.
        const byTitleForNet = {};
        Object.values(groups).forEach(g => {
          const sample = [...g.wallets.values()][0];
          const t = sample ? sample.title : g.eventSlug;
          if (!byTitleForNet[t]) byTitleForNet[t] = [];
          byTitleForNet[t].push(g);
        });
        Object.values(byTitleForNet).forEach(sides => {
          if (sides.length < 2) return;
          const walletSideVol = {};
          sides.forEach((side, idx) => {
            for (const [wallet, a] of side.wallets) {
              if (!walletSideVol[wallet]) walletSideVol[wallet] = {};
              walletSideVol[wallet][idx] = (walletSideVol[wallet][idx] || 0) + (a.usdValue || 0);
            }
          });
          Object.keys(walletSideVol).forEach(wallet => {
            const bySide = walletSideVol[wallet];
            const sideIdxs = Object.keys(bySide);
            if (sideIdxs.length < 2) return;
            let winnerIdx = sideIdxs[0], winnerVol = bySide[sideIdxs[0]];
            sideIdxs.forEach(idx => { if (bySide[idx] > winnerVol) { winnerVol = bySide[idx]; winnerIdx = idx; } });
            sideIdxs.forEach(idx => {
              if (idx === winnerIdx) return;
              const side = sides[idx];
              const a = side.wallets.get(wallet);
              if (a) side.totalVol -= (a.usdValue || 0);
              side.wallets.delete(wallet);
            });
          });
        });

        // Ported from the client's signalScore()/sigLabel() — same formula, same tiers.
        function computeGroupScore(g) {
          const buyers = [...g.wallets.values()];
          const vol = g.totalVol;
          const base = vol <= 500 ? 5 : Math.min(Math.round(Math.log10(vol / 500) * 38) + 15, 90);
          let bestRank = 999;
          buyers.forEach(b => (b.categories || []).forEach(c => { const r = parseInt(c.rank) || 999; if (r < bestRank) bestRank = r; }));
          const rm = bestRank <= 5 ? 1.6 : bestRank <= 15 ? 1.4 : bestRank <= 30 ? 1.2 : bestRank <= 75 ? 1.0 : 0.85;
          const conv = buyers.length >= 4 ? 28 : buyers.length >= 3 ? 20 : buyers.length >= 2 ? 12 : 0;
          const score = Math.min(Math.round(base * rm) + conv, 100);
          const tier = score >= 80 ? 'ELITE' : score >= 60 ? 'STRONG' : 'MODERATE';
          return { score, tier, bestRank };
        }

        for (const key of Object.keys(groups)) {
          const g = groups[key];
          const allBuyers = [...g.wallets.values()];
          const realBuyers = allBuyers.filter(a => !a.gateFailed);
          const gfBuyers = allBuyers.filter(a => a.gateFailed);
          // COUNCIL DECISION 2026-08-10: the trigger, score, and tier all come from REAL
          // wallets only — a known-negative-in-sport wallet's dollars don't inflate
          // conviction, and can't singlehandedly (or in pairs) trigger a ping. They can
          // still appear as visible, clearly-marked context on this same line.
          if (realBuyers.length < 2) continue;
          results.discord.scanned++;

          const names = realBuyers.map(a => nameWithRecord(a, trackedRecords)).join(', ');
          const realVol = realBuyers.reduce((s, a) => s + (a.usdValue || 0), 0);
          const gameTitle = (slugTitle[g.eventSlug] && slugTitle[g.eventSlug].text) || g.outcome;
          const { score, tier } = computeGroupScore({ ...g, totalVol: realVol, wallets: new Map(realBuyers.map(b => [b.wallet, b])) });
          const gfNote = gfBuyers.length
            ? `\n_Also on this side, known negative in-sport (not counted): ${gfBuyers.map(a => nameWithRecord(a, trackedRecords)).join(', ')}_`
            : '';

          let contrastLine = '';
          let oppBuyersForLean = null, oppOutcomeForLean = null;
          // FEATURE 2026-08-11 (per Derek, confirmed real case): this previously skipped
          // totals markets entirely, so an Over/Under split with real disagreement never
          // showed a contrast line at all. Matches by exact market TITLE now (not just
          // eventSlug) rather than removing the totals check outright — that's what
          // correctly limits Over to only ever matching Under on the SAME total line, and
          // stops an H2H group from ever cross-matching against an unrelated Totals group
          // just because they share a game.
          const myTitle = realBuyers[0] ? realBuyers[0].title : null;
          if (myTitle) {
            const oppKey = Object.keys(groups).find(k2 => {
              const g2 = groups[k2];
              if (g2.outcome === g.outcome || g2.wallets.size === 0) return false;
              const g2Sample = [...g2.wallets.values()][0];
              return g2Sample && g2Sample.title === myTitle;
            });
            if (oppKey) {
              const opp = groups[oppKey];
              const oppAll = [...opp.wallets.values()];
              const oppNames = oppAll.map(a => nameWithRecord(a, trackedRecords) + (a.gateFailed ? ' _(known negative in-sport)_' : '')).join(', ');
              contrastLine = `\n**${realBuyers.length}v${oppAll.length}** — ${oppAll.length} on **${opp.outcome}** (${oppNames})`;
              oppBuyersForLean = oppAll.filter(a => !a.gateFailed); // lean inference stays on real records only
              oppOutcomeForLean = opp.outcome;
            }
          }
          const leanLine = inferLean(realBuyers, g.outcome, oppBuyersForLean, oppOutcomeForLean, trackedRecords);

          const content = [
            `🎯 **POLY CONVERGENCE** — ${realBuyers.length} traders on the same side (ML + spread combined)`,
            `Score: **${score}** (${tier})`,
            `**${gameTitle}**`,
            `Side: **${g.outcome}**`,
            `Traders: ${names}`,
            `Combined volume: $${Math.round(realVol).toLocaleString()}`,
          ].join('\n') + gfNote + contrastLine + leanLine;

          const dedupKey = `discord:conv:${key}`;
          const stateRes = await upstashPost(['GET', dedupKey]);
          let state = null;
          if (stateRes.ok && stateRes.result) { try { state = JSON.parse(stateRes.result); } catch {} }

          if (!state) {
            // Never sent before — post new, capturing the message ID for future edits.
            try {
              const r = await fetch(`${discordWebhook}?wait=true`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
              });
              if (r.ok) {
                const msg = await r.json();
                await upstashPost(['SET', dedupKey, JSON.stringify({ messageId: msg.id, walletCount: realBuyers.length, score, tier }), 'EX', '172800']);
                results.discord.sent++;
                results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, buyers: realBuyers.length, score, tier, action: 'sent' });
              } else {
                results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, action: 'send-failed', status: r.status });
              }
            } catch (e) {
              results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, action: 'send-error', error: e.message });
            }
            continue;
          }

          const grew = realBuyers.length > state.walletCount;
          const upgraded = tierRank(tier) > tierRank(state.tier || 'MODERATE');

          if (grew) {
            // CHANGE 2026-08-03 (per Derek): was PATCH-editing the original message in
            // place. Derek wants a net-new message every time instead, specifically so
            // it shows up as a fresh line in Discord rather than requiring a scroll back
            // to find something that changed quietly. Keeps the same "(updated — was X,
            // now Y)" wording he liked, just posted fresh instead of edited in place.
            try {
              const r = await fetch(discordWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: content + `\n_(updated — was ${state.walletCount}, now ${realBuyers.length})_` }),
              });
              if (r.ok) {
                results.discord.edited++;
                results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, buyers: realBuyers.length, action: 'update-posted', was: state.walletCount });
              } else {
                results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, action: 'update-post-failed', status: r.status });
              }
            } catch (e) {
              results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, action: 'update-post-error', error: e.message });
            }
          }

          if (upgraded) {
            // Tier improved — a silent edit doesn't re-notify on Discord, so this earns
            // an actual new message, not just an update to the old one.
            const upgradeContent = [
              `🚀 **CONVERGENCE UPGRADE** — jumped from ${state.tier || 'MODERATE'} (${state.score ?? '—'}) to **${tier}** (${score})`,
              `**${gameTitle}**`,
              `Side: **${g.outcome}**`,
              `Now ${realBuyers.length} traders: ${names}`,
              `Combined volume: $${Math.round(realVol).toLocaleString()}`,
            ].join('\n') + gfNote + contrastLine + leanLine;
            try {
              const r = await fetch(discordWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: upgradeContent }),
              });
              if (r.ok) {
                results.discord.upgraded++;
                results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, action: 'upgrade-alert', fromTier: state.tier, toTier: tier });
              } else {
                results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, action: 'upgrade-failed', status: r.status });
              }
            } catch (e) {
              results.discord.alerts.push({ title: gameTitle, outcome: g.outcome, action: 'upgrade-error', error: e.message });
            }
          }

          if (grew || upgraded) {
            await upstashPost(['SET', dedupKey, JSON.stringify({ messageId: state.messageId, walletCount: realBuyers.length, score, tier }), 'EX', '172800']);
          }
          // else: already posted, nothing changed since — no action.
        }
      } catch (e) {
        results.discord.error = e.message;
      }
    }

    /* ── STEP 2: Sharp Line Signal — from /api/odds ──
       READINESS 2026-08-02 (per Derek, NFL/NBA/NHL prep): was hardcoded to fetchSharpLinePlays
       ('MLB') only. The odds engine itself (SI score, REL z-score, DISP dispersion, RLM,
       exchange lean) is already sport-agnostic — confirmed directly in odds.js, the only
       sport-specific code there is the default query-param fallback and MLB-gated weather.
       So the one thing actually blocking NFL/NBA/NHL was this hardcoded call. Now loops over
       ACTIVE_LINE_SPORTS — to turn a sport on once its season starts, add its code to this
       one array; no other change needed here. Left as MLB-only for now since NFL/NBA/NHL are
       all off-season — no reason to spend API quota polling empty boards. */
    const ACTIVE_LINE_SPORTS = ['MLB'];
    let linePlays = [];
    for (const lsport of ACTIVE_LINE_SPORTS) {
      const sportPlays = await fetchSharpLinePlays(lsport); // Only SI >= 70 returned (raised from 65)
      sportPlays.forEach(p => { p.sport = p.sport || lsport; });
      linePlays = linePlays.concat(sportPlays);
    }
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
        discord: { scanned: results.discord.scanned, sent: results.discord.sent, edited: results.discord.edited, upgraded: results.discord.upgraded, alerts: results.discord.alerts, error: results.discord.error || null },
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
