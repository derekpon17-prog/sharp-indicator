/* api/report-image.js
   Renders the Converge Score Report as a real PNG image using satori + @resvg/resvg-js
   -- the same rendering engine behind @vercel/og, run as a regular Node serverless
   function (not Edge) specifically so the embedded MLB/NFL team logos (~1.4MB total)
   aren't constrained by Edge Runtime's much tighter function size limits.

   MLB and NFL logos are bundled locally (team_logos_data.js) -- real, verified logos
   pulled from MLBAMGames/mlb_teams_logo_svg and ChrisKatsaras/React-NFL-Logos, converted
   once and embedded as base64 so no network fetch is needed for those two sports at
   render time. NCAAF has no equivalent clean open-source bundle (130+ FBS teams), so its
   logos are fetched dynamically from ESPN's own scoreboard API at render time -- this
   works from Vercel's network (already proven: getScheduleFromESPN in polymarket-notify.js
   hits the same ESPN API today), even though it isn't reachable from every environment.

   GET /api/report-image?sports=MLB,NFL,NCAAF
   Returns: image/png
*/

const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');
const teamLogos = require('./team_logos_data.js');

const SITE_URL = 'https://sharp-indicator-a34j.vercel.app';

let cachedFonts = null;
async function getFonts() {
  if (cachedFonts) return cachedFonts;
  // Google Fonts' raw TTF endpoints are stable, direct-download URLs -- fetched once per
  // cold start and reused for the life of the function instance, not on every request.
  const [regular, bold] = await Promise.all([
    fetch('https://raw.githubusercontent.com/googlefonts/opensans/main/fonts/ttf/OpenSans-Regular.ttf').then(r => r.arrayBuffer()),
    fetch('https://raw.githubusercontent.com/googlefonts/opensans/main/fonts/ttf/OpenSans-Bold.ttf').then(r => r.arrayBuffer()),
  ]);
  cachedFonts = [
    { name: 'Open Sans', data: Buffer.from(regular), weight: 400, style: 'normal' },
    { name: 'Open Sans', data: Buffer.from(bold), weight: 700, style: 'normal' },
  ];
  return cachedFonts;
}

