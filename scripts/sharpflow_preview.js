/* Sharp Flow preview card: one card per sport, about 60 minutes before that sport's first game of the day. No Claude.
   MODE=plan  -> checks ESPN for each sport's first start; writes due sports to $GITHUB_OUTPUT (due=NFL,NBA ...). Cheap, no SharpFlow call.
   MODE=build -> reads the fresh sf_branch/latest.json + flags.json, writes one outbox card per due sport into CARD_DIR,
                 records the sport as posted in sf_branch/previews.json (only when a card was written).
   Test: FAKE_NOW=2026-11-15T23:00:00Z, SPORTS=NFL, OUT_DIR=/tmp/sf, CARD_DIR=/tmp/cards, ESPN_OFF=1 (use ticket times instead of ESPN). */
const fs = require('fs');
const OUT = process.env.OUT_DIR || 'sf_branch';
const CARD_DIR = process.env.CARD_DIR || 'cards';
const MODE = process.env.MODE || 'plan';
const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
const LEAD_MAX = +(process.env.LEAD_MAX || 75), LEAD_MIN = +(process.env.LEAD_MIN || 3); // post when first start is 3-75 min away
const MIN_DOLLARS = +(process.env.MIN_DOLLARS || 1000);
const ESPN = { NFL: 'football/nfl', CFB: 'football/college-football', NBA: 'basketball/nba', WNBA: 'basketball/wnba',
  CBB: 'basketball/mens-college-basketball', NHL: 'hockey/nhl', MLB: 'baseball/mlb' };
const ctDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
const today = ctDay(now);
const etOffset = (() => { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).format(now); const m = s.match(/GMT([+-]\d+)/); return m ? -parseInt(m[1], 10) : 5; })();
function startUtc(k) { // "Sun, Nov 15, 8:22 PM" (ET)
  const m = (k || '').match(/(\w+), (\w+) (\d+), (\d+):(\d+) (AM|PM)/); if (!m) return null;
  const h = +m[4] % 12 + (m[6] === 'PM' ? 12 : 0);
  const d = new Date(`${m[2]} ${m[3]}, ${now.getUTCFullYear()} ${h}:${m[5]}:00 UTC`);
  return new Date(d.getTime() + etOffset * 3600000);
}
const ctTime = d => d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
const k = n => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : '$' + Math.round(n);
let SPEC = {}; try { SPEC = JSON.parse(fs.readFileSync(OUT + '/specialists.json', 'utf8')).sports || {}; } catch {}
let posted = {}; try { posted = JSON.parse(fs.readFileSync(OUT + '/previews.json', 'utf8')); } catch {}
const done = new Set(posted[today] || []);

