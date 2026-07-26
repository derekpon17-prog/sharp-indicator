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
      const r = await fetch(`${DATA_API}/closed-positions?user=${wallet}&limit=${L}`);
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
        const r = await fetch(`${DATA_API}/closed-positions?user=${wallet}&limit=${limit}&offset=${page * limit}`);
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
const PNL_MODE = 'net';   // 'net' = realizedPnl - totalBought | 'raw' = realizedPnl

function positionPnl(p, pnlField, mode) {
  const gross = parseFloat(pnlField ? p[pnlField] : undefined);
  const cost  = parseFloat(p && p.totalBought);
  const g = isFinite(gross) ? gross : 0;
  const c = isFinite(cost) ? cost : 0;
  return mode === 'raw' ? g : (g - c);
}

function bucket(positions) {
  const bySport = {};
  let total = 0, unmapped = 0;
  const via = { slug: 0, title: 0, none: 0 };
  const pnlField = resolvePnlField(positions);
  const sampleKeys = positions.length ? Object.keys(positions[0]).slice(0, 40) : [];
  // Real rows, trimmed of bulky/identifying fields, so field SEMANTICS are inspectable
  // rather than inferred. This is the diagnostic that ends the guessing.
  const sampleRows = positions.slice(0, 3).map(p => {
    const r = {};
    ['avgPrice', 'totalBought', 'realizedPnl', 'curPrice', 'outcome', 'slug', 'endDate']
      .forEach(k => { if (p[k] !== undefined) r[k] = p[k]; });
    return r;
  });
  // Both interpretations, so the choice is evidence-based.
  const compare = { raw: 0, net: 0, rawWins: 0, netWins: 0, rawLosses: 0, netLosses: 0 };
  positions.forEach(p => {
    const rv = positionPnl(p, pnlField, 'raw');
    const nv = positionPnl(p, pnlField, 'net');
    compare.raw += rv; compare.net += nv;
    if (rv > 0) compare.rawWins++; else if (rv < 0) compare.rawLosses++;
    if (nv > 0) compare.netWins++; else if (nv < 0) compare.netLosses++;
  });
  compare.raw = Math.round(compare.raw * 100) / 100;
  compare.net = Math.round(compare.net * 100) / 100;

  positions.forEach(p => {
    const pnl = positionPnl(p, pnlField, PNL_MODE);
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
  });

  return { bySport, totalPnl: Math.round(total * 100) / 100, positions: positions.length,
           unmapped, via, pnlField, pnlMode: PNL_MODE, sampleKeys, sampleRows,
           pnlCompare: compare };
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
    /* A wallet with hundreds of graded positions and ZERO losses means the metric is
       measuring proceeds, not profit. Flag it instead of reporting a flawless record. */
    pnlHealthy: !!(b.pnlField && b.positions > 0 &&
                   !(b.pnlCompare && b.pnlCompare.netLosses === 0 && b.positions >= 50)),
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
