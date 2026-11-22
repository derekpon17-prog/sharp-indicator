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
/* Nov 22 2026 (Derek): when the game also has a Sharp Flow card, the late Poly buy goes on THAT card (Sharp Flow rows + every Poly
   wallet on the game), not on a separate Polymarket card. Games with no Sharp Flow side keep the stand-alone Poly card. */
const R = require('./sf_rules.js');
const latest = read(sfDir + '/latest.json', { tickets: [] });
const POLY = cur.matches || [];
const grpOf = mk => mk === 'TOTAL' ? 'total' : 'team';
const FLOOR = +(process.env.MIN_DOLLARS || 500);
const startOf = t => { const m = (t.kickoffEt || '').match(/(\w+), (\w+) (\d+), (\d+):(\d+) (AM|PM)/); return m; };
const combined = {}, solo = [];
for (const h of hits) {
  const g = grpOf(h.m.market), tix = (latest.tickets || []).filter(t => t.sport === h.m.sport && t.matchup === h.m.matchup && grpOf(t.market) === g);
  const good = tix.filter(t => !R.cold(t)).reduce((a, t) => a + t.dollars, 0);
  const r = tix.length && good >= R.floorFor(FLOOR, h.m.sport, tix[0].market) ? R.matchupRow(h.m.sport, tix, g) : null;
  if (!r) { solo.push(h); continue; }
  const ck = h.m.sport + '|' + h.m.matchup + '|' + g;
  (combined[ck] ||= { sp: h.m.sport, matchup: h.m.matchup, g, r, hs: [] }).hs.push(h);
}
const kickTxt = st => { const m = Math.round((st - now) / 60000); return m < 1 ? 'KICKOFF NOW' : m <= 10 ? 'LATE: kickoff in ' + m + ' min' : 'kickoff in ' + (m >= 90 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'); };
const hhmm0 = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(':', '');
const csec = {};
for (const c of Object.values(combined)) {
  c.r.for = R.labRows(c.sp, c.r.for); c.r.against = R.labRows(c.sp, c.r.against);
  const st = new Date(c.hs[0].m.startUtc), pv = R.polyFor(POLY, c.sp, c.matchup, c.g, c.r);
  const top = c.hs.slice().sort((a, b) => b.m.usd - a.m.usd)[0].m;
  const heading = `${c.sp} - ${ctTime(st).toUpperCase()} CT`;
  (csec[c.sp] ||= {}); (csec[c.sp][heading] ||= []).push({ eyebrow: c.matchup, time: ctTime(st) + ' CT', tag: c.r.tag, sources: pv.sources, bet: c.r.bet, price: c.r.price,
    for: pv.for, against: pv.against, moneyBar: c.r.moneyBar, confidence: c.r.confidence, callout: c.r.callout,
    footerLabel: `POLY LATE: ${top.name} HOT ${k(top.usd)} on ${bet(top)} - ${kickTxt(st)}` });
}
for (const [sp, hd] of Object.entries(csec)) {
  const secs = Object.entries(hd).map(([heading, picks]) => ({ heading, picks: picks.sort((a, b) => b.confidence - a.confidence) }));
  const n = secs.reduce((a, x) => a + x.picks.length, 0);
  const card = { route: 'Sharp Signals', content: `**Sharp Flow + Polymarket late money - ${sp}** - ${n} game${n === 1 ? '' : 's'}`,
    boards: [{ design: 'sharpflow', brand: 'SHARP FLOW + POLYMARKET', title: `${sp} - late Polymarket money on a Sharp Flow game`, subtitle: `HOT Polymarket wallet bought after the ${sp} report posted - shown with the Sharp Flow read, games not started. Buys checked ${cur.at ? ctTime(new Date(cur.at)) : 'n/a'} CT, SharpFlow snapshot ${latest.scannedAt ? ctTime(new Date(latest.scannedAt)) : 'n/a'} CT`,
      sections: secs, legend: R.CONF_LEGEND, footer: 'Wallet money, not a pick. Leans, not guarantees' }] };
  const f = `${cardDir}/${ctDay(now)}-${hhmm0}-polylate-sf-${sp.toLowerCase()}.json`;
  fs.writeFileSync(f, JSON.stringify(card, null, 1));
  console.log('poly_alert: wrote COMBINED', f, secs.flatMap(x => x.picks.map(p => p.eyebrow)).join('; '));
}
const bySport = {};
for (const h of solo) (bySport[h.m.sport] ||= []).push(h);
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
    if (m.vsUsual != null) chips.push({ t: `${m.sizeTier === 'BIG' ? 'BIG ' : ''}${m.vsUsual}x their usual ${k(m.usualMed)}`, c: m.sizeTier === 'BIG' ? 'green' : 'grey' });
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
