/* Sharp Flow live alerts. No Claude. Runs after a fresh SharpFlow pull (sf_branch/latest.json).
   Posts one Discord card (outbox) with every NEW or GROWN sharp side since the last run.
   A side = sport|matchup|market|pick. Counts only wallets with non-negative ROI in that sport+market (Derek, Nov 16 rule).
   Floor $500 per side (MIN_DOLLARS). Follow-up alert only when the side grew by 1.5x and $500 or more.
   First run of a CT day only records the board silently (the pre-game cards already show it); alerts start after that.
   Seeds from today's pre-game card files in sf_branch/previews so a side already carded is not re-announced.
   Caps: MAX_PER_RUN rows per card, MAX_PER_HOUR rows per hour.
   Test: FAKE_NOW=..., OUT_DIR=/tmp/sf, CARD_DIR=/tmp/cards, ESPN_OFF unused (uses ticket start times). */
const fs = require('fs');
const OUT = process.env.OUT_DIR || 'sf_branch';
const CARD_DIR = process.env.CARD_DIR || 'cards';
const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
const MIN_DOLLARS = +(process.env.MIN_DOLLARS || 500);
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
const R = require('./sf_rules.js');
const cold = R.cold;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const latest = readJson(OUT + '/latest.json', null);
if (!latest) { console.log('no latest.json'); process.exit(0); }
const age = (now - new Date(latest.scannedAt)) / 60000;
if (!process.env.FAKE_NOW && age > 45) { console.log('snapshot too old', Math.round(age), 'min - skipping'); process.exit(0); }
const POLY = (readJson(OUT + '/poly_matches.json', {}).matches) || [];   // Nov 22: Poly wallets on the same game ride along on the alert
const POSTED = readJson(process.env.POSTED_PLAYS || 'posted_plays.json', []);   // Nov 22: today's posted PLAY rows (posted_plays.py)
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
    if (good < R.floorFor(MIN_DOLLARS, ts[0].sport, ts[0].market)) continue;
    const oppAll = (latest.tickets || []).filter(t => t.sport === ts[0].sport && t.matchup === ts[0].matchup && R.isOpposed(pick, ts[0].market, t.pick, t.market));
    const oppTs = oppAll.filter(t => !cold(t));
    sides.push({ key: key(ts[0].sport, ts[0].matchup, ts[0].market, pick), sp: ts[0].sport, matchup: ts[0].matchup, market: ts[0].market, pick, ts: gt, oppTs, oppAll,
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
const grpOf = m => m === 'TOTAL' ? 'total' : 'team';
// Kickoff countdown (Derek, Nov 21): alerts can land minutes before the game, so say how long is left.
const kickTxt = st => { const m = Math.round((st - now) / 60000); return m < 1 ? ' - KICKOFF NOW' : m <= 10 ? ' - LATE: kickoff in ' + m + ' min' : ' - kickoff in ' + (m >= 90 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'); };
const gseen = {}, rows = [];
for (const s of send) {
  const gk = s.sp + '|' + s.matchup + '|' + grpOf(s.market); if (gseen[gk]) continue; gseen[gk] = 1;
  const tix = (latest.tickets || []).filter(t => t.sport === s.sp && t.matchup === s.matchup && grpOf(t.market) === grpOf(s.market));
  const r = R.matchupRow(s.sp, tix, grpOf(s.market)); if (!r) continue;
  const growTxt = s.prev != null ? `GREW ${k(s.prev)} to ${k(s.good)}` : `NEW ${k(s.good)} on ${s.pick}`;
  r.for = R.labRows(s.sp, r.for); r.against = R.labRows(s.sp, r.against);
  const pv = R.polyFor(POLY, s.sp, s.matchup, grpOf(s.market), r);
  rows.push({ st: s.st, sp: s.sp, eyebrow: s.matchup, time: ctTime(s.st) + ' CT', tag: r.tag, sources: pv.sources, bet: r.bet, price: r.price,
    for: pv.for, against: pv.against, moneyBar: r.moneyBar, confidence: r.confidence, callout: r.callout, footerLabel: (R.postedNote(POSTED, s.sp, s.matchup, s.pick, s.market) ? R.postedNote(POSTED, s.sp, s.matchup, s.pick, s.market) + ' - ' : '') + (pv.sources.length > 1 ? 'SHARP FLOW + POLYMARKET - ' : '') + growTxt + kickTxt(s.st) + (R.siteLockTxt(latest.plays, s.sp, s.matchup, grpOf(s.market)) ? ' - ' + R.siteLockTxt(latest.plays, s.sp, s.matchup, grpOf(s.market)) : '') });
}
rows.sort((a, b) => b.confidence - a.confidence || a.st - b.st); // Derek, Nov 18: order by confidence, not kickoff time
const secs = [];
for (const r of rows) {
  const h = `${r.sp} - ${ctTime(r.st).toUpperCase()} CT`;
  let s = secs.find(x => x.heading === h); if (!s) secs.push(s = { heading: h, picks: [] });
  const { st: _s, sp: _p, ...pk } = r; s.picks.push(pk);
}
const snap = ctTime(new Date(latest.scannedAt));
const card = { route: 'Sharp Signals', content: `**Sharp Flow alert** - ${rows.length} new sharp-money side${rows.length === 1 ? '' : 's'}`,
  boards: [{ design: 'sharpflow', brand: 'SHARP FLOW ALERT', title: 'New sharp money', subtitle: `Positive market ROI and last-30 ROI, $${MIN_DOLLARS}+ per side (more for NHL and spreads) - SharpFlow snapshot ${snap} CT`,
    sections: secs, legend: R.CONF_LEGEND, footer: 'Wallet money, not a pick. Leans, not guarantees' }] };
fs.mkdirSync(CARD_DIR, { recursive: true });
const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(':', '');
const f = `${CARD_DIR}/${today}-${hhmm}-sharpflow-alert.json`;
fs.writeFileSync(f, JSON.stringify(card, null, 1));
for (let i = 0; i < send.length; i++) st.sent.push(now.toISOString());
console.log('wrote', f, rows.length, 'alert rows');
finish(rows.length);