// ESPN scoreboard responses include each team's real logo URL directly -- no separate
// team-ID lookup table needed. Cached per college-football fetch since one scoreboard
// call covers every game that day, not one call per team.
let ncaafLogoCache = null;
async function getNcaafLogoUrl(teamName) {
  if (!ncaafLogoCache) {
    ncaafLogoCache = {};
    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${today}&groups=80&limit=200`);
      const j = await r.json();
      (j.events || []).forEach(ev => {
        const comp = ev.competitions && ev.competitions[0];
        (comp && comp.competitors || []).forEach(c => {
          const name = c.team && (c.team.displayName || c.team.name);
          const logo = c.team && c.team.logos && c.team.logos[0] && c.team.logos[0].href;
          if (name && logo) ncaafLogoCache[name] = logo;
        });
      });
    } catch { /* leave cache empty -- falls back to no-logo rendering below */ }
  }
  return ncaafLogoCache[teamName] || null;
}

async function toDataUri(sport, teamName) {
  if (sport === 'NCAAF') {
    const url = await getNcaafLogoUrl(teamName);
    if (!url) return null;
    try {
      const r = await fetch(url);
      const buf = Buffer.from(await r.arrayBuffer());
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch { return null; }
  }
  const table = sport === 'NFL' ? teamLogos.nfl : teamLogos.mlb;
  const b64 = table && table[teamName];
  return b64 ? `data:image/png;base64,${b64}` : null;
}

function tierColor(score) {
  if (score >= 85) return '#E5A00D';
  if (score >= 75) return '#00C896';
  return '#40B4FF';
}
function tierName(score) {
  if (score >= 85) return 'ELITE';
  if (score >= 75) return 'STRONG';
  return 'MODERATE';
}
function marketLabel(mk) {
  return { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' }[mk] || 'Moneyline';
}

async function playCard(p) {
  const cs = p.convergeScore || { score: p.siScore || 0, breakdown: { book: { score: p.siScore || 0 } } };
  const color = tierColor(cs.score);
  const isTotal = (p.market || p.activeMarket) === 'totals';

  const logoEls = [];
  if (isTotal) {
    const [awayUri, homeUri] = await Promise.all([toDataUri(p.sport, p.away), toDataUri(p.sport, p.home)]);
    if (awayUri) logoEls.push({ type: 'img', props: { src: awayUri, width: 44, height: 44 } });
    if (awayUri && homeUri) logoEls.push({ type: 'div', props: { style: { fontSize: 16, color: '#5a5a66', margin: '0 4px', display: 'flex' }, children: '@' } });
    if (homeUri) logoEls.push({ type: 'img', props: { src: homeUri, width: 44, height: 44 } });
  } else {
    // Pick side names a specific team -- show that team's logo, not both.
    const pickedTeam = [p.away, p.home].find(t => (p.sharpSide || '').includes(t)) || p.home;
    const uri = await toDataUri(p.sport, pickedTeam);
    if (uri) logoEls.push({ type: 'img', props: { src: uri, width: 52, height: 52, style: { display: 'flex' } } });
  }

  const poly = cs.breakdown && cs.breakdown.poly;
  const polyNames = (poly && poly.traderNames) || [];

  return {
    type: 'div', props: {
      style: { display: 'flex', flexDirection: 'column', padding: '22px 26px', backgroundColor: '#1a1a24', borderRadius: 14, borderLeft: `5px solid ${color}`, marginTop: 18 },
      children: [
        { type: 'div', props: { style: { fontSize: 15, color: '#ffffff', display: 'flex' }, children: `${p.away} @ ${p.home}` } },
        { type: 'div', props: {
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
            children: [
              { type: 'div', props: {
                  style: { display: 'flex', alignItems: 'center' },
                  children: [
                    ...(logoEls.length ? [{ type: 'div', props: { style: { display: 'flex', alignItems: 'center', marginRight: 14 }, children: logoEls } }] : []),
                    { type: 'div', props: { style: { display: 'flex', fontSize: 24, fontWeight: 700, color: '#0d0d12', backgroundColor: color, padding: '8px 16px', borderRadius: 8 }, children: p.sharpSide || '—' } },
                  ],
                } },
              { type: 'div', props: {
                  style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 32, fontWeight: 700, color, display: 'flex' }, children: String(cs.score) } },
                    { type: 'div', props: { style: { fontSize: 14, fontWeight: 700, color, display: 'flex' }, children: tierName(cs.score) } },
                  ],
                } },
            ],
          } },
        { type: 'div', props: { style: { fontSize: 16, color: '#9ca3af', marginTop: 14, display: 'flex' }, children:
          (p.currentPinPrice != null && p.currentSoftAvg != null)
            ? `Pinnacle ${p.currentPinPrice > 0 ? '+' : ''}${p.currentPinPrice} vs ${p.currentSoftAvg > 0 ? '+' : ''}${p.currentSoftAvg} avg`
            : (p.gapPP != null ? `Pinnacle gap ${p.gapPP}pp` : 'Pinnacle: —') } },
        ...(polyNames.length ? [{ type: 'div', props: {
            style: { display: 'flex', flexDirection: 'column', marginTop: 10 },
            children: polyNames.map(n => ({ type: 'div', props: { style: { fontSize: 16, color: '#7ee787', marginTop: 4, display: 'flex' }, children: `\u2713 ${n}` } })),
          } }] : []),
      ],
    },
  };
}

module.exports = async function handler(req, res) {
  try {
    const sports = ((req.query && req.query.sports) || 'MLB').split(',').map(s => s.trim().toUpperCase());
    const allPlays = [];
    const errors = [];
    for (const sp of sports) {
      try {
        const r = await fetch(`${SITE_URL}/api/odds?sport=${sp}`);
        const d = await r.json();
        (d.plays || []).forEach(p => {
          const cs = p.convergeScore && p.convergeScore.score;
          if (!p.noSignal && typeof cs === 'number' && cs >= 75) allPlays.push({ ...p, sport: sp });
        });
      } catch (e) { errors.push(`${sp}: ${e.message}`); }
    }
    allPlays.sort((a, b) => (b.convergeScore.score) - (a.convergeScore.score));

    const cards = await Promise.all(allPlays.slice(0, 10).map(playCard));
    const fonts = await getFonts();

    const tree = {
      type: 'div', props: {
        style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: '#0d0d12', padding: '36px 40px', fontFamily: 'Open Sans' },
        children: [
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center' }, children: [
              { type: 'div', props: { style: { fontSize: 30, marginRight: 10, display: 'flex' }, children: '\u{1F3AF}' } },
              { type: 'div', props: { style: { fontSize: 30, fontWeight: 700, color: '#fff', display: 'flex' }, children: 'Converge Score Report' } },
            ] } },
          { type: 'div', props: { style: { fontSize: 18, color: '#9ca3af', marginTop: 6, display: 'flex' }, children: sports.join(' / ') } },
          ...(cards.length ? cards : [{ type: 'div', props: { style: { fontSize: 18, color: '#9ca3af', marginTop: 24, display: 'flex' }, children: 'Nothing cleared the 75+ threshold right now.' } }]),
        ],
      },
    };

    const height = 140 + cards.length * 190 + (cards.length ? 0 : 60);
    const svg = await satori(tree, { width: 900, height: Math.max(height, 300), fonts });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 900 } }).render().asPng();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
