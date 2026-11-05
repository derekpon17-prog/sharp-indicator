/* Wallet collector: runs in GitHub Actions (no Claude, no Vercel function).
   Reuses api/trader-stats.js (per-sport record by slug) and api/discover.js (verdict rules).
   Output: wallets/wallets.json  { generatedAt, sports: { NFL: { sharp:[], loser:[], unproven:[] } } } */
const fs = require('fs');
const path = require('path');
const stats = require('../api/trader-stats.js');
const discover = require('../api/discover.js');

const V2 = 'https://data-api.polymarket.com/v2';
const SPORTS = ['NFL', 'NCAAF', 'NHL', 'NBA', 'NCAAB'];
const MAX_WALLETS = parseInt(process.env.MAX_WALLETS || '300', 10);
const CONC = 6;
const LOG = [];
const _log = console.log;
console.log = (...a) => { const m = a.join(' '); if (LOG.length < 60) LOG.push(m); _log(m); };
const LOSER_ROI = -4;      // settled ROI at or below this = loser
const MIN_SETTLED = 20;

async function j(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) { console.log('HTTP', r.status, url.slice(0, 110), (await r.text()).slice(0, 160)); return null; }
    const d = await r.json();
    if (!d || !Array.isArray(d.data) || !d.data.length) console.log('EMPTY', url.slice(0, 110), JSON.stringify(d).slice(0, 160));
    return d;
  } catch (e) { console.log('ERR', url.slice(0, 110), e.message, e.cause && e.cause.code); return null; }
}

