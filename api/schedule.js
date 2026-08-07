/* =========================================================
   api/schedule.js
   PURPOSE (per Derek, 2026-08-07): fixed a real bug where a completed NFL preseason game
   (Panthers 33, Cardinals 30 — the Hall of Fame Game) was still showing on the dashboard
   as an active "Top Play Today" recommendation, hours after it ended. Root cause: the
   client's only source of "has this game started?" data was /api/odds, which only ever
   requests sport=MLB (matching ACTIVE_LINE_SPORTS, scoped for Sharp Line's paid signal
   generation). Any other sport had zero commence-time data to check against, so the
   started-check silently defaulted to false regardless of real-world game state.

   This is a SEPARATE, DECOUPLED fix — it does NOT turn on Sharp Line scoring for any new
   sport (that stays exactly as scoped in ACTIVE_LINE_SPORTS, a bigger decision requiring
   real calibration). It only answers "has this game started," for every sport at once,
   using The Odds API's /events endpoint — which is explicitly documented as FREE, zero
   quota cost, no markets/regions requested, just event listings with commence_time.

   Per Derek: "every sport coming up will fall off" — this covers every sport in
   SPORT_KEYS generically, so a new sport coming into season (NBA/NHL in the fall, NCAAF
   in September) gets correct started-detection automatically, with no per-sport code
   change needed — only a genuinely new sport type would ever need a key added below.

   Cached briefly in KV (10 min) — /events is free on quota, but there's no reason to
   refetch on every single page load either.
   ========================================================= */

const SPORT_KEYS = {
  MLB: 'baseball_mlb',
  NFL: 'americanfootball_nfl',
  NBA: 'basketball_nba',
  NHL: 'icehockey_nhl',
  WNBA: 'basketball_wnba',
  NCAAFB: 'americanfootball_ncaaf',
  NCAAB: 'basketball_ncaab',
};

const CACHE_KEY = 'schedule:all-sports';
const CACHE_TTL_SEC = 600; // 10 min — free endpoint, but no reason to hammer it every load

async function upstash(body) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    return d.result ?? null;
  } catch { return null; }
}

async function fetchEventsForSport(sport, sportKey, apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${apiKey}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const events = await r.json();
    const now = Date.now();
    return (Array.isArray(events) ? events : []).map(e => ({
      sport,
      away: e.away_team || null,
      home: e.home_team || null,
      commenceTime: e.commence_time || null,
      started: !!(e.commence_time && now >= new Date(e.commence_time).getTime()),
    })).filter(g => g.away && g.home && g.commenceTime);
  } catch {
    return [];
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return res.status(200).json({ schedule: [], error: 'ODDS_API_KEY not configured' });

  // Serve from cache if fresh — /events is free but this is still a well-mannered default.
  const cached = await upstash(['GET', CACHE_KEY]);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.fetchedAt && Date.now() - parsed.fetchedAt < CACHE_TTL_SEC * 1000) {
        return res.status(200).json({ schedule: parsed.schedule, cached: true });
      }
    } catch { /* fall through to a fresh fetch */ }
  }

  try {
    const results = await Promise.all(
      Object.entries(SPORT_KEYS).map(([sport, key]) => fetchEventsForSport(sport, key, apiKey))
    );
    const schedule = results.flat();
    await upstash(['SET', CACHE_KEY, JSON.stringify({ schedule, fetchedAt: Date.now() }), 'EX', String(CACHE_TTL_SEC * 2)]);
    return res.status(200).json({ schedule, cached: false });
  } catch (err) {
    return res.status(200).json({ schedule: [], error: err.message });
  }
};
