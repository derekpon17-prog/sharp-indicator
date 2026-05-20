const { analyzeGame, SOFT_KEYS } = require('../lib/analyze');

const SPORTS = {
  MLB: 'baseball_mlb',
  NFL: 'americanfootball_nfl',
  NBA: 'basketball_nba',
  NHL: 'icehockey_nhl',
};

const SCORE_THRESHOLD = parseInt(process.env.SHARP_THRESHOLD || '70');

async function fetchSport(sportKey, apiKey) {
  const bookmakers = ['pinnacle', ...SOFT_KEYS].join(',');
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&bookmakers=${bookmakers}&oddsFormat=american`;
  const res  = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function sendNotification(plays, topic) {
  if (!topic || !plays.length) return;

  const top   = plays[0];
  const extra = plays.length > 1 ? `\n+${plays.length - 1} more sharp play${plays.length > 2 ? 's' : ''} detected` : '';

  const sportLabel = Object.entries(SPORTS)
    .find(([, v]) => v === top.sportKey)?.[0] || '';

  await fetch(`https://ntfy.sh/${topic}`, {
    method:  'POST',
    headers: {
      'Title':        `${top.score}% Sharp — ${sportLabel} ${top.away} @ ${top.home}`,
      'Priority':     top.score >= 85 ? 'urgent' : top.score >= 75 ? 'high' : 'default',
      'Tags':         'chart_with_upwards_trend,sports_medal',
      'Content-Type': 'text/plain',
    },
    body: [
      `▶ ${top.sharpSide}`,
      `Pinnacle: ${top.pinnacleLine}  |  Market avg: ${top.softLine}`,
      `Pinnacle gap: ${top.gapPP}pp across ${top.numBooks} books`,
      extra,
    ].filter(Boolean).join('\n'),
  });
}

module.exports = async function handler(req, res) {
  // Vercel automatically validates cron requests — add CRON_SECRET for extra safety
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ODDS_API_KEY not set' });

  const allPlays = [];
  const now      = Date.now();

  for (const [label, key] of Object.entries(SPORTS)) {
    try {
      const games    = await fetchSport(key, apiKey);
      const upcoming = games.filter(g => {
        const ct = new Date(g.commence_time).getTime();
        return ct > now && ct < now + 86_400_000;
      });

      upcoming.forEach(game => {
        const play = analyzeGame(game);
        if (play && play.score >= SCORE_THRESHOLD) {
          allPlays.push({ ...play, sportKey: key, sportLabel: label });
        }
      });
    } catch (err) {
      console.error(`cron error for ${label}:`, err.message);
    }
  }

  allPlays.sort((a, b) => b.score - a.score);

  if (allPlays.length > 0) {
    await sendNotification(allPlays, process.env.NTFY_TOPIC);
  }

  res.status(200).json({
    checked:   new Date().toISOString(),
    playsFound: allPlays.length,
    threshold:  SCORE_THRESHOLD,
    top:        allPlays[0] || null,
  });
};
