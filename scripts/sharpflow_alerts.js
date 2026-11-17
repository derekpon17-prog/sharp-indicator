/* Sharp Flow live alerts. No Claude. Runs after a fresh SharpFlow pull (sf_branch/latest.json).
   Posts one Discord card (outbox) with every NEW or GROWN sharp side since the last run.
   A side = sport|matchup|market|pick. Counts only wallets with non-negative ROI in that sport+market (Derek, Nov 16 rule).
   Floor $1,000 per side (MIN_DOLLARS). Follow-up alert only when the side grew by 1.5x and $1,000 or more.
   First run of a CT day only records the board silently (the pre-game cards already show it); alerts start after that.
   Seeds from today's pre-game card files in sf_branch/previews so a side already carded is not re-announced.
   Caps: MAX_PER_RUN rows per card, MAX_PER_HOUR rows per hour.
   Test: FAKE_NOW=..., OUT_DIR=/tmp/sf, CARD_DIR=/tmp/cards, ESPN_OFF unused (uses ticket start times). */
const fs = require('fs');
const OUT = process.env.OUT_DIR || 'sf_branch';
const CARD_DIR = process.env.CARD_DIR || 'cards';
const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
const MIN_DOLLARS = +(process.env.MIN_DOLLARS || 1000);
const MAX_PER_RUN = +(process.env.MAX_PER_RUN || 8);
const MAX_PER_HOUR = +(process.env.MAX_PER_HOUR || 12);
const SPORTS = new Set((process.env.SPORTS || 'NFL,NBA,NHL,CBB,CFB,MLB,WNBA').split(','));
const ctDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
const today = ctDay(now);
const etOffset = (() => { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).format(now); const m = s.match(/GMT([+-]\d+)/); return m ? -parseInt(m[1], 10) : 5; })();
function startUtc(k) {
  const m = (k || '').match(/(\w+), (\w+) (\d+), (\d+):(\d+) (AM|PM)/); if (!m) return null;
  const h = +m[4] % 12 + (m[6] === 'PM' ? 12 : 0);
  const d = new Date(`${m[2]} ${m[3]}, ${now.getUTCFullYear()} ${h}:${m[5]}:00 UTC`);
  return new Date(d.getTime() + etOffset * 3600000);
}
const ctTime = d => d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
const k = n => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : '$' + Math.round(n);
const team = p => p.replace(/\s*[+-]?\d+(\.\d+)?$/, '').trim();
const opp = (a, b, market) => market === 'TOTAL' ? /^over/i.test(a) !== /^over/i.test(b) : team(a) !== team(b);
const bets = rec => { const m = String(rec || '').match(/^(\d+)-(\d+)/); return m ? +m[1] + +m[2] : 0; };
const cold = t => t.mktRoi != null && t.mktRoi < 0;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const latest = readJson(OUT + '/latest.json', null);
if (!latest) { console.log('no latest.json'); process.exit(0); }
const age = (now - new Date(latest.scannedAt)) / 60000;
if (!process.env.FAKE_NOW && age > 45) { console.log('snapshot too old', Math.round(age), 'min - skipping'); process.exit(0); }
const SPEC = (readJson(OUT + '/specialists.json', {}).sports) || {};
let st = readJson(OUT + '/alerts.json', {});
if (st.date !== today) st = { date: today, baselined: false, sides: {}, sent: [] };
const key = (sp, m, mk, p) => [sp, m, mk, p].join('|');

// group today's unstarted tickets
const groups = {};
for (const t of latest.tickets || []) {
  if (!SPORTS.has(t.sport)) continue;
  const s = startUtc(t.kickoffEt); if (!s || s <= now || ctDay(s) !== today) continue;
  (groups[t.sport + '|' + t.matchup + '|' + t.market] ||= []).push({ ...t, st: s });
}
const sides = [];
for (const arr of Object.values(groups)) {
  const byPick = {};
  for (const t of arr) (byPick[t.pick] ||= []).push(t);
  for (const [pick, ts] of Object.entries(byPick)) {
    const gt = ts.filter(t => !cold(t));
    const good = gt.reduce((a, t) => a + t.dollars, 0);
    if (good < MIN_DOLLARS) continue;
    const oppTs = Object.entries(byPick).filter(([p]) => p !== pick && opp(pick, p, ts[0].market)).flatMap(([, x]) => x).filter(t => !cold(t));
    sides.push({ key: key(ts[0].sport, ts[0].matchup, ts[0].market, pick), sp: ts[0].sport, matchup: ts[0].matchup, market: ts[0].market, pick, ts: gt, oppTs,
      good, oppD: oppTs.reduce((a, t) => a + t.dollars, 0), st: ts[0].st, big: gt.slice().sort((a, b) => b.dollars - a.dollars)[0],
      wallets: new Set(gt.map(t => t.wallet)).size, vs: Math.max(...gt.map(t => t.vsUsual || 0)) });
  }
}

// seed from today's pre-game cards so carded sides are not re-announced
const seeded = {};
try {
  for (const f of fs.readdirSync(OUT + '/previews')) {
    if (!f.startsWith(today)) continue;
    const j = readJson(OUT + '/previews/' + f, null); if (!j) continue;
    for (const s of j.sides || []) seeded[key(j.sport, s.game, s.market, s.pick)] = s.dollars;
  }
} catch {}

const fresh = []; // sides to announce
for (const s of sides) {
  const prev = st.sides[s.key] != null ? st.sides[s.key].d : (seeded[s.key] != null ? seeded[s.key] : null);
  const isNew = prev == null, grew = prev != null && s.good >= prev * 1.5 && s.good - prev >= MIN_DOLLARS;
  if (st.baselined && (isNew || grew)) fresh.push({ ...s, prev });
  st.sides[s.key] = { d: s.good, t: st.sides[s.key] ? st.sides[s.key].t : now.toISOString(), a: (st.baselined && (isNew || grew)) ? now.toISOString() : (st.sides[s.key] || {}).a };
}
const firstRun = !st.baselined;
st.baselined = true;
st.sent = (st.sent || []).filter(t => now - new Date(t) < 3600000);

