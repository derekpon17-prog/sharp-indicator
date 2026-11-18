/* One-off: match tonight's NBA games against confirmed_sharp/confirmed_loser wallets from wallets.json,
   by scanning recent Polymarket trades and matching team-name tokens in the market title/slug. */
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
  for (const g of GAMES) {
    if (t.includes(g.away.toLowerCase()) && t.includes(g.home.toLowerCase())) return g;
  }
  return null;
}

async function j(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!r.ok) { console.log('HTTP', r.status, url); return null; }
  return r.json();
}

(async () => {
  // build wallet -> {sport, bucket, roi, pnl} lookup for NBA sharp/loser
  const byWallet = {};
  for (const sp of Object.keys(wallets.sports)) {
    const o = wallets.sports[sp];
    for (const r of o.confirmed_sharp || []) byWallet[r.wallet.toLowerCase()] = { sport: sp, bucket: 'sharp', pre: r.pre, post: r.post, name: r.name };
    for (const r of o.confirmed_loser || []) byWallet[r.wallet.toLowerCase()] = { sport: sp, bucket: 'loser', pre: r.pre, post: r.post, name: r.name };
  }
  console.log('tracked wallets (sharp+loser, all sports):', Object.keys(byWallet).length);

  // scan recent trades, paged, looking for matches on tonight's games
  const hits = [];
  let cursor = null;
  for (let pg = 0; pg < 15; pg++) {
    const d = await j(`${V2}/trades?limit=500` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    if (!d) break;
    const rows = Array.isArray(d) ? d : (d.data || []);
    if (!rows.length) break;
    for (const t of rows) {
      const g = matchGame(t.title, t.slug || t.eventSlug || t.event_slug);
      if (!g) continue;
      const w = (t.proxyWallet || t.proxy_wallet || '').toLowerCase();
      const known = byWallet[w];
      hits.push({
        game: g.away + ' at ' + g.home, title: t.title, outcome: t.outcome, side: t.side,
        size: t.size, price: t.price, wallet: w, known: known || null,
        ts: t.timestamp,
      });
    }
    cursor = d.pagination && d.pagination.next_cursor;
    if (!cursor) break;
  }
  console.log('total trades scanned, matched to tonight NBA games:', hits.length);
  fs.writeFileSync('tonight_hits.json', JSON.stringify(hits, null, 1));
  const known = hits.filter(h => h.known);
  console.log('of those, from a TRACKED (sharp or loser) wallet:', known.length);
  known.forEach(h => console.log(JSON.stringify(h)));
})();
