/* Site lock gap alert (Derek, Nov 21 2026): the Sharp Flow site's open staked locks that do NOT line up with any card we
   posted today. Posts ONE plain-text Discord card with the FULL list of such locks whenever a new one appears.
   "Lines up" = a card from today (sent/ or outbox/ on the outbox branch) has a row for that game with the same pick
   (ML: "<team> ml", spread: "<team> <line>", total: "<over|under> <line>"). A different line on our card counts as not lined up.
   Display only. Usage: node site_lock_alert.js <sf_branch> <outbox_clone_dir> [cards_dir]. Test: FAKE_NOW=ISO. */
const fs = require('fs'), path = require('path');
const SF = process.argv[2] || 'sf_branch', OB = process.argv[3] || 'ob_read', CARDS = process.argv[4] || 'cards';
const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const ctDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
const today = ctDay(now);
const latest = rd(SF + '/latest.json', null);
const emit = n => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `locks_wrote=${n}\n`); };
if (!latest) { console.log('no latest.json'); emit(0); process.exit(0); }
if (!process.env.FAKE_NOW && (now - new Date(latest.scannedAt)) / 60000 > 45) { console.log('snapshot too old - skipping'); emit(0); process.exit(0); }
const etOffset = (() => { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).format(now); const m = s.match(/GMT([+-]\d+)/); return m ? -parseInt(m[1], 10) : 5; })();
function startUtc(k) {
  const m = (k || '').match(/(\w+), (\w+) (\d+), (\d+):(\d+) (AM|PM)/); if (!m) return null;
  const h = +m[4] % 12 + (m[6] === 'PM' ? 12 : 0);
  return new Date(new Date(`${m[2]} ${m[3]}, ${now.getUTCFullYear()} ${h}:${m[5]}:00 UTC`).getTime() + etOffset * 3600000);
}
const ctTime = d => d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9+\-. ]/g, ' ').replace(/\s+/g, ' ').trim();
// candidate "row" records from today's cards: dicts that name a pick/matchup and are not wrappers
const WRAP = new Set(['rows', 'sections', 'boards', 'slate', 'picks', 'scorecards', 'embeds', 'parts', 'returns']);
const leaves = (o, out = []) => { if (typeof o === 'string') out.push(o); else if (Array.isArray(o)) o.forEach(x => leaves(x, out)); else if (o && typeof o === 'object') Object.values(o).forEach(x => leaves(x, out)); return out; };
function records(o, out = []) {
  if (Array.isArray(o)) o.forEach(x => records(x, out));
  else if (o && typeof o === 'object') {
    const ks = Object.keys(o);
    if (!ks.some(k => WRAP.has(k)) && ks.some(k => ['bet', 'pick', 'eyebrow', 'matchup', 'game', 'sub'].includes(k))) out.push(norm(leaves(o).join(' | ')));
    Object.values(o).forEach(x => records(x, out));
  }
  return out;
}
const recs = [];
for (const dir of ['sent', 'outbox']) {
  let fl = []; try { fl = fs.readdirSync(path.join(OB, dir)); } catch {}
  for (const f of fl) if (f.startsWith(today) && f.endsWith('.json') && !/sitelocks/.test(f)) records(rd(path.join(OB, dir, f), null), recs);
}
const lineUp = p => {
  const [away, home] = String(p.matchup).split(/ at /).map(norm);
  const pk = norm(p.pick), sameGame = r => away && home && r.includes(away) && r.includes(home);
  return recs.some(r => {
    if (p.market === 'TOTAL') return sameGame(r) && r.includes(pk);
    if (!r.includes(pk + (p.market === 'ML' ? ' ml' : ''))) return false;
    return p.market === 'ML' ? true : true;
  });
};
const open = [];
for (const p of latest.plays || []) {
  if (p.status !== 'locked') continue;
  const st = startUtc(p.kickoffEt); if (!st || st <= now || ctDay(st) !== today) continue;
  open.push({ ...p, st, key: [today, p.sport, p.matchup, p.market, p.pick].join('|') });
}
const gaps = open.filter(p => !lineUp(p)).sort((a, b) => a.st - b.st);
let state = rd(SF + '/site_lock_alerted.json', {}); if (state.date !== today) state = { date: today, keys: [] };
const fresh = gaps.filter(g => !state.keys.includes(g.key));
console.log(`site locks: ${open.length} open, ${gaps.length} not on a card, ${fresh.length} new, ${recs.length} card rows checked`);
if (!fresh.length) { fs.writeFileSync(SF + '/site_lock_alerted.json', JSON.stringify(state)); emit(0); process.exit(0); }
const odd = o => o == null ? '' : ' ' + (+o > 0 ? '+' + (+o) : o);
const line = g => `- ${g.sport} ${ctTime(g.st)} CT - ${g.pick}${g.market === 'ML' ? ' ML' : ''}${odd(g.odds)} - ${g.units}u - ` + (g.alignment === 'with' ? `wallet money behind it${g.money ? ' $' + Math.round(g.money.dollars).toLocaleString('en-US') : ''}` : g.alignment === 'against' ? 'wallet money AGAINST it' : 'no wallet money') + ` - ${g.matchup}` + (fresh.includes(g) ? ' (NEW)' : '');
const head = `Sharp Signals - SITE LOCKS NOT ON A CARD (${gaps.length} open, ${fresh.length} new)\nThe Sharp Flow site has these staked locks and none of today's cards has the same pick. Display only, not a play.`;
const parts = []; let cur = head;
for (const g of gaps) { const l = '\n' + line(g); if ((cur + l).length > 1850) { parts.push(cur); cur = 'Sharp Signals - site locks (cont.)'; } cur += l; }
parts.push(cur + '\nSource: nhlsavant.com site locks. Rules frozen; record in site_lock_record.json.');
fs.mkdirSync(CARDS, { recursive: true });
const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(':', '');
fs.writeFileSync(path.join(CARDS, `${today}-${hhmm}-sitelocks.json`), JSON.stringify({ route: 'Sharp Signals', parts: parts.slice(0, 6) }, null, 1));
state.keys = Array.from(new Set(state.keys.concat(gaps.map(g => g.key))));
fs.writeFileSync(SF + '/site_lock_alerted.json', JSON.stringify(state));
emit(1);
