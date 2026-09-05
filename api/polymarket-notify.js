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
// REBUILT 2026-09-01 (per Derek, real trigger -- a wallet needed a name and hit this
// exact system): this was still the flat 60/90-name pool with a numbered-suffix fallback
// (BigBob, BigBob2, BigBob3...) already flagged as explicitly unwanted, with an agreed
// direction never actually built until now -- two independent word lists combined at
// assignment time, 20x20 = 400 real combinations before any repeat, no numbered suffixes
// for a very long time. Same atomic KV-INCR index as before, just decoded into two
// dimensions (adjective = idx % 20, noun = idx / 20) instead of one flat array + suffix.
const NICKNAME_ADJECTIVES = [
  'Swift','Sharp','Steady','Quick','Iron','Bold','Calm','Fast','Cold','Warm',
  'Deep','Sly','Loud','Quiet','Keen','Rapid','Firm','Smooth','Hardy','Brave',
];
const NICKNAME_NOUNS = [
  'Falcon','Wolf','Hawk','Tiger','Bear','Eagle','Fox','Lion','Shark','Panther',
  'Raven','Cobra','Viper','Puma','Lynx','Jaguar','Osprey','Badger','Stallion','Griffin',
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
  const totalCombos = NICKNAME_ADJECTIVES.length * NICKNAME_NOUNS.length;
  const cycle = Math.floor(idx / totalCombos);
  const comboIdx = idx % totalCombos;
  const adj = NICKNAME_ADJECTIVES[comboIdx % NICKNAME_ADJECTIVES.length];
  const noun = NICKNAME_NOUNS[Math.floor(comboIdx / NICKNAME_ADJECTIVES.length) % NICKNAME_NOUNS.length];
  const name = adj + noun + (cycle > 0 ? cycle + 1 : '');
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
  // BUGFIX 2026-08-19 (per Derek, real incident): confirmed directly -- this used
  // new Date().toISOString(), which is UTC. An evening MLB game (e.g. 7:10pm CT) is
  // still "today" by every US clock, but UTC has often already rolled to the NEXT
  // calendar date by kickoff -- querying ESPN for "today" (UTC) silently returned zero
  // games for the actual live slate, findGameForTrade found no match, and live
  // suppression failed open for the entire run (confirmed: liveSkipped:0 while a real
  // live Angels/Astros trade passed with reject:null). Queries both the real Eastern
  // "baseball day" AND the UTC date as a second attempt, rather than picking one and
  // risking the same class of mismatch in the other direction.
  try {
    /* FIX 2026-08-29 (per Derek, real incident investigated this morning): confirmed
       directly -- Orioles/Athletics trades from last night, timestamped ~12:15-1:00 AM
       ET, fed a "6 traders ELITE" convergence alert for a game that had actually been
       live since 9:41 PM the evening before. Root cause, confirmed mathematically: at
       that trade timestamp, BOTH the ET date (20260829) and UTC date (20260829) the old
       code queried had already rolled to the 29th -- but ESPN still files a 9:41 PM
       start under the 28th's scoreboard even hours after midnight. Neither existing
       query could ever have found it; this isn't the same gap the Aug 19 fix closed
       (that was ET-vs-UTC on the SAME calendar day), it's a late-night game surviving
       past a real midnight rollover. Added yesterday's ET date as a third query -- cheap
       (one more free ESPN call), and directly closes the exact gap that let this happen. */
    const etDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
    const utcDateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const yesterdayET = new Date(Date.now() - 24 * 3600000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
    const dates = [...new Set([etDateStr, utcDateStr, yesterdayET])];
    const allEvents = [];
    for (const d of dates) {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}`);
      const j = await r.json();
      allEvents.push(...(j.events || []));
    }
    return allEvents.map(ev => {
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

// FEATURE 2026-08-21 (per Derek): "can we do poly tracking only, no odds API" -- this
// function is ONLY ever used for the live-game check (confirmed: not called anywhere in
// Sharp Line's own price-fetching path), so it doesn't need paid data at all, just
// schedule/started info. ESPN already proven fully reliable for this all session
// (including the UTC/ET slug fix) -- tried first now, so Poly tracking's live-check
// never touches paid quota. The Odds API is now a last-resort fallback only, for a sport
// ESPN's free scoreboard doesn't cover (ESPN_SPORT_PATH is MLB/NBA/NFL/NHL only).
async function getSchedule(sport) {
  const espnSched = await getScheduleFromESPN(sport);
  if (espnSched.length) return espnSched;
  const d = await fetchOddsPayload(sport);
  const sched = (d && d.schedule) || [];
  if (sched.length) return sched;
  const fromPlays = ((d && d.plays) || []).filter(p => p.commenceTime)
    .map(p => ({ away: p.away, home: p.home, commenceTime: p.commenceTime, started: false }));
  return fromPlays;
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
   Webhook URLs come from env vars -- never hardcode them here. They're credentials: anyone
   holding a URL can post into that channel, and this file is committed to a repo. Set once
   in Vercel (Project Settings → Environment Variables) and available to every future deploy
   without ever touching source.

   TWO SEPARATE CHANNELS, TWO SEPARATE VARS (added 2026-08-27, per Derek):
     DISCORD_WEBHOOK_URL   -- convergence only. Unchanged, still the only thing that posts
                              here (2+ wallets on the same side).
     DISCORD_WEBHOOK_URL_ALERTS -- every individual Poly alert that passes the existing
                              gates. Replaces ntfy for this alert type specifically -- Sharp
                              Line and Combined Sharp Score alerts (different call sites, no
                              wallet/bettor involved) still go to ntfy unchanged, since
                              "bettor's record" and "units" don't apply to those. Discord's
                              own webhook DISPLAY NAME rejects "DISCORD" as a substring --
                              that's a separate field from this Vercel variable, which does
                              carry the DISCORD_ prefix like the other one. If unset,
                              silently no-ops rather than erroring, same fail-open pattern
                              as the convergence webhook. */
async function sendDiscord(webhookUrl, content, embeds) {
  // EMBEDS 2026-08-27 (per Derek): optional third param. Existing callers pass only
  // (url, content) and are completely unaffected -- embeds stays undefined and is
  // stripped from the payload below. Embeds are Discord's native rich-card format
  // (the coloured left bar + structured fields, same as the BettorOdds card Derek
  // liked). Chosen over AI-generated images deliberately: this report is entirely
  // exact numbers, and image models render text/digits unreliably -- a wrong number
  // in a pretty card is worse than no card.
  try {
    const payload = {};
    if (content) payload.content = content;
    if (embeds && embeds.length) payload.embeds = embeds;
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ─── BEST PLAYS REPORT (added 2026-08-27, per Derek) ──────────────────────────
   WHAT THIS IS. A scheduled digest posted to Discord ahead of first pitch/kickoff,
   plus follow-up pings when a NEW play later crosses the bar. Hit via
   ?bestPlays=1 so it adds ZERO serverless functions -- the project is exactly at
   the Hobby plan's 12-function ceiling (confirmed live: a new file broke the deploy).

   THRESHOLD IS A FIRST-CUT DEFAULT, NOT CONFIRMED. TOP_PLAY_MIN=70 mirrors the
   existing auto-track bar (plays >=70 SI are already auto-tracked) so it's at least
   consistent with current behaviour rather than invented. Derek should confirm or
   change it -- flagged rather than silently chosen.

   DEDUP. Each posted play is keyed by date+game+market+side in KV. A play is only
   posted once. If it later UPGRADES (score climbs into a higher tier) it re-pings,
   same pattern the convergence alerts already use for tier upgrades. */
/* THRESHOLD SET FROM REAL GRADED DATA 2026-08-27 (council, per Derek). Was a provisional
   70; raised to 75 on evidence from 750 graded plays (?scoreStats=1):
     cumulative win rate at-or-above 75 ... 58.0%  (n=157)  <-- best
     cumulative win rate at-or-above 70 ... 56.6%  (n=189)
     the 70-74 band ALONE .................. 50.0%  (n=32)
   Break-even at -110 juice is 52.4%, so 70-74 is a net LOSER after vig -- including it
   actively dilutes the report. Also: the relationship is NOT monotonic. The 90-100 band
   grades 52.9% (n=85), WORSE than 75-79's 65.7% (n=35). Higher is not reliably better,
   so raising this further is not automatically safer and shouldn't be done without
   re-running the numbers.
   CAVEAT: those bands are POLY convergence scores, not Sharp Line SI scores -- same
   0-100 shape and the same 75+/85+ tier language already in use, but not the identical
   scale. Revisit once Sharp Line has its own graded sample stored server-side. */
const TOP_PLAY_MIN = 75;        // evidence-backed (see above); was 70

// TRACKING START DATE 2026-08-28 (per Derek): today's MLB SI scores are unreliable --
// the Odds API key was expanded this morning, resetting quota and forcing a fresh line
// baseline (rlmSource: "line_velocity" / "inferred_first_run" earlier today, siScore 0
// across the board). The report still sends today so Derek sees real output, but nothing
// posted today gets captured into converge:pending -- starting the real W-L/units record
// off a broken baseline would poison it from day one. Tracking (capture only, not
// sending) begins the day after this ships.
const TRACKING_START_DATE = '2026-08-29';
// FIX: anchor on Eastern time, same convention already used elsewhere in this file
// (etDateStr, etDateForCommence) -- UTC would flip this gate at 8pm ET tonight, mid-slate
// for tonight's MLB games, not on an actual "tomorrow" the way a bettor means it.
function trackingIsLive() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) >= TRACKING_START_DATE;
}
const REPORT_TTL   = 172800;    // 2 days, comfortably past a single slate

// FORMATTING FIXES 2026-08-30 (per Derek, real screenshot): three separate readability
// issues on the same card. (1) marketLabel -- raw market keys ('h2h'/'spreads'/'totals')
// aren't self-explanatory. (2) signalTypeLabel -- RELATIVE_STANDOUT is an internal
// system name, not something an average bettor would understand at a glance. (3) the
// Pinnacle gap field switches to real odds (reusing currentPinPrice/currentSoftAvg,
// already real American-odds numbers on the play object) instead of a raw pp figure --
// same fix already applied to the ML-velocity reasoning text, extended here to the
// Discord card itself.
function marketLabel(mk) {
  return { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' }[mk] || mk || 'Moneyline';
}
function signalTypeLabel(st) {
  const map = {
    RELATIVE_STANDOUT: 'Stands out vs. today\u2019s board',
    NONE: 'No signal',
  };
  return map[st] || st;
}
function pinnacleGapDisplay(p) {
  if (p.currentPinPrice != null && p.currentSoftAvg != null) {
    const fmtOdds = n => n > 0 ? `+${n}` : String(n);
    return `${fmtOdds(p.currentPinPrice)} vs ${fmtOdds(p.currentSoftAvg)} avg`;
  }
  return p.gapPP != null ? `${p.gapPP}pp` : null;
}
function tierFor(score) {
  if (score >= 85) return { name: 'ELITE',  color: 0xE5A00D };
  if (score >= 75) return { name: 'STRONG', color: 0x00C896 };
  return { name: 'MODERATE', color: 0x40B4FF };
}

async function buildBestPlaysReport(sports) {
  // CHANGED 2026-08-28 (per Derek): the report now filters/sorts on convergeScore (the
  // real book+poly+kalshi blend already computed in odds.js) instead of siScore alone.
  // HONEST CAVEAT: TOP_PLAY_MIN=75 was validated against 750 graded POLY-only plays, not
  // this blended metric -- carried over as a starting point, not re-validated for this
  // scale. A play can now qualify purely off a strong book signal (book absent poly/kalshi
  // still gets full weight renormalized), which is intended, but the right cutoff for the
  // blended number specifically hasn't been checked against real graded results yet.
  /* TOP SIGNALS FALLBACK 2026-08-29 (per Derek): confirmed real -- two straight days
     where nothing cleared 75 at all, even though real relative standouts exist (the
     indication system's dispersion/percentile catches, independent of the absolute book
     floor). Rather than silence, always also track the best available candidates
     regardless of threshold, clearly separated from real qualifiers, never blended into
     the same count. Sorted by convergeScore first, indication.score as a tiebreaker --
     necessary specifically because convergeScore ties at 0 on a quiet day (as it has for
     two days straight) while indication still meaningfully differentiates games. */
  const plays = [];
  const allCandidates = [];
  const errors = [];
  for (const sp of sports) {
    try {
      const r = await fetch(`${SITE_URL}/api/odds?sport=${sp}`);
      const d = await r.json();
      if (d && d.error) { errors.push(`${sp}: ${d.error}`); continue; }
      const nowMs = Date.now();
      (d.plays || []).forEach(p => {
        // FIX 2026-08-30 (per Derek, real incident -- games shown well after they'd
        // ended): p.isLive is computed once, when /api/odds's response gets CACHED
        // (up to 60 minutes, and this internal call doesn't force fresh=1) -- if that
        // cache was written before a game started, isLive:false gets frozen into the
        // stale snapshot and never self-corrects until the cache naturally expires.
        // commenceTime comparison is evaluated fresh right here, at report-build time,
        // so it can never be stale regardless of how old the underlying cache is.
        const alreadyStarted = p && p.commenceTime && new Date(p.commenceTime).getTime() < nowMs;
        // TIMING GATE 2026-09-02 (per Derek, real incident -- a 1:30am send with the
        // relevant game hours away): a play more than 2 hours before its own commence
        // time is real information but not yet actionable -- lines and Poly positioning
        // both keep moving in that window, so an early ping just creates noise now and
        // asks Derek to re-check the same game again closer to game time anyway. Applies
        // to every send path (real qualifying AND the fallback), not just the digest.
        const tooEarly = p && p.commenceTime && (new Date(p.commenceTime).getTime() - nowMs) > (2 * 60 * 60 * 1000);
        if (!p || p.isLive || alreadyStarted || tooEarly) return; // never surface a live/finished/too-early game, fallback or not
        const cs = p && p.convergeScore && typeof p.convergeScore.score === 'number' ? p.convergeScore.score : 0;
        const ind = p.indication && typeof p.indication.score === 'number' ? p.indication.score : 0;
        const candidate = { ...p, sport: sp, _convergeScore: cs, _indicationScore: ind };
        // REAL QUALIFYING GATE 2026-08-31 (per Derek, real complaint): score >= 75 alone
        // let plays through on book OR poly independently -- a relative-percentile book
        // standout with zero real Poly backing, or a single Poly buyer with a thin book
        // gap, could both clear 75 through the blend. Derek wants genuine confirmation
        // from BOTH sides, not a blend that lets one compensate for the other's absence.
        // bookConfirmed: the ABSOLUTE gap floor was actually cleared (pinnacleSource is
        // only set to relative_fallback when the retrofit fired instead of the real
        // floor -- undefined/absent means the genuine floor was met).
        // polyConfirmed: 2+ real distinct accounts on this exact side, not the phantom
        // single-buyer case already excluded upstream in polymarket-alerts.js.
        const bookConfirmed = p.pillars && p.pillars.pinnacleSource !== 'relative_fallback' && !p.noSignal;
        const polyConfirmed = !!(p.convergeScore && p.convergeScore.breakdown && p.convergeScore.breakdown.poly && p.convergeScore.breakdown.poly.buyers >= 2);
        if (bookConfirmed && polyConfirmed) plays.push(candidate);
        allCandidates.push(candidate);
      });
    } catch (e) { errors.push(`${sp}: ${e.message}`); }
  }
  plays.sort((a, b) => b._convergeScore - a._convergeScore);
  allCandidates.sort((a, b) => (b._convergeScore - a._convergeScore) || (b._indicationScore - a._indicationScore));
  // FIX 2026-08-31: was filtering purely by score < TOP_PLAY_MIN, but qualifying is now
  // the bookConfirmed+polyConfirmed gate above, not the raw score -- a play could score
  // 100 and still fail the real gate (exactly whats expected most days now), and under
  // the old filter it would show in neither list: too high a score for below-threshold,
  // but not in plays since it failed the real gate. Now anything not already in the
  // real qualifying list is eligible for the fallback, regardless of its raw score.
  const qualifyingIds = new Set(plays.map(p => p.id));
  // FIX 2026-09-01 (per Derek + council): originally set to "any real poly backing" as a
  // softer bar than the real gate's 2+. Council review: a single wallet has zero
  // cross-validation -- one persons opinion, weighted only by their own track record --
  // and this codebase has already found and fixed the "single trader can mislead" pattern
  // multiple times (IAmHomelessNow's narrow sample, Ferrari's cross-sport inflation, the
  // exact reason the real gate requires 2+ in the first place). Raised to match the real
  // gate's poly bar exactly, so the ONLY thing separating "qualifying" from "below
  // threshold" is the book side (absolute floor vs. the relative-percentile retrofit),
  // not a second, independent relaxation stacked on the poly side too.
  const polyConfirmedFallback = c => !!(c.convergeScore && c.convergeScore.breakdown && c.convergeScore.breakdown.poly && c.convergeScore.breakdown.poly.buyers >= 2);
  const topAvailable = allCandidates
    .filter(c => !qualifyingIds.has(c.id))
    .filter(polyConfirmedFallback)
    .slice(0, 3);
  return { plays, errors, topAvailable };
}

/* CONVERGE SCORE RECORD 2026-08-28 (per Derek): tracks real W-L and units for every
   play the Converge Score Report actually posts, using American-odds unit convention
   Derek specified exactly: positive odds risk 1u to win (odds/100)u; negative odds risk
   (|odds|/100)u to win 1u -- e.g. -120 risks 1.2u to win 1u.
   PENDING/GRADED split, same shape as everything else built today: a play gets appended
   to converge:pending at post time with everything needed to grade it later (teams,
   sport, market, sharpSide -- which already embeds the spread/total line, e.g.
   "Yankees -1.5" or "Over 8.5" -- and the odds captured at posting). Grading runs via
   ESPN's free scoreboard (same source grade-cron.js already uses elsewhere), moves
   resolved plays into converge:graded, and record/units are computed fresh from that
   array every time rather than kept as a running counter that could drift. */
function unitsForOdds(americanOdds) {
  const o = parseFloat(americanOdds);
  if (!isFinite(o) || o === 0) return { risk: 1, toWin: 1 };
  return o > 0 ? { risk: 1, toWin: o / 100 } : { risk: Math.abs(o) / 100, toWin: 1 };
}

function resolveConvergePlay(sharpSide, market, hN, aN, hS, aS) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const s = (sharpSide || '').trim();

  if (market === 'totals') {
    const m = s.match(/^(Over|Under)\s+([\d.]+)$/i);
    if (!m) return null;
    const total = hS + aS, line = parseFloat(m[2]);
    if (total === line) return 'PUSH';
    const isOver = total > line;
    return (m[1].toLowerCase() === 'over') === isOver ? 'WIN' : 'LOSS';
  }

  // spreads embed a trailing +/-N; h2h has no trailing number -- same sharpSide shape
  // odds.js already builds (out.name + ' ' + point for spreads, bare name for h2h).
  const spreadMatch = s.match(/^(.+?)\s+([+-][\d.]+)$/);
  const team = spreadMatch ? spreadMatch[1].trim() : s;
  const line = spreadMatch ? parseFloat(spreadMatch[2]) : null;

  const nTeam = norm(team), nH = norm(hN), nA = norm(aN);
  const isHome = nH.includes(nTeam) || nTeam.includes(nH);
  const isAway = nA.includes(nTeam) || nTeam.includes(nA);
  if (!isHome && !isAway) return null;

  if (market === 'spreads' && line !== null) {
    const margin = (isHome ? (hS - aS) : (aS - hS)) + line;
    if (margin === 0) return 'PUSH';
    return margin > 0 ? 'WIN' : 'LOSS';
  }
  // h2h
  if (hS === aS) return 'PUSH';
  const won = isHome ? hS > aS : aS > hS;
  return won ? 'WIN' : 'LOSS';
}

async function gradeConvergePending() {
  let pending = [];
  try {
    const res = await upstashPost(['GET', 'converge:pending']);
    const raw = res && res.ok ? res.result : null;
    pending = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  } catch {}
  if (!pending.length) return { graded: 0, stillPending: 0 };

  const sports = [...new Set(pending.map(p => p.sport))];
  const dates = [...new Set(pending.map(p => (p.postedAt ? new Date(p.postedAt) : new Date())
    .toISOString().slice(0, 10).replace(/-/g, '')))];
  // also check the day before, in case a play posted late and the game finished after midnight UTC
  const extraDates = new Set();
  dates.forEach(d => {
    const dt = new Date(d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8)+'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    extraDates.add(dt.toISOString().slice(0,10).replace(/-/g,''));
  });
  extraDates.forEach(d => dates.push(d));

  const eventsBySport = {};
  await Promise.all(sports.map(async sp => {
    const path = ESPN_SPORT_PATH[sp];
    if (!path) { eventsBySport[sp] = []; return; }
    const all = [];
    await Promise.all(dates.map(async d => {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}`);
        const j = await r.json();
        all.push(...(j.events || []));
      } catch {}
    }));
    eventsBySport[sp] = all;
  }));

  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stillPending = [];
  const newlyGraded = [];
  for (const p of pending) {
    const evs = eventsBySport[p.sport] || [];
    let match = null;
    for (const ev of evs) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp || !comp.status || !comp.status.type || !comp.status.type.completed) continue;
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const hN = home.team && (home.team.displayName || home.team.name) || '';
      const aN = away.team && (away.team.displayName || away.team.name) || '';
      const nHN = norm(hN), nAN = norm(aN), nPH = norm(p.home), nPA = norm(p.away);
      if ((nHN.includes(nPH) || nPH.includes(nHN)) && (nAN.includes(nPA) || nPA.includes(nAN))) {
        match = { hN, aN, hS: parseFloat(home.score || 0), aS: parseFloat(away.score || 0) };
        break;
      }
    }
    if (!match) { stillPending.push(p); continue; }
    const result = resolveConvergePlay(p.sharpSide, p.market || p.activeMarket, match.hN, match.aN, match.hS, match.aS);
    if (!result) { stillPending.push(p); continue; }
    const u = unitsForOdds(p.odds);
    const netUnits = result === 'WIN' ? u.toWin : (result === 'LOSS' ? -u.risk : 0);
    newlyGraded.push({ ...p, result, netUnits, riskUnits: u.risk, toWinUnits: u.toWin, gradedAt: Date.now(),
      finalScore: `${match.aN} ${match.aS} - ${match.hS} ${match.hN}` });
  }

  if (newlyGraded.length) {
    let graded = [];
    try {
      const res = await upstashPost(['GET', 'converge:graded']);
      const raw = res && res.ok ? res.result : null;
      graded = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    } catch {}
    graded.push(...newlyGraded);
    await upstashPost(['SET', 'converge:graded', JSON.stringify(graded), 'EX', '7776000']); // 90 days
  }
  await upstashPost(['SET', 'converge:pending', JSON.stringify(stillPending), 'EX', '2592000']); // 30 days

  return { graded: newlyGraded.length, stillPending: stillPending.length };
}

