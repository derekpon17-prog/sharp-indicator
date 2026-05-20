const { analyzeGame, SOFT_KEYS } = require('../lib/analyze');

const SPORT_KEYS = {
  MLB:  'baseball_mlb',
  NFL:  'americanfootball_nfl',
  NBA:  'basketball_nba',
  NHL:  'icehockey_nhl',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sport    = req.query.sport || 'MLB';
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return res.status(400).json({ error: 'Unknown sport' });

  const key = process.env.ODDS_API_KEY;
  if (!key) return res.status(500).json({ error: 'ODDS_API_KEY not configured' });

  const bookmakers = ['pinnacle', ...SOFT_KEYS].join(',');
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${key}&regions=us&markets=h2h,spreads,totals&bookmakers=${bookmakers}&oddsFormat=american`;

  try {
    const upstream = await fetch(url);

    // Forward quota headers to client
    const rem  = upstream.headers.get('x-requests-remaining');
    const used = upstream.headers.get('x-requests-used');
    if (rem)  res.setHeader('x-requests-remaining', rem);
    if (used) res.setHeader('x-requests-used', used);

    if (upstream.status === 401)
      return res.status(401).json({ error: 'Invalid Odds API key' });
    if (upstream.status === 422)
      return res.status(200).json({ plays: [], message: 'Sport not in season' });
    if (!upstream.ok)
      return res.status(upstream.status).json({ error: `Odds API error ${upstream.status}` });

    const games = await upstream.json();

    // Filter to games starting within the next 24 hours
    const now      = Date.now();
    const upcoming = (Array.isArray(games) ? games : []).filter(g => {
      const ct = new Date(g.commence_time).getTime();
      return ct > now && ct < now + 86_400_000;
    });

    // Analyse and score each game
    const plays = upcoming
      .map(analyzeGame)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    res.status(200).json({ plays, quota: { remaining: rem, used } });
  } catch (err) {
    console.error('odds.js error:', err);
    res.status(500).json({ error: err.message });
  }
};
