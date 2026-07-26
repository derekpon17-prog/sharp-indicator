/* ─── PER-SPORT TRADER PnL ────────────────────────────────────────────
   WHY. The notify bot's only quality gate is "is this wallet on the leaderboard."
   That leaderboard ranks ALL-TIME PnL across every market Polymarket runs —
   politics, crypto, sports. A wallet up $5M on elections and down $40K on MLB
   passes that gate on every MLB bet it places. This module answers the question
   the gate should have been asking all along: is this wallet net-positive IN THE
   SPORT IT IS BETTING?

   The frontend already computed something like this (fetchTraderStats), but it
   lived client-side where the bot could never see it, and it bucketed by title
   keywords — the same approach that would tag Glasgow Rangers as MLB because
   'rangers' is in the team list. Here it buckets by SLUG PREFIX, which is
   structured and unambiguous, with title matching only as a fallback.

   TWO THINGS DELIBERATELY INSTRUMENTED, both because of failures earlier this
   week. The limit parameter LADDERS DOWN instead of assuming 500 works — the
   frontend hardcoded limit=500 and that is the exact pattern that silently
   returned nothing when Polymarket capped the leaderboard, blacking out alerts
   for 19 hours. And every response reports which bucketing method was used and
   whether results were truncated, so degraded data is visible rather than
   quietly wrong. */

const DATA_API = 'https://data-api.polymarket.com';

// Mirrors LEAGUE_BY_SLUG in polymarket-notify.js. Kept local rather than imported
// to avoid coupling two serverless entry points; if one changes, change both.
const LEAGUE_BY_SLUG = {
  mlb: 'MLB', nfl: 'NFL', nhl: 'NHL', nba: 'NBA', wnba: 'WNBA',
  ncaaf: 'NCAAF', ncaafb: 'NCAAF', cfb: 'NCAAF',
  ncaab: 'NCAAB', ncaamb: 'NCAAB', ncaawb: 'NCAAB', cbb: 'NCAAB',
};
const MLB_TEAMS = ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies',
  'padres','giants','cardinals','brewers','guardians','royals','twins','orioles','rays',
  'blue jays','mariners','rangers','angels','athletics','tigers','white sox','reds',
  'pirates','rockies','marlins','nationals','diamondbacks'];

const POS_LIMITS = [500, 200, 100, 50];  // ladder, never assume
/* 4 pages x 50 = 200 positions was far too shallow: a wallet that bets several sports
   showed only 1 MLB position, so nobody could ever reach the 20-position minimum and the
   gate permanently failed open — present but inert. Pages are sequential per wallet but
   wallets resolve in parallel, and results are cached for a day, so the cost lands once. */
const MAX_PAGES  = 16;                    // up to 800 positions per wallet
const CACHE_TTL  = 86400;                 // PnL moves slowly; refresh daily

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

/* Slug is authoritative; title is the fallback for rows that carry no slug. */
function sportOf(pos) {
  const slug = String((pos && (pos.slug || pos.eventSlug)) || '').toLowerCase();
  const prefix = slug.split('-')[0];
  if (prefix) return { sport: LEAGUE_BY_SLUG[prefix] || null, via: 'slug' };
  const t = String((pos && (pos.title || pos.question)) || '').toLowerCase();
  if (!t) return { sport: null, via: 'none' };
  if (t.includes('wnba')) return { sport: 'WNBA', via: 'title' };
  if (t.includes('ncaaf') || t.includes('college football')) return { sport: 'NCAAF', via: 'title' };
  if (t.includes('ncaab') || t.includes('march madness')) return { sport: 'NCAAB', via: 'title' };
  if (t.includes('nfl')) return { sport: 'NFL', via: 'title' };
  if (t.includes('nhl')) return { sport: 'NHL', via: 'title' };
  if (t.includes('nba')) return { sport: 'NBA', via: 'title' };
  if (t.includes('mlb') || MLB_TEAMS.some(x => t.includes(x))) return { sport: 'MLB', via: 'title' };
  return { sport: null, via: 'none' };
}