async function getConvergeRecord() {
  let graded = [];
  try {
    const res = await upstashPost(['GET', 'converge:graded']);
    const raw = res && res.ok ? res.result : null;
    graded = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  } catch {}
  const wins = graded.filter(g => g.result === 'WIN').length;
  const losses = graded.filter(g => g.result === 'LOSS').length;
  const pushes = graded.filter(g => g.result === 'PUSH').length;
  const decided = wins + losses;
  const winPct = decided ? Math.round((wins / decided) * 1000) / 10 : null;
  const netUnits = Math.round(graded.reduce((s, g) => s + (g.netUnits || 0), 0) * 100) / 100;
  return { wins, losses, pushes, winPct, netUnits, sample: graded.length };
}

function playKey(p) {
  // FIX 2026-08-30 (per Derek, real recurring incident -- qualifying>0 but
  // newOrUpgraded:0, twice now): same exact bug class as yesterday's
  // getScheduleFromESPN midnight fix, different function. Used UTC date for the "day"
  // boundary -- testing last night around 10-11pm CT already meant UTC had rolled to the
  // 30th while it was still the 29th locally, so dedup keys got written under TODAY's
  // date last night. This morning's genuinely new qualifying plays then collided with
  // those stale entries and were incorrectly treated as already-posted. Switched to ET,
  // the same convention already used everywhere else in this file (etDateStr, etDateForCommence,
  // trackingIsLive).
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return `report:posted:${day}:${p.sport}:${p.away}@${p.home}:${p.market || p.activeMarket}:${p.sharpSide}`;
}

function playEmbed(p) {
  // CHANGED 2026-08-28 (per Derek): headline is now Converge Score (book+poly+kalshi
  // blend), with the full breakdown shown so it's never a black box -- exactly the
  // transparency requirement from the council session that approved this blend. Book
  // (siScore) shown as its own field either way, since that's still the always-present
  // anchor component.
  const cs = p.convergeScore || { score: p.siScore || 0, componentsUsed: ['book'], breakdown: { book: { score: p.siScore || 0 } } };
  const tier = tierFor(cs.score);
  const fields = [
    { name: 'Pick',   value: `**${p.sharpSide}** (${marketLabel(p.market || p.activeMarket)})`, inline: true },
    { name: 'Converge Score', value: `**${cs.score}** \u00b7 ${tier.name}`,  inline: true },
  ];
  const b = cs.breakdown || {};
  const parts = [];
  if (b.book) parts.push(`Book ${b.book.score}`);
  if (b.poly) parts.push(`Poly ${b.poly.score}${b.poly.buyers ? ` (${b.poly.buyers} buyers)` : ''}`);
  if (b.kalshi) parts.push(`Kalshi ${b.kalshi.score} (${b.kalshi.direction || 'steam'})`);
  if (parts.length) fields.push({ name: 'Components', value: parts.join(' \u00b7 '), inline: true });
  if (p.signalType) fields.push({ name: 'Signal', value: signalTypeLabel(p.signalType), inline: true });
  const gapDisplay = pinnacleGapDisplay(p);
  if (gapDisplay) fields.push({ name: 'Pinnacle', value: gapDisplay, inline: true });
  const best = p.bestPrices && p.bestPrices[p.sharpSide];
  if (best && best.price != null) {
    fields.push({ name: 'Best price', value: `${best.price > 0 ? '+' : ''}${best.price} (${best.book || '—'})`, inline: true });
  }
  if (p.kelly && p.kelly.suggestedPctOfBankroll > 0) {
    fields.push({ name: 'Half-Kelly', value: `${p.kelly.suggestedPctOfBankroll}% bankroll`, inline: true });
  }
  if (p.exConfirms) fields.push({ name: 'Exchange', value: `${p.exConfirms} confirm(s)`, inline: true });
  if (p.pitcherWatch && p.pitcherWatch.state === 'RECENT_CHANGE') {
    fields.push({ name: '\u26a0\ufe0f SP change', value: `${p.pitcherWatch.hoursSinceChange}h ago \u2014 line move may be rotation news`, inline: false });
  }
  return {
    title: `${p.away} @ ${p.home}`,
    description: `${p.sport}${p.commenceTime ? ` \u00b7 <t:${Math.floor(new Date(p.commenceTime).getTime() / 1000)}:t>` : ''}`,
    color: tier.color,
    fields,
  };
}