async function collectCandidates() {
  const cands = {};   // wallet -> { name, sports:Set, src:Set, usd }
  const add = (w, name, sport, src, usd) => {
    if (!w) return;
    w = String(w).toLowerCase();
    const c = cands[w] || (cands[w] = { wallet: w, name: name || null, sports: new Set(), src: new Set(), usd: 0 });
    if (name && !c.name) c.name = name;
    if (sport) c.sports.add(sport);
    c.src.add(src); c.usd += usd || 0;
  };
  // 1) v2 leaderboards: sports category, all-time + month, plus overall all-time
  for (const [cat, tp] of [['sports', 'all'], ['sports', 'month'], ['sports', 'week'], ['overall', 'all']]) {
    let cursor = null;
    for (let pg = 0; pg < 2; pg++) {
      const d = await j(`${V2}/leaderboard?category=${cat}&time_period=${tp}&sort_by=PNL&limit=200` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
      (d && d.data || []).forEach(t => { if (t.pnl > 0) add(t.user_id, t.user_name, null, 'lb-' + cat + '-' + tp); });
      cursor = d && d.pagination && d.pagination.next_cursor;
      if (!cursor) break;
    }
  }
  // 2) global trade feed, large buys, cursor paged
  let pages = 0, cursor = null;
  for (let pg = 0; pg < 8; pg++) {
    const d = await j(`${V2}/trades?limit=1000&taker_only=true&side=BUY&filter_type=CASH&filter_amount=500` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    if (!d || !Array.isArray(d.data) || !d.data.length) break;
    pages++;
    d.data.forEach(t => {
      const sport = discover.sportOfTrade(t);
      if (!sport || !SPORTS.includes(sport)) return;
      add(t.proxy_wallet, t.name, sport, 'feed', (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0));
    });
    cursor = d.pagination && d.pagination.next_cursor;
    if (!cursor) break;
  }
  // 3) optional: existing roster from KV if secrets are present
  try {
    const roster = await discover.getRoster(null);
    (roster || []).forEach(e => add(e.wallet, e.name, e.sport, 'roster'));
  } catch {}
  return { cands, feedPages: pages };
}

function classify(sport, s, cand) {
  const b = s.bySport && s.bySport[sport];
  if (!b) return null;
  const row = {
    wallet: cand.wallet, name: cand.name, src: [...cand.src],
    markets: b.positions, settled: b.settled || 0, pnl: b.pnl, roiPct: b.roiPct,
    winRate: b.resolvedWinRate, impliedWinRate: b.impliedWinRate, edgePP: b.edgePP,
    avgEntry: b.avgEntry, staked: b.staked,
  };
  if (b.positions < MIN_SETTLED || (b.settled || 0) < MIN_SETTLED) { row.reason = 'sample ' + (b.settled || 0) + '/' + MIN_SETTLED; return { bucket: 'unproven', row }; }
  const hedgePct = Math.round(((s.hedgedMarkets || 0) / Math.max(1, s.positions)) * 100);
  row.hedgePct = hedgePct;
  if (hedgePct > 60) { row.reason = 'market maker'; return null; }
  return { bucket: 'eval', row };
}

/* PERSISTENCE TEST. Every wallet is judged on bets settled BEFORE the cutoff only, then checked on bets
   settled AFTER it. A wallet is "confirmed" only if the edge held out of sample. */
const CUTOFF_DAYS = parseInt(process.env.CUTOFF_DAYS || '45', 10);
function leg(p) {
  const cp = parseFloat(p.curPrice), px = parseFloat(p.avgPrice), sh = parseFloat(p.totalBought), pnl = parseFloat(p.realizedPnl);
  if (!isFinite(cp) || !isFinite(px) || !isFinite(sh) || !isFinite(pnl) || sh <= 0) return null;
  const win = cp >= 0.99, loss = cp <= 0.01;
  if (!win && !loss) return null;
  return { win, cost: px * sh, pnl, ts: parseFloat(p.firstEntryAt) || parseFloat(p.lastEventAt) || 0 };
}
function agg(legs) {
  const n = legs.length;
  if (!n) return { n: 0, roi: null, wr: null, pnl: 0, staked: 0, implied: null };
  const cost = legs.reduce((a, l) => a + l.cost, 0), pnl = legs.reduce((a, l) => a + l.pnl, 0);
  const wins = legs.filter(l => l.win).length;
  return { n, roi: cost > 0 ? Math.round(pnl / cost * 1000) / 10 : null, wr: Math.round(wins / n * 1000) / 10,
           pnl: Math.round(pnl), staked: Math.round(cost) };
}

(async () => {
  const t0 = Date.now();
  const { cands, feedPages } = await collectCandidates();
  const list = Object.values(cands).sort((a, b) => (b.usd - a.usd) || (b.src.size - a.src.size)).slice(0, MAX_WALLETS);
  const cutoff = Math.floor(Date.now() / 1000) - CUTOFF_DAYS * 86400;
  console.log('candidates', Object.keys(cands).length, 'evaluating', list.length, 'feedPages', feedPages, 'cutoffDays', CUTOFF_DAYS);
  const out = { log: LOG, generatedAt: new Date().toISOString(), cutoffDays: CUTOFF_DAYS, candidates: Object.keys(cands).length, evaluated: 0, feedPages,
                sports: Object.fromEntries(SPORTS.map(s => [s, { confirmed_sharp: [], failed_sharp: [], confirmed_loser: [], failed_loser: [], watch: [], groups: null }])) };
  const allRows = Object.fromEntries(SPORTS.map(s => [s, []]));
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const c = list[idx++];
      const r = await stats.fetchClosedPositions(c.wallet);
      if (!r || !r.ok || !r.positions.length) continue;
      out.evaluated++;
      const by = {};
      r.positions.forEach(p => {
        const sp = stats.sportOf(p).sport;
        if (!sp || !SPORTS.includes(sp)) return;
        const l = leg(p); if (!l) return;
        (by[sp] || (by[sp] = [])).push(l);
      });
      for (const sport of Object.keys(by)) {
        const legs = by[sport];
        const pre = agg(legs.filter(l => l.ts && l.ts < cutoff)), post = agg(legs.filter(l => l.ts >= cutoff));
        allRows[sport].push({ wallet: c.wallet, name: c.name, src: [...c.src], pre, post });
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const PRE_MIN = 40, POST_MIN = 10;
  for (const sp of SPORTS) {
    const o = out.sports[sp], rows = allRows[sp];
    const preSharp = rows.filter(r => r.pre.n >= PRE_MIN && r.pre.roi >= 10);
    const preLoser = rows.filter(r => r.pre.n >= PRE_MIN && r.pre.roi <= -4 && r.pre.pnl < 0);
    const grp = (g) => { const legs = g.filter(r => r.post.n >= 1); const st = legs.reduce((a, r) => a + r.post.staked, 0), pn = legs.reduce((a, r) => a + r.post.pnl, 0); return { wallets: g.length, withPostBets: legs.length, postBets: legs.reduce((a, r) => a + r.post.n, 0), postStaked: st, postPnl: pn, postRoiPct: st > 0 ? Math.round(pn / st * 1000) / 10 : null }; };
    o.groups = { preSharp: grp(preSharp), preLoser: grp(preLoser), everyone: grp(rows) };
    preSharp.forEach(r => { (r.post.n >= POST_MIN ? (r.post.roi > 0 ? o.confirmed_sharp : o.failed_sharp) : o.watch).push(r); });
    preLoser.forEach(r => { if (r.post.n >= POST_MIN) (r.post.roi < 0 ? o.confirmed_loser : o.failed_loser).push(r); });
    o.confirmed_sharp.sort((a, b) => b.post.roi - a.post.roi);
    o.confirmed_loser.sort((a, b) => a.post.roi - b.post.roi);
    o.watch.sort((a, b) => b.pre.roi - a.pre.roi); o.watch = o.watch.slice(0, 25);
  }
  fs.mkdirSync('wallets', { recursive: true });
  fs.writeFileSync(path.join('wallets', 'wallets.json'), JSON.stringify(out, null, 1));
  console.log('done in', Math.round((Date.now() - t0) / 1000) + 's', SPORTS.map(s => s + ' ' + out.sports[s].confirmed_sharp.length + '/' + out.sports[s].confirmed_loser.length).join(' | '));
})();