const diag = { limitUsed: null, offsetSupported: null };

async function fetchClosedPositions(wallet) {
  let limit = null, all = [], firstHash = null, truncated = false;

  /* Find a limit the API actually honours.
     CRITICAL: an empty array must NOT end the ladder. When Polymarket capped the
     leaderboard it returned [] for over-sized requests instead of clamping, and treating
     that as "no data" is precisely what blacked out alerts for 19 hours. An empty response
     is ambiguous — it means either "wallet has no positions" or "your limit was too big" —
     so keep laddering, and only conclude the wallet is genuinely empty after the SMALLEST
     limit also comes back empty. (Caught by the e2e test reproducing the outage.) */
  let sawEmpty = false;
  for (const L of POS_LIMITS) {
    try {
      const r = await fetch(`${DATA_API}/closed-positions?user=${wallet}&limit=${L}&sortBy=TIMESTAMP`);
      if (!r.ok) continue;
      const d = await r.json();
      if (!Array.isArray(d)) continue;
      if (d.length) { limit = L; all = d; diag.limitUsed = L; break; }
      sawEmpty = true;   // ambiguous — try a smaller limit before believing it
    } catch {}
  }
  if (limit === null) {
    if (sawEmpty) return { positions: [], ok: true, error: null, truncated: false }; // truly empty
    return { positions: [], ok: false, error: 'all limits failed', truncated: false };
  }

  // Page deeper only if the first page came back full.
  if (all.length === limit) {
    /* Compare the WHOLE first row, not a guessed identity field. The earlier probe used
       `conditionId || title`; on a payload carrying neither, both sides evaluated to
       undefined, the probe concluded offset was unsupported, and pagination stopped dead
       after one page — depth silently capped at 50. Schema-independent is the point. */
    firstHash = JSON.stringify(all[0]);
    for (let page = 1; page < MAX_PAGES; page++) {
      let d;
      try {
        const r = await fetch(`${DATA_API}/closed-positions?user=${wallet}&limit=${limit}&offset=${page * limit}&sortBy=TIMESTAMP`);
        if (!r.ok) break;
        d = await r.json();
      } catch { break; }
      if (!Array.isArray(d) || !d.length) break;
      if (JSON.stringify(d[0]) === firstHash) {
        diag.offsetSupported = false;   // offset ignored — stop rather than duplicate
        break;
      }
      diag.offsetSupported = true;
      all = all.concat(d);
      if (d.length < limit) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
  }
  return { positions: all, ok: true, error: null, truncated };
}

/* PnL FIELD RESOLUTION.
   The live payload carried neither `cashPnl` nor `pnl`, so every bucket computed 0 while
   looking perfectly healthy — 200 positions parsed, slugs mapped, totals silently zero.
   That is the worst failure shape: plausible output, no signal. Rather than guess again,
   try the known candidates in order, report WHICH field resolved, and expose the raw key
   list of a sample row so an unknown schema is diagnosable in one call instead of three. */
const PNL_FIELDS = ['realizedPnl', 'cashPnl', 'realized_pnl', 'pnl', 'profit', 'totalPnl', 'cash_pnl'];

function resolvePnlField(positions) {
  for (const f of PNL_FIELDS) {
    const hit = positions.find(p => p && p[f] !== undefined && p[f] !== null);
    if (hit) return f;
  }
  return null;
}

/* PnL INTERPRETATION.
   `realizedPnl` resolved correctly but produced a 100% win rate with zero losses across
   800 positions in every sport — impossible, and worse, it made the gate look healthy
   while passing everyone. That field is evidently gross proceeds, not net profit: a
   losing position returns 0 rather than a negative number, so nothing is ever counted as
   a loss and every wallet reads as flawless.
   `totalBought` sits alongside it in the payload, so net is most likely
   proceeds - cost. Rather than guess a third time, compute BOTH interpretations, report
   both, and expose real sample rows so the correct one is decidable from one call.
   PNL_MODE selects which drives the gate; 'net' is the default because a metric that can
   never produce a loss cannot gate anything. */
/* CORRECTED after reading real rows: `totalBought` is a SHARE COUNT, not a dollar cost.
   Row 1 of live data: 383,004.69 shares at avgPrice 0.36633 = $140,297 cost; sold at $1
   = $383,005 proceeds; profit $242,708. Reported realizedPnl: $242,697 — a 0.004% match.
   So realizedPnl IS net profit, correctly signed, and subtracting totalBought was
   subtracting a share count from dollars, which flipped all 800 positions to losses and
   turned the gate from inert into actively blocking everything. */
const PNL_MODE = 'raw';   // realizedPnl is already net profit

function positionPnl(p, pnlField, mode) {
  const gross = parseFloat(pnlField ? p[pnlField] : undefined);
  const cost  = parseFloat(p && p.totalBought);
  const g = isFinite(gross) ? gross : 0;
  const c = isFinite(cost) ? cost : 0;
  return mode === 'raw' ? g : (g - c);
}

/* NET BY MARKET.
   Live data shows this wallet holding BOTH sides of the same conditionId — ex-RUBY at
   -$992 and CYBERSHOKE at +$1,041 on one CS2 match. Counted as two positions that is
   permanently one win and one loss, pinning every win rate near 50% and making the gate
   uninformative. Netting by conditionId scores the market once, on the trader's actual
   net outcome. It also reflects reality: taking both sides is market-making, not a
   directional read, and nets to roughly zero as it should. */
function netByMarket(positions, pnlField) {
  const byCond = new Map();
  const loose = [];
  positions.forEach(p => {
    const cid = p && p.conditionId;
    if (!cid) { loose.push(p); return; }
    const cur = byCond.get(cid);
    const pnl = positionPnl(p, pnlField, PNL_MODE);   // compute here; bucket() reads _netPnl
    if (!cur) byCond.set(cid, { ...p, _netPnl: pnl, _legs: 1 });
    else { cur._netPnl += pnl; cur._legs++; }
  });
  return [...byCond.values(), ...loose.map(p => ({ ...p, _netPnl: positionPnl(p, pnlField, PNL_MODE), _legs: 1 }))];
}

function bucket(rawPositions) {
  const bySport = {};
  let total = 0, unmapped = 0;
  const via = { slug: 0, title: 0, none: 0 };
  const pnlField = resolvePnlField(rawPositions);
  const positions = netByMarket(rawPositions, pnlField);
  const hedged = positions.filter(p => p._legs > 1).length;
  const sampleKeys = rawPositions.length ? Object.keys(rawPositions[0]).slice(0, 40) : [];
  // Real rows, trimmed of bulky/identifying fields, so field SEMANTICS are inspectable
  // rather than inferred. This is the diagnostic that ends the guessing.
  const sampleRows = rawPositions.slice(0, 3).map(p => {
    const r = {};
    ['avgPrice', 'totalBought', 'realizedPnl', 'curPrice', 'outcome', 'slug', 'endDate']
      .forEach(k => { if (p[k] !== undefined) r[k] = p[k]; });
    return r;
  });
  // Both interpretations, so the choice is evidence-based.
  const compare = { raw: 0, net: 0, rawWins: 0, netWins: 0, rawLosses: 0, netLosses: 0 };
  positions.forEach(p => {
    const rv = p._netPnl;
    const nv = positionPnl(p, pnlField, 'net');
    compare.raw += rv; compare.net += nv;
    if (rv > 0) compare.rawWins++; else if (rv < 0) compare.rawLosses++;
    if (nv > 0) compare.netWins++; else if (nv < 0) compare.netLosses++;
  });
  compare.raw = Math.round(compare.raw * 100) / 100;
  compare.net = Math.round(compare.net * 100) / 100;

  /* SAMPLE BIAS DETECTION.
     Live rows arrive in DESCENDING realizedPnl order (242,697 -> 224,114 -> 208,139), so
     fetching the first N positions returns the N biggest WINNERS of possibly thousands.
     Every wallet then reads as flawless and per-sport PnL is meaningless. Two independent
     tells: a monotonically non-increasing PnL sequence, and zero losses over a large
     sample. When either fires the record is not evidence and must not gate anything. */
  let sampleBiased = false, biasReason = null;
  const vals = positions.map(p => p._netPnl);
  if (vals.length >= 20) {
    let descending = true;
    for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1] + 1e-6) { descending = false; break; }
    if (descending) { sampleBiased = true; biasReason = 'results sorted by PnL — sample is top-N winners, not representative'; }
  }
  const losses = PNL_MODE === 'raw' ? compare.rawLosses : compare.netLosses;
  if (!sampleBiased && positions.length >= 50 && losses === 0) {
    sampleBiased = true; biasReason = 'zero losses over ' + positions.length + ' positions — sample cannot be representative';
  }

  /* ENTRY-PRICE AGGREGATION.
     A 99.1% win rate over 109 markets is not handicapping — it is buying near-certainties
     at 0.97-0.99, where ~97% of bets win by construction. The filter caught hedgers but
     had nothing to say about price selection, so a favourite-scalper passed every test:
     positive PnL, large sample, near-zero hedging, and zero information about which side
     is right.
     The honest measure is win rate against what the price ALREADY implied. Buying at 0.50
     and winning 54% is a 4pp edge; buying at 0.98 and winning 99% is 1pp and inside noise.
     Dollar-weighted across RAW legs, because a netted market carries only one leg's price. */
  const entryBySport = {};
  rawPositions.forEach(p => {
    const { sport } = sportOf(p);
    if (!sport) return;
    const px = parseFloat(p && p.avgPrice);
    const sh = parseFloat(p && p.totalBought);
    if (!isFinite(px) || !isFinite(sh) || sh <= 0) return;
    const e = entryBySport[sport] || (entryBySport[sport] = { cost: 0, shares: 0 });
    e.cost += px * sh;
    e.shares += sh;
  });

  positions.forEach(p => {
    const pnl = p._netPnl;
    total += pnl;
    const { sport, via: how } = sportOf(p);
    via[how] = (via[how] || 0) + 1;
    if (!sport) { unmapped++; return; }
    const b = bySport[sport] || (bySport[sport] = { pnl: 0, positions: 0, wins: 0, losses: 0 });
    b.pnl += pnl; b.positions++;
    if (pnl > 0) b.wins++; else if (pnl < 0) b.losses++;
  });

  Object.keys(bySport).forEach(k => {
    const b = bySport[k];
    b.pnl = Math.round(b.pnl * 100) / 100;
    const graded = b.wins + b.losses;
    b.winRate = graded ? Math.round((b.wins / graded) * 1000) / 10 : null;
    const e = entryBySport[k];
    if (e && e.shares > 0) {
      b.avgEntry = Math.round((e.cost / e.shares) * 1000) / 1000;
      b.impliedWinRate = Math.round(b.avgEntry * 1000) / 10;   // price IS the implied probability
      // The number that matters: how much the wallet beat its own entry prices.
      b.edgePP = b.winRate !== null ? Math.round((b.winRate - b.impliedWinRate) * 10) / 10 : null;
    } else {
      b.avgEntry = null; b.impliedWinRate = null; b.edgePP = null;
    }
  });

  return { bySport, totalPnl: Math.round(total * 100) / 100, positions: positions.length,
           rawPositions: rawPositions.length, hedgedMarkets: hedged,
           unmapped, via, pnlField, pnlMode: PNL_MODE, sortedBy: 'TIMESTAMP',
           sampleKeys, sampleRows, pnlCompare: compare, sampleBiased, biasReason };
}