// OPTION A REPORT FORMAT 2026-08-30 (per Derek, real complaint w/ screenshot): full
// embeds per play were too crowded across 6 plays. Cleaner: one compact line per play,
// plus a poly bullet underneath showing BOTH sides' real counts and who's on them --
// not just the side Converge Score happens to be picking. Plain text, not an embed --
// six embeds each with their own colored bar reads as more visual weight than six lines
// of text, which was the actual complaint.
function playLine(p) {
  // FIX 2026-09-02 (per Derek, real complaint w/ screenshot): was dumping polyBothSides
  // raw and unfiltered -- every scattered market/outcome for the whole game mixed
  // together ("5 Under, 5 Over, 2 Under, 2 Seattle Mariners..."), completely unreadable.
  // Now shows only the actual picks own side, using the already-deduplicated,
  // side-exclusive backers from convergeScore.breakdown.poly -- the same real count that
  // decided whether this play qualifies at all, not a wall of unrelated activity.
  const tier = tierFor(p._convergeScore != null ? p._convergeScore : p.siScore);
  const gap = pinnacleGapDisplay(p);
  const mainLine = `\u{1F3AF} **${p.away} @ ${p.home}** \u00b7 ${p.sharpSide} (${marketLabel(p.market || p.activeMarket)}) \u00b7 **${p._convergeScore != null ? p._convergeScore : p.siScore} ${tier.name}**${gap ? ` \u00b7 Pinnacle ${gap}` : ''}`;

  const poly = p.convergeScore && p.convergeScore.breakdown && p.convergeScore.breakdown.poly;
  if (!poly || !poly.buyers) return mainLine;
  const names = (poly.traderNames || []).slice(0, 6).join(', ');
  const polyLine = `   \u2713 ${poly.buyers} real backer${poly.buyers > 1 ? 's' : ''}${names ? `: ${names}` : ''}`;
  return [mainLine, polyLine].join('\n');
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
  // FIX 2026-08-30 (per Derek, real confusion): this used to suppress the sport tag
  // whenever a wallet's tracked history was all one sport, on the reasoning that
  // "(MLB: 2-6)" next to an already-identical "(2-6)" was pure redundant noise. Real
  // feedback: showing the number twice isn't noise, it's CONFIRMATION -- without it,
  // there's no way to tell "2-6 overall, which happens to be his only tracked sport"
  // from "2-6 overall, but I have no idea what his MLB-specific number even is." Always
  // show it now when the sport has any tracked data at all, single-sport or not.
  if (!sport || !trackedEntry.bySport) return null;
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
  // FEATURE 2026-08-30 (per Derek): a small tracked sample overriding a much larger,
  // better real record (per the IAmHomelessNow case -- 2-6 tracked vs. a real 36-bet,
  // 91.7% specialist record) shouldn't just look like a scary flat negative number with
  // no context. Cold flag on the TRACKED record specifically -- distinct icon from the
  // existing wallet-form 🧊 (which means "recent cooling trend", a different concept) --
  // signals "small sample, weigh cautiously" without hiding or discarding the number.
  // Threshold is a first cut, not validated against anything -- same posture as every
  // other new threshold shipped this way tonight.
  const SMALL_SAMPLE_MAX = 10;
  const coldFlag = (rec.source === 'tracked' && (rec.wins + rec.losses) > 0 && (rec.wins + rec.losses) <= SMALL_SAMPLE_MAX) ? ' \u2744\ufe0f' : '';
  return `${label} (${rec.wins}-${rec.losses}${marker}${roiPart})${sportPart}${coldFlag}`;
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

  /* REPORT IMAGE 2026-08-30 (per Derek): renders the Converge Score Report as a real PNG
     using satori + resvg (the same engine behind @vercel/og). Folded into this existing
     file as a query branch rather than a new /api/report-image.js file -- confirmed live
     that a separate file (even just a plain data module with no handler) pushes this
     project past the Hobby plans hard 12-serverless-function ceiling; this is the same
     pattern already used everywhere else in this codebase for that exact constraint.
     MLB/NFL logos are bundled at /lib/team_logos_data.js (verified real, correctly
     rendering, pulled from MLBAMGames/mlb_teams_logo_svg and ChrisKatsaras/React-NFL-Logos).
     NCAAF has no equivalent clean bundle (130+ FBS teams) -- fetched dynamically from
     ESPN's own scoreboard API at render time instead, the same ESPN endpoint
     getScheduleFromESPN already uses successfully today.
     GET ?reportImage=1&sports=MLB,NFL,NCAAF -> image/png
     Known real gap: Poly names render without win-loss records (bare traderNames only;
     the record-lookup lives elsewhere in this file and isn't wired into this branch yet). */
  // ONE-TIME ADMIN RESET 2026-09-01 (per Derek, real decision): none of the 6-26 graded
  // plays were selected under the current gates (book+poly AND-gate, wallet dedup,
  // SITE_URL poly-matching fix) -- that record reflects a fundamentally different,
  // partially broken selection process, not the current algorithm. Archives the old
  // record under a clearly-labeled key (never destroyed, just no longer active) and
  // resets the live counter to start fresh. Also resets converge:pending -- the 8
  // still-grading plays were ALSO selected under the old logic, same reasoning applies.
  // Requires an explicit confirm param so this can never fire by accident.
  if (req.query && req.query.adminResetRecord === 'confirm') {
    try {
      const gradedRes = await upstashPost(['GET', 'converge:graded']);
      const gradedRaw = gradedRes && gradedRes.ok ? gradedRes.result : null;
      const graded = gradedRaw ? (typeof gradedRaw === 'string' ? JSON.parse(gradedRaw) : gradedRaw) : [];
      const pendingRes = await upstashPost(['GET', 'converge:pending']);
      const pendingRaw = pendingRes && pendingRes.ok ? pendingRes.result : null;
      const pending = pendingRaw ? (typeof pendingRaw === 'string' ? JSON.parse(pendingRaw) : pendingRaw) : [];

      const archiveKey = 'converge:graded:archive:pre-gate-fix-2026-09-01';
      await upstashPost(['SET', archiveKey, JSON.stringify(graded), 'EX', '31536000']); // 1 year
      const pendingArchiveKey = 'converge:pending:archive:pre-gate-fix-2026-09-01';
      await upstashPost(['SET', pendingArchiveKey, JSON.stringify(pending), 'EX', '31536000']);

      await upstashPost(['SET', 'converge:graded', JSON.stringify([]), 'EX', '2592000']);
      await upstashPost(['SET', 'converge:pending', JSON.stringify([]), 'EX', '2592000']);

      return res.status(200).json({
        ok: true,
        archived: { graded: graded.length, pending: pending.length },
        archiveKeys: [archiveKey, pendingArchiveKey],
        reset: 'converge:graded and converge:pending both cleared -- record now starts fresh under the current gates',
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  /* NOVIG RECORD TRACKING 2026-09-04 (per Derek). Staking rule, his: a plus-money play
     RISKS 1u to win the odds; a minus-money play risks the odds TO WIN 1u. So +127 risks
     1u to win 1.27u, and -150 risks 1.5u to win 1u. P&L is therefore asymmetric and must
     be computed per play from the entry price, not assumed flat.
     Price is captured at ALERT time, not at grade time -- a signal's honest result is
     what you could actually have gotten when it fired, not where the line drifted to.
     Grading matches Novig's team abbreviation against ESPN's own abbreviation rather than
     fuzzy-matching team names: Novig says "GAST", ESPN says "GAST". When that match is
     not unambiguous the play is left UNGRADED and reported as such -- a wrong grade is
     worse than a missing one, especially on a signal with no track record yet. */
  /* CROSS-BOOK PRICE CHECK 2026-09-04 (council). This is the piece that turns the signal
     from "here is where money is" into something with a verifiable edge. Knowing money is
     on a side requires believing that money is smart -- unprovable, and on a big favorite
     probably false. But "that same side is available cheaper at another book" is a fact,
     independent of whose money it is. That price gap is the actual product.
     Reuses /api/odds bestPrices, already computed per book per market for every game, so
     no new data source is needed. Matching is deliberately conservative: Novig uses team
     abbreviations, the Odds API uses full names, so anything that does not match cleanly
     returns null and the play simply carries no cross-book edge rather than a wrong one. */
  const NOVIG_ODDS_SPORT = { MLB:'MLB', NFL:'NFL', NCAAF:'NCAAF', NBA:'NBA', NHL:'NHL' };

  async function novigCrossBook(signals) {
    const bySport = {};
    signals.forEach(s => { if (s.league) (bySport[s.league] = bySport[s.league] || []).push(s); });
    const boards = {};
    await Promise.all(Object.keys(bySport).map(async lg => {
      const sp = NOVIG_ODDS_SPORT[lg];
      if (!sp) return;
      try {
        const r = await fetch(`${SITE_URL}/api/odds?sport=${sp}`);
        const j = await r.json();
        boards[lg] = (j && j.plays) || [];
      } catch { boards[lg] = []; }
    }));

    const mktKey = { MONEY: 'h2h', SPREAD: 'spreads', TOTAL: 'totals' };
    return signals.map(s => {
      const board = boards[s.league] || [];
      // Match the game by requiring BOTH team surnames to appear in the Novig event text.
      const desc = String(s.event || '').toLowerCase();
      const game = board.find(p => {
        const last = n => String(n || '').toLowerCase().split(' ').pop();
        const a = last(p.away), h = last(p.home);
        return a && h && desc.includes(a) && desc.includes(h);
      });
      if (!game) return { ...s, crossBook: null };
      const mk = game.markets && game.markets[mktKey[s.marketType]];
      const best = mk && mk.bestPrices;
      if (!best) return { ...s, crossBook: null };

      // Find the bestPrices entry for our side. Totals key on Over/Under; team markets
      // key on full name, which we match back from the Novig abbreviation.
      const side = String(s.sharpSide || '');
      let key = null;
      if (s.marketType === 'TOTAL') {
        const m = side.match(/^(Over|Under)/i);
        if (m) key = Object.keys(best).find(k => k.toLowerCase() === m[1].toLowerCase());
      } else {
        const ab = side.replace(/\s*[+-][\d.]+\s*$/, '').trim().toUpperCase();
        key = Object.keys(best).find(k => {
          const words = String(k).toUpperCase().split(' ');
          const initials = words.map(w => w[0]).join('');
          return initials === ab || String(k).toUpperCase().replace(/[^A-Z]/g, '').startsWith(ab);
        });
      }
      if (!key || !best[key] || best[key].price == null) return { ...s, crossBook: null };

      const bookPrice = best[key].price;
      const nov = s.sharpSideAmerican;
      if (nov == null) return { ...s, crossBook: null };
      // "Better" means a higher payout for the same side: less negative, or more positive.
      const payout = a => (a > 0 ? a / 100 : 100 / Math.abs(a));
      const better = payout(bookPrice) > payout(nov);
      return { ...s, crossBook: { book: best[key].book, price: bookPrice, better,
        edgePct: Math.round((payout(bookPrice) - payout(nov)) * 1000) / 10 } };
    });
  }

  const NOVIG_ESPN_PATHS = { MLB:'baseball/mlb', NFL:'football/nfl',
    NCAAF:'football/college-football', NBA:'basketball/nba', NHL:'hockey/nhl' };

  function novigStakeFor(american) {
    if (american == null || !isFinite(american)) return null;
    const r2 = n => Math.round(n * 100) / 100;
    return american > 0 ? { risk: 1, toWin: r2(american / 100) }
                        : { risk: r2(Math.abs(american) / 100), toWin: 1 };
  }

  async function novigFetchFinal(league, eventDesc, gameTime) {
    const path = NOVIG_ESPN_PATHS[league];
    if (!path || !gameTime) return null;
    const d0 = new Date(gameTime);
    // Check the game's own UTC day and the day before -- late starts file under the
    // prior day's scoreboard, the same rollover issue already hit elsewhere here.
    const days = [d0, new Date(d0.getTime() - 86400000)]
      .map(x => x.toISOString().slice(0, 10).replace(/-/g, ''));
    const desc = String(eventDesc || '').toLowerCase();
    for (const day of days) {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${day}&limit=300`);
        const j = await r.json();
        for (const ev of (j.events || [])) {
          const comp = ev.competitions && ev.competitions[0];
          if (!comp || !(comp.status && comp.status.type && comp.status.type.completed)) continue;
          const cs = comp.competitors || [];
          const home = cs.find(x => x.homeAway === 'home');
          const away = cs.find(x => x.homeAway === 'away');
          if (!home || !away || !home.team || !away.team) continue;
          const lastWord = n => String(n || '').toLowerCase().split(' ').pop();
          const hit = [home.team.displayName, away.team.displayName]
            .every(n => { const w = lastWord(n); return w && desc.includes(w); });
          if (!hit) continue;
          return {
            home: { abbrev: home.team.abbreviation, score: parseInt(home.score, 10) },
            away: { abbrev: away.team.abbreviation, score: parseInt(away.score, 10) },
          };
        }
      } catch { /* try the other day */ }
    }
    return null;
  }

  function novigGradeOne(play, final) {
    const side = String(play.sharpSide || '');
    const total = final.home.score + final.away.score;
    if (play.marketType === 'TOTAL') {
      const m = side.match(/^(Over|Under)\s+([\d.]+)$/i);
      if (!m) return null;
      const line = parseFloat(m[2]);
      if (total === line) return 'PUSH';
      return ((m[1].toLowerCase() === 'over') === (total > line)) ? 'W' : 'L';
    }
    const abbrev = side.replace(/\s*[+-][\d.]+\s*$/, '').trim().toUpperCase();
    const isHome = abbrev === String(final.home.abbrev || '').toUpperCase();
    const isAway = abbrev === String(final.away.abbrev || '').toUpperCase();
    if (isHome === isAway) return null; // ambiguous -- do not guess
    const mine = isHome ? final.home : final.away;
    const opp  = isHome ? final.away : final.home;
    if (play.marketType === 'MONEY') {
      return mine.score > opp.score ? 'W' : (mine.score < opp.score ? 'L' : 'PUSH');
    }
    if (play.marketType === 'SPREAD') {
      const m = side.match(/([+-][\d.]+)\s*$/);
      if (!m) return null;
      const margin = (mine.score - opp.score) + parseFloat(m[1]);
      if (margin === 0) return 'PUSH';
      return margin > 0 ? 'W' : 'L';
    }
    return null;
  }

  async function novigGradePending() {
    let pending = [];
    try {
      const raw = await upstashPost(['GET', 'novig:pending']);
      const v = raw && raw.ok ? raw.result : null;
      pending = v ? (typeof v === 'string' ? JSON.parse(v) : v) : [];
    } catch { return { graded: 0, stillPending: 0 }; }
    if (!pending.length) return { graded: 0, stillPending: 0 };

    const nowMs = Date.now();
    const ready = pending.filter(p => p.gameTime && (nowMs - new Date(p.gameTime).getTime()) > (3.5 * 3600 * 1000));
    const notReady = pending.filter(p => !ready.includes(p));
    if (!ready.length) return { graded: 0, stillPending: notReady.length };

    let graded = [];
    try {
      const raw = await upstashPost(['GET', 'novig:graded']);
      const v = raw && raw.ok ? raw.result : null;
      graded = v ? (typeof v === 'string' ? JSON.parse(v) : v) : [];
    } catch {}

    const stillOpen = [];
    let newlyGraded = 0;
    for (const p of ready.slice(0, 25)) {
      const final = await novigFetchFinal(p.league, p.event, p.gameTime);
      if (!final) { stillOpen.push(p); continue; }
      const res = novigGradeOne(p, final);
      if (!res) { graded.push({ ...p, result: 'UNGRADED', units: 0, gradedAt: nowMs }); newlyGraded++; continue; }
      const st = novigStakeFor(p.sharpSideAmerican);
      const units = !st ? 0 : (res === 'W' ? st.toWin : (res === 'L' ? -st.risk : 0));
      graded.push({ ...p, result: res, units: Math.round(units * 100) / 100,
        finalScore: `${final.away.score}-${final.home.score}`, gradedAt: nowMs });
      newlyGraded++;
    }
    try {
      await upstashPost(['SET', 'novig:graded', JSON.stringify(graded.slice(-500)), 'EX', '7776000']);
      await upstashPost(['SET', 'novig:pending', JSON.stringify(notReady.concat(stillOpen)), 'EX', '2592000']);
    } catch {}
    return { graded: newlyGraded, stillPending: notReady.length + stillOpen.length };
  }

  async function novigRecord() {
    try {
      const raw = await upstashPost(['GET', 'novig:graded']);
      const v = raw && raw.ok ? raw.result : null;
      const g = v ? (typeof v === 'string' ? JSON.parse(v) : v) : [];
      const scored = g.filter(x => x.result === 'W' || x.result === 'L' || x.result === 'PUSH');
      const w = scored.filter(x => x.result === 'W').length;
      const l = scored.filter(x => x.result === 'L').length;
      const p = scored.filter(x => x.result === 'PUSH').length;
      const units = Math.round(scored.reduce((s, x) => s + (x.units || 0), 0) * 100) / 100;
      const ungraded = g.filter(x => x.result === 'UNGRADED').length;
      return { sample: scored.length, wins: w, losses: l, pushes: p, units, ungraded,
        winPct: (w + l) ? Math.round((w / (w + l)) * 1000) / 10 : null };
    } catch { return { sample: 0, wins: 0, losses: 0, pushes: 0, units: 0, ungraded: 0, winPct: null }; }
  }

  /* NOVIG SHARP-SIDE ALERT 2026-09-03 (per Derek): posts to Discord when Novig's own
     order book shows a large one-sided pile of resting liquidity. Real mechanic: resting
     orders on an outcome are offers to SELL it, so heavy size sitting on "MIL +2.5" means
     that money actually wants CIN -2.5 -- the sharp read is the OPPOSITE of the heavy
     side. Format is exactly what Derek asked for: SHARP SIDE - team - score.
     Reads /api/odds?novigSharp=1, which touches ONLY Novig's free API -- no Odds API key
     or quota, so this keeps working after that subscription lapses.
     Dedup is per event+market+side+day, so a standing imbalance pings once, not every
     sweep. Same 2h-before-commence gate as the Converge report, per Derek's stated rule
     that nothing should fire while a game is still hours away.
     GET ?novigAlert=1&league=MLB[&dry=1] */
  /* NOVIG ALERT GRAPHIC 2026-09-04 (per Derek). Same satori+resvg pipeline as the
     Converge report. Two Novig-specific wrinkles:
     - Novig identifies sides by abbreviation ("KU", "GAST"), not full team name, so
       logos are looked up from the EVENT description ("Long Island University @ Kansas")
       which does carry real names, rather than from the abbreviation.
     - Totals get both logos, since neither team is "the pick". Moneyline/spread show the
       picked team alone when the abbreviation matches confidently, and fall back to both
       logos when it doesn't -- showing both is honest, showing the wrong one is not.
     Icons are drawn shapes, never emoji: satori has no emoji glyph coverage and they
     render as invisible blanks, which is how the first Converge card silently lost its
     markers. */
  if (req.query && req.query.novigImage) {
    try {
      const satori = require('satori').default;
      const { Resvg } = require('@resvg/resvg-js');
      const teamLogos = require('../lib/team_logos_data.js');

      let fonts = global.__reportImageFonts;
      if (!fonts) {
        const [rg, bd] = await Promise.all([
          fetch('https://raw.githubusercontent.com/googlefonts/opensans/main/fonts/ttf/OpenSans-Regular.ttf').then(r => r.arrayBuffer()),
          fetch('https://raw.githubusercontent.com/googlefonts/opensans/main/fonts/ttf/OpenSans-Bold.ttf').then(r => r.arrayBuffer()),
        ]);
        fonts = [
          { name: 'Open Sans', data: Buffer.from(rg), weight: 400, style: 'normal' },
          { name: 'Open Sans', data: Buffer.from(bd), weight: 700, style: 'normal' },
        ];
        global.__reportImageFonts = fonts;
      }

      let espnCache = null;
      async function espnLogo(name) {
        if (!espnCache) {
          espnCache = {};
          try {
            const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${today}&groups=80&limit=300`);
            const j = await r.json();
            (j.events || []).forEach(ev => {
              const comp = ev.competitions && ev.competitions[0];
              (comp && comp.competitors || []).forEach(x => {
                const n = x.team && (x.team.displayName || x.team.name);
                const l = x.team && x.team.logos && x.team.logos[0] && x.team.logos[0].href;
                if (n && l) espnCache[n] = l;
              });
            });
          } catch {}
        }
        const want = String(name || '').toLowerCase();
        const hit = Object.keys(espnCache).find(k => {
          const kk = k.toLowerCase();
          return kk === want || kk.includes(want) || want.includes(kk);
        });
        return hit ? espnCache[hit] : null;
      }

      async function logoFor(league, teamName) {
        if (!teamName) return null;
        if (league === 'NCAAF') {
          const url = await espnLogo(teamName);
          if (!url) return null;
          try {
            const r = await fetch(url);
            return `data:image/png;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
          } catch { return null; }
        }
        const tbl = league === 'NFL' ? teamLogos.nfl : teamLogos.mlb;
        if (!tbl) return null;
        const want = String(teamName).toLowerCase();
        const key = Object.keys(tbl).find(k => {
          const kk = k.toLowerCase();
          return kk === want || kk.includes(want) || want.includes(kk);
        });
        return key ? `data:image/png;base64,${tbl[key]}` : null;
      }

      // FIX 2026-09-05 (per Derek, real screenshot -- text said imbalance 85, image said
      // no qualifying plays): this fetch had its own hardcoded windowHours=2 and its own
      // requireEdge-by-default, both DIFFERENT from what the real alert path now uses
      // (per-sport windows, edge optional not required). Two configs for the same signal
      // meant the image and text could disagree on the exact same board. Now matches the
      // alert path exactly -- no forced window, requireEdge opt-in only.
      const leagueQ = req.query.league ? `&league=${encodeURIComponent(String(req.query.league))}` : '';
      const win = req.query.windowHours ? `&windowHours=${encodeURIComponent(String(req.query.windowHours))}` : '';
      const sr = await fetch(`${SITE_URL}/api/odds?novigSharp=1${win}${leagueQ}`);
      const sd = await sr.json();
      let sigs = (sd && sd.signals) || [];
      if (String(req.query.requireEdge || '') === '1') {
        const withBook = await novigCrossBook(sigs);
        sigs = withBook.filter(s => s.crossBook && s.crossBook.better);
      } else {
        sigs = await novigCrossBook(sigs); // still attach crossBook info for display, just not required
      }
      sigs = sigs.slice(0, 6);
      const rec = await novigRecord();

      const fmt = a => (a > 0 ? '+' + a : String(a));
      const cards = await Promise.all(sigs.map(async s => {
        const parts = String(s.event || '').split(' @ ');
        const away = (parts[0] || '').trim(), home = (parts[1] || '').trim();
        const [aL, hL] = await Promise.all([logoFor(s.league, away), logoFor(s.league, home)]);

        // Totals -> both logos. Team markets -> the picked side alone when the
        // abbreviation matches confidently, otherwise both.
        let logos = [aL, hL];
        if (s.marketType !== 'TOTAL') {
          const ab = String(s.sharpSide || '').replace(/\s*[+-][\d.]+\s*$/, '').trim().toUpperCase();
          const match = n => {
            const N = String(n || '').toUpperCase();
            return N === ab || N.replace(/[^A-Z]/g, '').startsWith(ab)
              || N.split(' ').map(w => w[0]).join('') === ab;
          };
          if (match(away) && !match(home)) logos = [aL];
          else if (match(home) && !match(away)) logos = [hL];
        }
        logos = logos.filter(Boolean);

        const cb = s.crossBook;
        const px = cb && cb.better ? cb.price : s.sharpSideAmerican;
        const where = cb && cb.better ? cb.book : 'Novig';
        const st = novigStakeFor(px);

        return { type: 'div', props: {
          style: { display: 'flex', flexDirection: 'column', backgroundColor: '#181c22',
            borderRadius: 14, borderLeft: '4px solid #4ade80', padding: 22, marginTop: 16 },
          children: [
            { type: 'div', props: { style: { display: 'flex', alignItems: 'center' }, children: [
              ...(logos.length ? [{ type: 'div', props: {
                style: { display: 'flex', alignItems: 'center', marginRight: 14 },
                children: logos.map((u, i) => ({ type: 'img', props: { src: u, width: 44, height: 44,
                  style: { marginLeft: i ? 6 : 0, display: 'flex' } } })) } }] : []),
              { type: 'div', props: { style: { display: 'flex', flexDirection: 'column' }, children: [
                { type: 'div', props: { style: { display: 'flex', alignItems: 'center' }, children: [
                  { type: 'div', props: { style: { display: 'flex', fontSize: 13, fontWeight: 700,
                    color: '#0d0d12', backgroundColor: '#4ade80', borderRadius: 5,
                    padding: '3px 9px', marginRight: 10 }, children: 'TAKE' } },
                  { type: 'div', props: { style: { fontSize: 26, fontWeight: 700, color: '#fff', display: 'flex' },
                    children: `${s.sharpSide}  ${fmt(px)}` } },
                ] } },
                { type: 'div', props: { style: { fontSize: 14, color: '#8a8a96', marginTop: 4, display: 'flex' },
                  children: `at ${where}${cb && cb.better ? ` \u00b7 better than Novig ${fmt(s.sharpSideAmerican)}` : ''}` } },
              ] } },
            ] } },
            { type: 'div', props: { style: { fontSize: 15, color: '#fff', marginTop: 12, display: 'flex' },
              children: `${s.league ? '[' + s.league + '] ' : ''}${s.event}` } },
            ...(s.gameTimeLabel ? [{ type: 'div', props: {
              style: { fontSize: 13, color: '#8a8a96', marginTop: 3, display: 'flex' },
              children: s.gameTimeLabel } }] : []),
            ...(st ? [{ type: 'div', props: { style: { fontSize: 14, color: '#9ca3af', marginTop: 4, display: 'flex' },
              children: `Risk ${st.risk}u to win ${st.toWin}u` } }] : []),
            { type: 'div', props: { style: { fontSize: 13, color: '#6b6b76', marginTop: 8, display: 'flex' },
              children: `$${(s.sharpSideLiquidityUsd || 0).toLocaleString()} bid \u00b7 imbalance ${s.score}` } },
          ] } };
      }));

      const recTxt = rec.sample
        ? `Record ${rec.wins}-${rec.losses}${rec.pushes ? '-' + rec.pushes : ''}`
          + `${rec.winPct != null ? ` (${rec.winPct}%)` : ''} \u00b7 ${rec.units >= 0 ? '+' : ''}${rec.units}u`
        : 'Record: no graded plays yet';

      const tree = { type: 'div', props: {
        style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
          backgroundColor: '#0a0a0d', padding: '30px 34px', fontFamily: 'Open Sans' },
        children: [
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center' }, children: [
            // Drawn bolt, not an emoji -- satori can't render emoji glyphs.
            { type: 'div', props: { style: { display: 'flex', width: 8, height: 24,
              backgroundColor: '#4ade80', marginRight: 12, borderRadius: 2 } } },
            { type: 'div', props: { style: { fontSize: 26, fontWeight: 700, color: '#fff', display: 'flex' },
              children: 'Novig Sharp Money' } },
          ] } },
          { type: 'div', props: { style: { fontSize: 15, color: '#9ca3af', marginTop: 6, display: 'flex' },
            children: recTxt } },
          ...(cards.length ? cards : [{ type: 'div', props: {
            style: { fontSize: 17, color: '#9ca3af', marginTop: 22, display: 'flex' },
            children: 'No qualifying plays right now.' } }]),
        ] } };

      const height = 120 + (cards.length ? cards.length * 168 : 60);
      const svg = await satori(tree, { width: 900, height: Math.max(height, 260), fonts });
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: 900 } }).render().asPng();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).send(png);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.query && req.query.novigAlert) {
    try {
      const dry = String(req.query.dry || '') === '1';
      // No league param scans every supported league -- one cron covers all sports.
      // windowHours is pushed DOWN into the scan rather than filtered here afterwards:
      // order books cost one API call per event, so filtering to near-start games before
      // fetching is what keeps an all-sports run inside the function time limit.
      const leagueQ = req.query.league ? `&league=${encodeURIComponent(String(req.query.league))}` : '';
      // No windowHours here on purpose -- the scan applies its own PER-SPORT window
      // (football needs days of visibility, daily sports do not). Forcing a flat 2h
      // here would silently override that.
      const r = await fetch(`${SITE_URL}/api/odds?novigSharp=1${leagueQ}`);
      const d = await r.json();
      if (!d || !d.ok) return res.status(200).json({ ok: false, error: (d && d.error) || 'scan failed' });

      // Council: alert only when BOTH agree -- exchange money on a side AND a better
      // price for it elsewhere. Either alone is weaker than the pair.
      // FIX 2026-09-04 (per Derek, real incident -- zero alerts all day on a board with
      // real 80+ score signals). Cross-book price was a HARD requirement, and it silently
      // killed every real signal tonight: novigCrossBook only finds an edge when the Odds
      // API tracks the same game, and small-conference/FCS games (exactly the kind of
      // thin market that produces a real 80+ imbalance) are often not carried by
      // mainstream books at all. Requiring an edge on top of an already-strict quality
      // gate meant nothing could ever pass both at once. The quality gates (score,
      // liquidity, price-extremity) are what decide whether a signal is real; cross-book
      // is now a bonus shown ON the alert when it exists, never a requirement to fire.
      // Old strict behavior is still available via requireEdge=1 for anyone who wants it.
      const withBook = await novigCrossBook(d.signals || []);
      const requireEdge = String(req.query.requireEdge || '') === '1';
      const eligible = requireEdge
        ? withBook.filter(s => s.crossBook && s.crossBook.better)
        : withBook;
      // Grade anything settled before reporting, so the record shown is current.
      const gradeRes = await novigGradePending();
      const rec = await novigRecord();

      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const fresh = [];
      for (const s of eligible) {
        const key = `novigsharp:${day}:${s.eventId}:${s.market}:${s.sharpSide}`;
        try {
          const seen = await upstashPost(['SET', key, '1', 'NX', 'EX', '172800']);
          if (!(seen && seen.result === 'OK')) continue;
        } catch { /* KV down -- fall through and send rather than silently drop */ }
        fresh.push(s);
      }

      /* ALERT FORMAT 2026-09-04 (per Derek: "simple to say, this is the inferred sharp
         side take this"). Lead with the action and the number to take it at. Mechanics
         (liquidity, imbalance score) are demoted to one supporting line -- present for
         auditing, never the headline. */
      const lines = fresh.slice(0, 10).map(s => {
        const cb = s.crossBook;
        const px = cb && cb.better ? cb.price : s.sharpSideAmerican;
        const where = cb && cb.better ? cb.book : 'Novig';
        const fmt = a => (a > 0 ? '+' + a : String(a));
        const st = novigStakeFor(px);
        return `\u26A1 **TAKE: ${s.sharpSide} (${fmt(px)} at ${where})**\n`
          + `   ${s.league ? '[' + s.league + '] ' : ''}${s.event}${s.gameTimeLabel ? ' \u00b7 ' + s.gameTimeLabel : ''}\n`
          + `   Exchange money on ${s.sharpSide}`
          + (cb && cb.better ? ` \u00b7 better than Novig's ${fmt(s.sharpSideAmerican)}` : '')
          + (st ? `\n   Risk ${st.risk}u to win ${st.toWin}u` : '')
          + `\n   _$${s.sharpSideLiquidityUsd.toLocaleString()} bid \u00b7 imbalance ${s.score}_`;
      });

      const result = {
        ok: true, leagues: d.leagues, leaguesFound: d.leaguesFound,
        scanned: d.eventsScanned, eventsInWindow: d.eventsInWindow, totalSignals: d.signalCount,
        withinWindow: eligible.length, newAlerts: fresh.length,
        thresholds: { minScore: d.minScore, minLiq: d.minLiq },
        record: rec, gradedThisRun: gradeRes.graded, stillPendingGrade: gradeRes.stillPending,
        preview: lines,
      };
      if (dry) { result.dryRun = true; return res.status(200).json(result); }
      if (!fresh.length) { result.sent = false; result.note = 'No new signals within the 2h window'; return res.status(200).json(result); }

      const webhook = process.env.novig_sharp_alerts || process.env.sharp_line_alerts;
      if (!webhook) { result.sent = false; result.note = 'No webhook set (novig_sharp_alerts or sharp_line_alerts)'; return res.status(200).json(result); }

      const recLine = rec.sample
        ? `Record: ${rec.wins}-${rec.losses}${rec.pushes ? '-' + rec.pushes : ''}`
          + `${rec.winPct != null ? ` (${rec.winPct}%)` : ''} \u00b7 ${rec.units >= 0 ? '+' : ''}${rec.units}u`
          + `${rec.ungraded ? ` \u00b7 ${rec.ungraded} ungraded` : ''}`
        : 'Record: no graded plays yet';
      const header = `\u26A1 **Novig Sharp Money** \u2014 ${fresh.length} play${fresh.length > 1 ? 's' : ''}\n${recLine}`;

      // Discord fetches embed.image.url itself; cache-buster so a later send never
      // shows a stale render of an earlier board.
      const imgEmbed = { image: { url: `${SITE_URL}/api/polymarket-notify?novigImage=1&t=${Date.now()}` } };
      const send = await sendDiscord(webhook, header + '\n\n' + lines.join('\n\n'), [imgEmbed]);
      result.sent = !!(send && send.ok);
      // Only record plays that actually went out -- a signal nobody was told about
      // shouldn't count for or against the record.
      if (send && send.ok) {
        try {
          const raw = await upstashPost(['GET', 'novig:pending']);
          const v = raw && raw.ok ? raw.result : null;
          const cur = v ? (typeof v === 'string' ? JSON.parse(v) : v) : [];
          fresh.slice(0, 10).forEach(s => cur.push({
            event: s.event, eventId: s.eventId, league: s.league, gameTime: s.gameTime,
            market: s.market, marketType: s.marketType, strike: s.strike,
            sharpSide: s.sharpSide, sharpSideAmerican: s.sharpSideAmerican,
            score: s.score, sharpSideLiquidityUsd: s.sharpSideLiquidityUsd,
            crossBook: s.crossBook || null,
            // Old inverted read, graded in parallel so results settle the direction
            // question rather than more reasoning about it.
            shadowInverseSide: s.shadowInverseSide, shadowInverseAmerican: s.shadowInverseAmerican,
            alertedAt: Date.now(),
          }));
          await upstashPost(['SET', 'novig:pending', JSON.stringify(cur.slice(-300)), 'EX', '2592000']);
        } catch {}
      }
      result.sendResult = send;
      return res.status(200).json(result);
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  if (req.query && req.query.reportImage) {
    try {
      const satori = require('satori').default;
      const { Resvg } = require('@resvg/resvg-js');
      const teamLogos = require('../lib/team_logos_data.js');

      let cachedFonts = global.__reportImageFonts;
      async function getFonts() {
        if (cachedFonts) return cachedFonts;
        const [regular, bold] = await Promise.all([
          fetch('https://raw.githubusercontent.com/googlefonts/opensans/main/fonts/ttf/OpenSans-Regular.ttf').then(r => r.arrayBuffer()),
          fetch('https://raw.githubusercontent.com/googlefonts/opensans/main/fonts/ttf/OpenSans-Bold.ttf').then(r => r.arrayBuffer()),
        ]);
        cachedFonts = [
          { name: 'Open Sans', data: Buffer.from(regular), weight: 400, style: 'normal' },
          { name: 'Open Sans', data: Buffer.from(bold), weight: 700, style: 'normal' },
        ];
        global.__reportImageFonts = cachedFonts;
        return cachedFonts;
      }

      let trackedRecordsImg = {};
      try {
        const trRes = await fetch(`${SITE_URL}/api/trader-records`);
        const trData = await trRes.json();
        trackedRecordsImg = trData.records || {};
      } catch {}

      let ncaafLogoCache = null;
      async function getNcaafLogoUrl(teamName) {
        if (!ncaafLogoCache) {
          ncaafLogoCache = {};
          try {
            const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${today}&groups=80&limit=200`);
            const j = await r.json();
            (j.events || []).forEach(ev => {
              const comp = ev.competitions && ev.competitions[0];
              (comp && comp.competitors || []).forEach(c => {
                const name = c.team && (c.team.displayName || c.team.name);
                const logo = c.team && c.team.logos && c.team.logos[0] && c.team.logos[0].href;
                if (name && logo) ncaafLogoCache[name] = logo;
              });
            });
          } catch {}
        }
        return ncaafLogoCache[teamName] || null;
      }

      async function toDataUri(sport, teamName) {
        if (sport === 'NCAAF') {
          const url = await getNcaafLogoUrl(teamName);
          if (!url) return null;
          try {
            const r = await fetch(url);
            const buf = Buffer.from(await r.arrayBuffer());
            return `data:image/png;base64,${buf.toString('base64')}`;
          } catch { return null; }
        }
        const table = sport === 'NFL' ? teamLogos.nfl : teamLogos.mlb;
        const b64 = table && table[teamName];
        return b64 ? `data:image/png;base64,${b64}` : null;
      }

      const fmtOdds = n => (n > 0 ? `+${n}` : String(n));

      async function playCardImg(p) {
        const cs = p.convergeScore || { score: p.siScore || 0, breakdown: { book: { score: p.siScore || 0 } } };
        const book = cs.breakdown && cs.breakdown.book;
        const poly = cs.breakdown && cs.breakdown.poly;
        const combined = !!poly;
        const tagColor = combined ? '#00C896' : '#40B4FF';
        const tagLabel = combined ? 'COMBINED' : 'LINE';

        const [awayUri, homeUri] = await Promise.all([toDataUri(p.sport, p.away), toDataUri(p.sport, p.home)]);
        const d = new Date(p.commenceTime);
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
        const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

        const tagIconEl = combined
          ? { type: 'div', props: { style: { display: 'flex', width: 14, height: 14, borderRadius: 7, border: `2px solid ${tagColor}`, marginRight: 6, alignItems: 'center', justifyContent: 'center' },
              children: [{ type: 'div', props: { style: { display: 'flex', width: 5, height: 5, borderRadius: 3, backgroundColor: tagColor } } }] } }
          : { type: 'div', props: { style: { display: 'flex', alignItems: 'flex-end', marginRight: 8, height: 14 },
              children: [
                { type: 'div', props: { style: { display: 'flex', width: 3, height: 6, backgroundColor: tagColor, marginRight: 2 } } },
                { type: 'div', props: { style: { display: 'flex', width: 3, height: 10, backgroundColor: tagColor, marginRight: 2 } } },
                { type: 'div', props: { style: { display: 'flex', width: 3, height: 14, backgroundColor: tagColor } } },
              ] } };

        const children = [
          { type: 'div', props: { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
            children: [
              { type: 'div', props: { style: { display: 'flex', alignItems: 'center' },
                children: [
                  { type: 'div', props: { style: { fontSize: 48, fontWeight: 700, color: '#4ade80', display: 'flex', marginRight: 16 }, children: String(cs.score) } },
                  { type: 'div', props: { style: { display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 700, color: tagColor, backgroundColor: tagColor + '22', border: `1px solid ${tagColor}`, borderRadius: 6, padding: '4px 12px' },
                      children: [tagIconEl, { type: 'div', props: { style: { display: 'flex' }, children: tagLabel } }] } },
                ] } },
              { type: 'div', props: { style: { display: 'flex', fontSize: 14, fontWeight: 700, color: '#9ca3af', border: '1px solid #333', borderRadius: 6, padding: '4px 12px' }, children: p.sport } },
            ] } },
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center', marginTop: 6 },
            children: [
              { type: 'div', props: { style: { display: 'flex', width: 12, height: 12, borderRadius: 6, border: '2px solid #8a8a96', marginRight: 6 } } },
              { type: 'div', props: { style: { fontSize: 14, color: '#8a8a96', display: 'flex' }, children: `${dateStr} \u00b7 ${timeStr}` } },
            ] } },
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center', marginTop: 10 },
            children: [
              ...(awayUri ? [{ type: 'img', props: { src: awayUri, width: 30, height: 30, style: { marginRight: 8, display: 'flex' } } }] : []),
              { type: 'div', props: { style: { fontSize: 20, fontWeight: 700, color: '#fff', display: 'flex' }, children: `${p.away} vs ${p.home}` } },
              ...(homeUri ? [{ type: 'img', props: { src: homeUri, width: 30, height: 30, style: { marginLeft: 8, display: 'flex' } } }] : []),
            ] } },
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center', marginTop: 8 },
            children: [
              { type: 'div', props: { style: { fontSize: 16, color: '#4ade80', marginRight: 6, display: 'flex' }, children: '\u25B6' } },
              { type: 'div', props: { style: { fontSize: 18, fontWeight: 700, color: '#4ade80', display: 'flex' }, children: p.sharpSide || '\u2014' } },
            ] } },
        ];

        // FIX 2026-09-01 (per Derek, real screenshot -- still showing pp in production):
        // currentPinPrice/currentSoftAvg only exist INSIDE markets[activeMarket], never
        // replicated to the top level of the play object. Checking p.currentPinPrice
        // directly was always undefined, so this fell back to the pp format every single
        // time regardless of the earlier fix -- confirmed by inspecting the actual real
        // JSON structure, not assuming the top-level fields existed.
        const activeMarketData = p.markets && p.activeMarket ? p.markets[p.activeMarket] : null;
        const pinPrice = activeMarketData ? activeMarketData.currentPinPrice : p.currentPinPrice;
        const softAvg = activeMarketData ? activeMarketData.currentSoftAvg : p.currentSoftAvg;
        const oddsLine = (pinPrice != null && softAvg != null)
          ? `Pinnacle ${fmtOdds(pinPrice)} vs ${fmtOdds(softAvg)} avg`
          : (p.gapPP != null ? `Pinnacle gap ${p.gapPP}pp` : 'Pinnacle: \u2014');

        if (!combined) {
          children.push({ type: 'div', props: { style: { fontSize: 14, color: '#8a8a96', marginTop: 10, display: 'flex' }, children: oddsLine } });
        } else {
          // SPACE FOR MULTIPLE TRADERS 2026-09-01 (per Derek): the poly box must never
          // clip real backers -- height is built from the actual trader count, not a
          // fixed guess, so 1 trader and 5 traders both render completely.
          const traders = (poly.traders && poly.traders.length) ? poly.traders : (poly.traderNames || []).map(n => ({ traderName: n, wallet: null }));
          const traderRows = traders.map(t => {
            const rec = t.wallet ? getRecordFor({ wallet: t.wallet, traderName: t.traderName, sport: p.sport }, trackedRecordsImg) : null;
            const rows = [{ type: 'div', props: { style: { fontSize: 15, fontWeight: 700, color: '#fff', marginTop: 8, display: 'flex' }, children: t.traderName } }];
            if (rec) {
              // FIX 2026-09-01: caught via visual check -- record color was hardcoded
              // green regardless of sign, so a real losing record (-47%) displayed as if
              // it were positive. Now reflects actual win/loss sign, matching the color
              // logic used everywhere else in this file.
              const recColor = rec.roiPct > 0 ? '#4ade80' : rec.roiPct < 0 ? '#f87171' : '#9ca3af';
              rows.push({ type: 'div', props: { style: { fontSize: 13, color: recColor, marginTop: 2, display: 'flex' },
                children: `${rec.wins}-${rec.losses}${rec.roiPct != null ? ` (${rec.roiPct >= 0 ? '+' : ''}${Math.round(rec.roiPct)}%)` : ''}` } });
              if (rec.sportBreakdown) {
                const sb = rec.sportBreakdown;
                rows.push({ type: 'div', props: { style: { fontSize: 12, color: '#6b6b76', marginTop: 1, display: 'flex' },
                  children: `(${sb.sport}: ${sb.wins}-${sb.losses}${sb.roiPct != null ? ` ${sb.roiPct >= 0 ? '+' : ''}${Math.round(sb.roiPct)}%` : ''})` } });
              }
            }
            return rows;
          }).flat();

          children.push({ type: 'div', props: { style: { display: 'flex', marginTop: 14, gap: 14 },
            children: [
              { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', flex: 1, backgroundColor: '#12161c', borderRadius: 10, padding: 16 },
                children: [
                  { type: 'div', props: { style: { fontSize: 12, fontWeight: 700, color: '#40B4FF', letterSpacing: 1, display: 'flex' }, children: 'SHARP LINE' } },
                  { type: 'div', props: { style: { fontSize: 16, fontWeight: 700, color: '#fff', marginTop: 6, display: 'flex' }, children: p.sharpSide || '\u2014' } },
                  { type: 'div', props: { style: { fontSize: 13, color: '#8a8a96', marginTop: 6, display: 'flex' }, children: oddsLine } },
                ] } },
              { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', flex: 1, backgroundColor: '#1c1712', borderRadius: 10, padding: 16 },
                children: [
                  { type: 'div', props: { style: { fontSize: 12, fontWeight: 700, color: '#E5A00D', letterSpacing: 1, display: 'flex' }, children: 'POLY SIGNAL' } },
                  { type: 'div', props: { style: { fontSize: 13, color: '#8a8a96', marginTop: 4, display: 'flex' }, children: `$${Math.round(poly.totalVol || 0).toLocaleString()} \u00b7 ${traders.length} trader${traders.length > 1 ? 's' : ''}` } },
                  ...traderRows,
                ] } },
            ] } });
        }

        return { type: 'div', props: {
          style: { display: 'flex', flexDirection: 'column', backgroundColor: '#181c22', borderRadius: 14, borderLeft: `4px solid ${tagColor}`, padding: 22, marginTop: 18 },
          children,
        } };
      }

      const sports = ((req.query.sports) || 'MLB').split(',').map(s => s.trim().toUpperCase());
      const allPlays = [];
      for (const sp of sports) {
        try {
          const r = await fetch(`${SITE_URL}/api/odds?sport=${sp}`);
          const d = await r.json();
          (d.plays || []).forEach(p => {
            // REAL FIX 2026-09-01 (per Derek, real incident -- Yankees/Angels, book-only,
            // zero poly, still showed): this branch is a completely SEPARATE code path
            // from buildBestPlaysReport, and never inherited the bookConfirmed+polyConfirmed
            // gate built there -- it was only ever checking score >= 75. Applying the exact
            // same standard here directly: book confirmed (real absolute floor, not the
            // relative_fallback retrofit) AND poly confirmed (2+ real distinct wallets).
            const bookConfirmedImg = p.pillars && p.pillars.pinnacleSource !== 'relative_fallback' && !p.noSignal;
            const polyConfirmedImg = !!(p.convergeScore && p.convergeScore.breakdown && p.convergeScore.breakdown.poly && p.convergeScore.breakdown.poly.buyers >= 2);
            // TIMING GATE 2026-09-02 (per Derek): same 2-hour-before-commence gate as
            // buildBestPlaysReport -- this is a separate code path and does not
            // automatically inherit it, same lesson as the bookConfirmed/polyConfirmed
            // gate above having needed its own separate fix here too.
            const tooEarlyImg = p.commenceTime && (new Date(p.commenceTime).getTime() - Date.now()) > (2 * 60 * 60 * 1000);
            if (bookConfirmedImg && polyConfirmedImg && !tooEarlyImg) allPlays.push({ ...p, sport: sp });
          });
        } catch {}
      }
      allPlays.sort((a, b) => b.convergeScore.score - a.convergeScore.score);

      // HEIGHT 2026-09-01: built from real content (multi-trader poly boxes vary a lot in
      // height), not a fixed per-card guess -- estimate per card from its trader count so
      // real cards with 4-5 backers never get clipped.
      const cards = await Promise.all(allPlays.slice(0, 10).map(playCardImg));
      const fonts = await getFonts();
      let totalHeight = 130;
      allPlays.slice(0, 10).forEach(p => {
        const poly = p.convergeScore && p.convergeScore.breakdown && p.convergeScore.breakdown.poly;
        const traderCount = poly ? ((poly.traders && poly.traders.length) || (poly.traderNames && poly.traderNames.length) || 1) : 0;
        totalHeight += poly ? (150 + traderCount * 46) : 170;
      });

      const tree = { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: '#0a0a0d', padding: '32px 36px', fontFamily: 'Open Sans' },
        children: [
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center' }, children: [
              { type: 'div', props: { style: { display: 'flex', width: 22, height: 22, borderRadius: 11, border: '3px solid #4ade80', marginRight: 10, alignItems: 'center', justifyContent: 'center' },
                  children: [{ type: 'div', props: { style: { display: 'flex', width: 8, height: 8, borderRadius: 4, backgroundColor: '#4ade80' } } }] } },
              { type: 'div', props: { style: { fontSize: 26, fontWeight: 700, color: '#fff', display: 'flex' }, children: 'Converge Score Report' } },
            ] } },
          ...(cards.length ? cards : [{ type: 'div', props: { style: { fontSize: 18, color: '#9ca3af', marginTop: 24, display: 'flex' }, children: 'Nothing cleared the 75+ threshold right now.' } }]),
        ] } };

      const svg = await satori(tree, { width: 900, height: Math.max(totalHeight, 300), fonts });
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: 900 } }).render().asPng();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).send(png);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  /* BEST PLAYS REPORT -- ?bestPlays=1 (scheduled digest) or ?bestPlays=check (follow-up
     sweep for plays that newly crossed the bar). Both share the same dedup, so the
     scheduled send and the follow-ups can never double-post the same play.
     Optional &sports=MLB,NFL overrides which sports to pull; defaults to MLB.
     &dry=1 builds the report and returns it WITHOUT posting -- for tuning the format
     without spamming the channel. */
  /* TEST MODE 2026-08-28 (per Derek): ?bestPlays=test posts one clearly-labeled sample
     embed to #sharp-report -- verifies the webhook, embed rendering, and delivery
     actually work end-to-end before any real play ever qualifies. Deliberately isolated
     from the real modes below: no dedup KV write, no odds.js call, cannot be confused
     with or interfere with a real report. Every field is fabricated and says so. */
  if (req.query && req.query.bestPlays === 'test') {
    const webhook = process.env.sharp_report;
    if (!webhook) return res.status(200).json({ ok: false, note: 'sharp_report env var not set' });
    const sampleEmbed = {
      title: '\u26a0\ufe0f TEST DATA \u2014 Boston Red Sox @ New York Yankees',
      description: 'MLB \u00b7 SAMPLE ONLY, not a real signal',
      color: 0x9B6DFF,
      fields: [
        { name: 'Pick', value: '**New York Yankees** (h2h) [SAMPLE]', inline: true },
        { name: 'Score', value: '**82** \u00b7 STRONG [FABRICATED]', inline: true },
        { name: 'Signal', value: 'Dual Consensus [SAMPLE]', inline: true },
        { name: 'Pinnacle gap', value: '2.3pp [SAMPLE]', inline: true },
        { name: 'Best price', value: '-142 (fanduel) [SAMPLE]', inline: true },
        { name: 'Half-Kelly', value: '3.1% bankroll [SAMPLE]', inline: true },
      ],
      footer: { text: 'This is a test send to verify formatting and delivery -- not a real play.' },
    };
    const send = await sendDiscord(webhook, '\u{1F9EA} **Sharp Report Test Send** \u2014 verifying channel + formatting, not a real signal', [sampleEmbed]);
    return res.status(200).json({ ok: true, testSend: true, sendResult: send });
  }

  if (req.query && req.query.bestPlays) {
    const mode = String(req.query.bestPlays);
    const sports = (req.query.sports ? String(req.query.sports) : 'MLB')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const dry = String(req.query.dry || '') === '1';
    // FIX 2026-08-28 (per Derek): Best Plays Report gets its own channel/webhook, separate
    // from the every-alert channel (DISCORD_WEBHOOK_URL_ALERTS, untouched below). Derek's
    // Vercel variable is lowercase sharp_report -- confirmed exact casing directly with him
    // rather than guessing, same lesson as the DISCORD-substring naming mixup earlier.
    const webhook = process.env.sharp_report;

    // Grade any previously-posted plays whose games have finished, before building this
    // report -- so the record shown is always current, not from whenever grading last ran.
    let gradeResult = { graded: 0, stillPending: 0 };
    try { gradeResult = await gradeConvergePending(); } catch {}
    const record = await getConvergeRecord();

    const { plays, errors, topAvailable } = await buildBestPlaysReport(sports);

    // Dedup: skip plays already posted today, unless the score climbed a tier.
    const fresh = [];
    for (const p of plays) {
      const key = playKey(p);
      let prior = null;
      try {
        // REAL ROOT CAUSE 2026-08-30 (per Derek, confirmed on the second recurrence):
        // upstashPost returns {ok,result} -- an object, ALWAYS truthy even when the key
        // doesn't exist. `if (raw)` on the wrapper itself was therefore always true,
        // `prior` got set to the wrapper (not the real stored data), so !prior never
        // fired for genuinely new plays, and prior.convergeScore was always undefined --
        // any real score compared to undefined via > is always false in JS, so upgraded
        // was always false too. Result: newOrUpgraded:0 no matter what, deterministically,
        // every single run. This was never about timing (yesterday's ET fix was real and
        // worth keeping, but it wasn't THIS bug). Extract .result first, matching the
        // correct pattern already used elsewhere in this file (getConvergeRecord etc).
        const res = await upstashPost(['GET', key]);
        const raw = res && res.ok ? res.result : null;
        if (raw) prior = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {}
      if (!prior) { fresh.push({ ...p, _reason: 'new' }); continue; }
      // FIX 2026-08-28: upgrade detection now compares Converge Score, matching what
      // qualifies/sorts the report -- was still comparing siScore, which could miss a
      // real upgrade driven by poly/kalshi and falsely fire on an unrelated siScore wobble.
      const upgraded = tierFor(p._convergeScore).name !== tierFor(prior.convergeScore).name && p._convergeScore > prior.convergeScore;
      if (upgraded) fresh.push({ ...p, _reason: `upgraded from ${prior.convergeScore}` });
    }

    // TOP SIGNALS FALLBACK 2026-08-29 (per Derek): only relevant when nothing real
    // qualified this run. Own dedup key (prefixed topsig:, separate from playKey's real
    // dedup) so a quiet day's "best available" doesn't get re-posted every single 30-min
    // cycle -- once per candidate per day, same TTL reasoning as the real dedup.
    const freshTopAvailable = [];
    if (!fresh.length) {
      for (const p of topAvailable) {
        const key = 'topsig:' + playKey(p);
        try {
          const res = await upstashPost(['GET', key]);
          const raw = res && res.ok ? res.result : null;
          if (raw) continue; // already shown today
        } catch {}
        freshTopAvailable.push(p);
      }
    }

    const result = {
      ok: true, mode, sports, threshold: TOP_PLAY_MIN,
      qualifying: plays.length, newOrUpgraded: fresh.length,
      topAvailableShown: freshTopAvailable.length,
      oddsErrors: errors,
      record, gradedThisRun: gradeResult.graded, stillPendingGrade: gradeResult.stillPending,
      plays: fresh.map(p => ({ game: `${p.away} @ ${p.home}`, sport: p.sport, market: p.market || p.activeMarket,
        side: p.sharpSide, convergeScore: p._convergeScore, siScore: p.siScore, reason: p._reason })),
    };

    // Record line, same wherever the record is shown -- report header or dry preview.
    // "no graded plays yet" until real games settle; never a fabricated 0-0 record.
    const recordLine = record.sample
      ? `Converge Score Record: ${record.wins}-${record.losses}${record.pushes ? '-' + record.pushes : ''} (${record.winPct}%) \u00b7 ${record.netUnits >= 0 ? '+' : ''}${record.netUnits}u`
      : 'Converge Score Record: no graded plays yet';

    if (dry) {
      result.dryRun = true; result.recordLine = recordLine;
      result.linePreview = fresh.map(playLine);
      result.topAvailablePreview = freshTopAvailable.slice(0, 3).map(playLine);
      return res.status(200).json(result);
    }
    if (!fresh.length && !freshTopAvailable.length) { result.sent = false; result.note = 'Nothing new above threshold, and no new below-threshold candidates to show'; return res.status(200).json(result); }
    if (!webhook) { result.sent = false; result.note = 'DISCORD_WEBHOOK_URL_ALERTS not set'; return res.status(200).json(result); }

    // OPTION A FORMAT (per Derek, 2026-08-30): plain compact lines instead of one embed
    // per play -- six colored embed cards read as more visual weight than six lines of
    // text, which was the actual "too crowded" complaint. Discord content caps at 2000
    // chars; sliced defensively so a big slate can never silently get cut mid-play.
    let header = (mode === 'check'
      ? `\u{1F195} **New top play${fresh.length > 1 ? 's' : ''}** \u2014 crossed ${TOP_PLAY_MIN}+ since the last report`
      : `\u{1F3AF} **Converge Score Report** \u2014 ${sports.join('/')} \u00b7 ${fresh.length} play${fresh.length > 1 ? 's' : ''} at ${TOP_PLAY_MIN}+`)
      + `\n${recordLine}`;

    const bodyParts = fresh.map(playLine);

    if (!fresh.length && freshTopAvailable.length) {
      header = `\u{1F3AF} **Converge Score Report** \u2014 ${sports.join('/')}\n${recordLine}\n`
        + `\u26a0\ufe0f *Nothing cleared the ${TOP_PLAY_MIN}+ preferred threshold today -- showing the most promising available signals below it instead.*`;
      bodyParts.push(...freshTopAvailable.slice(0, 3).map(p => `\u26a0\ufe0f BELOW THRESHOLD \u2014 ${playLine(p)}`));
    } else if (fresh.length && freshTopAvailable.length) {
      bodyParts.push(...freshTopAvailable.slice(0, 3).map(p => `\u26a0\ufe0f BELOW THRESHOLD \u2014 ${playLine(p)}`));
    }

    let fullMessage = header + '\n\n' + bodyParts.join('\n\n');
    if (fullMessage.length > 1900) fullMessage = fullMessage.slice(0, 1880) + '\n\n_(truncated -- see site for the rest)_';

    // IMAGE 2026-08-31 (per Derek): attach the real rendered card (see ?reportImage=1
    // above) alongside the existing text. Discord fetches embed.image.url itself -- no
    // file upload needed, just a public URL to the same endpoint with the same sports
    // param, so the image always reflects the identical qualifying plays as the text.
    const imageEmbed = { image: { url: `${SITE_URL}/api/polymarket-notify?reportImage=1&sports=${sports.join(',')}&t=${Date.now()}` } };

    const send = await sendDiscord(webhook, fullMessage, [imageEmbed]);
    result.sent = send.ok;
    result.sendResult = send;

    if (send.ok) {
      for (const p of fresh) {
        try { await upstashPost(['SET', playKey(p), JSON.stringify({ convergeScore: p._convergeScore, siScore: p.siScore, at: Date.now() }), 'EX', String(REPORT_TTL)]); } catch {}
        // Capture what's needed to grade this play later -- teams, sport, market, the
        // sharpSide string (already embeds the spread/total line), and the odds at the
        // moment it was posted (units are computed off THIS price, not whatever it moves
        // to later). Gated on trackingIsLive() -- see TRACKING_START_DATE above -- so
        // today's unreliable-baseline plays send normally but never enter the record.
        if (trackingIsLive()) {
          try {
            const best = p.bestPrices && p.bestPrices[p.sharpSide];
            const pendingRes = await upstashPost(['GET', 'converge:pending']);
            const pendingRaw = pendingRes && pendingRes.ok ? pendingRes.result : null;
            const pendingArr = pendingRaw ? (typeof pendingRaw === 'string' ? JSON.parse(pendingRaw) : pendingRaw) : [];
            pendingArr.push({ away: p.away, home: p.home, sport: p.sport, market: p.market || p.activeMarket,
              sharpSide: p.sharpSide, odds: best ? best.price : null, siScore: p.siScore, postedAt: Date.now() });
            await upstashPost(['SET', 'converge:pending', JSON.stringify(pendingArr), 'EX', '2592000']);
          } catch {}
        }
      }
      // Below-threshold candidates get ONLY the topsig dedup marker -- deliberately NOT
      // captured into converge:pending/grading. They're explicitly not real qualifiers;
      // grading them would mix unvalidated below-threshold picks into the real record.
      for (const p of freshTopAvailable.slice(0, 3)) {
        try { await upstashPost(['SET', 'topsig:' + playKey(p), JSON.stringify({ at: Date.now() }), 'EX', String(REPORT_TTL)]); } catch {}
      }
    }
    return res.status(200).json(result);
  }

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

    /* WALLET FORM 2026-08-27 (council-approved) -- rolling per-sport recent form, fetched
       once per run alongside unitSizes so Discord shows the same tag the site will.
       SHADOW ONLY: this is a display callout, it does NOT gate or score anything. It exists
       because a wallet's all-time record can look excellent while recent form is mediocre
       (confirmed live: SDTrading is 80.1% all-time ROI but 10-10 over its last 20 MLB
       plays). Walk-forward test backing this: hot 57.9% / warm 52.0% / cold 50.0% against a
       52.4% break-even. Internal call to our own endpoint -- costs no Odds API quota. */
    let walletForm = {};
    try {
      const wfRes = await fetch(`${SITE_URL}/api/grade-cron?walletForm=1`);
      const wfData = await wfRes.json();
      walletForm = wfData.form || {};
    } catch { /* best-effort -- alert still works without form context */ }
    function formLabel(wallet, sport) {
      if (!wallet || !sport) return '';
      const f = walletForm[wallet + '|' + sport];
      if (!f) return '';   // under the min-sample gate -- deliberately show nothing
      const icon = f.form === 'HOT' ? '\u{1F525}' : (f.form === 'COLD' ? '\u{1F9CA}' : '\u2696\ufe0f');
      return `${icon} ${f.form} in ${sport} \u2014 ${f.wins}-${f.losses} (${f.winPct}%) last ${f.window}`;
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

    // BUGFIX 2026-08-20 (per Derek, real incident): confirmed directly -- laozishudaosan's
    // real Orioles trade was correctly rejected as live at the time it was made (game
    // genuinely in progress), but once that game later fully concluded and dropped out of
    // active schedule data entirely, findGameForTrade found no match, the code correctly
    // "failed open" (its own separate, deliberate safety net for missing schedule data),
    // and the SAME trade got a silent second chance -- surfacing hours later as if it were
    // new, on a game whose outcome was already known. A live rejection needs to be
    // permanent, not re-decided from scratch every run based on whatever schedule data
    // happens to still be available. Tracked by transactionHash, 7-day TTL (long enough
    // to cover any realistic delay, short enough not to accumulate forever).
    for (const cand of liveGameChecks) {
      const { wallet, usd, sport, t, traderInfo } = cand;
      const txKey = 'liverejected:' + (t.transactionHash || (wallet + '|' + t.title + '|' + t.timestamp));
      let alreadyLiveRejected = false;
      try {
        const r = await upstashPost(['GET', txKey]);
        alreadyLiveRejected = r.ok && r.result != null;
      } catch { /* best-effort -- falls through to the normal check below on failure */ }
      if (alreadyLiveRejected) {
        results.poly.liveSkipped++;
        if (cand.dbg) cand.dbg.reject = 'live: game already started (previously flagged, permanent)';
        continue;
      }

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
          try { await upstashPost(['SET', txKey, '1', 'EX', '604800']); } catch {}
          continue;
        }
      }
      // No matching game found (e.g. schedule fetch failed, or a market our
      // matcher can't parse): fail OPEN rather than silently dropping a real signal.
      const key = `${wallet}||${t.title}`;
      const ex  = walletMarketBest.get(key);
      if (!ex || usd > ex.usd) walletMarketBest.set(key, { wallet, usd, sport, t, traderInfo, dbg: cand.dbg });
    }

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

    // FEATURE 2026-08-19 (per Derek): standalone Discord ping when a specifically-flagged
    // wallet makes any real play, regardless of whether anyone else is on it -- separate
    // from the convergence pipeline entirely. Reuses polyAlerts (already live-checked,
    // gate-checked, sport-filtered), so this inherits every existing safety check rather
    // than re-implementing them. Independently deduped (standalone:* prefix) from the
    // ntfy poly:* dedup, since these are different channels for the same underlying trade.
    results.discordStandalone = { scanned: 0, sent: 0, alerts: [] };
    const standaloneWebhook = process.env.DISCORD_WEBHOOK_URL;
    if (standaloneWebhook) {
      const alwaysAlertWalletSet = new Set(watchedWallets.filter(w => w.alwaysAlert === true).map(w => w.wallet));
      for (const alert of polyAlerts) {
        if (!alwaysAlertWalletSet.has(alert.wallet)) continue;
        results.discordStandalone.scanned++;
        const standaloneKey = `standalone:${alert.transactionHash || alert.wallet + alert.title}`;
        if (!(await claimAlert(standaloneKey))) continue;

        const usd = Math.round(alert.usdValue).toLocaleString();
        const price = (parseFloat(alert.price || 0) * 100).toFixed(1);
        const gameDate = extractSlugDate(alert);
        const body = [
          `\ud83d\udd14 **WATCHED WALLET PLAY** \u2014 ${cleanTraderName(alert.traderName, alert.wallet)}`,
          `$${usd}${unitsLabel(alert.usdValue, alert.wallet)} on ${alert.sport || 'Unknown'}`,
          `Market: ${(alert.title || '').slice(0, 80)}${gameDate ? ` (${gameDate})` : ''}`,
          `Side: ${alert.outcome || '\u2014'} @ ${price}\u00a2`,
          // Own line, deliberately separate from the record/units line above -- council
          // was explicit this must never read as part of the score.
          formLabel(alert.wallet, alert.sport) ? `Form: ${formLabel(alert.wallet, alert.sport)}` : null,
        ].filter(Boolean).join('\n');

        const result = await sendDiscord(standaloneWebhook, body);
        results.discordStandalone.alerts.push({ trader: alert.traderName, title: alert.title, usd: alert.usdValue, result });
        if (result.ok) results.discordStandalone.sent++;
      }
    }

    // Send Poly alerts
    for (const alert of polyAlerts) {
      const sessionKey = `poly:${alert.transactionHash || alert.wallet + alert.title}`;
      if (!(await claimAlert(sessionKey))) continue;   // durable dedup — survives cold starts

      const usd      = Math.round(alert.usdValue).toLocaleString();
      const price    = (parseFloat(alert.price || 0) * 100).toFixed(1);
      // FIX 2026-08-29 (per Derek, real incident w/ screenshot): two bugs in one. (1)
      // categories were shown unfiltered by sport -- an NCAAF alert displayed an unrelated
      // MLB specialist tag just because the same wallet happens to also be a confirmed
      // MLB specialist. (2) SPECIALIST categories were built with rank:null always (no
      // numeric-rank concept exists for a specialist promotion, unlike a real leaderboard
      // rank), producing the literal text "#null". Now: only show a category if it's sport-
      // agnostic (no colon, e.g. a real leaderboard rank) OR matches THIS alert's own
      // sport; specialist entries show PnL context instead of a fabricated rank number.
      const rankInfo = (alert.categories || [])
        .filter(c => !c.category.includes(':') || c.category.endsWith(':' + alert.sport))
        .map(c => c.rank != null ? `${c.category} #${c.rank}` : `${c.category}${c.pnl != null ? ` ($${Math.round(c.pnl).toLocaleString()} PnL)` : ''}`)
        .join(' / ');
      // BUGFIX 2026-08-10 (per Derek): "Specialist: 96.2% of 26 settled bets" was showing
      // unconditionally, even when the name line right above it was already using OUR OWN
      // tracked record (e.g. kkookkoo's real 0-1) instead — two different numbers for the
      // same wallet in the same message, no indication which one actually counts. Same
      // tracked-first principle used everywhere else on the site, just never applied to
      // this specific line before: only show the self-reported stat when actually falling
      // back to it, not alongside a real tracked result.
      const usingTracked = getRecordFor(alert, trackedRecords)?.source === 'tracked';
      // FORMATTING OVERHAUL 2026-08-29 (per Derek, real complaint -- "poly alerts feels
      // crowded too"): same treatment as the convergence channel got moments ago. Every
      // field its own line/row instead of a stacked plain-text block.
      const alertFields = [
        { name: 'Trader', value: nameWithRecord(alert, trackedRecords), inline: false },
        { name: 'Side', value: `${alert.outcome || '—'} @ ${price}¢`, inline: true },
        { name: 'Amount', value: `$${usd}${unitsLabel(alert.usdValue, alert.wallet)}`, inline: true },
      ];
      if (rankInfo) alertFields.push({ name: 'Rank', value: rankInfo, inline: true });
      if (alert.specialistRecord && !usingTracked) alertFields.push({ name: 'Specialist Record', value: alert.specialistRecord, inline: false });
      if (alert.sportRecord) alertFields.push({ name: 'Record', value: alert.sportRecord, inline: false });
      const form = formLabel(alert.wallet, alert.sport);
      if (form) alertFields.push({ name: 'Form', value: form, inline: false });
      // FIX 2026-08-29 (per Derek, real total outage): tag was referenced inside
      // alertEmbed's title BEFORE its own const declaration further down -- a real
      // ReferenceError (TDZ violation), not a typo that happened to still run. This
      // crashed every single invocation of this endpoint outright ("Cannot access 'tag'
      // before initialization"), meaning zero Poly alerts of ANY kind have gone out
      // since this shipped, not just the standalone channel. Title names the population
      // so it's clear which cohort fired at a glance -- moved before the object that uses it.
      const tag = alert.type === 'SPEC' ? 'Specialist' : 'Whale';
      /* FIX 2026-08-29 (per Derek, real incident w/ screenshot): confirmed live -- some
         totals-market titles from Polymarket are genuinely bare ("O/U 56.5", no teams at
         all), unlike moneyline/spread markets which always carry both team names. Real
         example: NCAAF, alert.title="O/U 56.5" while eventSlug="cfb-mphs-unlv-2026-08-30"
         -- the team codes exist, just not in title. Same eventSlug convention already
         used everywhere else in this file (sport-team-team-date), so this is a real,
         reliable fallback, not a guess. Only kicks in when title lacks "vs" -- moneyline/
         spread titles that already carry both team names are left completely untouched. */
      let displayTitle = alert.title || '';
      if (!/\bvs\.?\b/i.test(displayTitle) && alert.eventSlug) {
        const parts = alert.eventSlug.split('-');
        // Drop the sport prefix and the trailing YYYY-MM-DD (3 segments) -- whatever's
        // left in the middle is the team codes, however many there are.
        if (parts.length >= 5) {
          const teams = parts.slice(1, -3).join(' vs ').toUpperCase();
          if (teams) displayTitle = `${teams}: ${displayTitle}`;
        }
      }
      const alertEmbed = {
        title: `⚡ $${usd} ${alert.sport} Poly ${tag}`,
        description: `**${displayTitle.slice(0, 80)}**${extractSlugDate(alert) ? ` (${extractSlugDate(alert)})` : ''}`,
        color: alert.type === 'SPEC' ? 0x9B6DFF : 0x40B4FF,
        fields: alertFields,
      };
      // CHANGED 2026-08-27 (per Derek): this channel replaces ntfy -- every single alert
      // that passes the existing gates now goes to its OWN Discord channel (separate from
      // the convergence channel below, which is untouched), instead of a phone push. Same
      // body that already had nameWithRecord (overall + by-sport) and unitsLabel built in
      // -- reused as-is, not reconstructed, so this can't drift from what ntfy was showing.
      // CORRECTED 2026-08-27 (per Derek, confirmed via screenshot): the earlier "fix" here
      // was a real misdiagnosis on Claude's part, not a setup mistake -- Discord's
      // "DISCORD" naming restriction only applies to the webhook's DISPLAY NAME inside
      // Discord (what it posts as), a completely separate field from the Vercel env var.
      // The Vercel variable was DISCORD_WEBHOOK_URL_ALERTS the entire time, confirmed
      // directly in the Vercel UI. Reverted back to the original name.
      const alertsWebhook = process.env.DISCORD_WEBHOOK_URL_ALERTS;
      let r = { ok: false };
      if (alertsWebhook) {
        r = await sendDiscord(alertsWebhook, null, [alertEmbed]);
      }
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
        // BUGFIX 2026-08-19 (per Derek, real incident): confirmed directly -- this had the
        // exact same bug just fixed in the contrast-line matching. Grouping by title alone
        // (not eventSlug) was DELIBERATE to keep h2h separate from totals on the same game
        // (they share one eventSlug but shouldn't net against each other) -- but the same
        // title text repeats across every day of a series, so a wallet's Tuesday bet could
        // get netted against their unrelated Wednesday bet on the same two teams. Composite
        // key (eventSlug + title) gets both right at once: h2h/totals on the SAME game stay
        // separate (different title, same eventSlug), and the SAME market on DIFFERENT days
        // now also stays separate (same title, different eventSlug) -- only a genuine same-
        // game, same-market both-sides bet nets together, which is the one case this was
        // actually meant to catch.
        const byTitleForNet = {};
        Object.values(groups).forEach(g => {
          const sample = [...g.wallets.values()][0];
          const t = (sample ? `${g.eventSlug}||${sample.title}` : g.eventSlug);
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

        // BUGFIX 2026-08-19 (per Derek, real incident): confirmed directly -- HomeRunHazard's
        // Tigers trade was genuinely pre-game when made (11:15am ET, game at 12:35pm ET), and
        // correctly passed the live-check at that point. But Discord's convergence groups are
        // built from ALREADY-STORED alerts (histAlerts, pulled from the alert log) -- once a
        // trade clears the live-check once and gets stored, nothing ever re-checks live status
        // again before Discord actually sends or updates a message. The game started in the
        // gap between storage and this later "was 2, now 3" update, and nothing caught it.
        // This re-checks live status right here, immediately before send/update, using the
        // same schedule mechanism as the main path -- with a per-run cache so repeated MLB
        // groups in the same invocation don't each trigger their own schedule fetch.
        const scheduleCache = {};
        async function isGameLiveNow(sport, sampleTrade) {
          if (!sport) return false;
          if (!scheduleCache[sport]) scheduleCache[sport] = await getSchedule(sport);
          const game = findGameForTrade(sampleTrade, scheduleCache[sport]);
          return !!(game && game.started);
        }
        // BUGFIX 2026-08-21 (per Derek, real incident): confirmed directly -- Fever/Wings
        // (Aug 20) generated a fresh "3 traders" convergence AND an upgrade message at
        // 6:45pm the NEXT day. The main poly loop's stale-date check (line ~836) only
        // ever runs once, at the moment a trade is first stored as an alert -- a trade
        // made on Aug 20, while Aug 20 was still "today", correctly passed that check at
        // the time. But this convergence logic builds groups from ALREADY-STORED alerts
        // later, and nothing re-checks whether the game's date has since become
        // yesterday's before actually sending or updating a message -- the exact same
        // class of gap the live re-check above already closes, just for date staleness
        // instead of live status.
        function isGameStaleNow(sampleTrade) {
          const slugDate = extractSlugDate(sampleTrade);
          const todayET = effectiveTodayET();
          return !!(slugDate && todayET && slugDate < todayET);
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
          if (isGameStaleNow(realBuyers[0])) continue;
          const liveNow = await isGameLiveNow(realBuyers[0].sport, realBuyers[0]);
          if (liveNow) continue;
          results.discord.scanned++;

          // CHANGED 2026-08-27 (per Derek): convergence messages had record via
          // nameWithRecord already, but never units -- only a combined dollar total.
          // Appends the same per-wallet unitsLabel already used in the standalone alert
          // body, so each trader's line reads consistently across both Discord channels.
          // FORMATTING OVERHAUL 2026-08-29 (per Derek, real complaint w/ screenshot): comma-
          // joined trader records crammed into flowing sentences were unreadable on
          // mobile. Kept as a helper here rather than joined inline -- names/lines/etc
          // all reused across the initial send, the "grew" update, and the tier-upgrade
          // alert below, so all three stay visually consistent.
          const pollyTierColor = t => t === 'ELITE' ? 0xE5A00D : t === 'STRONG' ? 0x00C896 : 0x40B4FF;
          const traderBullets = buyers => buyers.map(a =>
            `• ${nameWithRecord(a, trackedRecords)}${unitsLabel(a.usdValue, a.wallet)}`).join('\n');
          const names = realBuyers.map(a => nameWithRecord(a, trackedRecords) + unitsLabel(a.usdValue, a.wallet)).join(', ');
          const realVol = realBuyers.reduce((s, a) => s + (a.usdValue || 0), 0);
          // FEATURE 2026-08-19 (per Derek, real ambiguity): same fix as the main alert body --
          // a bare team-vs-team title gives no way to tell which game in a series this is.
          // Fixed at the source so both the initial convergence message and the upgrade
          // message (which both reuse gameTitle) get the date automatically.
          const gameDate = extractSlugDate(g);
          const gameTitle = ((slugTitle[g.eventSlug] && slugTitle[g.eventSlug].text) || g.outcome) + (gameDate ? ` (${gameDate})` : '');
          const { score, tier } = computeGroupScore({ ...g, totalVol: realVol, wallets: new Map(realBuyers.map(b => [b.wallet, b])) });
          const gfNote = gfBuyers.length
            ? `\n_Also on this side, known negative in-sport (not counted): ${gfBuyers.map(a => nameWithRecord(a, trackedRecords)).join(', ')}_`
            : '';

          let contrastLine = '';
          let oppBuyersForLean = null, oppOutcomeForLean = null;
          let oppFieldForEmbed = null; // structured version, built alongside contrastLine below -- avoids re-parsing a display string
          // FEATURE 2026-08-11 (per Derek, confirmed real case): this previously skipped
          // totals markets entirely, so an Over/Under split with real disagreement never
          // showed a contrast line at all. Matches by exact market TITLE now (not just
          // eventSlug) rather than removing the totals check outright — that's what
          // correctly limits Over to only ever matching Under on the SAME total line, and
          // stops an H2H group from ever cross-matching against an unrelated Totals group
          // just because they share a game.
          // BUGFIX 2026-08-19 (per Derek, real incident): confirmed directly -- HomeRunHazard's
          // real Aug 18 Pirates bet was showing up as the "opposing side" of today's (Aug 19)
          // Tigers convergence, because this matched by bare title text only. "Detroit Tigers
          // vs. Pittsburgh Pirates" is identical across both days of a series -- eventSlug is
          // what actually distinguishes one game from another, and it was never checked here.
          const myTitle = realBuyers[0] ? realBuyers[0].title : null;
          if (myTitle) {
            const oppKey = Object.keys(groups).find(k2 => {
              const g2 = groups[k2];
              if (g2.outcome === g.outcome || g2.wallets.size === 0) return false;
              if (g2.eventSlug !== g.eventSlug) return false;
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
              oppFieldForEmbed = { name: `Opposing: ${opp.outcome} (${oppAll.length})`, value: traderBullets(oppAll) || '—', inline: false };
            }
          }
          const leanLine = inferLean(realBuyers, g.outcome, oppBuyersForLean, oppOutcomeForLean, trackedRecords);

          const baseFields = [
            { name: 'Side', value: g.outcome, inline: true },
            { name: 'Score', value: `${score} (${tier})`, inline: true },
            { name: 'Volume', value: `$${Math.round(realVol).toLocaleString()}`, inline: true },
            { name: `Traders (${realBuyers.length})`, value: traderBullets(realBuyers) || '—', inline: false },
          ];
          if (gfBuyers.length) {
            baseFields.push({ name: 'Also on this side (not counted)', value: traderBullets(gfBuyers) + '\n_known negative in-sport_', inline: false });
          }
          if (oppFieldForEmbed) baseFields.push(oppFieldForEmbed);
          const embed = {
            title: `🎯 Poly Alignment — ${realBuyers.length} on the same side`,
            description: `**${gameTitle}**`,
            color: pollyTierColor(tier),
            fields: baseFields,
            footer: leanLine ? { text: leanLine.replace(/^\n📊 \*/, '').replace(/\*$/, '') } : undefined,
          };

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
                body: JSON.stringify({ embeds: [embed] }),
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
            const growEmbed = { ...embed, footer: { text: `Updated — was ${state.walletCount} traders, now ${realBuyers.length}` + (embed.footer ? ' · ' + embed.footer.text : '') } };
            try {
              const r = await fetch(discordWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [growEmbed] }),
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
            const upgradeFields = [
              { name: 'Side', value: g.outcome, inline: true },
              { name: 'Score', value: `${score} (${tier})`, inline: true },
              { name: 'Volume', value: `$${Math.round(realVol).toLocaleString()}`, inline: true },
              { name: `Traders (${realBuyers.length})`, value: traderBullets(realBuyers) || '—', inline: false },
            ];
            if (gfBuyers.length) upgradeFields.push({ name: 'Also on this side (not counted)', value: traderBullets(gfBuyers) + '\n_known negative in-sport_', inline: false });
            if (oppFieldForEmbed) upgradeFields.push(oppFieldForEmbed);
            const upgradeEmbed = {
              title: `🚀 Convergence Upgrade — ${state.tier || 'MODERATE'} (${state.score ?? '—'}) → ${tier} (${score})`,
              description: `**${gameTitle}**`,
              color: pollyTierColor(tier),
              fields: upgradeFields,
              footer: leanLine ? { text: leanLine.replace(/^\n📊 \*/, '').replace(/\*$/, '') } : undefined,
            };
            try {
              const r = await fetch(discordWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [upgradeEmbed] }),
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
    /* OPENED 2026-08-27 (per Derek): NCAAF Week 0 is this Saturday, NFL follows shortly.
       QUOTA NOTE -- cheaper than it looks: The Odds API does not charge for responses
       containing no odds, so polling a sport with no scheduled games costs nothing; real
       cost only starts once boards are posted. Each populated pull is markets x regions
       = 3 credits (h2h,spreads,totals), and every pull hits the existing 60-minute KV
       cache first, so repeat callers inside the hour are free. NBA/NHL deliberately left
       OFF -- genuinely out of season, turning them on would spend quota on nothing. */
    // FIX 2026-08-28 (per Derek, real API key now live): odds.js's own SPORT_KEYS has
    // always used NCAAFB, not NCAAF -- confirmed live, /api/odds?sport=NCAAF returned
    // "Unknown sport". Last night's open only worked for NFL; NCAAF has been silently
    // dead since. Corrected to match odds.js's real key.
    const ACTIVE_LINE_SPORTS = ['MLB', 'NCAAFB', 'NFL'];
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
        `Converge Score: ${si} — ${play.signalType}`,
        `Sharp Side: ${play.sharpSide}`,
        `Pinnacle: ${play.lines?.pinnacle || '—'} | Soft avg: ${play.lines?.softAvg || '—'}`,
        `Gap: +${gap}pp | Exchange confirms: ${ex}`,
        `Pillars — Pin: ${pin} | Money: ${mon} | RLM: ${play.pillars?.rlm || 35}`,
        play.pillars?.rlmIsReal ? '✓ Real line velocity data' : '⚠ RLM inferred (building baseline)',
      ].join('\n');

      // CHANGED 2026-08-28 (per Derek): Sharp Line moves to its own Discord channel,
      // replacing ntfy -- same pattern as the Poly alerts move. Reuses this exact body
      // (already renamed SI Score -> Converge Score above, matching today's site rename)
      // rather than reconstructing it, so this can't drift from what ntfy was showing.
      const sharpLineWebhook = process.env.sharp_line_alerts;
      let r = { ok: false };
      if (sharpLineWebhook) {
        const discordContent = `${title}\n${body}`;
        r = await sendDiscord(sharpLineWebhook, discordContent);
      }
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
        // TEMP DIAGNOSTIC 2026-08-27 (per Derek): direct, immediate check of whether the
        // env var is actually readable -- doesn't depend on a real trade happening or on
        // dedup state, which was blocking a clean retest after the URL got re-pasted.
        // Reports presence/shape only, never the real URL. Safe to remove once confirmed.
        webhookAlertsEnvCheck: {
          set: !!process.env.DISCORD_WEBHOOK_URL_ALERTS,
          looksLikeDiscordUrl: /^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(process.env.DISCORD_WEBHOOK_URL_ALERTS || ''),
          length: (process.env.DISCORD_WEBHOOK_URL_ALERTS || '').length,
        },
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
