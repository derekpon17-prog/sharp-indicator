/* Sharp Flow preview card: one card per sport, built for that sport's MAIN SLATE (the cluster of
   games most of the day's action falls in), not just the single earliest game.
   Deadline rule (Derek, Nov 18 2026): post at least MIN_LEAD minutes before the main slate's first
   kickoff, but never later than DEADLINE_HOUR CT (default 5pm) even if the slate itself starts well
   after that - whichever is earlier. A one-off game that starts OUTLIER_GAP+ minutes before the rest
   of that sport's slate (e.g. an NFL London game on a Sunday morning) is treated separately: it gets
   its own early card (scoped to just the games before the main cluster) and its own "posted" flag, so
   it never consumes the main slate's flag and the main slate still gets its own card later.
   MODE=plan  -> checks ESPN for each sport's games today; writes due tokens to $GITHUB_OUTPUT
                 (due=NFL,NBA_OUTLIER,...). A "_OUTLIER" suffix means the one-off card, not the main slate.
                 Cheap, no SharpFlow call.
   MODE=build -> reads the fresh sf_branch/latest.json + flags.json, writes one outbox card per due
                 token into CARD_DIR, records it as posted in sf_branch/previews.json (only when a
                 card was actually written).
   Test: FAKE_NOW=2026-11-15T23:00:00Z, SPORTS=NFL, OUT_DIR=/tmp/sf, CARD_DIR=/tmp/cards, ESPN_OFF=1 (use ticket times instead of ESPN). */
const fs = require('fs');
const OUT = process.env.OUT_DIR || 'sf_branch';
const CARD_DIR = process.env.CARD_DIR || 'cards';
const MODE = process.env.MODE || 'plan';
const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
const MIN_LEAD = +(process.env.MIN_LEAD || 60);          // post no later than this many minutes before kickoff
const RETRY_WINDOW = +(process.env.RETRY_WINDOW || 70);  // start trying this many minutes before the deadline, and keep retrying every run up to kickoff if missed
const DEADLINE_HOUR = +(process.env.DEADLINE_HOUR || 17); // wall-clock cap, CT, 24h (17 = 5pm) - main slate only
const OUTLIER_GAP = +(process.env.OUTLIER_GAP || 120);    // minutes of gap that marks a game as a one-off ahead of the main slate
const MIN_DOLLARS = +(process.env.MIN_DOLLARS || 500);
const ESPN = { NFL: 'football/nfl', CFB: 'football/college-football', NBA: 'basketball/nba', WNBA: 'basketball/wnba',
  CBB: 'basketball/mens-college-basketball', NHL: 'hockey/nhl', MLB: 'baseball/mlb' };
const ctDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
const today = ctDay(now);
const etOffset = (() => { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).format(now); const m = s.match(/GMT([+-]\d+)/); return m ? -parseInt(m[1], 10) : 5; })();
const ctOffset = (() => { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' }).format(now); const m = s.match(/GMT([+-]\d+)/); return m ? -parseInt(m[1], 10) : 6; })();
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
// 5pm (DEADLINE_HOUR) CT today, as a real UTC Date, same trick as startUtc's ET offset above.
const deadlineToday = new Date(new Date(`${today}T${String(DEADLINE_HOUR).padStart(2, '0')}:00:00Z`).getTime() + ctOffset * 3600000);

async function allStarts() { // sport -> sorted array of today's not-yet-started game Dates
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
        if (ts.length) out[sp] = ts;
      } catch (e) { console.log('espn failed', sp, e.message); }
    }));
  }
  return { out, want };
}

function ticketStarts(latest, want) { // fallback / test: every start seen on SharpFlow tickets
  const out = {};
  for (const t of latest.tickets || []) {
    if (!want.includes(t.sport)) continue;
    const st = startUtc(t.kickoffEt); if (!st || st <= now || ctDay(st) !== today) continue;
    (out[t.sport] ||= []).push(st);
  }
  for (const sp of Object.keys(out)) out[sp].sort((a, b) => a - b);
  return out;
}

