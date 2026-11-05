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

(async () => {
  const t0 = Date.now();
  const { cands, feedPages } = await collectCandidates();
  let list = Object.values(cands).sort((a, b) => (b.usd - a.usd) || (b.src.size - a.src.size)).slice(0, MAX_WALLETS);
  console.log('candidates', Object.keys(cands).length, 'evaluating', list.length, 'feedPages', feedPages);
  const out = { log: LOG, generatedAt: new Date().toISOString(), candidates: Object.keys(cands).length, evaluated: 0, feedPages,
                sports: Object.fromEntries(SPORTS.map(s => [s, { sharp: [], loser: [], unproven: [] }])) };
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const c = list[idx++];
      const s = await stats.getTraderStats(c.wallet, { fresh: true });
      if (!s || !s.ok || s.sampleBiased) continue;
      out.evaluated++;
      for (const sport of SPORTS) {
        const cl = classify(sport, s, c);
        if (!cl) continue;
        if (cl.bucket === 'unproven') { if (cl.row.markets >= 5) out.sports[sport].unproven.push(cl.row); continue; }
        const verdict = await discover.evaluateCandidate({ wallet: c.wallet, sport }, { fresh: false });
        const row = cl.row;
        if (verdict.verdict === 'promote') { row.reason = verdict.reason; out.sports[sport].sharp.push(row); }
        else if ((row.roiPct != null && row.roiPct <= LOSER_ROI) && row.pnl < 0) { row.reason = verdict.reason; out.sports[sport].loser.push(row); }
        else { row.reason = verdict.reason; out.sports[sport].unproven.push(row); }
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  for (const sp of SPORTS) {
    const o = out.sports[sp];
    o.sharp.sort((a, b) => b.roiPct - a.roiPct); o.loser.sort((a, b) => a.roiPct - b.roiPct);
    o.unproven.sort((a, b) => b.markets - a.markets); o.unproven = o.unproven.slice(0, 25);
  }
  fs.mkdirSync('wallets', { recursive: true });
  fs.writeFileSync(path.join('wallets', 'wallets.json'), JSON.stringify(out, null, 1));
  console.log('done in', Math.round((Date.now() - t0) / 1000) + 's', SPORTS.map(s => s + ' ' + out.sports[s].sharp.length + '/' + out.sports[s].loser.length).join(' | '));
})();
