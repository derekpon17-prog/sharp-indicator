/* ─── KALSHI (PHASE 1 — READ ONLY, SHADOW) ────────────────────────────
   WHY. Kalshi is CFTC-regulated and available in all 50 states, sports are roughly
   three-quarters of its volume, and single-game MLB (KXMLBGAME) alone is over 20% of
   platform trading. Its public market data needs no auth and prices are quoted in cents,
   so a price IS an implied probability with no devig required.

   WHAT THIS IS NOT. Kalshi's public trades carry price, size and taker side but NO trader
   identity — accounts are KYC'd and the book is anonymous. Wallet-style smart-money
   tracking, the thing the Polymarket pillar is built on, cannot be replicated here. Anyone
   proposing it is assuming attribution that does not exist.

   WHAT IT IS FOR. Two things:
     1. A fourth price source alongside Pinnacle, Novig and ProphetX.
     2. The differentiated signal — cross-venue divergence CONDITIONED ON the Polymarket
        roster. Price-vs-price arbitrage between the two venues is already crowded; what is
        not crowded is "a wallet with proven in-sport ROI just took this side on Polymarket
        and Kalshi has not repriced". Polymarket has attribution, Kalshi has none, and that
        asymmetry is the asset.

   EXECUTION IS A SEPARATE DECISION. Kalshi's fee is 0.07·P·(1−P), about 1.75c at even
   money — roughly 3.5% round trip. This board's h2h edges run under 1pp, which is about 2%
   on an even-money bet. Most of what the engine finds would not survive those fees, so
   this is a signal venue until Phase 1 proves otherwise.

   BUILT DEFENSIVELY ON PURPOSE. The API base and ticker shape are unverified from here, so
   the base URL ladders through candidates and every response carries raw samples. The
   first live call is the real test, and it should be diagnosable in one pass rather than
   six. */

const BASE_CANDIDATES = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
  'https://trading-api.kalshi.com/trade-api/v2',
];

// Series tickers confirmed from Kalshi's own volume reporting and market pages.
const SERIES = {
  MLB:   'KXMLBGAME',
  WNBA:  'KXWNBAGAME',
  NBA:   'KXNBAGAME',
  NHL:   'KXNHLGAME',
  NFL:   'KXNFLGAME',
};

const CACHE_TTL = 300;   // 5 min — prices move, but not every request needs a fetch
const diag = { baseUsed: null, attempts: [] };

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

/* Kalshi's quadratic taker fee. Quoted here so any edge can be reported NET, which is the
   only number worth acting on — a 1pp gross edge is underwater once this is applied. */
function kalshiFee(priceProb) {
  const p = Math.max(0, Math.min(1, priceProb));
  return 0.07 * p * (1 - p);
}

function normTeam(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

/* Ladder the base URL. Kalshi has moved hosts before and the correct one is unverified
   from this environment, so try each and record which answered rather than hardcoding a
   guess that fails silently. */
async function fetchSeries(sport) {
  const series = SERIES[sport];
  if (!series) return { ok: false, error: 'no Kalshi series for ' + sport, markets: [] };

  for (const base of BASE_CANDIDATES) {
    const url = `${base}/markets?series_ticker=${series}&status=open&limit=200`;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      diag.attempts.push({ base, status: r.status });
      if (!r.ok) continue;
      const d = await r.json();
      const markets = (d && (d.markets || d.data)) || [];
      if (Array.isArray(markets) && markets.length) {
        diag.baseUsed = base;
        return { ok: true, error: null, markets, series };
      }
      // Reachable but empty is ambiguous (off-season vs wrong host) — keep laddering.
    } catch (e) {
      diag.attempts.push({ base, error: e.message });
    }
  }
  return { ok: false, error: 'no base URL returned markets', markets: [], series };
}

/* Normalise a Kalshi market. Field names are taken from the documented schema but the
   payload is unverified here, so every field falls back and `raw` keys are surfaced. */