// Splits today's sorted start times into { mainStart, outliers }. outliers are games that sit
// OUTLIER_GAP+ minutes ahead of the next game - a one-off slate (e.g. an early-morning game) that
// shouldn't anchor, or get bundled into, the main slate's own deadline.
function clusterStarts(times) {
  if (!times.length) return null;
  let i = 0;
  while (i < times.length - 1 && (times[i + 1] - times[i]) / 60000 > OUTLIER_GAP) i++;
  return { mainStart: times[i], outliers: times.slice(0, i) };
}

function dueList(startsAll, prefix = '', capAt5 = true) {
  const due = [];
  for (const [sp, times] of Object.entries(startsAll)) {
    const cluster = clusterStarts(times);
    if (!cluster) continue;
    if (!done.has(prefix + sp) && cluster.mainStart > now) {
      const lead = cluster.mainStart.getTime() - MIN_LEAD * 60000;
      const mainDeadline = new Date(capAt5 ? Math.min(lead, deadlineToday.getTime()) : lead);
      if (now >= new Date(mainDeadline.getTime() - RETRY_WINDOW * 60000)) due.push(prefix + sp);
    }
    if (cluster.outliers.length && !done.has(prefix + sp + '_OUTLIER')) {
      const earliestOutlier = cluster.outliers[0];
      if (earliestOutlier > now) {
        const outlierDeadline = new Date(earliestOutlier.getTime() - MIN_LEAD * 60000);
        if (now >= new Date(outlierDeadline.getTime() - RETRY_WINDOW * 60000)) due.push(prefix + sp + '_OUTLIER');
      }
    }
  }
  return due;
}

const team = p => p.replace(/\s*[+-]?\d+(\.\d+)?$/, '').trim();
const opp = (a, b, market) => market === 'TOTAL' ? /^over/i.test(a) !== /^over/i.test(b) : team(a) !== team(b);
const num = s => parseFloat(String(s).replace('+', ''));
const bets = rec => { const m = String(rec || '').match(/^(\d+)-(\d+)/); return m ? +m[1] + +m[2] : 0; };

const R = require('./sf_rules.js');
const cold = R.cold; // Nov 16 ROI rule plus Nov 17 form gate (see sf_rules.js)

/* Polymarket wallet rows (Derek, Nov 20 2026). poly_matches.json is written by scripts/poly_match.js earlier in the same
   workflow run: classified Polymarket wallets (wallets.json HOT/COLD, judged only in the sport they are classified in)
   that bought one side of a game on this card. Shown ONLY when a match exists - no match, no Poly row and no
   POLYMARKET tag. Display only: never changes the verdict, confidence or money bar, which stay Sharp Flow's. */
