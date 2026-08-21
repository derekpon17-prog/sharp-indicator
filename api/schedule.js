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
  // BUGFIX 2026-08-08 (per council audit): was keyed NCAAFB here specifically, while
  // detectSport() (client), LEAGUE_BY_SLUG (discover.js), and NCAAF conference tracking
  // all already use NCAAF consistently. Since isLiveAlert()'s same-sport-coverage check
  // compares this key against a.sport (which is always "NCAAF"), the mismatch meant
  // "NCAAFB" !== "NCAAF" would never match — silently defeating the started/live-game
  // filter specifically for college football, the exact bug already fixed for NFL.
  NCAAF: 'americanfootball_ncaaf',
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

// BUGFIX 2026-08-21 (per Derek, real incident): confirmed directly -- The Odds API's
// americanfootball_nfl events endpoint only carries REGULAR SEASON games (earliest entry
// starts Sept 10), zero preseason coverage. Texans vs. Raiders (Aug 20, preseason week 2)
// simply doesn't exist in that data source at all, so findGameForTrade could never match
// it, and the dashboard's "has this game started" check silently failed open for the
// entire preseason. This is a genuine data coverage gap, not a logic bug -- same class of
// issue the MLB ESPN fallback in polymarket-notify.js already solves, applied here for
// NFL specifically. ESPN's scoreboard covers preseason games directly (confirmed: this is
// literally how the real Texans/Raiders final score was verified). Added as a SUPPLEMENT,
// not a replacement -- merged alongside whatever The Odds API already provides, same
// "don't lose what's already working" pattern as every other fix like this this session.
async function fetchNflFromESPN() {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
    const yesterdayET = new Date(Date.now() - 24 * 3600000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
    const dates = [...new Set([todayET, yesterdayET])];
    const allEvents = [];
    for (const d of dates) {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${d}`);
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
        sport: 'NFL',
        away: away.team && (away.team.displayName || away.team.name),
        home: home.team && (home.team.displayName || home.team.name),
        commenceTime: ev.date,
        started: !!(comp.status && comp.status.type && comp.status.type.state !== 'pre'),
      };
    }).filter(g => g && g.away && g.home && g.commenceTime);
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
    const nflEspn = await fetchNflFromESPN();
    // Merge, don't duplicate: keep The Odds API's NFL entries as-is (regular season,
    // wherever it has them) and only ADD ESPN games not already covered by team+date.
    const existingNflKeys = new Set(
      results.flat().filter(g => g.sport === 'NFL').map(g => `${g.away}|${g.home}|${(g.commenceTime||'').slice(0,10)}`)
    );
    const newFromEspn = nflEspn.filter(g => !existingNflKeys.has(`${g.away}|${g.home}|${(g.commenceTime||'').slice(0,10)}`));
    const schedule = results.flat().concat(newFromEspn);
    await upstash(['SET', CACHE_KEY, JSON.stringify({ schedule, fetchedAt: Date.now() }), 'EX', String(CACHE_TTL_SEC * 2)]);
    return res.status(200).json({ schedule, cached: false });
  } catch (err) {
    return res.status(200).json({ schedule: [], error: err.message });
  }
};