function normalizeMarket(m) {
  // FIX 2026-08-27 (per Derek, first live call per the header above): the schema guess
  // was wrong. Kalshi actually returns yes_bid_dollars/yes_ask_dollars/last_price_dollars
  // as STRING dollar amounts (e.g. "0.2300"), not yes_bid/yes_ask/last_price as numeric
  // cents -- confirmed via a live sampleRaw pull showing count:96 real NFL markets with
  // count:0 actually priced under the old parsing. volume_fp/open_interest_fp are the real
  // fields too, and volume_fp is CONTRACT COUNT (confirmed against yes_ask_size_fp/
  // yes_bid_size_fp in the same sample), not a dollar amount -- treat accordingly.
  const dollars = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  };
  const yesBid = dollars(m.yes_bid_dollars ?? m.yes_bid);
  const yesAsk = dollars(m.yes_ask_dollars ?? m.yes_ask);
  const last = dollars(m.last_price_dollars ?? m.last_price);
  // Mid is the fairest single read; fall back to last trade when the book is one-sided.
  const mid = (yesBid !== null && yesAsk !== null) ? (yesBid + yesAsk) / 2 : last;
  const volNum = parseFloat(m.volume_fp ?? m.volume);
  const oiNum = parseFloat(m.open_interest_fp ?? m.open_interest);
  return {
    ticker: m.ticker || null,
    eventTicker: m.event_ticker || null,
    title: m.title || null,
    yesSubTitle: m.yes_sub_title || m.subtitle || null,
    yesBid, yesAsk, last,
    impliedProb: mid,
    spreadPP: (yesBid !== null && yesAsk !== null) ? Math.round((yesAsk - yesBid) * 1000) / 10 : null,
    volume: isFinite(volNum) ? volNum : null,           // contract count, NOT dollars -- see fix note
    openInterest: isFinite(oiNum) ? oiNum : null,        // contract count
    closeTime: m.close_time || m.expiration_time || null,
    feeAtMid: mid !== null ? Math.round(kalshiFee(mid) * 10000) / 100 : null,  // in cents
  };
}

/* Match Kalshi markets to a game. Team names are matched out of the title/subtitle rather
   than parsed from the ticker, because the ticker encoding is unverified and a name match
   degrades gracefully where a format assumption would break outright. */
function matchGame(markets, away, home) {
  const a = normTeam(away), h = normTeam(home);
  if (a.length < 3 || h.length < 3) return [];
  const aLast = a.split(' ').pop(), hLast = h.split(' ').pop();
  return markets.filter(m => {
    const t = normTeam((m.title || '') + ' ' + (m.yesSubTitle || '') + ' ' + (m.ticker || ''));
    return (t.includes(aLast) || t.includes(a)) && (t.includes(hLast) || t.includes(h));
  });
}

/* PROVIDER INTERFACE. Returns normalised Kalshi markets for a sport, KV-cached. */
async function getKalshi(sport) {
  const key = 'kalshi:' + sport;
  const cached = await kv(['GET', key]);
  if (cached.ok && cached.result) {
    try {
      const d = typeof cached.result === 'string' ? JSON.parse(cached.result) : cached.result;
      d.cached = true;
      return d;
    } catch {}
  }
  const res = await fetchSeries(sport);
  const markets = (res.markets || []).map(normalizeMarket);
  const out = {
    sport, series: res.series || null, ok: res.ok, error: res.error,
    baseUsed: diag.baseUsed, attempts: diag.attempts.slice(0, 6),
    count: markets.length,
    priced: markets.filter(m => m.impliedProb !== null).length,
    totalVolume: markets.reduce((s, m) => s + (m.volume || 0), 0),
    markets,
    // Raw sample so an unexpected schema is diagnosable in ONE call, not six.
    sampleRaw: (res.markets || []).slice(0, 2),
    fetchedAt: Date.now(), cached: false,
  };
  if (out.ok) await kv(['SET', key, JSON.stringify(out), 'EX', String(CACHE_TTL)]);
  return out;
}

/* PHASE 1 QUESTION: does Kalshi lead, lag, or track Pinnacle?
   Compares Kalshi's implied probability against a supplied Pinnacle fair probability and
   reports the gap BOTH gross and net of Kalshi's fee, because gross edge is the number
   that misleads. */
