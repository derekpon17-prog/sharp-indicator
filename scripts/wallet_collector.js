/* Wallet collector: runs in GitHub Actions (no Claude, no Vercel function).
   Reuses api/trader-stats.js (per-sport record by slug) and api/discover.js (verdict rules).
   Output: wallets/wallets.json  { generatedAt, sports: { NFL: { sharp:[], loser:[], unproven:[] } } } */
const fs = require('fs');
const path = require('path');
const stats = require('../api/trader-stats.js');
const discover = require('../api/discover.js');

const DATA = 'https://data-api.polymarket.com';
const SPORTS = ['NFL', 'NCAAF', 'NHL', 'NBA', 'NCAAB'];
const MAX_WALLETS = parseInt(process.env.MAX_WALLETS || '300', 10);
const CONC = 6;
const LOSER_ROI = -4;      // settled ROI at or below this = loser
const MIN_SETTLED = 20;

async function j(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

async function collectCandidates() {
  const cands = {};   // wallet -> { name, sports:Set, src:Set, usd }
  const add = (w, name, sport, src, usd) => {
    if (!w) return;
    const c = cands[w] || (cands[w] = { wallet: w, name: name || null, sports: new Set(), src: new Set(), usd: 0 });
    if (name && !c.name) c.name = name;
    if (sport) c.sports.add(sport);
    c.src.add(src); c.usd += usd || 0;
  };
  // 1) leaderboards (sports + overall, month and all-time)
  for (const cat of ['SPORTS', 'OVERALL']) for (const tp of ['ALL', 'MONTH']) for (const off of [0, 50]) {
    const d = await j(`${DATA}/v1/leaderboard?category=${cat}&timePeriod=${tp}&orderBy=PNL&limit=50&offset=${off}`);
    (Array.isArray(d) ? d : []).forEach(t => add(t.proxyWallet, t.userName || t.pseudonym, null, 'lb-' + cat));
  }
  // 2) global trade feed, large buys, paged
  let pages = 0;
  for (let off = 0; off < 3000; off += 500) {
    const d = await j(`${DATA}/trades?limit=500&offset=${off}&takerOnly=true&side=BUY&filterType=CASH&filterAmount=500`);
    if (!Array.isArray(d) || !d.length) break;
    pages++;
    d.forEach(t => {
      const sport = discover.sportOfTrade(t);
      if (!sport || !SPORTS.includes(sport)) return;
      add(t.proxyWallet, t.name, sport, 'feed', (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0));
    });
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
  const out = { generatedAt: new Date().toISOString(), candidates: Object.keys(cands).length, evaluated: 0, feedPages,
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