/* PROVIDER INTERFACE. Returns per-sport PnL for one wallet, KV-cached daily. */
async function getTraderStats(wallet, opts) {
  const fresh = !!(opts && opts.fresh);
  const key = 'tstats:' + wallet;
  /* A 24h TTL is right for production — per-sport PnL barely moves day to day — but it
     also means a deployed fix is invisible until tomorrow. That bit us immediately: the
     PnL-field and depth fixes shipped and the endpoint kept serving yesterday's object,
     which reads as "the fix didn't work" when in fact it never ran. ?fresh=1 forces a
     re-fetch and rewrites the entry. */
  const cached = fresh ? { ok: false, result: null } : await kv(['GET', key]);
  if (cached.ok && cached.result) {
    try {
      const d = typeof cached.result === 'string' ? JSON.parse(cached.result) : cached.result;
      d.cached = true;
      return d;
    } catch {}
  }
  const { positions, ok, error, truncated } = await fetchClosedPositions(wallet);
  const b = bucket(positions);
  const out = {
    wallet, ok, error, truncated, cached: false, fetchedAt: Date.now(),
    limitUsed: diag.limitUsed, offsetSupported: diag.offsetSupported,
    ...b,
    // A resolved pnlField with an all-zero total means the schema changed again.
    pnlHealthy: !!(b.pnlField && b.positions > 0 && !b.sampleBiased),
    sampleBiased: b.sampleBiased,
    biasReason: b.biasReason,
  };
  if (ok) await kv(['SET', key, JSON.stringify(out), 'EX', String(CACHE_TTL)]);
  return out;
}

