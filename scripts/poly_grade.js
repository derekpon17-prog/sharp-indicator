/* scripts/poly_grade.js  (Derek, Nov 20 2026 - "track their bets")
   Grades the Polymarket HOT/COLD calls logged by scripts/poly_match.js (<sf>/polylog/<date>.json) and keeps the
   running record in <sf>/poly_record.json, the same idea as SharpFlow's SF_CALLED record (sf_record.json).

   GRADING
   - Only entries whose game started 3+ hours ago and that have no result yet.
   - Result comes from Polymarket's own resolution of the exact market the wallet bought (conditionId + outcome):
     first Gamma (/markets?condition_ids=, outcomePrices of a closed market), then the wallet's own settled
     positions (v2 /positions, current_price 1 = won, 0 = lost) as a fallback. Never guessed: an entry with no
     resolution after 5 days is marked NA and left out of the record.
   - Units use the RUNBOOK section 14 staking rule at the wallet's Polymarket fill price (firstPrice, frozen at first
     sighting): underdog (price under 0.50) risks 1u to win (1-p)/p; favorite risks p/(1-p) to win 1u. This is the
     price THEY got on Polymarket, not a sportsbook price - say so wherever the record is shown.
   - COLD calls are graded on the cold wallet's own side. "fadeU" is the approximate result of taking the other side at
     1-p (no vig), which is what a COLD flag suggests.
   - twoSided entries are never counted. sameAsSF HOT entries are kept in their own bucket (HOT_SAME_SF) because they
     are the same bettor as a SharpFlow ticket, not an independent Polymarket call.

   CLI: node scripts/poly_grade.js <sf_dir>
*/
const fs = require('fs');
const { fetchSettled } = require('./poly_match.js');

const GAMMA = 'https://gamma-api.polymarket.com';
const now = Date.now();
const H = 3600000;

function unitsFor(p, won) {
  if (!(p > 0 && p < 1)) return null;
  const dog = p < 0.5;
  const risk = dog ? 1 : p / (1 - p), win = dog ? (1 - p) / p : 1;
  return +(won ? win : -risk).toFixed(3);
}

