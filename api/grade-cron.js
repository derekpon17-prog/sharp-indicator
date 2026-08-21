/* =========================================================
   api/grade-cron.js
   Upstash Redis — same KV_REST_API_URL / KV_REST_API_TOKEN as everything else.

   PURPOSE (per Derek, 2026-08-16 — real recurring incident): tracked records only ever
   update when Derek personally opens the Tracking tab — grading and auto-tracking are
   pure client-side JS with no background process. laozishudaosan's real Aug 15 results
   sat un-graded for days, and by the time anyone looked, the underlying alert data had
   already scrolled off the log entirely (before the retention fix landed). Formal-Cupcake
   hit the same failure mode earlier. Root cause isn't retention alone — it's that nothing
   runs this logic unless a human happens to load a specific tab.

   THIS IS STEP 1 OF A STAGED MIGRATION, not a full cutover:
     1. THIS FILE — port grading + auto-track to a cron, write to NEW KV keys
        (pm:server-sig-plays / pm:server-spec-plays). The client's own localStorage-based
        system is completely untouched — this runs in parallel, not in place of it.
     2. Run both in parallel for a real validation window, comparing outputs, before
        trusting the server version for anything.
     3. Once they agree consistently, flip the client to read from the server instead of
        generating its own copy.
     4. Wire Add Historical Play into the same server path.
   Steps 2-4 are NOT done here — this file is step 1 only.

   DELIBERATE SCOPE REDUCTIONS FOR THIS FIRST PASS (see comments below for each):
     - Whale-population tracking (buildTrendingGroups and everything under it — net-out-
       both-sides, the 40-point display filter) is NOT ported yet. Every real recurring
       failure this session (BigBob, laozishudaosan, Formal-Cupcake) was in the
       specialist/watched pathway, not whale tracking, so that's what's covered first.
     - Precise game-time matching (gameSchedule / findScheduledGame) is NOT ported —
       this uses the same bare-date fallback the client itself uses when its own
       schedule cache misses, protected by the existing 14h-delta + ambiguity safety net.
     - Live-game pre-filtering (isLiveAlert/isStaleAlert, which depend on gameSchedule
       too) is skipped — a candidate for a still-live game just stays OPEN harmlessly
       until ESPN confirms it's actually completed, which is what real grading
       correctness depends on, not the pre-filter.

   GET  → runs one grading + auto-track pass, returns a diagnostic summary.
   ========================================================= */

const SIG_KEY = 'pm:server-sig-plays';
const SPEC_KEY = 'pm:server-spec-plays';
const ALERTS_KEY = 'pm:alerts';
const WATCHED_KEY = 'pm:watched-wallets';
const POLY_AUTOTRACK_THRESHOLD = 60;
const ESPN_SPORTS = { MLB: 'baseball/mlb', NBA: 'basketball/nba', NFL: 'football/nfl', NHL: 'hockey/nhl' };

const MLB_TEAMS = ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies','padres','san francisco giants','st. louis cardinals','st louis cardinals','brewers','guardians','royals','twins','orioles','rays','blue jays','mariners','texas rangers','angels','athletics','tigers','white sox','reds','pirates','rockies','marlins','nationals','diamondbacks'];
const WNBA_TEAMS = ['fever','storm','sparks','liberty','sky','mercury','lynx','sun','mystics','wings','aces','dream','valkyries','tempo','fire'];
const NBA_TEAMS = ['hawks','celtics','nets','hornets','bulls','cavaliers','mavericks','nuggets','pistons','warriors','rockets','pacers','clippers','lakers','grizzlies','heat','bucks','timberwolves','pelicans','knicks','thunder','magic','76ers','suns','trail blazers','sacramento kings','spurs','raptors','jazz','wizards'];
const NFL_TEAMS = ['cardinals','falcons','ravens','bills','panthers','bears','bengals','browns','cowboys','broncos','lions','packers','texans','colts','jaguars','chiefs','raiders','chargers','rams','dolphins','vikings','patriots','saints','giants','jets','eagles','steelers','seahawks','49ers','buccaneers','titans','commanders'];
const NHL_TEAMS = ['ducks','bruins','sabres','flames','hurricanes','blackhawks','avalanche','blue jackets','stars','red wings','oilers','florida panthers','los angeles kings','wild','canadiens','predators','devils','islanders','new york rangers','senators','flyers','penguins','sharks','kraken','blues','lightning','maple leafs','mammoth','canucks','golden knights','capitals','winnipeg jets'];
const SOCCER_INTL = ['premier league','la liga','serie a','bundesliga','champions league','copa america','gold cup','concacaf','fa cup','nations league','world cup qualifier','man city','man united','liverpool','chelsea','arsenal','barcelona','real madrid','france vs','england vs','brazil vs','germany vs','spain vs','portugal vs','argentina vs','italy vs','netherlands vs'];
const ESPORTS = ['dota','valorant','cs2','counter-strike','league of legends','lol:','esports world cup','starcraft','overwatch','fortnite','pubg','apex legends','rainbow six','rocket league'];

