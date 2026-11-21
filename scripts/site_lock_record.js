/* Sharp Flow site locks: log + running record (Derek, Nov 21 2026, council COUNCIL_2026-11-21_site-locks).
   Display-only: never feeds PLAY/LEAN/PASS. Reads sf_branch/latest.json plays (the site's staked locks, graded by the site),
   logs each lock once (first seen, frozen units/odds/alignment), updates status when it turns win/loss, and writes
   sf_branch/site_locks.json (log) and sf_branch/site_lock_record.json (record split by sport, wallet money, market).
   Staking: units = risk; win pays toWin, loss costs units (the site's own stake sizes). Usage: node site_lock_record.js <sf_branch> */
const fs = require('fs');
const OUT = process.argv[2] || 'sf_branch';
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(OUT + '/' + f, 'utf8')); } catch { return d; } };
const latest = rd('latest.json', null);
if (!latest) { console.log('no latest.json'); process.exit(0); }
const log = rd('site_locks.json', { locks: {} });
const date = latest.date;
let added = 0, graded = 0;
for (const p of latest.plays || []) {
  const k = [date, p.sport, p.matchup, p.market, p.pick].join('|');
  const cur = log.locks[k];
  if (!cur) {
    log.locks[k] = { date, sport: p.sport, matchup: p.matchup, market: p.market, pick: p.pick, units: p.units, odds: p.odds, toWin: p.toWin ?? null,
      alignment: p.alignment || 'none', money: p.money ? p.money.dollars : null, first_seen: new Date().toISOString(), status: p.status };
    added++;
  } else if (cur.status !== p.status) { cur.status = p.status; cur.graded_at = new Date().toISOString(); graded++; }
  const l = log.locks[k];
  if (l.toWin == null && p.toWin != null) l.toWin = p.toWin;
}
// the payload's plays carry no toWin once trimmed by the transform; derive from odds when missing
const toWin = l => l.toWin != null ? l.toWin : (() => { const o = +l.odds; if (!o) return 0; return +(o > 0 ? l.units * o / 100 : l.units * 100 / -o).toFixed(2); })();
const bucket = () => ({ w: 0, l: 0, p: 0, open: 0, units: 0, staked: 0 });
const add = (b, l) => {
  if (l.status === 'win') { b.w++; b.units += toWin(l); b.staked += l.units; }
  else if (l.status === 'loss') { b.l++; b.units -= l.units; b.staked += l.units; }
  else if (l.status === 'push') b.p++;
  else b.open++;
};
const rec = { updated: new Date().toISOString(), note: 'Site locks are display-only and graded by the site itself. Rules frozen until 100 graded locks.', all: bucket(), bySport: {}, byMoney: { with_money: bucket(), no_money: bucket() }, byMarket: {} };
for (const l of Object.values(log.locks)) {
  add(rec.all, l);
  add(rec.bySport[l.sport] ||= bucket(), l);
  add(rec.byMoney[l.alignment === 'none' ? 'no_money' : 'with_money'], l);
  add(rec.byMarket[l.sport + ' ' + l.market] ||= bucket(), l);
}
const fix = b => { b.units = +b.units.toFixed(2); b.staked = +b.staked.toFixed(2); b.record = b.w + '-' + b.l; b.yield = b.staked ? +(100 * b.units / b.staked).toFixed(1) : null; return b; };
fix(rec.all); Object.values(rec.bySport).forEach(fix); Object.values(rec.byMoney).forEach(fix); Object.values(rec.byMarket).forEach(fix);
fs.writeFileSync(OUT + '/site_locks.json', JSON.stringify(log));
fs.writeFileSync(OUT + '/site_lock_record.json', JSON.stringify(rec, null, 1));
console.log(`site locks: +${added} new, ${graded} graded, record ${rec.all.record} (${rec.all.units}u of ${rec.all.staked}u staked), open ${rec.all.open}`);
