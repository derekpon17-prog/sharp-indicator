/* v2: instead of scanning the global feed (thin overlap with only ~36 tracked wallets),
   pull each tracked wallet's own recent trade history directly and check for tonight's games. */
const fs = require('fs');
const wallets = JSON.parse(fs.readFileSync('wallets.json', 'utf8'));
const V2 = 'https://data-api.polymarket.com/v2';

const GAMES = [
  { sport: 'NBA', away: '76ers', home: 'Magic' },
  { sport: 'NBA', away: 'Bucks', home: 'Heat' },
  { sport: 'NBA', away: 'Bulls', home: 'Nets' },
  { sport: 'NBA', away: 'Rockets', home: 'Pacers' },
  { sport: 'NBA', away: 'Warriors', home: 'Mavericks' },
];
function matchGame(title, slug) {
  const t = (String(title || '') + ' ' + String(slug || '')).toLowerCase();
  for (const g of GAMES) if (t.includes(g.away.toLowerCase()) && t.includes(g.home.toLowerCase())) return g;
  return null;
}
async function j(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

(async () => {
  const tracked = [];
  for (const sp of Object.keys(wallets.sports)) {
    const o = wallets.sports[sp];
    for (const r of o.confirmed_sharp || []) tracked.push({ wallet: r.wallet, sport: sp, bucket: 'sharp', pre: r.pre, post: r.post, name: r.name });
    for (const r of o.confirmed_loser || []) tracked.push({ wallet: r.wallet, sport: sp, bucket: 'loser', pre: r.pre, post: r.post, name: r.name });
  }
  console.log('tracked wallets to check:', tracked.length);
  const hits = [];
  for (const w of tracked) {
    const d = await j(`${V2}/trades?user=${w.wallet}&side=BUY&limit=100`);
    const rows = d ? (Array.isArray(d) ? d : (d.data || [])) : [];
    for (const t of rows) {
      const g = matchGame(t.title, t.slug || t.eventSlug || t.event_slug);
      if (!g) continue;
      hits.push({ game: g.away + ' at ' + g.home, wallet: w.wallet, name: w.name, sport: w.sport, bucket: w.bucket,
        pre: w.pre, post: w.post, title: t.title, outcome: t.outcome, size: t.size, price: t.price, ts: t.timestamp });
    }
  }
  console.log('hits on tonight games from tracked wallets:', hits.length);
  fs.writeFileSync('tonight_hits2.json', JSON.stringify(hits, null, 1));
  hits.forEach(h => console.log(JSON.stringify(h)));
})();
