const { analyzeGame, SHARP_BOOKS, SOFT_BOOKS } = require('../lib/analyze');

const SPORT_KEYS = {
  MLB: 'baseball_mlb',
  NFL: 'americanfootball_nfl',
  NBA: 'basketball_nba',
  NHL: 'icehockey_nhl',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sport    = (req.query.sport || 'MLB').toUpperCase();
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return res.status(400).json({ error: `Unknown sport: ${sport}` });

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ODDS_API_KEY is not set',
      setup: 'Go to Vercel → your project → Settings → Environment Variables → add ODDS_API_KEY',
    });
  }

  const books = [...SHARP_BOOKS, ...SOFT_BOOKS].join(',');
  const url   = [
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`,
    `?apiKey=${apiKey}`,
    `&regions=us`,
    `&markets=h2h,spreads,totals`,
    `&bookmakers=${books}`,
    `&oddsFormat=american`,
  ].join('');

  try {
    const upstream = await fetch(url);
    const rem  = upstream.headers.get('x-requests-remaining');
    const used = upstream.headers.get('x-requests-used');
    if (rem)  res.setHeader('x-requests-remaining', rem);
    if (used) res.setHeader('x-requests-used', used);

    if (upstream.status === 401) {
      return res.status(200).json({
        plays: [],
        error: 'Invalid API key — check ODDS_API_KEY in Vercel environment variables',
        quota: { remaining: null, used: null },
      });
    }
    if (upstream.status === 422) {
      return res.status(200).json({
        plays: [],
        message: `${sport} is not currently in season`,
        quota: { remaining: rem, used },
      });
    }
    if (!upstream.ok) {
      return res.status(200).json({
        plays: [],
        error: `Odds API returned status ${upstream.status}`,
        quota: { remaining: rem, used },
      });
    }

    const games    = await upstream.json();
    const now      = Date.now();
    const upcoming = (Array.isArray(games) ? games : []).filter(g => {
      const ct = new Date(g.commence_time).getTime();
      return ct > now && ct < now + 86_400_000;
    });

    const plays = upcoming
      .map(analyzeGame)
      .filter(p => p !== null && p.pillars.pinnacle > 0)
      .sort((a, b) => b.siScore - a.siScore);

    res.status(200).json({
      plays,
      total: upcoming.length,
      quota: { remaining: rem, used },
    });

  } catch (err) {
    console.error('odds.js error:', err.message);
    res.status(200).json({
      plays: [],
      error: err.message,
      quota: { remaining: null, used: null },
    });
  }
};