function compareToPinnacle(kalshiProb, pinnacleFairProb) {
  if (kalshiProb === null || !isFinite(pinnacleFairProb)) return null;
  const grossPP = Math.round((pinnacleFairProb - kalshiProb) * 1000) / 10;
  const fee = kalshiFee(kalshiProb);
  const netPP = Math.round((pinnacleFairProb - kalshiProb - fee) * 1000) / 10;
  return {
    kalshiProb: Math.round(kalshiProb * 1000) / 10,
    pinnacleProb: Math.round(pinnacleFairProb * 1000) / 10,
    grossEdgePP: grossPP,
    feePP: Math.round(fee * 1000) / 10,
    netEdgePP: netPP,
    // Plain-language verdict — the number that actually decides anything.
    verdict: netPP > 0 ? 'Kalshi cheap by ' + netPP + 'pp after fees'
                       : 'no edge after fees (' + netPP + 'pp)',
  };
}

/* ─── KALSHI STEAM (added 2026-08-26, per Derek) ────────────────────────
   WHY THIS EXISTS. Kalshi's public trades carry no trader identity (see header above --
   wallet-style tracking cannot be replicated here), but rapid price movement backed by
   real volume is visible and legitimate regardless of who's behind it. This is the same
   concept as this project's existing steam detection on soft books ("rapid coordinated
   movement across multiple books"), just sourced from a third, structurally distinct venue
   (CFTC-regulated, KYC-gated) instead of retail sportsbooks.

   HOW IT WORKS. No /trades endpoint needed -- steam is detected by snapshotting every
   market's implied probability + volume on each call and comparing to the last stored
   snapshot. If price moved enough AND real volume backed the move AND it happened within
   the window since the last snapshot, it's flagged. Snapshot cadence is whatever calls
   this (currently piggybacked on the same ~30-min cron driving NFL/NCAAF harvest), so the
   window is measured from actual elapsed time, not assumed.

   THRESHOLDS ARE FIRST-CUT DEFAULTS, NOT TUNED. Unlike changing an existing production
   threshold, these are initial values for a brand-new signal with no baseline yet --
   flagged here explicitly so they get revisited with real data, not treated as settled:
     STEAM_MIN_PP        = 5     -- minimum probability move to even consider
     STEAM_MIN_VOL_ADDED  = 2000  -- absolute $ floor, so a thin market can't fake a print
     STEAM_MIN_VOL_PCT    = 0.15  -- OR volume must grow >=15% relative to its own prior size
   A market must clear the $ floor AND (have near-zero prior volume OR clear the % growth
   bar) -- this mirrors the same per-market-relative-plus-absolute-floor pattern used by
   commercial whale-flow trackers on this exact problem (a flat $ threshold treats a
   Tuesday college market and a Chiefs Sunday market as equally liquid, which they aren't).

   NCAAF IS NOT INCLUDED. No confirmed Kalshi series ticker for NCAAF exists in SERIES yet
   (unverified from here, same caveat as the rest of this file) -- steam only covers the
   sports with a confirmed ticker: MLB, WNBA, NBA, NHL, NFL. */

// FIX 2026-08-27: volume is CONTRACT COUNT (see normalizeMarket fix above), not dollars.
// 2000 contracts at typical NFL game-line prices (~$0.20-$0.80) is roughly $400-$1,600 of
// real flow -- an approximation, not a confirmed dollar figure. Still a first-cut default.
const STEAM_MIN_PP = 5;
const STEAM_MIN_VOL_ADDED = 2000; // contracts, not dollars
const STEAM_MIN_VOL_PCT = 0.15;

/* STEAM SCORE 2026-08-28 (per Derek + council): 0-100 score for the new unified Converge
   Score -- steam detection previously only produced a yes/no event with raw movePP/
   volumeAdded, no single number to blend with other pillars. First-cut bands, not
   independently validated -- same posture as every other new score shipped this
   session. Move dominates (it's the real signal); volume is a secondary confidence
   multiplier, not a separate additive term, so a huge-volume/tiny-move market can't
   outscore a real, sharp move on thin volume. */
