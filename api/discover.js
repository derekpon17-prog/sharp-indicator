/* ─── BOTTOM-UP WALLET DISCOVERY ──────────────────────────────────────
   WHY THIS EXISTS. The Polymarket leaderboard is capped at 50 rows per board, and both
   boards rank ALL-TIME PnL across every market the platform runs — politics, crypto,
   soccer, sports pooled together. Being on it proves you made money SOMEWHERE. It says
   nothing about whether you can pick a baseball game. RN1 sits at rank 25 with $1.26M
   lifetime and a real MLB record of +$2,108 over 98 markets — about $21 a market, which
   is a market-maker's spread, not a handicapper's edge. Meanwhile a trader up $80K on
   baseball specifically, who never cracked the all-time top 50, is invisible.

   So stop asking Polymarket who is rich and start measuring who is good AT A SPORT.

   HOW. The global trade feed (no user= param) is a live cross-wallet stream, and it
   accepts a server-side cash filter, so large trades arrive pre-narrowed at no extra cost.
   Harvest wallets from it, evaluate each through trader-stats (which now samples
   chronologically and nets both sides of a market), and promote the ones that are
   net-positive IN THAT SPORT over a real sample.

   CUMULATIVE, NOT EXHAUSTIVE. The feed moves fast — five rows spanned a single second in
   testing — so no single run sees everything. That is fine: a wallet that bets regularly
   surfaces within a few runs, and MIN_SIGHTINGS deliberately requires repeat appearances
   before we spend an evaluation on anyone. One-off tourists never get looked at.

   PER SPORT, DELIBERATELY. A roster is kept per league because skill does not transfer —
   treating an NHL winner as an MLB authority is the exact flaw in the current approach. */

const DATA_API = 'https://data-api.polymarket.com';
const traderStats = require('./trader-stats.js');
const kalshi = require('./kalshi.js');

// Mirrors the whitelist in polymarket-notify.js and trader-stats.js.
const LEAGUE_BY_SLUG = {
  mlb: 'MLB', nfl: 'NFL', nhl: 'NHL', nba: 'NBA', wnba: 'WNBA',
  ncaaf: 'NCAAF', ncaafb: 'NCAAF', cfb: 'NCAAF',
  ncaab: 'NCAAB', ncaamb: 'NCAAB', ncaawb: 'NCAAB', cbb: 'NCAAB',
};

const MIN_TRADE_USD  = 500;   // server-side filter — only bets worth noticing
const FEED_LIMIT     = 500;   // rows per harvest
const MIN_SIGHTINGS  = 3;     // repeat appearances before we spend an evaluation
const EVALS_PER_RUN  = 5;     // cap work per invocation; Vercel timeout is the constraint
const MIN_SAMPLE     = 20;    // graded markets in-sport before a verdict means anything
const MAX_HEDGE_PCT  = 60;    // above this the wallet is market-making, not handicapping
/* PRICE-SELECTION GUARDS (provisional — calibrate at the Aug 1 review).
   Discovery's first roster surfaced `comon119` at a 99.1% win rate over 109 markets. That
   is not skill, it is buying near-certainties at 0.97-0.99, where the price already
   guarantees the win rate. Such a wallet passes every other test — profitable, big sample,
   1% hedged — while carrying no information about which side is right, and following it
   means 1-3% returns against catastrophic tail risk.
   Two guards. A hard cap on average entry price catches favourite-scalping outright. And
   the real measure: EDGE OVER IMPLIED. The price is the market's probability, so beating
   it is the only thing that constitutes a read. Counterintuitively this ranks a 54% wallet
   above a 99% one — which is correct, and is why the guard is needed. */
const MAX_AVG_ENTRY  = 0.80;  // above this the wallet is buying favourites, not handicapping
const MIN_EDGE_PP    = 2.0;   // win rate must beat its own average entry price by this much
/* ROI IS THE PRIMARY GATE.
   Win rate is distorted in both directions and neither distortion is rare. A disciplined
   underdog bettor winning 40% at +200 is genuinely profitable and every win-rate metric
   penalises them. A favourite-farmer winning 98% at 0.97 is nearly break-even and every
   win-rate metric crowns them. ROI ranks those correctly and cannot be gamed by bet
   selection: profit over dollars actually staked, computed on the same settled legs the
   win rate uses, so no count/dollar weighting mismatch can inflate it.
   PROVISIONAL — calibrate at the Aug 1 review once the roster has real distribution. */
const MIN_ROI_PCT    = 4.0;   // below this it is churn or coin-flipping, not an edge
const MAX_ENTRY_SKEW = 0.15;  // count- vs dollar-weighted entry gap that signals farming
const CAND_TTL       = 604800;   // 7d — candidates decay if they stop appearing
const ROSTER_TTL     = 2592000;  // 30d — roster is re-confirmed by ongoing evaluation