/* THE GATE. A wallet qualifies for a sport only if it is net-positive in THAT
   sport over a meaningful sample. MIN_SAMPLE exists because three lucky bets is
   not evidence; without it this filter would mostly launder variance. */
const MIN_SAMPLE = 20;
function qualifiesForSport(stats, sport, minSample) {
  const min = minSample === undefined ? MIN_SAMPLE : minSample;
  if (!stats || !stats.ok) return { pass: true, reason: 'stats unavailable — failing open', known: false };
  /* A biased sample is worse than no sample: it looks authoritative and is wrong in a
     consistent direction. Refuse to gate on it rather than block or pass on noise. */
  if (stats.sampleBiased) {
    return { pass: true, known: false, reason: 'sample not representative (' + (stats.biasReason || 'biased') + ') — failing open' };
  }
  const b = stats.bySport && stats.bySport[sport];
  if (!b) return { pass: true, reason: 'no closed positions in ' + sport + ' — failing open', known: false };
  if (b.positions < min) {
    return { pass: true, reason: b.positions + ' ' + sport + ' positions, under the ' + min + ' minimum — failing open', known: false, sample: b.positions };
  }
  const pass = b.pnl > 0;
  return {
    pass, known: true, sample: b.positions,
    pnl: b.pnl, winRate: b.winRate,
    reason: sport + ' ' + (b.pnl >= 0 ? '+' : '') + '$' + Math.round(b.pnl).toLocaleString()
      + ' over ' + b.positions + ' positions' + (b.winRate !== null ? ' (' + b.winRate + '%)' : ''),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const wallet = req.query && req.query.wallet;
  const sport = String((req.query && req.query.sport) || '').toUpperCase();
  if (!wallet) return res.status(200).json({ ok: false, error: 'wallet query param required' });
  try {
    const fresh = String((req.query && req.query.fresh) || '') === '1';
    const stats = await getTraderStats(String(wallet), { fresh });
    const out = { ...stats };
    if (sport) out.gate = qualifiesForSport(stats, sport);
    return res.status(200).json(out);
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message, wallet });
  }
};
module.exports.getTraderStats = getTraderStats;
module.exports.qualifiesForSport = qualifiesForSport;
module.exports.bucket = bucket;
module.exports.sportOf = sportOf;
module.exports.MIN_SAMPLE = MIN_SAMPLE;
