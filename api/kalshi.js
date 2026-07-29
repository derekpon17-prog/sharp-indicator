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
  const cents = (v) => (typeof v === 'number' && isFinite(v) ? v / 100 : null);
  const yesBid = cents(m.yes_bid), yesAsk = cents(m.yes_ask), last = cents(m.last_price);
  // Mid is the fairest single read; fall back to last trade when the book is one-sided.
  const mid = (yesBid !== null && yesAsk !== null) ? (yesBid + yesAsk) / 2 : last;
  return {
    ticker: m.ticker || null,
    eventTicker: m.event_ticker || null,
    title: m.title || null,
    yesSubTitle: m.yes_sub_title || m.subtitle || null,
    yesBid, yesAsk, last,
    impliedProb: mid,
    spreadPP: (yesBid !== null && yesAsk !== null) ? Math.round((yesAsk - yesBid) * 1000) / 10 : null,
    volume: m.volume ?? null,
    openInterest: m.open_interest ?? null,
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