let POLY = [], POLYMETA = {}; try { POLYMETA = JSON.parse(fs.readFileSync(OUT + '/poly_matches.json', 'utf8')); POLY = POLYMETA.matches || []; } catch {}
const MIN_POLY = +(process.env.POLY_MIN_USD || 500);
// Running Poly record (scripts/poly_grade.js -> poly_record.json): one legend line on every Sharp Flow card.
let POLYREC = null; try { POLYREC = JSON.parse(fs.readFileSync(OUT + '/poly_record.json', 'utf8')); } catch {}
function polyRecordLine() {
  if (!POLYREC || !POLYREC.buckets) return '';
  const b = POLYREC.buckets, n = Object.values(b).reduce((a, x) => a + x.all.n, 0);
  const since = POLYREC.since ? new Date(POLYREC.since + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  if (n < 10) return `Poly record building: ${n} graded${since ? ' since ' + since : ''}`;
  const u = x => (x >= 0 ? '+' : '') + x.toFixed(1) + 'u';
  const parts = [];
  if (b.HOT) parts.push(`HOT ${b.HOT.all.w}-${b.HOT.all.l} ${u(b.HOT.all.u)}`);
  if (b.COLD) parts.push(`COLD sides ${b.COLD.all.w}-${b.COLD.all.l} (fading ${u(b.COLD.all.fadeU)})`);
  return `Poly calls since ${since} at Polymarket prices: ${parts.join(', ')}`;
}
function polyFor(sp, matchup, grp, r) {
  const ms = POLY.filter(m => m.sport === sp && m.matchup === matchup && m.grp === grp);
  if (!ms.length) return { for: r.for, against: r.against, sources: ['SHARP FLOW'] };
  const label = side => grp === 'total' ? side : String(side).toUpperCase();
  const row = m => ({ src: 'POLYMARKET', team: m.side, wallet: m.name, market: m.market, record: m.rec, recLabel: m.recScope ? m.recScope.replace(/, last (\d+) days/, ' · last $1d') + ' record' : null, roi: m.roi, dollars: m.usd,
    note: ['Polymarket', m.gateNote && m.sportCls !== m.cls ? m.gateNote : null, m.l10 ? m.l10.txt : null, m.n < 10 ? 'thin' : null, m.sameAsSF ? 'same wallet as Sharp Flow ' + m.sameAsSF.sfWallet + ' above' : null].filter(Boolean).join(' · '),
    status: m.twoSided ? { t: 'POLY TWO-SIDED - not counted', c: 'grey' }
      : m.cls === 'HOT' ? (m.sameAsSF ? { t: 'POLY HOT - same wallet, not a 2nd source', c: 'grey' } : { t: 'POLY HOT', c: 'green' })
      : m.sportCls === 'HOT' ? { t: 'POLY COLD in this bet type - not counted', c: 'red' } : { t: 'POLY COLD - fade flag', c: 'red' } });
  const f = r.for ? { ...r.for, rows: [...(r.for.rows || [])] } : null;
  let a = r.against ? { ...r.against, rows: [...(r.against.rows || [])] } : null;
  for (const m of ms.sort((x, y) => y.usd - x.usd)) {
    const t = label(m.side);
    if (f && f.team === t) f.rows.push(row(m));
    else if (a && a.team === t) a.rows.push(row(m));
    else if (!a) a = { team: t, rows: [row(m)] };
  }
  return { for: f, against: a, sources: ['SHARP FLOW', 'POLYMARKET'] };
}
const siteLockOf = (latest, sp, matchup, grp) => R.siteLockTxt(latest.plays, sp, matchup, grp);
function buildCards(sp, latest, flags, before) { // before: optional Date - only include tickets starting earlier than this (for an outlier/one-off card, so it doesn't swallow the main slate too)
  const tickets = (latest.tickets || []).filter(t => t.sport === sp).map(t => ({ ...t, st: startUtc(t.kickoffEt) })).filter(t => t.st && t.st > now && (!before || t.st < before));
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
      const oppAll = tickets.filter(t => t.matchup === ts[0].matchup && R.isOpposed(pick, ts[0].market, t.pick, t.market));
      const oppD = oppAll.filter(t => !cold(t)).reduce((a, t) => a + t.dollars, 0);
      const FL = R.floorFor(MIN_DOLLARS, sp, ts[0].market);
      if (all >= FL && good < FL) {
        const cb = ts.filter(cold).sort((a, b) => b.dollars - a.dollars)[0];
        if (cb) coldSides.push({ txt: `${pick}${ts[0].market === 'ML' ? ' ML' : ''} ${k(all)} (${R.coldWhy(cb)})`, dollars: all });
        continue;
      }
      if (good < FL) continue;
      const gt = ts.filter(t => !cold(t));
      const big = gt.slice().sort((a, b) => b.dollars - a.dollars)[0];
      const wallets = new Set(gt.map(t => t.wallet)).size;
      sides.push({ byPick, ts: gt, pick, dollars: good, oppD, oppAll, big, wallets, vs: Math.max(...gt.map(t => t.vsUsual || 0)), st: ts[0].st, matchup: ts[0].matchup, market: ts[0].market,
        tail: tails.has([ts[0].matchup, ts[0].market, pick].join('|')) });
    }
  }
  sides.sort((a, b) => a.st - b.st || b.dollars - a.dollars);
  coldSides.sort((a, b) => b.dollars - a.dollars);
  if (!sides.length) return [];
  const grpOf = m => m === 'TOTAL' ? 'total' : 'team';
  const gseen = {}, rows = [];
  for (const s of sides) {
    const gk = s.matchup + '|' + grpOf(s.market); if (gseen[gk]) continue; gseen[gk] = 1;
    const tix = tickets.filter(t => t.matchup === s.matchup && grpOf(t.market) === grpOf(s.market));
    const r = R.matchupRow(sp, tix, grpOf(s.market)); if (!r) continue;
    const star = sides.some(x => x.matchup === s.matchup && grpOf(x.market) === grpOf(s.market) && x.tail);
    // Record label (Derek, Nov 20 2026): the number on the right of each row is that wallet's record in THIS sport and
    // bet type - all-time for SharpFlow rows (mktRecord), last 45 days for Poly rows. Say so under the number.
    const lab = v => v && v.rows ? { ...v, rows: v.rows.map(x => ({ ...x, recLabel: x.recLabel || `${sp} ${x.market} · all-time record` })) } : v;
    r.for = lab(r.for); r.against = lab(r.against);
    const siteLock = (a, b, c) => siteLockOf(latest, a, b, c);
    const pv = polyFor(sp, s.matchup, grpOf(s.market), r);
    rows.push({ st: s.st, eyebrow: s.matchup, time: ctTime(s.st) + ' CT', tag: r.tag, sources: pv.sources, bet: (star ? '★ ' : '') + r.bet,
      price: r.price, for: pv.for, against: pv.against, moneyBar: r.moneyBar, confidence: r.confidence, callout: r.callout,
      footerLabel: (pv.sources.length > 1 ? 'SHARP FLOW + POLYMARKET READ' : 'SHARP FLOW READ') + (siteLock(sp, s.matchup, grpOf(s.market)) ? ' - ' + siteLock(sp, s.matchup, grpOf(s.market)) : '') });
  }
  rows.sort((a, b) => b.confidence - a.confidence || a.st - b.st); // Derek, Nov 18: order by confidence, not kickoff time
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
    const coldTxt = last && coldSides.length ? 'Not counted (negative market ROI or cold last 30 days): ' + coldSides.slice(0, 3).map(c => c.txt).join('; ') : '';
    cards.push({ design: 'sharpflow', brand: 'SHARP FLOW', title: `${sp} - sharp wallets`, subtitle: `Wallets with positive ${sp} market ROI and last-30 ROI, $${MIN_DOLLARS}+ per side (more for NHL and spreads) - SharpFlow snapshot ${snap} CT${rows.length > 12 ? ` - board ${cards.length + 1}` : ''}`,
      sections: secs, legend: (coldTxt ? coldTxt + ' | ' : '') + (polyRecordLine() ? polyRecordLine() + ' | ' : '') + R.CONF_LEGEND + ' Quality wallet = 10+ bets here at +15% ROI. ★ = good tail', footer: 'Wallet money, not a pick. Leans, not guarantees' });
  }
  return { cards, n: rows.length, data, cold: coldSides };
}