async function upstash(body) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV_NOT_CONFIGURED');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

function wordBoundaryIncludes(text, term) {
  var idx = text.indexOf(term);
  while (idx !== -1) {
    var beforeOk = idx === 0 || !/[a-z0-9]/.test(text[idx - 1]);
    var afterIdx = idx + term.length;
    var afterOk = afterIdx >= text.length || !/[a-z0-9]/.test(text[afterIdx]);
    if (beforeOk && afterOk) return true;
    idx = text.indexOf(term, idx + 1);
  }
  return false;
}

// SCOPE NOTE: MLB/WNBA/NBA/NFL/NHL/Soccer/Olympics/Tennis only — NCAAF/NCAAB conference
// matching intentionally not ported for this first pass (see file header).
function detectSport(title) {
  const t = (title || '').toLowerCase();
  if (ESPORTS.some(x => t.includes(x))) return null;
  if (t.includes('mlb') || t.includes('world baseball classic') || t.includes('wbc') || MLB_TEAMS.some(x => wordBoundaryIncludes(t, x))) return 'MLB';
  if (t.includes('wnba') || WNBA_TEAMS.some(x => wordBoundaryIncludes(t, x))) return 'WNBA';
  if (t.includes('nba') || t.includes('nba finals') || NBA_TEAMS.some(x => wordBoundaryIncludes(t, x))) return 'NBA';
  if (t.includes('nfl') || t.includes('super bowl') || t.includes('afc championship') || t.includes('nfc championship') || NFL_TEAMS.some(x => wordBoundaryIncludes(t, x))) return 'NFL';
  if (t.includes('nhl') || t.includes('stanley cup') || NHL_TEAMS.some(x => wordBoundaryIncludes(t, x))) return 'NHL';
  if (t.includes('fifa world cup') || t.includes('world cup winner') || SOCCER_INTL.some(x => wordBoundaryIncludes(t, x))) return 'Soccer';
  if (t.includes('olympic') || t.includes('summer games') || t.includes('winter games')) return 'Olympics';
  if (t.includes('wimbledon') || t.includes('us open tennis') || t.includes('french open') || t.includes('australian open') || t.includes('roland garros') || (t.includes('atp ') && !t.includes('esport')) || t.includes('wta ') || t.includes('grand slam')) return 'Tennis';
  return null;
}

