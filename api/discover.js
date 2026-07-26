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
async function evaluateCandidate(c) {
  const stats = await traderStats.getTraderStats(c.wallet);
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
  return {
    verdict: 'promote', sample: b.positions, pnl: b.pnl, winRate: b.winRate, hedgePct,
    reason: c.sport + ' +$' + Math.round(b.pnl).toLocaleString() + ' over ' + b.positions
            + ' markets' + (b.winRate !== null ? ' (' + b.winRate + '%)' : ''),
  };
}

async function runDiscovery(opts) {
  const now = Date.now();
  const limitEvals = (opts && opts.evals !== undefined) ? opts.evals : EVALS_PER_RUN;

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
  const queue = Object.keys(cands)
    .map(k => cands[k])
    .filter(c => c.sightings >= MIN_SIGHTINGS)
    .filter(c => !c.lastEval || (now - c.lastEval) > 86400000)
    .sort((a, b) => (b.totalUsd || 0) - (a.totalUsd || 0))
    .slice(0, limitEvals);

  const evaluated = [];
  for (const c of queue) {
    const v = await evaluateCandidate(c);
    c.lastEval = now;
    c.lastVerdict = v.verdict;
    c.lastReason = v.reason;
    const rk = c.wallet + '|' + c.sport;
    if (v.verdict === 'promote') {
      const prev = roster[rk];
      roster[rk] = { wallet: c.wallet, sport: c.sport, name: c.name || null,
                     pnl: v.pnl, sample: v.sample, winRate: v.winRate, hedgePct: v.hedgePct,
                     reason: v.reason, addedAt: prev ? prev.addedAt : now, confirmedAt: now };
    } else if (v.verdict === 'reject' && roster[rk]) {
      delete roster[rk];   // demote — the roster must be able to shrink
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
  Object.keys(bySport).forEach(s => bySport[s].sort((a, b) => (b.pnl || 0) - (a.pnl || 0)));

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (req.query && req.query.roster) {
      const sport = String(req.query.roster).toUpperCase();
      return res.status(200).json({ ok: true, sport, roster: await getRoster(sport === 'ALL' ? null : sport) });
    }
    const evals = req.query && req.query.evals ? parseInt(req.query.evals) : undefined;
    return res.status(200).json(await runDiscovery({ evals }));
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