/* Polymarket sharp-wallet report card (Derek, Nov 20 2026 - "post a Polymarket sharp wallet report an hour before
   games ... I want to make sure I don't miss anything"). Every classified wallet position on this sport's slate from
   poly_matches.json (bet-type check already applied), whether or not SharpFlow has a side - grouped by side, HOT
   sides first. Two-sided wallets are left out (counted in the legend). Returns null when nothing qualifies, so the
   run retries next hour until the games start. */
function amer(p) { if (!(p > 0 && p < 1)) return null; return p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p; }
function polyBet(m) {
  if (m.market === 'TOTAL') { const l = String(m.title || '').match(/O\/U\s+([\d.]+)/i); return `${m.side}${l ? ' ' + l[1] : ''}`; }
  if (m.market === 'SPREAD') { const l = String(m.title || '').match(/\(([+-][\d.]+)\)/); const fav = String(m.title || '').replace(/^spread:\s*/i, '').replace(/\(.*$/, '').trim();
    if (l) { const v = parseFloat(l[1]); const mine = fav && m.side && fav.toLowerCase() === String(m.side).toLowerCase(); return `${m.side} ${mine ? (v > 0 ? '+' : '') + v : (v > 0 ? '-' : '+') + Math.abs(v)}`; } return `${m.side} spread`; }
  return `${m.side} ML`;
}
function buildPolyCard(sp, latest, before, firstStart, outlier) {
  const ms = POLY.filter(m => m.sport === sp && m.startUtc && new Date(m.startUtc) > now && (!before || new Date(m.startUtc) < before));
  const two = ms.filter(m => m.twoSided).length;
  const use = ms.filter(m => !m.twoSided);
  if (!use.length) return null;
  const tix = (latest && latest.tickets) || [];
  const sideKey = m => [m.matchup, m.market, m.side].join('|');
  const groups = {};
  for (const m of use) (groups[sideKey(m)] ||= []).push(m);
  const sfFor = m => {
    const same = tix.filter(t => t.matchup === m.matchup && t.market === m.market && (m.market === 'TOTAL' ? (/^over/i.test(t.pick) ? 'Over' : 'Under') === m.side : t.pick.toLowerCase().startsWith(String(m.side).toLowerCase())));
    const oth = tix.filter(t => t.matchup === m.matchup && t.market === m.market && !same.includes(t));
    const sd = same.reduce((a, t) => a + t.dollars, 0), od = oth.reduce((a, t) => a + t.dollars, 0);
    if (!sd && !od) return { t: 'SF no money here', c: 'grey' };
    return sd >= od ? { t: `SF same side ${k(sd)}${od ? ' vs ' + k(od) : ''}`, c: 'blue' } : { t: `SF other side ${k(od)} vs ${k(sd)}`, c: 'orange' };
  };
  const picks = Object.values(groups).map(g => {
    g.sort((a, b) => (a.cls === b.cls ? b.usd - a.usd : a.cls === 'HOT' ? -1 : 1));
    const m0 = g[0], st = new Date(m0.startUtc);
    const hot = g.filter(m => m.cls === 'HOT' && !m.sameAsSF), cold = g.filter(m => m.cls === 'COLD');
    // Short chips per wallet so they wrap instead of running into the price column (Nov 20 render check):
    // [verdict + name + $] [sport bet-type record, last 45d] [L10] [note]
    const chips = [];
    for (const m of g) {
      const rec = m.rec ? `${sp} ${m.market} ${m.rec}${m.roi != null ? ` (${m.roi >= 0 ? '+' : ''}${Math.round(m.roi)}%)` : ''} last 45d` : null;
      const same = m.cls === 'HOT' && m.sameAsSF, gated = m.cls === 'COLD' && m.sportCls === 'HOT';
      const c = same ? 'grey' : m.cls === 'HOT' ? 'green' : 'red';
      chips.push({ t: `${gated ? 'COLD in this bet type' : m.cls} ${m.name} ${k(m.usd)}`, c });
      if (rec) chips.push({ t: rec, c: 'grey' });
      if (m.l10) chips.push({ t: m.l10.txt, c: 'grey' });
      if (m.vsUsual != null) chips.push({ t: `${m.sizeTier === 'BIG' ? 'BIG ' : m.sizeTier === 'SMALL' ? 'small ' : ''}${m.vsUsual}x their usual ${k(m.usualMed)}${m.usualScope === 'all sports' ? ' (all sports)' : ''}`, c: m.sizeTier === 'BIG' ? (m.cls === 'HOT' && !same ? 'green' : m.cls === 'COLD' ? 'red' : 'grey') : 'grey' });
      chips.push({ t: same ? `same wallet as SF ${m.sameAsSF.sfWallet} - not a 2nd source` : gated ? 'not counted' : m.cls === 'COLD' ? 'fade flag' : 'counts', c: same ? 'grey' : c });
    }
    chips.push(sfFor(m0));
    const px = amer(g.reduce((a, m) => a + (m.avgPrice || 0) * m.usd, 0) / g.reduce((a, m) => a + m.usd, 0));
    return { st, hotUsd: hot.reduce((a, m) => a + m.usd, 0), coldUsd: cold.reduce((a, m) => a + m.usd, 0),
      pick: { bet: polyBet(m0), sub: `${m0.matchup} - ${ctTime(st)} CT`, chips, price: px == null ? null : Math.round(px),
        polyHot: hot.length, polyCold: cold.length } };
  }).sort((a, b) => (b.hotUsd > 0) - (a.hotUsd > 0) || b.hotUsd - a.hotUsd || b.coldUsd - a.coldUsd);
  const boards = [];
  const rosterAt = POLYMETA.rosterGeneratedAt ? ctTime(new Date(POLYMETA.rosterGeneratedAt)) : 'n/a';
  const checkedAt = POLYMETA.at ? ctTime(new Date(POLYMETA.at)) : 'n/a';
  for (let i = 0; i < picks.length && boards.length < 2; i += 12) {
    const chunk = picks.slice(i, i + 12);
    const secs = [];
    for (const p of chunk.slice().sort((a, b) => a.st - b.st)) {
      const h = `${sp} - ${ctTime(p.st).toUpperCase()} CT`;
      let sec = secs.find(x => x.heading === h); if (!sec) secs.push(sec = { heading: h, picks: [] });
      sec.picks.push(p.pick);
    }
    const last = i + 12 >= picks.length || boards.length === 1;
    const rl = polyRecordLine();
    boards.push({ brand: 'POLYMARKET', title: `${sp} - Polymarket sharp wallets`,
      subtitle: `Classified wallets with $${MIN_POLY}+ on a side. HOT = profitable in ${sp} and this bet type (last 45 days, ${(POLYMETA.hotBar || {}).mktMin || 5}+ bets${(POLYMETA.hotBar || {}).roiMin ? `, +${POLYMETA.hotBar.roiMin}% ROI or better` : ''}); COLD = losing. Wallet roster ${rosterAt} CT, buys checked ${checkedAt} CT${picks.length > 12 ? ` - board ${boards.length + 1}` : ''}`,
      sections: secs,
      legend: [last && two ? `${two} two-sided position${two === 1 ? '' : 's'} left out` : '', last && picks.length > 24 ? `${picks.length - 24} more sides not shown (smallest wallet money)` : '', rl, 'Price = their average Polymarket price as American odds. Usual = the wallet\'s median game-line bet (1.5x+ = BIG). COLD = fade flag. Same wallet as SF = not a second source.'].filter(Boolean).join(' | '),
      footer: 'Wallet money, not a pick. Leans, not guarantees' });
  }
  const nh = picks.filter(p => p.hotUsd > 0).length;
  const first = firstStart ? ctTime(firstStart) : '';
  return { route: 'Sharp Signals', content: `**Polymarket sharp wallets - ${sp}${outlier ? ' one-off' : ''} - first game ${first} CT** - ${picks.length} side${picks.length === 1 ? '' : 's'} (${nh} with a HOT wallet)`, boards };
}

(async () => {
  let latest = null; try { latest = JSON.parse(fs.readFileSync(OUT + '/latest.json', 'utf8')); } catch {}
  let { out: startsAll, want } = await allStarts();
  if (process.env.ESPN_OFF || !Object.keys(startsAll).length) { if (latest) Object.assign(startsAll, Object.fromEntries(Object.entries(ticketStarts(latest, want)).filter(([s]) => !startsAll[s]))); }
  // Polymarket sharp-wallet report (Derek, Nov 20 2026): its own card per sport, an hour before that sport's games
  // (no 5pm cap - it follows the games), tracked with its own POLY_<sport> posted flag. Runs alongside, not instead of,
  // the Sharp Flow card.
  const due = [...dueList(startsAll), ...dueList(startsAll, 'POLY_', false)];
  const summary = Object.entries(startsAll).map(([s, ts]) => {
    const c = clusterStarts(ts);
    return s + ' main ' + ctTime(c.mainStart) + (c.outliers.length ? ` (+${c.outliers.length} outlier ${ctTime(c.outliers[0])})` : '');
  }).join(', ');
  console.log('today (CT):', summary || 'none', '| posted today:', [...done].join(',') || 'none', '| due:', due.join(',') || 'none');
  if (MODE === 'plan') {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due.join(',')}\n`);
    return;
  }
  /* WATCHDOG (council Nov 20 - replaces the Claude "Sharp Flow dispatcher + watchdog" task's checks, no Claude usage):
     remembers each sport's first start of the CT day (sf_branch/first_starts.json). A sport whose first game has
     started without its Sharp Flow card is a GitHub warning (it can be legit: no sides over the threshold). A
     SharpFlow snapshot older than 3 hours between 9am and 10pm CT FAILS the run, because it means the puller is down
     and every card and alert is running blind - GitHub emails Derek on a failed scheduled run. */
  if (MODE === 'watch') {
    let fsj = {}; try { fsj = JSON.parse(fs.readFileSync(OUT + '/first_starts.json', 'utf8')); } catch {}
    const day = (fsj[today] ||= {});
    for (const [sp, ts] of Object.entries(startsAll)) if (ts.length && (!day[sp] || new Date(ts[0]) < new Date(day[sp]))) day[sp] = ts[0].toISOString();
    for (const d of Object.keys(fsj)) if (d < today) delete fsj[d];
    if (!process.env.NO_MARK) fs.writeFileSync(OUT + '/first_starts.json', JSON.stringify(fsj));
    const missed = Object.entries(day).filter(([sp, iso]) => new Date(iso) < now && !done.has(sp)).map(([sp]) => sp);
    if (missed.length) console.log(`::warning::MISSED Sharp Flow card (first game started, no card): ${missed.join(', ')}`);
    const hr = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(now);
    const ageMin = latest ? Math.round((now - new Date(latest.scannedAt)) / 60000) : null;
    const polyAge = POLYMETA.at ? Math.round((now - new Date(POLYMETA.at)) / 60000) : null;
    console.log(`watchdog: SharpFlow snapshot ${ageMin ?? 'missing'} min old, Poly matches ${polyAge ?? 'missing'} min old, missed: ${missed.join(',') || 'none'}`);
    if (hr >= 9 && hr < 22 && (ageMin == null || ageMin > 180)) { console.log(`::error::SharpFlow snapshot is ${ageMin ?? 'missing'} min old - the SharpFlow MCP puller scheduled task is not landing data`); process.exitCode = 1; }
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
  for (const token of dueIn) {
    if (token.startsWith('POLY_')) {
      const t2 = token.slice(5), outlierP = t2.endsWith('_OUTLIER'), spP = outlierP ? t2.slice(0, -'_OUTLIER'.length) : t2;
      const clP = clusterStarts(startsAll[spP] || []);
      const firstP = clP ? (outlierP ? clP.outliers[0] : clP.mainStart) : null;
      const card = buildPolyCard(spP, latest, outlierP && clP ? clP.mainStart : null, firstP, outlierP);
      if (!card) { console.log(token, 'no classified Polymarket wallet on this slate yet - will retry next run'); continue; }
      const f = `${CARD_DIR}/${today}-${hhmm}-poly-${spP.toLowerCase()}${outlierP ? '-outlier' : ''}.json`;
      fs.writeFileSync(f, JSON.stringify(card, null, 1)); wrote.push(token); console.log('wrote', f);
      continue;
    }
    const outlier = token.endsWith('_OUTLIER');
    const sp = outlier ? token.slice(0, -'_OUTLIER'.length) : token;
    const cluster = clusterStarts(startsAll[sp] || []);
    const before = outlier ? cluster.mainStart : null;
    const res = buildCards(sp, latest, flags, before);
    if (!res || !res.cards || !res.cards.length) { console.log(token, 'no sides over threshold yet - will retry next run'); continue; }
    const firstSt = outlier ? cluster.outliers[0] : cluster.mainStart;
    const first = firstSt ? ctTime(firstSt) : '';
    const label = outlier ? `${sp} one-off` : sp;
    const card = { route: 'Sharp Signals', content: `**Sharp Flow - ${label} - first game ${first} CT** - ${res.n} sharp-money side${res.n === 1 ? '' : 's'}`, boards: res.cards };
    const f = `${CARD_DIR}/${today}-${hhmm}-sharpflow-${sp.toLowerCase()}${outlier ? '-outlier' : ''}.json`;
    fs.writeFileSync(f, JSON.stringify(card, null, 1)); wrote.push(token);
    if (!process.env.NO_MARK) { fs.mkdirSync(OUT + '/previews', { recursive: true }); fs.writeFileSync(`${OUT}/previews/${today}-${hhmm}-${sp.toLowerCase()}${outlier ? '-outlier' : ''}.json`, JSON.stringify({ date: today, posted_ct: hhmm, sport: sp, outlier, first_start: firstSt ? firstSt.toISOString() : null, snapshot: latest.scannedAt, sides: res.data }, null, 1)); } console.log('wrote', f, res.n, 'sides');
  }
  if (wrote.length && !process.env.NO_MARK) { posted[today] = [...done, ...wrote]; for (const d of Object.keys(posted)) if (d < today) delete posted[d]; fs.writeFileSync(OUT + '/previews.json', JSON.stringify(posted)); }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `wrote=${wrote.length}\n`);
})();