async function gammaResolution(conditionId) {
  try {
    const r = await fetch(`${GAMMA}/markets?condition_ids=${conditionId}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const j = await r.json();
    const m = Array.isArray(j) ? j[0] : (j && j.data ? j.data[0] : null);
    if (!m || !m.closed) return null;
    const outs = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
    const prices = (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices).map(Number);
    if (!Array.isArray(outs) || !Array.isArray(prices)) return null;
    if (!prices.some(x => x >= 0.99)) return null;          // closed but not cleanly resolved (e.g. 50-50 refund)
    return { outs, prices };
  } catch { return null; }
}

/* CLV (council Nov 20): the outcome token's last Polymarket price before the start vs the wallet's first-sighting
   price, in probability points (+0.03 = the market moved 3 points toward the wallet by tip-off). Uses the CLOB
   prices-history for the exact token the wallet bought; entries logged before tokenId was stored have no CLV. */
const CLOB = 'https://clob.polymarket.com';
async function closePrice(tokenId, startMs) {
  try {
    const q = `market=${tokenId}&startTs=${Math.floor(startMs / 1000) - 3 * 3600}&endTs=${Math.floor(startMs / 1000)}&fidelity=5`;
    const r = await fetch(`${CLOB}/prices-history?${q}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const h = ((await r.json()) || {}).history || [];
    const last = h.filter(x => x.t * 1000 <= startMs).pop();
    return last && last.p > 0 && last.p < 1 ? +(+last.p).toFixed(4) : null;
  } catch { return null; }
}

(async () => {
  const sfDir = process.argv[2] || 'sf_branch';
  const dir = sfDir + '/polylog';
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { console.log('poly_grade: no polylog yet'); }
  const logs = files.map(f => ({ f, log: JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')) }));

  // 1) grade what is due
  const due = [];
  for (const { log } of logs) for (const e of Object.values(log.entries || {})) {
    if (e.result) continue;
    const st = e.startUtc ? Date.parse(e.startUtc) : null;
    if (!st || now - st < 3 * H) continue;
    due.push(e);
  }
  const posCache = {};
  let graded = 0;
  for (const e of due) {
    let won = null, how = null;
    if (e.conditionId && e.outcome) {
      const g = await gammaResolution(e.conditionId);
      if (g) {
        const i = g.outs.findIndex(o => String(o).toLowerCase() === String(e.outcome).toLowerCase());
        if (i >= 0) { won = g.prices[i] >= 0.99; how = 'gamma'; }
      }
      if (won === null) {
        posCache[e.wallet] ||= await fetchSettled(e.wallet);
        const p = posCache[e.wallet].find(x => (x.condition_id === e.conditionId) && String(x.outcome).toLowerCase() === String(e.outcome).toLowerCase());
        const cp = p ? parseFloat(p.current_price ?? p.cur_price) : NaN;
        if (cp >= 0.99 || cp <= 0.01) { won = cp >= 0.99; how = 'positions'; }
      }
    }
    if (won !== null) {
      e.result = won ? 'W' : 'L';
      e.u = unitsFor(e.firstPrice, won);
      e.fadeU = e.firstPrice > 0 && e.firstPrice < 1 ? unitsFor(1 - e.firstPrice, !won) : null;
      e.gradedAt = new Date(now).toISOString(); e.gradedBy = how;
      graded++;
    } else if (now - Date.parse(e.startUtc) > 5 * 24 * H) {
      e.result = 'NA'; e.gradedAt = new Date(now).toISOString();   // never resolved where we can see it - not counted
    }
  }
  let clvDone = 0;
  for (const { log } of logs) for (const e of Object.values(log.entries || {})) {
    if (e.closePrice != null || e.clvTried || !e.tokenId || !e.startUtc) continue;
    const st = Date.parse(e.startUtc);
    if (now < st + 15 * 60000) continue;
    const cp = await closePrice(e.tokenId, st);
    if (cp != null && e.firstPrice > 0) { e.closePrice = cp; e.clv = +(cp - e.firstPrice).toFixed(4); clvDone++; }
    else if (now - st > 2 * 24 * H) e.clvTried = true;   // history never came back - stop asking
  }
  for (const { f, log } of logs) fs.writeFileSync(`${dir}/${f}`, JSON.stringify(log, null, 1));

  // 2) rebuild the record from every logged entry
  const blank = () => ({ w: 0, l: 0, n: 0, u: 0, fadeU: 0, clvN: 0, clvAvg: null, clvPos: 0 });
  const add = (b, e) => { b.n++; e.result === 'W' ? b.w++ : b.l++; b.u = +(b.u + (e.u || 0)).toFixed(2); b.fadeU = +(b.fadeU + (e.fadeU || 0)).toFixed(2);
    if (e.clv != null) { b.clvAvg = +(((b.clvAvg || 0) * b.clvN + e.clv) / (b.clvN + 1)).toFixed(4); b.clvN++; if (e.clv > 0) b.clvPos++; } };
  const rec = { updated: new Date(now).toISOString(), since: files[0] ? files[0].slice(0, 10) : null, pending: 0, na: 0,
    note: 'CLV = last Polymarket price before the start minus their first-sighting price (probability points). Graded at the wallet\'s own Polymarket fill price (first sighting), RUNBOOK section 14 staking. COLD = the cold wallet\'s own side; fadeU = taking the other side at 1-p, no vig.',
    buckets: {} };
  for (const { log } of logs) for (const e of Object.values(log.entries || {})) {
    if (e.twoSided) continue;
    if (!e.result) { rec.pending++; continue; }
    if (e.result === 'NA') { rec.na++; continue; }
    const bk = e.cls === 'HOT' && e.sameAsSF ? 'HOT_SAME_SF' : e.cls;
    const B = (rec.buckets[bk] ||= { all: blank(), onCard: blank(), offCard: blank(), bySport: {}, byMarket: {}, byTiming: {} });
    add(B.all, e);
    if (e.onCard) add(B.onCard, e);
    add(B.bySport[e.sport] ||= blank(), e);
    add(B.byMarket[e.market] ||= blank(), e);
    if (!e.onCard) add(B.offCard, e);
    // When the wallet first bought, hours before the start (council Nov 20): does early or late Polymarket money do better?
    const h = e.hoursBeforeStart;
    add(B.byTiming[h == null ? 'unknown' : h > 6 ? 'over 6h before' : h >= 1 ? '1-6h before' : 'under 1h before'] ||= blank(), e);
  }
  fs.writeFileSync(sfDir + '/poly_record.json', JSON.stringify(rec, null, 1));
  const line = Object.entries(rec.buckets).map(([k, b]) => `${k} ${b.all.w}-${b.all.l} (${b.all.u >= 0 ? '+' : ''}${b.all.u}u)`).join(', ');
  console.log(`poly_grade: CLV added for ${clvDone}`);
  console.log(`poly_grade: graded ${graded} now, ${rec.pending} pending, ${rec.na} NA | ${line || 'nothing graded yet'}`);
})();