async function kv(body) {
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
/* NICKNAMES 2026-08-27 (per Derek): historical-pipeline promotions were writing
   name: null, so a newly promoted NCAAF/NFL wallet shows as a raw 0x address until it
   happens to trigger an alert (polymarket-notify assigns nicknames lazily at alert time).
   This assigns one AT PROMOTION instead. Deliberately reuses the exact same KV key format
   ('nickname:'+wallet) and the same atomic 'nickname:counter' INCR as polymarket-notify's
   getWalletNickname -- so a wallet keeps ONE name everywhere, and the collision-free
   guarantee still holds across both callers. NOT a second naming system: if notify already
   named this wallet, the GET below returns that existing name unchanged. Pool is
   intentionally duplicated rather than imported to avoid a circular require between these
   two modules; if the pool ever changes, change it in both (noted in both files). */
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
async function assignNickname(wallet) {
  const key = 'nickname:' + wallet;
  try {
    const existing = await kv(['GET', key]);
    if (existing.ok && existing.result) return existing.result;   // already named -- keep it
  } catch {}
  let idx = 0;
  try {
    const inc = await kv(['INCR', 'nickname:counter']);
    idx = (typeof inc.result === 'number' ? inc.result : parseInt(inc.result) || 1) - 1;
  } catch {}
  const cycle = Math.floor(idx / NICKNAME_POOL.length);
  const name = NICKNAME_POOL[idx % NICKNAME_POOL.length] + (cycle > 0 ? cycle + 1 : '');
  try { await kv(['SET', key, name]); } catch {}
  return name;
}
async function kvGetJson(key) {
  const r = await kv(['GET', key]);
  if (!r.ok || !r.result) return null;
  try { return typeof r.result === 'string' ? JSON.parse(r.result) : r.result; } catch { return null; }
}
async function kvSetJson(key, val, ttl) {
  return kv(['SET', key, JSON.stringify(val), 'EX', String(ttl)]);
}

function sportOfTrade(t) {
  const slug = String((t && (t.slug || t.eventSlug)) || '').toLowerCase();
  const prefix = slug.split('-')[0];
  return prefix ? (LEAGUE_BY_SLUG[prefix] || null) : null;
}

/* Harvest one page of the global feed. side=BUY because a SELL is an exit, not an
   opinion; takerOnly because a resting maker order is liquidity provision. */
async function harvest() {
  const url = `${DATA_API}/trades?limit=${FEED_LIMIT}&takerOnly=true&side=BUY`
            + `&filterType=CASH&filterAmount=${MIN_TRADE_USD}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: 'http ' + r.status, trades: [] };
    const d = await r.json();
    return { ok: Array.isArray(d), error: null, trades: Array.isArray(d) ? d : [] };
  } catch (e) {
    return { ok: false, error: e.message, trades: [] };
  }
}

/* Fold a harvest into the candidate ledger, keyed wallet+sport. Sightings accumulate
   across runs, which is what makes a fast-moving feed usable. */
function foldCandidates(trades, cands, now) {
  let seenSports = {}, added = 0, skippedSport = 0;
  trades.forEach(t => {
    const sport = sportOfTrade(t);
    if (!sport) { skippedSport++; return; }
    const wallet = t.proxyWallet;
    if (!wallet) return;
    const usd = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
    if (usd < MIN_TRADE_USD) return;   // belt and braces if the server filter is ignored
    seenSports[sport] = (seenSports[sport] || 0) + 1;
    const key = wallet + '|' + sport;
    const c = cands[key];
    if (!c) {
      cands[key] = { wallet, sport, name: t.name || null, sightings: 1,
                     firstSeen: now, lastSeen: now, totalUsd: Math.round(usd) };
      added++;
    } else {
      c.sightings++;
      c.lastSeen = now;
      c.totalUsd = Math.round((c.totalUsd || 0) + usd);
      if (!c.name && t.name) c.name = t.name;
    }
  });
  return { seenSports, added, skippedSport };
}

/* Evaluate one candidate. Returns a verdict plus the evidence behind it, so a roster
   entry can always explain itself rather than being an opaque allow-list. */
async function evaluateCandidate(c, opts) {
  /* FORCE MUST PROPAGATE.
     discover's force=1 bypassed its own 24h evaluation guard but still let trader-stats
     serve from ITS 24h cache, so a wallet cached before a metric existed was re-judged
     against the old object. Observed exactly that: torta.tech came back with no roiPct,
     the ROI gate silently skipped (hasPx(undefined) === false), it fell through to the
     weaker edgePP check, and it survived a purge that removed 18 others. A forced re-score
     has to be forced all the way down or it is not a re-score. */
  const stats = await traderStats.getTraderStats(c.wallet, { fresh: !!(opts && opts.fresh) });
  if (!stats || !stats.ok) return { verdict: 'unknown', reason: 'stats unavailable' };
  if (stats.sampleBiased) return { verdict: 'unknown', reason: stats.biasReason || 'sample biased' };

  const b = stats.bySport && stats.bySport[c.sport];
  if (!b) return { verdict: 'reject', reason: 'no graded ' + c.sport + ' markets' };
  if (b.positions < MIN_SAMPLE) {
    return { verdict: 'pending', reason: b.positions + '/' + MIN_SAMPLE + ' ' + c.sport + ' markets',
             sample: b.positions };
  }
  // Hedge ratio separates handicappers from market makers. A wallet holding both sides of
  // most markets profits from spread regardless of who wins — real, but not a read.
  const hedgePct = stats.rawPositions
    ? Math.round(((stats.hedgedMarkets || 0) / Math.max(1, stats.positions)) * 100) : 0;
  if (hedgePct > MAX_HEDGE_PCT) {
    return { verdict: 'reject', reason: hedgePct + '% of markets hedged — market making, not handicapping',
             sample: b.positions, hedgePct };
  }
  if (b.pnl <= 0) {
    return { verdict: 'reject', reason: c.sport + ' $' + Math.round(b.pnl).toLocaleString()
             + ' over ' + b.positions + ' markets', sample: b.positions, pnl: b.pnl, hedgePct };
  }
  // Price selection. Carried on every verdict so the numbers are visible even when passing.
  const px = { avgEntry: b.avgEntry, impliedWinRate: b.impliedWinRate, edgePP: b.edgePP,
               resolvedWinRate: b.resolvedWinRate, settled: b.settled, unsettled: b.unsettled,
               roiPct: b.roiPct, staked: b.staked, settledPnl: b.settledPnl,
               pnlPerMarket: b.pnlPerMarket, avgEntryByCount: b.avgEntryByCount, entrySkew: b.entrySkew };
  const hasPx = (v) => typeof v === 'number' && isFinite(v);
  if (hasPx(b.avgEntry) && b.avgEntry > MAX_AVG_ENTRY) {
    return { verdict: 'reject', sample: b.positions, pnl: b.pnl, winRate: b.winRate, hedgePct, ...px,
      reason: 'avg entry ' + b.avgEntry + ' — buying favourites, not handicapping'
              + (hasPx(b.winRate) ? ' (' + b.winRate + '% wins vs ' + b.impliedWinRate + '% implied)' : '') };
  }
  // A verdict needs SETTLED bets. Positions exited before the market resolved say nothing
  // about whether the pick was right, so they cannot support a promotion.
  if (!hasPx(b.settled) || b.settled < MIN_SAMPLE) {
    return { verdict: 'pending', sample: b.positions, settled: b.settled || 0, hedgePct, ...px,
      reason: (b.settled || 0) + '/' + MIN_SAMPLE + ' SETTLED ' + c.sport + ' markets ('
              + b.positions + ' total, rest exited pre-settlement)' };
  }
  /* ROI FIRST. This is the gate that answers "is this wallet actually making money on the
     money it risks", which is the only question that matters and the one win rate keeps
     getting wrong in both directions. */
  /* MISSING ROI IS NOT A PASS. When the metric is absent the wallet cannot be judged under
     the current rules, so it returns to pending rather than falling through to the weaker
     checks below — which is exactly how a stale cached wallet survived a purge. */
  if (!hasPx(b.roiPct)) {
    return { verdict: 'pending', sample: b.positions, settled: b.settled, hedgePct, ...px,
      reason: 'ROI unavailable — stats predate current metrics, re-fetch required' };
  }
  /* A FLAWLESS RECORD IS A DATA PROBLEM, NOT A TRADER.
     Nobody resolves 100% of settled bets at fair prices. When it appears it means the
     fetch was truncated and we are looking at the head of an ordering, not a history.
     Observed: torta.tech at 36-for-36 with 74% ROI, promoted, alerting. */
  if (hasPx(b.resolvedWinRate) && b.resolvedWinRate >= 100) {
    return { verdict: 'unknown', sample: b.positions, settled: b.settled, hedgePct, ...px,
      reason: '100% of ' + b.settled + ' settled bets won — truncated or unrepresentative sample' };
  }
  if (b.roiPct < MIN_ROI_PCT) {
    return { verdict: 'reject', sample: b.positions, settled: b.settled, pnl: b.pnl,
      winRate: b.resolvedWinRate, hedgePct, ...px,
      reason: 'ROI ' + b.roiPct + '% on $' + Math.round(b.staked || 0).toLocaleString()
              + ' staked — not an edge'
              + (hasPx(b.resolvedWinRate) ? ' (despite ' + b.resolvedWinRate + '% wins)' : '') };
  }
  /* ENTRY SKEW. Win rate counts markets equally while entry price is dollar-weighted, so a
     wallet farming many tiny 0.97 near-certainties alongside a few large mid-priced bets
     shows ~98% wins against a ~0.60 "average" entry. A large positive skew means those two
     numbers describe different populations and the win-rate evidence is not trustworthy. */
  if (hasPx(b.entrySkew) && b.entrySkew > MAX_ENTRY_SKEW) {
    return { verdict: 'reject', sample: b.positions, settled: b.settled, pnl: b.pnl,
      winRate: b.resolvedWinRate, hedgePct, ...px,
      reason: 'entry skew ' + b.entrySkew + ' — typical bet at ' + b.avgEntryByCount
              + ' but dollars at ' + b.avgEntry + ', win rate reflects small favourites' };
  }
  // edgePP is now ADVISORY: informative when the populations line up, misleading when they
  // do not, so it only rejects once ROI and skew have already passed.
  if (hasPx(b.edgePP) && b.edgePP < MIN_EDGE_PP) {
    return { verdict: 'reject', sample: b.positions, settled: b.settled, pnl: b.pnl,
      winRate: b.resolvedWinRate, hedgePct, ...px,
      reason: 'no edge over price — ' + b.resolvedWinRate + '% of ' + b.settled
              + ' settled bets won vs ' + b.impliedWinRate + '% implied ('
              + (b.edgePP >= 0 ? '+' : '') + b.edgePP + 'pp)' };
  }
  return {
    verdict: 'promote', sample: b.positions, pnl: b.pnl, winRate: b.winRate, hedgePct, ...px,
    // Guarded: a fixture (or a schema change) without price data must not render
    // "undefined% implied (undefinedpp)" — the same defect caught once already.
    reason: c.sport + ' ' + (hasPx(b.roiPct) ? b.roiPct + '% ROI on $'
              + Math.round(b.staked || 0).toLocaleString() + ' staked' : '+$' + Math.round(b.pnl).toLocaleString())
            + ' \u00b7 '
            + (hasPx(b.resolvedWinRate) ? b.resolvedWinRate + '% of ' + b.settled + ' settled bets won' : b.settled + ' settled bets')
            + (hasPx(b.impliedWinRate) && hasPx(b.edgePP)
               ? ' vs ' + b.impliedWinRate + '% implied (' + (b.edgePP >= 0 ? '+' : '') + b.edgePP + 'pp)'
               : ''),
  };
}

async function runDiscovery(opts) {
  const now = Date.now();
  const limitEvals = (opts && opts.evals !== undefined) ? opts.evals : EVALS_PER_RUN;
  /* FORCE RE-EVALUATION.
     Roster entries were shielded by a 24h freshness guard, so three wallets promoted
     BEFORE the price and settlement filters existed could never be re-examined and simply
     stayed on the roster with stale, weaker evidence. Raising the eval cap did not help —
     it lifts the ceiling, not the guard. force=1 bypasses it so a rule change can be
     applied retroactively to everyone already on the list. */
  const force = !!(opts && opts.force);

  const h = await harvest();
  const cands = (await kvGetJson('discover:candidates')) || {};
  const roster = (await kvGetJson('discover:roster')) || {};

  const fold = foldCandidates(h.trades, cands, now);

  // Drop candidates that have gone quiet, so the ledger reflects who is active now.
  Object.keys(cands).forEach(k => {
    if (now - (cands[k].lastSeen || 0) > CAND_TTL * 1000) delete cands[k];
  });

  /* Evaluation queue: enough sightings to be worth the call, not evaluated recently, and
     roster members re-checked on the same footing so a decayed edge gets demoted. */
  // COUNCIL DECISION 2026-08-13 (per Derek): confirmed directly — NFL trades ARE flowing
  // through the harvest correctly (8 seen in a single run), but new candidates were
  // sorted purely by trade volume, with no sport-awareness. A sport with months of MLB
  // history permanently outcompetes a brand-new sport's candidates on raw dollar volume
  // alone, so NFL (and NCAAF/NCAAB/NBA/NHL as each comes online) would never surface in
  // reasonable time behind a 742-deep, MLB-heavy backlog.
  //
  // REVISITED 2026-08-13 (per Derek, real weekend timing): roster re-verification was
  // still unlimited and always went first — with 20 MLB roster members, several being due
  // for re-check on the same run could consume the entire 5-slot budget before a single
  // new candidate (NFL or otherwise) ever got evaluated. Confirmed real risk, not
  // hypothetical, since it's exactly the mechanism that was starving new-candidate
  // discovery. Fix keeps the safety net (a decayed roster entry can't silently keep
  // firing alerts on stale evidence — that's the documented hypoxia1 incident, still a
  // real risk to guard against) but CAPS how much of the budget it can consume, so most
  // of every run's capacity goes to new-candidate discovery regardless of roster size.
  // sportFocus is optional and opt-in — pass ?sportFocus=NFL to point the remaining
  // budget at a specific sport ahead of the generic under-coverage heuristic, for a
  // weekend where catching new activity in one sport specifically matters most.
  const MAX_ROSTER_REVERIFY_PER_RUN = 2;
  const sportFocus = opts && opts.sportFocus ? String(opts.sportFocus).toUpperCase() : null;

  const rosterCountBySport = {};
  Object.values(roster).forEach(r => { rosterCountBySport[r.sport] = (rosterCountBySport[r.sport] || 0) + 1; });

  const eligible = Object.keys(cands)
    .map(k => cands[k])
    .filter(c => c.sightings >= MIN_SIGHTINGS)
    .filter(c => force || !c.lastEval || (now - c.lastEval) > 86400000);

  const rosterCands = eligible.filter(c => roster[c.wallet + '|' + c.sport]);
  const newCands = eligible.filter(c => !roster[c.wallet + '|' + c.sport]);

  /* ROSTER MEMBERS FIRST, BUT CAPPED.
     Highest-volume roster members re-verify first within that capped slice — the biggest
     positions matter most if something has decayed. hypoxia1 kept alerting on pre-ROI
     evidence across three forced runs before this safety net existed at all; the cap
     keeps the net without letting it eat the whole budget. */
  rosterCands.sort((a, b) => (b.totalUsd || 0) - (a.totalUsd || 0));
  const rosterSlice = rosterCands.slice(0, MAX_ROSTER_REVERIFY_PER_RUN);

  newCands.sort((a, b) => {
    if (sportFocus) {
      const af = a.sport === sportFocus ? 1 : 0;
      const bf = b.sport === sportFocus ? 1 : 0;
      if (af !== bf) return bf - af;
    }
    const aCoverage = rosterCountBySport[a.sport] || 0;
    const bCoverage = rosterCountBySport[b.sport] || 0;
    if (aCoverage !== bCoverage) return aCoverage - bCoverage;
    return (b.totalUsd || 0) - (a.totalUsd || 0);
  });
  const remainingBudget = Math.max(0, limitEvals - rosterSlice.length);
  const queue = [...rosterSlice, ...newCands.slice(0, remainingBudget)];

  /* TIME BUDGET.
     Each evaluation can cost up to MAX_PAGES sequential upstream fetches, so a forced run
     over 25 wallets is ~400 calls in one request — past the Vercel timeout and into
     rate-limit territory, which is what produced the wall of 'stats unavailable'. Stop
     cleanly before that and let the next cycle continue; discovery is cumulative by
     design, so a partial pass costs nothing but time. */
  const BUDGET_MS = 20000;
  const startedAt = Date.now();
  let budgetHit = false;

  const evaluated = [];
  for (const c of queue) {
    if (Date.now() - startedAt > BUDGET_MS) { budgetHit = true; break; }
    const v = await evaluateCandidate(c, { fresh: force });
    c.lastEval = now;
    c.lastVerdict = v.verdict;
    c.lastReason = v.reason;
    const rk = c.wallet + '|' + c.sport;
    if (v.verdict === 'promote') {
      const prev = roster[rk];
      /* SAMPLE COLLAPSE GUARD.
         A roster entry re-scored on a fraction of its previous sample is a data-quality
         event, not a performance change: 0x3dfb153c went from 425 settled bets at 14.5%
         ROI to 45 at 80.8% within an hour, because rate limiting cut pagination to one
         page. Re-scoring on the truncated set would overwrite good evidence with noise and
         inflate every number. Keep the existing entry and retry next cycle. */
      if (prev && prev.sample && v.sample && v.sample < prev.sample * 0.5) {
        c.lastVerdict = 'unknown';
        c.lastReason = 'sample collapsed ' + prev.sample + ' -> ' + v.sample + ' (likely truncated fetch)';
        c.lastEval = 0;
        evaluated.push({ wallet: c.wallet.slice(0, 10), sport: c.sport, verdict: 'unknown',
          reason: c.lastReason, sample: v.sample, priorSample: prev.sample });
        continue;
      }
      roster[rk] = { wallet: c.wallet, sport: c.sport, name: c.name || null,
                     pnl: v.pnl, sample: v.sample, winRate: v.winRate, hedgePct: v.hedgePct,
                     avgEntry: v.avgEntry, impliedWinRate: v.impliedWinRate, edgePP: v.edgePP,
                     roiPct: v.roiPct, staked: v.staked, pnlPerMarket: v.pnlPerMarket,
                     avgEntryByCount: v.avgEntryByCount, entrySkew: v.entrySkew,
                     reason: v.reason, addedAt: prev ? prev.addedAt : now, confirmedAt: now };
    } else if (v.verdict === 'unknown') {
      /* UNKNOWN IS NOT EVIDENCE.
         'stats unavailable' means the upstream fetch failed — a rate limit, a timeout, a
         bad gateway. It says nothing about the wallet. Demoting on it makes roster
         membership a function of API availability rather than performance, and a forced
         run that trips rate limits would wipe good wallets wholesale. Observed exactly
         that: 11 of 25 evaluations came back unknown and took canoflanagan off the roster
         for reasons that had nothing to do with its record. Leave the entry alone and
         re-check next cycle. */
      c.lastEval = 0;   // clear so it is retried promptly rather than waiting 24h
    } else if (roster[rk]) {
      /* DEMOTE ON ANY EVIDENCE-BASED NON-PROMOTION.
         Previously only an explicit 'reject' removed an entry, so a wallet that became
         UNVERIFIABLE — verdict 'pending' or 'unknown' — kept its old score and kept firing
         alerts on evidence the current rules can no longer confirm. Ten entries survived a
         forced re-evaluation that way. A roster place has to be continuously earned: if we
         cannot verify it today, it comes off and can return when it re-qualifies. */
      delete roster[rk];
    }
    evaluated.push({ wallet: c.wallet.slice(0, 10), sport: c.sport, ...v });
  }

  await kvSetJson('discover:candidates', cands, CAND_TTL);
  await kvSetJson('discover:roster', roster, ROSTER_TTL);

  const bySport = {};
  Object.keys(roster).forEach(k => {
    const e = roster[k];
    (bySport[e.sport] = bySport[e.sport] || []).push(e);
  });
  // Ranked by EDGE, not profit: raw PnL rewards bankroll size, edge rewards being right.
  // Ranked by ROI, not profit and not win rate — the only one of the three that a wallet
  // cannot inflate through bet selection.
  Object.keys(bySport).forEach(s => bySport[s].sort((a, b) => (b.roiPct || 0) - (a.roiPct || 0)));

  return {
    ok: h.ok, harvestError: h.error,
    harvested: h.trades.length,
    inScope: Object.values(fold.seenSports).reduce((a, b) => a + b, 0),
    bySportSeen: fold.seenSports,
    outOfScope: fold.skippedSport,
    newCandidates: fold.added,
    totalCandidates: Object.keys(cands).length,
    readyToEvaluate: Object.keys(cands).filter(k => cands[k].sightings >= MIN_SIGHTINGS).length,
    evaluated,
    forced: force,
    budgetHit,
    queued: queue.length,
    rosterInQueue: queue.filter(c => !!roster[c.wallet + '|' + c.sport]).length,
    rosterUnverified: Object.keys(roster).filter(k => roster[k].roiPct === undefined).length,
    demoted: evaluated.filter(e => e.verdict === 'reject' || e.verdict === 'pending').length,
    unknown: evaluated.filter(e => e.verdict === 'unknown').length,
    rosterSize: Object.keys(roster).length,
    roster: bySport,
  };
}

/* Consumed by the notify bot: discovered wallets for a sport, merged with the
   leaderboard set rather than replacing it. */
async function getRoster(sport) {
  const roster = (await kvGetJson('discover:roster')) || {};
  return Object.keys(roster)
    .map(k => roster[k])
    .filter(e => !sport || e.sport === sport);
}

// FEATURE 2026-08-19 (per Derek): "wallets that were profitable last year but don't have
// current activity yet" -- pulls candidates from LAST SEASON's actual events (via
// Polymarket's own /series endpoint, confirmed real: NFL=1, NBA=2, MLB=3) instead of
// waiting for current-season activity to surface them the normal way. Two phases, both
// resumable across calls via KV-tracked progress, since a full season is too much for one
// serverless invocation:
//   Phase 1 (harvesting): page through last season's closed events, fetch trades for each,
//     collect every unique wallet that participated.
//   Phase 2 (evaluating): run each newly-found wallet through the exact same
//     evaluateCandidate() gate normal discovery uses -- same standards, same promotion
//     path, same roster. This isn't a separate, looser bar.
// Confirmed via Polymarket's own /series endpoint directly (not guessed) --
// NFL/NBA/MLB from their docs example, NHL/NCAAF/NCAAB confirmed live via ?listSeries=.
// NCAAF's actual slug is "cfb", not "ncaaf" -- worth knowing if this ever needs re-verifying.
const SERIES_IDS = { NFL: '1', NBA: '2', MLB: '3', NHL: '4', NCAAF: '10002', NCAAB: '10012' };
// SPEEDUP 2026-08-20 (per Derek, real concern -- "I don't want to rely on waiting for the
// season to start"): confirmed honest math -- at the original one-at-a-time, 8s-budget
// design, NFL's 4,200+ discovered wallets alone would have taken DAYS to evaluate. Fixed
// with two real changes: (1) both phases now process in small concurrent batches instead
// of sequentially awaiting one request at a time, (2) budget raised from 8s to 20s. This
// is a genuine multi-x throughput improvement, not a cosmetic tweak -- concurrency is the
// actual lever here, since each fetch spends most of its time waiting on the network, not
// on this server doing work.
async function runHistoricalDiscovery(sport, opts) {
  const seriesId = SERIES_IDS[sport];
  if (!seriesId) return { ok: false, error: `No known series id for ${sport}` };
  const startedAt = Date.now();
  // Default raised 20s -> 45s to use the 60s maxDuration now configured in vercel.json.
  // The piggyback path on the 30-min cron still passes an explicit 8s budget, so this
  // only affects direct ?historical=SPORT calls, which have the function to themselves.
  const BUDGET_MS = (opts && opts.budgetMs) || 45000;
  /* Lowered 8 -> 4 for the evaluation phase specifically: the first full-throughput run
     rate-limited Polymarket badly enough that a large share of wallets returned "stats
     unavailable". Slower per call, but a result that's actually trustworthy. */
  const CONCURRENCY = (opts && opts.concurrency) || 4;

  const progressKey = `discover:historical:${sport}:progress`;
  let progress = (await kvGetJson(progressKey)) || { eventsHarvested: 0, walletsFound: [], harvestDone: false };

  // PHASE 1: harvest events -> unique wallets, concurrent batches within the budget.
  if (!progress.harvestDone) {
    /* THROUGHPUT FIX 2026-08-27 (per Derek, kickoff deadline): this was hardcoded to 20.
       That -- not the time budget -- was the real cap: 20 events processed in ~3 batches
       of 8 finishes in a few seconds and returns, never approaching the 20s budget. It's
       why raising Vercel's maxDuration to 60s produced exactly zero change in throughput
       (measured: +20 events per call before and after, identically). Now the page is large
       enough that the BUDGET is the binding constraint, which is what was intended all
       along. Safe by construction: offset advances only by batches actually processed
       (progress.eventsHarvested += batch.length inside the loop), so a budget-truncated
       call resumes exactly where it stopped and skips nothing -- the only cost is
       re-fetching an event-list page that was partially consumed.
       CONCURRENCY deliberately left at 8: raising parallel fetches against Polymarket's
       API risks rate-limiting, which would be slower overall, not faster. */
    const limit = 200;
    try {
      const evRes = await fetch(`https://gamma-api.polymarket.com/events?series_id=${seriesId}&closed=true&order=startDate&ascending=false&limit=${limit}&offset=${progress.eventsHarvested}`);
      const events = await evRes.json();
      if (!Array.isArray(events) || !events.length) {
        progress.harvestDone = true;
      } else {
        const walletSet = new Set(progress.walletsFound);
        for (let i = 0; i < events.length; i += CONCURRENCY) {
          if (Date.now() - startedAt > BUDGET_MS) break;
          const batch = events.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.all(batch.map(async ev => {
            try {
              const trRes = await fetch(`https://data-api.polymarket.com/trades?eventId=${ev.id}&limit=500&takerOnly=true&side=BUY`);
              const trades = await trRes.json();
              return Array.isArray(trades) ? trades.map(t => t.proxyWallet).filter(Boolean) : [];
            } catch { return []; } // one event's trade fetch failing shouldn't stop the batch
          }));
          batchResults.forEach(wallets => wallets.forEach(w => walletSet.add(w)));
          progress.eventsHarvested += batch.length;
        }
        progress.walletsFound = [...walletSet];
      }
    } catch (e) {
      return { ok: false, error: e.message, phase: 'harvesting' };
    }
    await kvSetJson(progressKey, progress, CAND_TTL);
    return {
      ok: true, sport, phase: 'harvesting',
      eventsHarvested: progress.eventsHarvested,
      uniqueWalletsFound: progress.walletsFound.length,
      harvestDone: progress.harvestDone,
      note: progress.harvestDone ? 'Harvest complete -- next call begins evaluation' : 'Call again to continue harvesting',
    };
  }

  // PHASE 2: evaluate newly-found wallets, concurrent batches, same gate as normal discovery.
  // FIX 2026-08-26 (per Derek): 'pending' verdicts (real wallet, under the 20-settled-bet
  // floor) were being added to the permanent evaluatedSet exactly like a real reject --
  // silently discarded, never re-checked, even though the underlying wallet might clear
  // the bar with more real games played. Confirmed this is a historical-pipeline-only gap:
  // the live discovery path already re-checks every candidate every 24h via c.lastEval, but
  // this evaluatedSet has no such expiry at all. Only 'reject'/'unknown' -- real negative
  // evidence, or a wallet whose historical record won't change -- get permanently excluded
  // here; ongoing monitoring for a wallet that becomes active again is live discovery's job,
  // not this backfill's. 'pending' wallets now persist in their own bucket with a recheck
  // date instead of vanishing.
  const roster = (await kvGetJson('discover:roster')) || {};
  const evaluatedKey = `discover:historical:${sport}:evaluated`;
  let evaluatedWallets = (await kvGetJson(evaluatedKey)) || [];
  const evaluatedSet = new Set(evaluatedWallets);

  const pendingKey = `discover:historical:${sport}:pending`;
  const pendingMap = (await kvGetJson(pendingKey)) || {};
  const PENDING_RECHECK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days -- real sample only grows via real games played

  const toEvaluate = progress.walletsFound.filter(w => {
    if (evaluatedSet.has(w)) return false; // permanently done (promoted, rejected, or unknown)
    const p = pendingMap[w];
    if (p && (Date.now() - p.lastCheckedAt) < PENDING_RECHECK_MS) return false; // pending, not due yet
    return true;
  });

  if (!toEvaluate.length) {
    return { ok: true, sport, phase: 'done', totalWalletsFound: progress.walletsFound.length,
      evaluated: evaluatedWallets.length, pending: Object.keys(pendingMap).length,
      promoted: Object.keys(roster).filter(k => k.endsWith('|' + sport)).length };
  }

  const results = [];
  for (let i = 0; i < toEvaluate.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > BUDGET_MS) break;
    const batch = toEvaluate.slice(i, i + CONCURRENCY);
    const verdicts = await Promise.all(batch.map(wallet => evaluateCandidate({ wallet, sport }, { fresh: false }).then(v => ({ wallet, v }))));
    // for...of rather than forEach: assignNickname is async and forEach can't await.
    for (const { wallet, v } of verdicts) {
      if (v.verdict === 'promote') {
        const rk = wallet + '|' + sport;
        const prev = roster[rk];
        roster[rk] = { wallet, sport, name: await assignNickname(wallet), pnl: v.pnl, sample: v.sample, winRate: v.winRate,
          hedgePct: v.hedgePct, avgEntry: v.avgEntry, impliedWinRate: v.impliedWinRate, edgePP: v.edgePP,
          roiPct: v.roiPct, staked: v.staked, pnlPerMarket: v.pnlPerMarket, avgEntryByCount: v.avgEntryByCount,
          entrySkew: v.entrySkew, reason: v.reason, addedAt: prev ? prev.addedAt : Date.now(), confirmedAt: Date.now(),
          source: 'historical-last-season' };
        evaluatedSet.add(wallet);
        delete pendingMap[wallet];
      } else if (v.verdict === 'pending') {
        pendingMap[wallet] = { wallet, sport, sample: v.sample || 0, reason: v.reason,
          firstSeenAt: (pendingMap[wallet] && pendingMap[wallet].firstSeenAt) || Date.now(),
          lastCheckedAt: Date.now() };
      } else if (v.verdict === 'unknown' && /stats unavailable|fetch|timeout|rate/i.test(v.reason || '')) {
        /* FIX 2026-08-27 (per Derek, found on the first full NCAAF evaluation pass): an
           'unknown' verdict caused by a FAILED FETCH is not evidence about the wallet --
           it's evidence the API was rate-limited. The first full-throughput run evaluated
           1,319 wallets in one call and a large share came back "stats unavailable" purely
           from hammering Polymarket's API, then got permanently locked out of ever being
           re-evaluated by the blanket else-branch below. That made a "zero promotions"
           result meaningless, because a big chunk of the population was never really
           assessed. Transient failures now go to the pending bucket for retry instead.
           Note the distinction: 'zero losses over N positions' is a REAL unknown (we saw
           the data and it's not trustworthy) and stays permanently excluded below. */
        pendingMap[wallet] = { wallet, sport, sample: 0, reason: 'retry: ' + (v.reason || 'fetch failed'),
          firstSeenAt: (pendingMap[wallet] && pendingMap[wallet].firstSeenAt) || Date.now(),
          lastCheckedAt: Date.now() };
      } else {
        // reject, or a real 'unknown' where the data WAS seen and judged untrustworthy.
        evaluatedSet.add(wallet);
        delete pendingMap[wallet];
      }
      results.push({ wallet: wallet.slice(0, 10), verdict: v.verdict, reason: v.reason });
    }
  }

  evaluatedWallets = [...evaluatedSet];
  await kvSetJson(evaluatedKey, evaluatedWallets, CAND_TTL);
  await kvSetJson(pendingKey, pendingMap, CAND_TTL);
  await kvSetJson('discover:roster', roster, ROSTER_TTL);

  return {
    ok: true, sport, phase: 'evaluating',
    totalWalletsFound: progress.walletsFound.length,
    evaluatedSoFar: evaluatedWallets.length,
    pendingCount: Object.keys(pendingMap).length,
    remainingToEvaluate: toEvaluate.length - results.length,
    thisRunCount: results.length,
    thisRunPromotions: results.filter(r => r.verdict === 'promote').length,
    thisRun: results,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (req.query && req.query.roster) {
      const sport = String(req.query.roster).toUpperCase();
      return res.status(200).json({ ok: true, sport, roster: await getRoster(sport === 'ALL' ? null : sport) });
    }
    // FEATURE 2026-08-26 (per Derek): read-only view of wallets sitting in the historical
    // pipeline's pending bucket (real wallet, under 20 settled bets, rechecked every 3
    // days rather than discarded). ?pending=NFL -- built now so the dashboard section
    // scoped for Saturday has something real to read from day one.
    /* ADMIN 2026-08-27 (per Derek): ?resetEvaluated=SPORT clears the historical pipeline's
       "already evaluated, never look again" set so the whole wallet population gets a fresh
       pass. Needed because thousands of wallets were locked out by transient rate-limit
       failures ("stats unavailable") BEFORE the retry fix shipped -- they can't self-heal,
       since the whole point of that set is that it's never revisited. Deliberately does NOT
       touch discover:roster (real promotions survive) or the harvest progress (no re-walking
       events). Re-evaluation is idempotent: a wallet that legitimately rejected will simply
       reject again. */
    if (req.query && req.query.resetEvaluated) {
      const sport = String(req.query.resetEvaluated).toUpperCase();
      const before = ((await kvGetJson(`discover:historical:${sport}:evaluated`)) || []).length;
      await kvSetJson(`discover:historical:${sport}:evaluated`, [], CAND_TTL);
      await kvSetJson(`discover:historical:${sport}:pending`, {}, CAND_TTL);
      return res.status(200).json({ ok: true, sport, clearedEvaluated: before,
        note: 'Evaluated set cleared. Next ?historical=' + sport + ' call re-evaluates the full population. Roster untouched.' });
    }
    if (req.query && req.query.pending) {
      const sport = String(req.query.pending).toUpperCase();
      const pendingMap = (await kvGetJson(`discover:historical:${sport}:pending`)) || {};
      return res.status(200).json({ ok: true, sport, pending: Object.values(pendingMap) });
    }
    // FEATURE 2026-08-19 (per Derek): ?historical=NFL runs one batch of the historical
    // discovery pipeline (harvest phase, then evaluate phase). Designed to be called
    // repeatedly -- via a dedicated cron job, same pattern as the other discovery crons --
    // resuming exactly where the last call left off, until the whole season is processed.
    // DIAGNOSTIC 2026-08-20 (per Derek): find the real series IDs for NCAAF/NCAAB/NHL
    // rather than guess -- lists real series matching a keyword search.
    if (req.query && req.query.listSeries) {
      const q = String(req.query.listSeries).toLowerCase();
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/series?limit=200`);
        const all = await r.json();
        const matches = (Array.isArray(all) ? all : []).filter(s =>
          (s.slug || '').toLowerCase().includes(q) || (s.title || '').toLowerCase().includes(q));
        return res.status(200).json({ ok: true, query: q, totalSeriesScanned: Array.isArray(all) ? all.length : 0, matches: matches.map(s => ({ id: s.id, slug: s.slug, title: s.title })) });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }

    if (req.query && req.query.historical) {
      const sport = String(req.query.historical).toUpperCase();
      return res.status(200).json(await runHistoricalDiscovery(sport, {}));
    }
    // DIAGNOSTIC 2026-08-19 (per Derek): "have we analyzed wallets that were profitable
    // last year but don't have current NFL activity yet" -- feasibility check for pulling
    // wallets from LAST season's events directly, rather than waiting for current-season
    // activity to surface them the normal way. Confirmed via Polymarket's own docs that
    // event-scoped trade queries exist with a ~3yr window -- this checks whether real NFL
    // events from last season are actually findable before building the full
    // evaluate-and-promote pipeline on top of it. Searches by slug prefix rather than a
    // guessed tag_id, matching the same slug convention already confirmed for MLB
    // (mlb-det-pit-2026-08-19) -- don't know the real tag_id for NFL, this doesn't
    // require knowing it. ?checkSeries=nfl
    // BUGFIX: this used to redeclare its own separate, incomplete SERIES_IDS here,
    // drifted out of sync with the module-level one runHistoricalDiscovery uses (missing
    // NHL/NCAAF/NCAAB). Now shares the single source of truth defined above instead.
    // DIAGNOSTIC 2026-08-22 (per Derek, real question): "will a prop just come through
    // if we do nothing" -- need to see a real prop market's actual slug/structure to
    // know whether it would even pass the existing sport-detection at all, since props
    // apparently don't show up as top-level events (all samples so far were game lines).
    // ?checkEventMarkets=EVENT_ID pulls that event's individual markets directly.
    if (req.query && req.query.checkEventMarkets) {
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/events/${req.query.checkEventMarkets}`);
        const ev = await r.json();
        const markets = (ev && ev.markets) || [];
        return res.status(200).json({
          ok: true,
          eventId: req.query.checkEventMarkets,
          eventSlug: ev.slug,
          eventTitle: ev.title,
          marketCount: markets.length,
          sampleMarkets: markets.slice(0, 15).map(m => ({
            slug: m.slug, question: m.question, groupItemTitle: m.groupItemTitle,
            outcomeType: m.outcome_type || m.outcomeType, propType: m.prop_type || m.propType,
          })),
        });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }

    if (req.query && req.query.checkSeries) {
      const sport = String(req.query.checkSeries).toUpperCase();
      const seriesId = SERIES_IDS[sport];
      if (!seriesId) return res.status(200).json({ ok: false, error: `No known series id for ${sport}` });
      try {
        const searchRes = await fetch(`https://gamma-api.polymarket.com/events?series_id=${seriesId}&closed=true&order=startDate&ascending=false&limit=50`);
        const searchData = await searchRes.json();
        const events = Array.isArray(searchData) ? searchData : [];
        return res.status(200).json({
          ok: true, sport, seriesId,
          note: 'Feasibility check only -- not the full pipeline',
          eventCount: events.length,
          newestEventDate: events[0] ? events[0].startDate : null,
          oldestOfThisBatch: events.length ? events[events.length - 1].startDate : null,
          sampleEvents: events.slice(0, 10).map(e => ({
            id: e.id, slug: e.slug, title: e.title, startDate: e.startDate,
          })),
        });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }
    const evals = req.query && req.query.evals ? parseInt(req.query.evals) : undefined;
    const force = String((req.query && req.query.force) || '') === '1';
    const sportFocus = req.query && req.query.sportFocus ? String(req.query.sportFocus) : undefined;
    const liveResult = await runDiscovery({ evals, force, sportFocus });

    // AUTOMATION 2026-08-26 (per Derek): the historical NFL/NCAAF backfill was designed
    // to run via "a dedicated cron job" (see comment above) but that cron was never
    // actually created -- confirmed via two real days of zero progress between manual
    // checks (180 events / 15,224 wallets NFL, 80 events / 6,636 wallets NCAAF, both
    // frozen at exactly the last manual call). Piggybacking one small batch of each onto
    // this already-running 15-min cron instead of requiring a new external cron entry.
    // Small budgets (8s each) so this can't meaningfully threaten the 60s function
    // ceiling alongside runDiscovery's own work.
    let historicalNFL = null, historicalNCAAF = null;
    try {
      historicalNFL = await runHistoricalDiscovery('NFL', { budgetMs: 8000 });
    } catch (e) {
      historicalNFL = { ok: false, error: e.message };
    }
    try {
      historicalNCAAF = await runHistoricalDiscovery('NCAAF', { budgetMs: 8000 });
    } catch (e) {
      historicalNCAAF = { ok: false, error: e.message };
    }

    // STEAM 2026-08-26 (per Derek): same piggyback pattern -- snapshot every tracked
    // sport's Kalshi markets on the same cadence this cron already runs at, so steam
    // (rapid price move + real volume, within the actual elapsed window since last
    // snapshot) gets detected continuously instead of only when someone happens to load
    // a page. NCAAF skipped -- no confirmed Kalshi series ticker for it yet.
    const kalshiSteam = {};
    for (const sp of ['MLB', 'NFL', 'NBA', 'NHL', 'WNBA']) {
      try {
        kalshiSteam[sp] = await kalshi.detectSteam(sp);
      } catch (e) {
        kalshiSteam[sp] = { ok: false, sport: sp, error: e.message };
      }
    }

    return res.status(200).json({ ...liveResult, historicalNFL, historicalNCAAF, kalshiSteam });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
};
module.exports.runDiscovery = runDiscovery;
module.exports.getRoster = getRoster;
module.exports.foldCandidates = foldCandidates;
module.exports.evaluateCandidate = evaluateCandidate;
module.exports.sportOfTrade = sportOfTrade;
module.exports.MIN_SIGHTINGS = MIN_SIGHTINGS;
module.exports.MIN_SAMPLE = MIN_SAMPLE;
module.exports.MAX_AVG_ENTRY = MAX_AVG_ENTRY;
module.exports.MIN_EDGE_PP = MIN_EDGE_PP;
module.exports.MIN_ROI_PCT = MIN_ROI_PCT;
module.exports.MAX_ENTRY_SKEW = MAX_ENTRY_SKEW;