async function firstStarts() { // sport -> Date of the first game that has not started, today (CT)
  const out = {};
  const ymd = today.replace(/-/g, '');
  const want = (process.env.SPORTS ? process.env.SPORTS.split(',') : Object.keys(ESPN));
  if (!process.env.ESPN_OFF) {
    await Promise.all(want.map(async sp => {
      try {
        const extra = sp === 'CBB' ? '&groups=50&limit=400' : sp === 'CFB' ? '&groups=80&limit=300' : '&limit=300';
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[sp]}/scoreboard?dates=${ymd}${extra}`, { signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        const ts = (j.events || []).filter(e => e.status?.type?.state === 'pre').map(e => new Date(e.date)).filter(d => ctDay(d) === today && d > now).sort((a, b) => a - b);
        if (ts.length) out[sp] = ts[0];
      } catch (e) { console.log('espn failed', sp, e.message); }
    }));
  }
  return { out, want };
}

function ticketStarts(latest, want) { // fallback / test: first start seen on SharpFlow tickets
  const out = {};
  for (const t of latest.tickets || []) {
    if (!want.includes(t.sport)) continue;
    const st = startUtc(t.kickoffEt); if (!st || st <= now || ctDay(st) !== today) continue;
    if (!out[t.sport] || st < out[t.sport]) out[t.sport] = st;
  }
  return out;
}

function dueList(starts) {
  const due = [];
  for (const [sp, st] of Object.entries(starts)) {
    const lead = (st - now) / 60000;
    if (done.has(sp)) continue;
    if (lead <= LEAD_MAX && lead >= LEAD_MIN) due.push(sp);
  }
  return due;
}

const team = p => p.replace(/\s*[+-]?\d+(\.\d+)?$/, '').trim();
const opp = (a, b, market) => market === 'TOTAL' ? /^over/i.test(a) !== /^over/i.test(b) : team(a) !== team(b);
const num = s => parseFloat(String(s).replace('+', ''));
const bets = rec => { const m = String(rec || '').match(/^(\d+)-(\d+)/); return m ? +m[1] + +m[2] : 0; };

const cold = t => t.mktRoi != null && t.mktRoi < 0; // Derek, Nov 16: negative ROI in this sport+market = money does not count
function buildCards(sp, latest, flags) {
  const tickets = (latest.tickets || []).filter(t => t.sport === sp).map(t => ({ ...t, st: startUtc(t.kickoffEt) })).filter(t => t.st && t.st > now);
  const games = {};
  for (const t of tickets) (games[t.matchup + '|' + t.market] ||= []).push(t);
  const tails = new Set((flags.sides || []).filter(s => s.tail).map(s => [s.matchup, s.market, s.pick].join('|')));
  const sides = [], coldSides = [];
  const sum = (ts, f) => ts.reduce((a, t) => a + (f(t) ? t.dollars : 0), 0);
  for (const arr of Object.values(games)) {
    const byPick = {};
    for (const t of arr) (byPick[t.pick] ||= []).push(t);
    for (const [pick, ts] of Object.entries(byPick)) {
      const all = sum(ts, () => true), good = sum(ts, t => !cold(t));
      const oppD = Object.entries(byPick).filter(([p]) => p !== pick && opp(pick, p, ts[0].market)).reduce((a, [, x]) => a + sum(x, t => !cold(t)), 0);
      if (all >= MIN_DOLLARS && good < MIN_DOLLARS) {
        const cb = ts.filter(cold).sort((a, b) => b.dollars - a.dollars)[0];
        if (cb) coldSides.push({ txt: `${pick}${ts[0].market === 'ML' ? ' ML' : ''} ${k(all)} (${cb.mktRecord} here, ${Math.round(cb.mktRoi)}% ROI)`, dollars: all });
        continue;
      }
      if (good < MIN_DOLLARS) continue;
      const gt = ts.filter(t => !cold(t));
      const big = gt.slice().sort((a, b) => b.dollars - a.dollars)[0];
      const wallets = new Set(gt.map(t => t.wallet)).size;
      sides.push({ byPick, ts: gt, pick, dollars: good, oppD, big, wallets, vs: Math.max(...gt.map(t => t.vsUsual || 0)), st: ts[0].st, matchup: ts[0].matchup, market: ts[0].market,
        tail: tails.has([ts[0].matchup, ts[0].market, pick].join('|')) });
    }
  }
  sides.sort((a, b) => a.st - b.st || b.dollars - a.dollars);
  coldSides.sort((a, b) => b.dollars - a.dollars);
  if (!sides.length) return [];
  const rows = sides.map(s => {
    const line = s.big.line != null ? s.big.line : null;
    let bet;
    if (s.market === 'ML') bet = s.pick + ' ML';
    else if (/\d/.test(s.pick)) bet = s.pick;
    else bet = s.pick + (line != null ? ' ' + (s.market === 'SPREAD' && line > 0 ? '+' : '') + line : ' spread');
    const chips = [];
    chips.push({ t: `SHARP ${k(s.dollars)} vs ${k(s.oppD)}`, c: s.oppD >= s.dollars / 2 ? 'orange' : 'blue' });
    const mk = s.market === 'ML' ? 'ML' : s.market === 'SPREAD' ? 'spread' : 'total';
    const nb = bets(s.big.mktRecord);
    if (s.big.mktRecord && s.big.mktRoi != null) chips.push({ t: `${sp} ${mk}: ${s.big.mktRecord} (${s.big.mktRoi >= 0 ? '+' : ''}${Math.round(s.big.mktRoi)}% ROI)`, c: nb < 5 ? 'orange' : s.big.mktRoi >= 15 ? 'green' : 'grey' });
    else chips.push({ t: `no ${sp} ${mk} record`, c: 'orange' });
    if (nb > 0 && nb < 5) chips.push({ t: `only ${nb} bet${nb === 1 ? "" : "s"} here`, c: 'orange' });
    if (s.big.mktL30Rec) chips.push({ t: `30d here ${s.big.mktL30Rec}`, c: 'grey' });
    chips.push({ t: `${(+s.vs).toFixed(1)}x their usual ${sp} bet`, c: s.vs >= 2 ? 'gold' : s.vs >= 1.5 ? 'blue' : 'grey' });
    if (s.big.usualAll) { const r = s.big.dollars / s.big.usualAll; chips.push({ t: `${r.toFixed(1)}x their all-sport usual`, c: r < 0.75 && s.vs >= 1.5 ? 'orange' : 'grey' }); }
    if (s.wallets > 1) chips.push({ t: `${s.wallets} wallets`, c: 'blue' });
    const specOf = (ts) => { const ids = new Set(ts.map(t => t.wid).filter(Boolean)); return (SPEC[sp] || []).filter(x => x.gap > 0 && ids.has(x.id)).sort((a, b) => b.gap - a.gap)[0]; };
    const sp1 = specOf(s.ts);
    if (sp1) chips.unshift({ t: `TOP ${sp} WALLET: ${sp1.sport} ${sp} vs ${sp1.overall} overall`, c: 'gold' });
    const oppTs = Object.entries(s.byPick || {}).filter(([p]) => p !== s.pick && opp(s.pick, p, s.market)).flatMap(([, x]) => x).filter(t => !cold(t));
    const sp2 = specOf(oppTs);
    if (sp2) chips.push({ t: `top ${sp} wallet on the other side (${sp2.sport})`, c: 'red' });
    const price = num(s.big.price);
    return { st: s.st, bet: (s.tail ? '★ ' : '') + bet, sub: `${s.matchup} - ${ctTime(s.st)}`, price: Number.isFinite(price) ? price : null, chips, usual: +s.vs };
  });
  const data = sides.map(s => ({ game: s.matchup, market: s.market, pick: s.pick, start_utc: s.st.toISOString(), dollars: s.dollars, opp_dollars: s.oppD, wallets: s.wallets,
    max_vs_usual: +s.vs, all_sport_ratio: s.big.usualAll ? +(s.big.dollars / s.big.usualAll).toFixed(2) : null, price: s.big.price, line: s.big.line ?? null,
    l30_rec: s.big.l30Rec || null, l30_roi: s.big.l30Roi ?? null, mkt_rec: s.big.mktRecord || null, mkt_roi: s.big.mktRoi ?? null, mkt_l30_rec: s.big.mktL30Rec || null, tail: s.tail }));
  const cards = [];
  const snap = latest.scannedAt ? ctTime(new Date(latest.scannedAt)) : 'n/a';
  for (let i = 0; i < rows.length && cards.length < 3; i += 12) {
    const chunk = rows.slice(i, i + 12);
    const secs = [];
    for (const r of chunk) {
      const h = `${sp} - ${ctTime(r.st).toUpperCase()} CT`;
      let s = secs.find(x => x.heading === h); if (!s) secs.push(s = { heading: h, picks: [] });
      const { st, ...pk } = r; s.picks.push(pk);
    }
    const last = i + 12 >= rows.length || cards.length === 2;
    const coldTxt = last && coldSides.length ? 'Not counted (negative ROI in this market): ' + coldSides.slice(0, 3).map(c => c.txt).join('; ') : '';
    cards.push({ brand: 'SHARP FLOW', title: `${sp} - sharp wallets`, subtitle: `Wallets with positive ${sp} ROI in that market, $${MIN_DOLLARS / 1000}K+ per side - SharpFlow snapshot ${snap} CT${rows.length > 12 ? ` - board ${cards.length + 1}` : ''}`,
      sections: secs, legend: coldTxt || 'Big number = biggest bet vs that wallet’s usual size in this sport. ★ = good tail', footer: 'Wallet money, not a pick. Leans, not guarantees' });
  }
  return { cards, n: rows.length, data, cold: coldSides };
}

(async () => {
  let latest = null; try { latest = JSON.parse(fs.readFileSync(OUT + '/latest.json', 'utf8')); } catch {}
  let { out: starts, want } = await firstStarts();
  if (process.env.ESPN_OFF || !Object.keys(starts).length) { if (latest) Object.assign(starts, Object.fromEntries(Object.entries(ticketStarts(latest, want)).filter(([s]) => !starts[s]))); }
  const due = dueList(starts);
  console.log('first starts (CT):', Object.entries(starts).map(([s, d]) => s + ' ' + ctTime(d)).join(', ') || 'none', '| posted today:', [...done].join(',') || 'none', '| due:', due.join(',') || 'none');
  if (MODE === 'plan') {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due.join(',')}\n`);
    return;
  }
  const dueIn = (process.env.DUE || '').split(',').filter(Boolean);
  if (!latest) { console.log('no latest.json'); return; }
  const age = (now - new Date(latest.scannedAt)) / 60000;
  if (!process.env.FAKE_NOW && age > 180) { console.log('snapshot too old', Math.round(age), 'min - skipping'); return; }
  let flags = {}; try { flags = JSON.parse(fs.readFileSync(OUT + '/flags.json', 'utf8')); } catch {}
  fs.mkdirSync(CARD_DIR, { recursive: true });
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(':', '');
  const wrote = [];
  for (const sp of dueIn) {
    const res = buildCards(sp, latest, flags);
    if (!res || !res.cards || !res.cards.length) { console.log(sp, 'no sides over threshold yet - will retry next run'); continue; }
    const first = starts[sp] ? ctTime(starts[sp]) : '';
    const card = { route: 'Sharp Signals', content: `**Sharp Flow - ${sp} - first game ${first} CT** - ${res.n} sharp-money side${res.n === 1 ? '' : 's'}`, boards: res.cards };
    const f = `${CARD_DIR}/${today}-${hhmm}-sharpflow-${sp.toLowerCase()}.json`;
    fs.writeFileSync(f, JSON.stringify(card, null, 1)); wrote.push(sp);
    if (!process.env.NO_MARK) { fs.mkdirSync(OUT + '/previews', { recursive: true }); fs.writeFileSync(`${OUT}/previews/${today}-${hhmm}-${sp.toLowerCase()}.json`, JSON.stringify({ date: today, posted_ct: hhmm, sport: sp, first_start: starts[sp] ? starts[sp].toISOString() : null, snapshot: latest.scannedAt, sides: res.data }, null, 1)); } console.log('wrote', f, res.n, 'sides');
  }
  if (wrote.length && !process.env.NO_MARK) { posted[today] = [...done, ...wrote]; for (const d of Object.keys(posted)) if (d < today) delete posted[d]; fs.writeFileSync(OUT + '/previews.json', JSON.stringify(posted)); }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `wrote=${wrote.length}\n`);
})();