function steamScore(movePP, volumeAdded) {
  const absMove = Math.abs(movePP);
  let base = absMove >= 15 ? 85 : absMove >= 10 ? 70 : absMove >= 7 ? 55 : absMove >= 5 ? 40 : 20;
  const volBonus = volumeAdded >= 10000 ? 15 : volumeAdded >= 5000 ? 10 : volumeAdded >= 2000 ? 5 : 0;
  return Math.min(100, base + volBonus);
}
const SNAPSHOT_TTL = 3 * 24 * 60 * 60; // 3 days -- plenty of headroom over the ~30-min cadence

async function detectSteam(sport) {
  const data = await getKalshi(sport);
  if (!data.ok) return { ok: false, sport, error: data.error, steamMarkets: [] };

  const snapKey = `kalshi:steamsnap:${sport}`;
  const prevRaw = await kv(['GET', snapKey]);
  let prev = {};
  if (prevRaw.ok && prevRaw.result) {
    try { prev = typeof prevRaw.result === 'string' ? JSON.parse(prevRaw.result) : prevRaw.result; } catch {}
  }

  const now = Date.now();
  const nextSnap = {};
  const steamMarkets = [];

  for (const m of data.markets) {
    if (!m.ticker || m.impliedProb === null) continue;
    nextSnap[m.ticker] = { impliedProb: m.impliedProb, volume: m.volume || 0, at: now };

    const p = prev[m.ticker];
    if (!p) continue; // first time seeing this market -- nothing to compare against yet

    const movePP = Math.round((m.impliedProb - p.impliedProb) * 1000) / 10;
    const volAdded = (m.volume || 0) - (p.volume || 0);
    const volPct = p.volume > 0 ? volAdded / p.volume : (volAdded > 0 ? Infinity : 0);
    const windowMs = now - p.at;

    const clearsVolBar = volAdded >= STEAM_MIN_VOL_ADDED && (p.volume < 100 || volPct >= STEAM_MIN_VOL_PCT);
    const clearsPriceBar = Math.abs(movePP) >= STEAM_MIN_PP;

    if (clearsVolBar && clearsPriceBar) {
      steamMarkets.push({
        ticker: m.ticker, title: m.title, yesSubTitle: m.yesSubTitle,
        movePP, direction: movePP > 0 ? 'toward YES' : 'toward NO',
        volumeAdded: volAdded, windowMinutes: Math.round(windowMs / 60000),
        currentImpliedProb: m.impliedProb, priorImpliedProb: p.impliedProb,
        score: steamScore(movePP, volAdded),
      });
    }
  }

  await kv(['SET', snapKey, JSON.stringify(nextSnap), 'EX', String(SNAPSHOT_TTL)]);

  return {
    ok: true, sport, marketsTracked: Object.keys(nextSnap).length,
    steamCount: steamMarkets.length, steamMarkets, checkedAt: now,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.query && req.query.steam) {
    const sport = String(req.query.steam).toUpperCase();
    try {
      return res.status(200).json(await detectSteam(sport));
    } catch (err) {
      return res.status(200).json({ ok: false, sport, error: err.message, steamMarkets: [] });
    }
  }

  const sport = String((req.query && req.query.sport) || 'MLB').toUpperCase();
  try {
    const data = await getKalshi(sport);
    // Optional join: ?away=Chicago Cubs&home=Pittsburgh Pirates
    if (req.query && req.query.away && req.query.home) {
      data.matched = matchGame(data.markets, req.query.away, req.query.home);
      data.matchedCount = data.matched.length;
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message, sport });
  }
};
module.exports.getKalshi = getKalshi;
module.exports.matchGame = matchGame;
module.exports.normalizeMarket = normalizeMarket;
module.exports.compareToPinnacle = compareToPinnacle;
module.exports.kalshiFee = kalshiFee;
module.exports.SERIES = SERIES;
module.exports.detectSteam = detectSteam;