function extractSlugDate(a) {
  const s = (a && (a.eventSlug || a.slug)) || '';
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// SCOPE NOTE: precise-time schedule matching (findScheduledGame/gameSchedule) not
// ported yet — same bare-date fallback the client uses on its own cache-miss path.
function findGameDateForTitle(title, eventSlug) {
  if (eventSlug) { const d = extractSlugDate({ eventSlug }); if (d) return d; }
  return '';
}

function normTN(s) { return (s || '').toLowerCase().replace(/[^a-z]/g, '').trim(); }
function gMatch(hN, aN, title) {
  var t = (title || '').toLowerCase();
  var normPhrase = function (s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  var nh = normPhrase(hN), na = normPhrase(aN);
  return (nh.length > 2 && t.includes(nh)) || (na.length > 2 && t.includes(na));
}
function gGrade(play, hN, aN, hS, aS) {
  var side = (play.outcome || '').toLowerCase();
  var total = hS + aS; var scoreStr = aN + ' ' + aS + ' - ' + hS + ' ' + hN;
  if (side.includes('over') || side.includes('under')) {
    var m = (play.title || '').match(/(\d+\.?\d*)/); var line = m ? parseFloat(m[1]) : 0; if (!line) return null;
    return { status: side.includes('over') ? (total > line ? 'WIN' : total === line ? 'PUSH' : 'LOSS') : (total < line ? 'WIN' : total === line ? 'PUSH' : 'LOSS'), espnScore: scoreStr };
  }
  var sN = normTN(side.split(' ').slice(-1)[0] || side);
  var shH = normTN(hN).includes(sN) || sN.includes(normTN(hN));
  var shA = normTN(aN).includes(sN) || sN.includes(normTN(aN));
  if (!shH && !shA) return null;
  return { status: (shH ? hS > aS : aS > hS) ? 'WIN' : 'LOSS', espnScore: scoreStr };
}

function uniqueBuyerCount(group, includeGateFailed) {
  var buys = includeGateFailed ? group.buys : group.buys.filter(b => !b.gateFailed);
  return new Set(buys.map(b => (b.wallet || b.traderName || '').toLowerCase())).size;
}
function signalScore(group) {
  var realBuys = (group.buys || []).filter(b => !b.gateFailed);
  const vol = realBuys.reduce((s, b) => s + (b.usdValue || 0), 0), buyers = uniqueBuyerCount({ buys: realBuys });
  const base = vol <= 500 ? 5 : Math.min(Math.round(Math.log10(vol / 500) * 38) + 15, 90);
  let bestRank = 999;
  realBuys.forEach(b => (b.categories || []).forEach(c => { const r = parseInt(c.rank) || 999; if (r < bestRank) bestRank = r; }));
  const rm = bestRank <= 5 ? 1.6 : bestRank <= 15 ? 1.4 : bestRank <= 30 ? 1.2 : bestRank <= 75 ? 1.0 : 0.85;
  const conv = buyers >= 4 ? 28 : buyers >= 3 ? 20 : buyers >= 2 ? 12 : 0;
  const rawScore = Math.round(base * rm) + conv;
  return { score: Math.min(rawScore, 100), bestRank, rawScore };
}
function polyDisplayScore(group) {
  const r = signalScore(group);
  const capped = uniqueBuyerCount(group) < 2 ? Math.min(r.score, 84) : r.score;
  return { score: capped, bestRank: r.bestRank, rawScore: r.rawScore };
}

// BUGFIX 2026-08-21 (per Derek, real incident): confirmed directly -- third occurrence of
// the same class of bug already fixed in the client's contrast-line matching and net-out
// grouping. This key was title+outcome only, no eventSlug -- meaning a wallet's alerts
// for the same two teams across DIFFERENT days of a series (e.g. Seattle Mariners vs.
// Milwaukee Brewers played more than once) could get merged into one group, with the
// group's eventSlug silently locked to whichever alert was processed first. Downstream,
// autoTrackPlays' dedup key inherits that wrong eventSlug and can then falsely match an
// existing tracked play from a DIFFERENT day, silently skipping a genuinely new trade as
// if it were a duplicate. Confirmed real: laozishudaosan's Aug 20 Athletics/Mariners/
// Guardians trades were never tracked despite being correctly SPEC+WATCHED tagged.
function buildTrackingCandidates(alerts, windowMs, filterFn) {
  const cutoff = Date.now() - windowMs, groups = {};
  alerts.forEach(a => {
    if (!filterFn(a)) return;
    const ts = a.loggedAt || (a.timestamp * 1000);
    if (ts < cutoff) return;
    const sp = a.sport || detectSport(a.title);
    if (!sp) return;
    const key = (a.title || '') + '||' + (a.outcome || '') + '||' + (a.eventSlug || ''); if (!key || key === '||||') return;
    if (!groups[key]) groups[key] = { title: a.title || 'Unknown', outcome: a.outcome || '', eventSlug: a.eventSlug, sport: sp, buys: [], totalVol: 0 };
    groups[key].buys.push(a); groups[key].totalVol += (a.usdValue || 0);
  });
  return Object.values(groups);
}

function autoTrackPlays(groups, sigPlays, specPlays) {
  let changed = false;
  groups.forEach(g => {
    const { score, bestRank, rawScore } = polyDisplayScore(g);
    const isSpec = (g.buys || []).length > 0 && (g.buys || []).every(b => b.type === 'SPEC');
    const isWatched = (g.buys || []).length > 0 && (g.buys || []).some(b => (b.categories || []).some(c => c.category === 'WATCHED'));
    if (!isSpec && !isWatched && score < POLY_AUTOTRACK_THRESHOLD) return;
    const key = (g.title || '') + '||' + (g.outcome || '') + '||' + (g.eventSlug || '');
    const store = isSpec ? specPlays : sigPlays;
    if (store.some(p => p.key === key)) return;
    const stakes = (g.buys || []).map(b => ({ trader: b.traderName || 'Anon', wallet: b.wallet || null, usdValue: b.usdValue || 0, price: b.price || null, type: b.type || null }));
    store.unshift({ key, population: isSpec ? 'SPECIALIST' : 'WHALE', title: g.title, outcome: g.outcome, eventSlug: g.eventSlug, score, rawScore, buyers: uniqueBuyerCount(g), totalVol: g.totalVol, traders: g.buys.map(b => b.traderName || 'Anon').filter((v, i, a) => a.indexOf(v) === i).slice(0, 5), stakes, sport: g.sport || detectSport(g.title), gameTime: findGameDateForTitle(g.title, g.eventSlug), bestRank, loggedAt: Date.now(), status: 'OPEN', resolution: null, gradedBy: null });
    changed = true;
  });
  return changed;
}

async function gradeFromESPN(sigPlays, specPlays) {
  var openPlays = [...sigPlays, ...specPlays].filter(p => p.status === 'OPEN');
  if (!openPlays.length) return false;
  var sN = new Set(); openPlays.forEach(p => sN.add(p.sport || 'MLB'));
  var results = {};
  var dateSet = new Set();
  var todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  dateSet.add(todayStr);
  openPlays.forEach(p => {
    if (p.gameTime) { try { dateSet.add(new Date(p.gameTime).toISOString().slice(0, 10).replace(/-/g, '')); } catch (e) {} }
  });
  var extra = new Set();
  dateSet.forEach(d => {
    var dt = new Date(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    extra.add(dt.toISOString().slice(0, 10).replace(/-/g, ''));
  });
  extra.forEach(d => dateSet.add(d));
  var dates = [...dateSet];
  await Promise.all([...sN].map(async sp => {
    var path = ESPN_SPORTS[sp]; if (!path) return;
    var evsAll = [];
    await Promise.all(dates.map(async d => {
      try {
        var r = await fetch('https://site.api.espn.com/apis/site/v2/sports/' + path + '/scoreboard?dates=' + d);
        var j = await r.json();
        evsAll.push.apply(evsAll, (j.events || []));
      } catch (e) {}
    }));
    results[sp] = evsAll;
  }));
  var changed = false;
  function tryGrade(plays) {
    plays.forEach(play => {
      if (play.status !== 'OPEN') return;
      var evs = results[play.sport || 'MLB'] || [];
      var MAX_GRADE_DELTA_MS = 14 * 60 * 60 * 1000;
      var playTime = play.gameTime ? new Date(play.gameTime).getTime() : null;
      var best = null, bestDelta = Infinity, matchCount = 0;
      for (var i = 0; i < evs.length; i++) {
        var comp = evs[i].competitions && evs[i].competitions[0]; if (!comp || !comp.status || !comp.status.type || !comp.status.type.completed) continue;
        var home = comp.competitors.find(c => c.homeAway === 'home'); var away = comp.competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        var hN = home.team && (home.team.displayName || home.team.name) || ''; var aN = away.team && (away.team.displayName || away.team.name) || '';
        if (!gMatch(hN, aN, play.title)) continue;
        matchCount++;
        var evTime = evs[i].date ? new Date(evs[i].date).getTime() : null;
        var delta = (playTime && evTime) ? Math.abs(evTime - playTime) : 0;
        if (delta < bestDelta) { bestDelta = delta; best = { hN, aN, hs: parseFloat(home.score || 0), as: parseFloat(away.score || 0) }; }
      }
      if (!best) return;
      if (!playTime && matchCount > 1) return;
      if (playTime && bestDelta > MAX_GRADE_DELTA_MS) return;
      var res = gGrade(play, best.hN, best.aN, best.hs, best.as);
      if (res) { play.status = res.status; play.gradedAt = Date.now(); play.espnScore = res.espnScore; play.gradedBy = 'ESPN-cron'; changed = true; }
    });
  }
  tryGrade(sigPlays); tryGrade(specPlays);
  return changed;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const [sigRaw, specRaw, alertsRaw, watchedRaw] = await Promise.all([
      upstash(['GET', SIG_KEY]),
      upstash(['GET', SPEC_KEY]),
      upstash(['LRANGE', ALERTS_KEY, 0, 2000]),
      upstash(['GET', WATCHED_KEY]),
    ]);
    let sigPlays = []; try { sigPlays = sigRaw ? JSON.parse(sigRaw) : []; } catch {}
    let specPlays = []; try { specPlays = specRaw ? JSON.parse(specRaw) : []; } catch {}
    let alerts = (alertsRaw || []).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    let watched = []; try { watched = watchedRaw ? JSON.parse(watchedRaw) : []; } catch {}

    // FEATURE 2026-08-17 (per Derek): "how many units is $74,000 for Wordy-Littleneck" --
    // there's no explicit unit size on file for any wallet except Derek's own ($50),
    // unlike a wallet whose typical bet size we can only infer from their own real
    // history. Uses the MEDIAN of a trader's own past stakes as the inferred "1 unit"
    // baseline -- median specifically because it's resistant to a few huge outlier bets
    // skewing the number the way a mean would, which matters given real bettors often
    // have a handful of much-larger high-conviction plays mixed into mostly-standard-size
    // activity. ?unitsFor=NAME (optionally &amount=74000 for a specific bet) runs this
    // lookup directly against the same play data already being tracked, without running
    // a full grading pass -- this is read-only, no ESPN calls, no KV writes.
    // FEATURE 2026-08-17 (per Derek): the site needs to show this next to every play by
    // every trader, not just one lookup at a time -- computing per-trader on demand would
    // mean dozens of round-trips for a single page render. This returns every trader's
    // inferred unit size in one call, so the client fetches once and reuses it everywhere.
    // MIN_SAMPLE_FOR_UNITS=15: below this, a "unit size" is more likely noise from a
    // handful of data points than a real read on a trader's typical bet size -- Derek's
    // own call on where that line sits, not a fixed convention Claude invented.
    // DIAGNOSTIC 2026-08-17 (per Derek): "is this wallet broken or just not betting" --
    // fetches directly from Polymarket's own API (ground truth, independent of anything
    // in our own pipeline) so quiet-vs-broken can actually be told apart with evidence
    // instead of guessed. ?checkWallet=0x... (redeploy-trigger 2026-08-18)
    if (req.query && req.query.checkWallet) {
      try {
        // BUGFIX 2026-08-19 (per Derek): "most recent trade" alone conflated a wallet's
        // most recent trade OVERALL with their most recent trade in the SPECIFIC sport
        // being asked about -- confirmed real gap, laozishudaosan's recent activity was
        // mostly soccer, so his true most-recent MLB trade could be meaningfully older
        // than his most-recent trade shown. Fetches a larger sample (50, not 10) and
        // reports the most recent trade PER SPORT, using the same detectSport already
        // used everywhere else in this file.
        const wr = await fetch(`https://data-api.polymarket.com/trades?user=${req.query.checkWallet}&side=BUY&takerOnly=true&limit=50`);
        const trades = await wr.json();
        const inAlerts = alerts.filter(a => (a.wallet || '').toLowerCase() === String(req.query.checkWallet).toLowerCase());
        const bySport = {};
        if (Array.isArray(trades)) {
          trades.forEach(t => {
            const sp = detectSport(t.title) || 'Other/Unrecognized';
            if (!bySport[sp] || t.timestamp > bySport[sp].timestamp) {
              bySport[sp] = { timestamp: t.timestamp, title: t.title };
            }
          });
        }
        // FEATURE 2026-08-19 (per Derek): "let all his plays come in and track by sport"
        // -- before building anything new, check whether the existing watched-wallet
        // bypass (already sport-agnostic by design) is already handling this. Shows what
        // our own tracked plays actually contain for this wallet, broken out by sport, so
        // this can be confirmed with evidence instead of assumed either way.
        const trackedForWallet = [...sigPlays, ...specPlays].filter(p =>
          (p.stakes || []).some(s => (s.wallet || '').toLowerCase() === String(req.query.checkWallet).toLowerCase())
        );
        const trackedBySport = {};
        trackedForWallet.forEach(p => {
          const sp = p.sport || 'Unknown';
          if (!trackedBySport[sp]) trackedBySport[sp] = { open: 0, win: 0, loss: 0, push: 0 };
          if (p.status === 'OPEN') trackedBySport[sp].open++;
          else if (p.status === 'WIN') trackedBySport[sp].win++;
          else if (p.status === 'LOSS') trackedBySport[sp].loss++;
          else if (p.status === 'PUSH') trackedBySport[sp].push++;
        });
        return res.status(200).json({
          ok: true,
          wallet: req.query.checkWallet,
          totalTradesFetched: Array.isArray(trades) ? trades.length : 0,
          mostRecentTradeTimestamp: Array.isArray(trades) && trades[0] ? trades[0].timestamp : null,
          mostRecentTradeBySport: bySport,
          inOurAlertLog: inAlerts.length,
          ourTrackedPlaysBySport: trackedBySport,
        });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }

    if (req.query && req.query.allUnits) {
      const MIN_SAMPLE_FOR_UNITS = 15;
      const byTrader = {};
      [...sigPlays, ...specPlays].forEach(p => {
        (p.stakes || []).forEach(s => {
          const key = s.wallet || s.trader;
          if (!key) return;
          if (!byTrader[key]) byTrader[key] = { name: s.trader, stakes: [] };
          byTrader[key].stakes.push(s.usdValue || 0);
        });
      });
      const result = {};
      Object.keys(byTrader).forEach(key => {
        const entry = byTrader[key];
        if (entry.stakes.length < MIN_SAMPLE_FOR_UNITS) return;
        const sorted = [...entry.stakes].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        result[key] = { name: entry.name, sampleSize: entry.stakes.length, inferredUnitSize: Math.round(median) };
      });
      return res.status(200).json({ ok: true, minSample: MIN_SAMPLE_FOR_UNITS, traderCount: Object.keys(result).length, units: result });
    }

    if (req.query && req.query.unitsFor) {
      const target = String(req.query.unitsFor).toLowerCase();
      const amount = req.query.amount ? parseFloat(req.query.amount) : null;
      const allStakes = [];
      [...sigPlays, ...specPlays].forEach(p => {
        (p.stakes || []).forEach(s => {
          if ((s.trader || '').toLowerCase() === target || (s.wallet || '').toLowerCase() === target) {
            allStakes.push(s.usdValue || 0);
          }
        });
      });
      if (!allStakes.length) {
        return res.status(200).json({ ok: true, trader: req.query.unitsFor, found: false, note: 'No tracked stakes found for this name/wallet yet in server-side data.' });
      }
      const sorted = [...allStakes].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const result = {
        ok: true, trader: req.query.unitsFor, found: true,
        sampleSize: allStakes.length,
        inferredUnitSize: Math.round(median),
        minStake: Math.round(Math.min(...allStakes)),
        maxStake: Math.round(Math.max(...allStakes)),
      };
      if (amount) result.impliedUnits = Math.round((amount / median) * 10) / 10;
      return res.status(200).json(result);
    }

    const watchedWalletSet = new Set(watched.map(w => w.wallet));
    // Tag alerts from watched wallets the same way the notify cron does, so the
    // isWatched check in autoTrackPlays works identically to the client/server alert path.
    alerts.forEach(a => {
      if (a.wallet && watchedWalletSet.has(a.wallet) && !(a.categories || []).some(c => c.category === 'WATCHED')) {
        a.categories = [...(a.categories || []), { category: 'WATCHED', rank: null, pnl: null }];
      }
    });

    const specCandidates = buildTrackingCandidates(alerts, 24 * 60 * 60 * 1000, a => a.type === 'SPEC');
    const watchedCandidates = buildTrackingCandidates(alerts, 7 * 24 * 60 * 60 * 1000, a => (a.categories || []).some(c => c.category === 'WATCHED'));

    const trackedNew1 = autoTrackPlays(specCandidates, sigPlays, specPlays);
    const trackedNew2 = autoTrackPlays(watchedCandidates, sigPlays, specPlays);
    const graded = await gradeFromESPN(sigPlays, specPlays);

    if (trackedNew1 || trackedNew2 || graded) {
      await Promise.all([
        upstash(['SET', SIG_KEY, JSON.stringify(sigPlays)]),
        upstash(['SET', SPEC_KEY, JSON.stringify(specPlays)]),
      ]);
    }

    return res.status(200).json({
      ok: true,
      step: '1 of 4 — parallel server-side tracking, not yet authoritative',
      alertsScanned: alerts.length,
      watchedWallets: watched.length,
      specCandidates: specCandidates.length,
      watchedCandidates: watchedCandidates.length,
      newlyTracked: trackedNew1 || trackedNew2,
      graded,
      sigPlaysTotal: sigPlays.length,
      specPlaysTotal: specPlays.length,
      sigPlaysOpen: sigPlays.filter(p => p.status === 'OPEN').length,
      specPlaysOpen: specPlays.filter(p => p.status === 'OPEN').length,
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
};