function finish(wrote) {
  fs.writeFileSync(OUT + '/alerts.json', JSON.stringify(st));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `wrote=${wrote}\n`);
}
if (firstRun) { console.log('baseline recorded:', sides.length, 'sides, no alerts this run'); finish(0); return; }
if (!fresh.length) { console.log('no new or grown sides'); finish(0); return; }

fresh.sort((a, b) => a.st - b.st || b.good - a.good);
const room = Math.max(0, Math.min(MAX_PER_RUN, MAX_PER_HOUR - st.sent.length));
const send = fresh.slice(0, room);
if (!send.length) { console.log('hourly cap reached;', fresh.length, 'held'); finish(0); return; }
// held sides are not recorded as announced, so the next run picks them up
for (const s of fresh.slice(room)) { if (st.sides[s.key]) { if (s.prev == null) delete st.sides[s.key]; else st.sides[s.key].d = s.prev; } }

const specOf = (sp, ts) => { const ids = new Set(ts.map(t => t.wid).filter(Boolean)); return (SPEC[sp] || []).filter(x => x.gap > 0 && ids.has(x.id)).sort((a, b) => b.gap - a.gap)[0]; };
const rows = send.map(s => {
  const mk = s.market === 'ML' ? 'ML' : s.market === 'SPREAD' ? 'spread' : 'total';
  const line = s.big.line != null ? s.big.line : null;
  let bet = s.market === 'ML' ? s.pick + ' ML' : /\d/.test(s.pick) ? s.pick : s.pick + (line != null ? ' ' + (s.market === 'SPREAD' && line > 0 ? '+' : '') + line : ' spread');
  const chips = [];
  chips.push({ t: s.prev != null ? `GREW ${k(s.prev)} to ${k(s.good)}` : `NEW ${k(s.good)} vs ${k(s.oppD)}`, c: s.oppD >= s.good / 2 ? 'orange' : 'blue' });
  const nb = bets(s.big.mktRecord);
  if (s.big.mktRecord && s.big.mktRoi != null) chips.push({ t: `${s.sp} ${mk}: ${s.big.mktRecord} (${s.big.mktRoi >= 0 ? '+' : ''}${Math.round(s.big.mktRoi)}% ROI)`, c: nb < 5 ? 'orange' : s.big.mktRoi >= 15 ? 'green' : 'grey' });
  else chips.push({ t: `no ${s.sp} ${mk} record`, c: 'orange' });
  if (nb > 0 && nb < 5) chips.push({ t: `only ${nb} bet${nb === 1 ? '' : 's'} here`, c: 'orange' });
  if (s.big.mktL30Rec) chips.push({ t: `30d here ${s.big.mktL30Rec}`, c: 'grey' });
  chips.push({ t: `${(+s.vs).toFixed(1)}x their usual ${s.sp} bet`, c: s.vs >= 2 ? 'gold' : s.vs >= 1.5 ? 'blue' : 'grey' });
  if (s.big.usualAll) { const r = s.big.dollars / s.big.usualAll; chips.push({ t: `${r.toFixed(1)}x their all-sport usual`, c: r < 0.75 && s.vs >= 1.5 ? 'orange' : 'grey' }); }
  if (s.wallets > 1) chips.push({ t: `${s.wallets} wallets`, c: 'blue' });
  const sp1 = specOf(s.sp, s.ts); if (sp1) chips.unshift({ t: `TOP ${s.sp} WALLET: ${sp1.sport} ${s.sp} vs ${sp1.overall} overall`, c: 'gold' });
  const sp2 = specOf(s.sp, s.oppTs); if (sp2) chips.push({ t: `top ${s.sp} wallet on the other side (${sp2.sport})`, c: 'red' });
  const price = parseFloat(String(s.big.price).replace('+', ''));
  return { st: s.st, sp: s.sp, bet, sub: `${s.matchup} - ${ctTime(s.st)}`, price: Number.isFinite(price) ? price : null, chips, usual: +s.vs };
});
const secs = [];
for (const r of rows) {
  const h = `${r.sp} - ${ctTime(r.st).toUpperCase()} CT`;
  let s = secs.find(x => x.heading === h); if (!s) secs.push(s = { heading: h, picks: [] });
  const { st: _s, sp: _p, ...pk } = r; s.picks.push(pk);
}
const snap = ctTime(new Date(latest.scannedAt));
const card = { route: 'Sharp Signals', content: `**Sharp Flow alert** - ${rows.length} new sharp-money side${rows.length === 1 ? '' : 's'}`,
  boards: [{ brand: 'SHARP FLOW ALERT', title: 'New sharp money', subtitle: `Wallets with positive ROI in that sport and market, $${MIN_DOLLARS / 1000}K+ per side - SharpFlow snapshot ${snap} CT`,
    sections: secs, legend: 'Big number = biggest bet vs that wallet’s usual size in this sport. Negative-ROI wallets are not counted', footer: 'Wallet money, not a pick. Leans, not guarantees' }] };
fs.mkdirSync(CARD_DIR, { recursive: true });
const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(':', '');
const f = `${CARD_DIR}/${today}-${hhmm}-sharpflow-alert.json`;
fs.writeFileSync(f, JSON.stringify(card, null, 1));
for (let i = 0; i < send.length; i++) st.sent.push(now.toISOString());
console.log('wrote', f, rows.length, 'alert rows');
finish(rows.length);
