/* scripts/poly_alert.js  (council, Nov 20 2026 - "late Polymarket money")
   After a sport's Polymarket report card has posted (POLY_<sport> in sf_branch/previews.json for today), a wallet can
   still buy a side before the game starts. This compares the fresh poly_matches.json with the previous run's copy and
   sends one alert card per sport when, on a game that hasn't started:
   - a HOT wallet shows up on a side it wasn't on before, or
   - a HOT wallet at least doubles its dollars on a side (and adds $500+).
   COLD wallets, two-sided wallets and HOT wallets that are the same bettor as a SharpFlow ticket never alert.
   Each wallet/side alerts once per size level (sf_branch/poly_alerted.json), so a rerun can't repeat it.

   CLI: node scripts/poly_alert.js <sf_dir> <prev poly_matches.json> <card dir>   (NO_MARK=1: build, don't record) */
const fs = require('fs');
const [sfDir = 'sf_branch', prevFile = 'poly_prev.json', cardDir = 'cards'] = process.argv.slice(2);
const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
const ctDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
const ctTime = d => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(d).toLowerCase().replace(' ', '');
const k = n => n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${Math.round(n)}`;
const amer = p => !(p > 0 && p < 1) ? null : Math.round(p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const cur = read(sfDir + '/poly_matches.json', {}), prev = read(prevFile, {});
const posted = read(sfDir + '/previews.json', {})[ctDay(now)] || [];
const alerted = read(sfDir + '/poly_alerted.json', {});
const key = m => [m.sport, m.matchup, m.market, m.side, m.wallet].join('|');
const before = {}; for (const m of prev.matches || []) before[key(m)] = m;

function bet(m) {
  if (m.market === 'TOTAL') { const l = String(m.title || '').match(/O\/U\s+([\d.]+)/i); return `${m.side}${l ? ' ' + l[1] : ''}`; }
  if (m.market === 'SPREAD') { const l = String(m.title || '').match(/\(([+-][\d.]+)\)/); const fav = String(m.title || '').replace(/^spread:\s*/i, '').replace(/\(.*$/, '').trim();
    if (l) { const v = parseFloat(l[1]); const mine = fav.toLowerCase() === String(m.side).toLowerCase(); return `${m.side} ${mine ? (v > 0 ? '+' : '') + v : (v > 0 ? '-' : '+') + Math.abs(v)}`; } return `${m.side} spread`; }
  return `${m.side} ML`;
}

const hits = [];
if (!prev.matches) console.log('poly_alert: no previous run to compare with - nothing alerts this time');
else for (const m of cur.matches || []) {
  if (m.cls !== 'HOT' || m.sameAsSF || m.twoSided || !m.startUtc) continue;
  if (new Date(m.startUtc) <= now) continue;
  if (!posted.includes('POLY_' + m.sport)) continue;          // the report card covers it until it has posted
  const p = before[key(m)];
  const isNew = !p, sizedUp = p && m.usd >= 2 * p.usd && m.usd - p.usd >= 500;
  if (!isNew && !sizedUp) continue;
  const level = Math.floor(Math.log2(Math.max(m.usd, 1)));    // one alert per doubling
  if (((alerted[key(m)] || {}).l ?? -1) >= level) continue;
  hits.push({ m, p, isNew, level });
}

if (!hits.length) { console.log('poly_alert: no late HOT money'); process.exit(0); }
fs.mkdirSync(cardDir, { recursive: true });
const bySport = {};
for (const h of hits) (bySport[h.m.sport] ||= []).push(h);
const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(':', '');
for (const [sp, hs] of Object.entries(bySport)) {
  hs.sort((a, b) => new Date(a.m.startUtc) - new Date(b.m.startUtc) || b.m.usd - a.m.usd);
  const secs = [];
  for (const { m, p, isNew } of hs) {
    const st = new Date(m.startUtc), h = `${sp} - ${ctTime(st).toUpperCase()} CT`;
    let sec = secs.find(x => x.heading === h); if (!sec) secs.push(sec = { heading: h, picks: [] });
    const chips = [{ t: `HOT ${m.name} ${k(m.usd)}`, c: 'green' },
      { t: isNew ? 'NEW since the report' : `sized up from ${k(p.usd)}`, c: 'green' }];
    if (m.rec) chips.push({ t: `${sp} ${m.market} ${m.rec}${m.roi != null ? ` (${m.roi >= 0 ? '+' : ''}${Math.round(m.roi)}%)` : ''} last 45d`, c: 'grey' });
    if (m.l10) chips.push({ t: m.l10.txt, c: 'grey' });
    if (!m.onCard) chips.push({ t: 'SF no money here', c: 'grey' });
    sec.picks.push({ bet: bet(m), sub: `${m.matchup} - ${ctTime(st)} CT - last buy ${m.lastBuyUtc ? ctTime(new Date(m.lastBuyUtc)) : '?'} CT`, chips, price: amer(m.avgPrice), polyHot: 1, polyCold: 0 });
  }
  const card = { route: 'Sharp Signals', content: `**Polymarket late money - ${sp}** - ${hs.length} HOT wallet move${hs.length === 1 ? '' : 's'} since the ${sp} Polymarket report`,
    boards: [{ brand: 'POLYMARKET', title: `${sp} - Polymarket late money`,
      subtitle: `HOT wallets that bought (or doubled up) after the ${sp} report posted, games not started. Buys checked ${cur.at ? ctTime(new Date(cur.at)) : 'n/a'} CT`,
      sections: secs, legend: 'Price = their average Polymarket price as American odds. In-game buys are not counted.', footer: 'Wallet money, not a pick. Leans, not guarantees' }] };
  const f = `${cardDir}/${ctDay(now)}-${hhmm}-polylate-${sp.toLowerCase()}.json`;
  fs.writeFileSync(f, JSON.stringify(card, null, 1));
  console.log('poly_alert: wrote', f, hs.map(h => `${h.m.name} ${bet(h.m)} ${k(h.m.usd)}`).join('; '));
}
if (!process.env.NO_MARK) {
  for (const h of hits) alerted[key(h.m)] = { l: h.level, s: h.m.startUtc };
  for (const [kk, v] of Object.entries(alerted)) if (!v || !v.s || Date.parse(v.s) < +now - 2 * 86400000) delete alerted[kk];   // games 2+ days old
  fs.writeFileSync(sfDir + '/poly_alerted.json', JSON.stringify(alerted));
}
