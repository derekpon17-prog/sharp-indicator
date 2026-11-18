/* Sharp Flow rules, shared by preview and alerts. Recalibrated Nov 17 (Derek) after the owner's note that the top sharps cooled
   (Oct 116-56, Nov 105-87) and our own Sharp Flow called sides ran 53-52 -12.2u since Nov 14.
   1. Form gate: a wallet counts only if its all-time ROI in this sport+market AND its last-30-day ROI in the sport are not negative.
   2. Size-ups: a big bet vs the wallet's usual size is NOT extra strength. Sizing up while hot (L10 8+ wins) is flagged, never gold.
   3. Wallet count is shown but not treated as extra confirmation (several sharps pile onto the same side together).
   4. Floors by segment: base $1K; NHL x2.5 (cold); spreads x1.5 (our spreads ran 12-18). NBA ML and NFL keep the base floor. */
const coldMkt = t => t.mktRoi != null && t.mktRoi <= 0;
// Nov 18 (owner's point: wallet + market): last-30 ROI in THIS market when known, else the sport-wide last-30 ROI.
const formRoi = t => t.mktL30Roi != null ? t.mktL30Roi : t.l30Roi;
const coldForm = t => formRoi(t) != null && formRoi(t) <= 0;
const cold = t => coldMkt(t) || coldForm(t);
const coldWhy = t => coldMkt(t) ? `${t.mktRecord} here, ${Math.round(t.mktRoi)}% ROI` : `cold form ${t.mktL30Roi != null ? (t.mktL30Rec || '') + ' L30 here' : (t.l30Rec || '') + ' L30'}, ${Math.round(formRoi(t))}% ROI`;
const hotWins = f => { const m = String(f || '').match(/L10 (\d+)-(\d+)/); return m ? +m[1] : null; };
const SPORT_MULT = { NHL: 2.5 }, MARKET_MULT = { SPREAD: 1.5 };
const floorFor = (base, sp, mk) => Math.round(base * (SPORT_MULT[sp] || 1) * (MARKET_MULT[mk] || 1));
function sizeChip(sp, vs, form) {
  const x = (+vs).toFixed(1) + 'x their usual ' + sp + ' bet';
  if (vs >= 1.5 && hotWins(form) >= 8) return { t: x + ' - sized up while hot', c: 'orange' };
  return { t: x, c: vs >= 1.5 ? 'blue' : 'grey' };
}
function segmentChips(sp, mk) {
  const out = [];
  if (sp === 'NHL') out.push({ t: 'NHL sharps cold lately - higher floor', c: 'orange' });
  if (mk === 'SPREAD') out.push({ t: 'spreads: lower confidence', c: 'orange' });
  return out;
}

/* Simple card view (Derek, Nov 17 6:25pm CT: "too much noise"): four chips per play.
   1 money for vs against, 2 x their usual bet, 3 sport record plus market record, 4 form label HOT / GOOD / COLD / THIN. */
const betsOf = rec => { const m = String(rec || '').match(/^(\d+)-(\d+)/); return m ? +m[1] + +m[2] : 0; };
function status(t) {
  const nb = betsOf(t.mktRecord), w = hotWins(t.form), l = (String(t.form || '').match(/L10 \d+-(\d+)/) || [])[1];
  if (nb < 5) return { t: 'THIN - ' + nb + ' bet' + (nb === 1 ? '' : 's') + ' here', c: 'grey' };
  if ((t.mktRoi != null && t.mktRoi <= 0) || (formRoi(t) != null && formRoi(t) <= 0) || (w != null && w <= 3)) return { t: 'COLD', c: 'red' };
  if (w != null && w >= 8) return { t: 'HOT (last 10: ' + w + '-' + l + ')', c: 'gold' };
  return { t: 'GOOD', c: 'green' };
}
function simpleChips({ sp, mk, moneyTxt, orange, vs, big, sportRec, opp }) {
  const chips = [{ t: moneyTxt, c: orange ? 'orange' : 'blue' }];
  chips.push({ t: (+vs).toFixed(1) + 'x their bet', c: 'grey' });
  const mrec = big.mktRecord ? mk + ' ' + big.mktRecord + (big.mktRoi != null ? ' (' + (big.mktRoi >= 0 ? '+' : '') + Math.round(big.mktRoi) + '%)' : '') : 'no ' + mk + ' record';
  const srec = sportRec ? sp + ' ' + sportRec + ' | ' : big.l30Rec ? sp + ' L30 ' + big.l30Rec + ' | ' : '';
  chips.push({ t: srec + mrec, c: 'grey' });
  chips.push(status(big));
  if (opp) chips.push(...againstChips(opp));
  return chips;
}

/* Opposed money (Derek, Nov 17 8:58pm CT): show who is on the other side, with records, and flag a COLD wallet against. ML and spread
   both count as team-sided, so Lakers -7.5 is against Hornets ML. Totals only oppose the other total side. */
const teamOf = p => String(p).replace(/\s*[+-]?\d+(\.\d+)?$/, '').trim();
function isOpposed(pickA, mkA, pickB, mkB) {
  if (mkA === 'TOTAL' || mkB === 'TOTAL') return mkA === mkB && /^over/i.test(pickA) !== /^over/i.test(pickB);
  return teamOf(pickA) !== teamOf(pickB);
}
const mkName = m => m === 'ML' ? 'ML' : m === 'SPREAD' ? 'spread' : 'total';
const kk = n => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : '$' + Math.round(n);
const recTxt = t => (t.mktRecord || 'no record') + (t.mktRoi != null ? ' (' + (t.mktRoi >= 0 ? '+' : '') + Math.round(t.mktRoi) + '%)' : '');
function againstChips(opp) {
  const good = opp.filter(t => !cold(t)).sort((a, b) => b.dollars - a.dollars), bad = opp.filter(cold).sort((a, b) => b.dollars - a.dollars);
  const chips = [];
  if (good.length) {
    const b = good[0], st = status(b), tot = good.reduce((a, t) => a + t.dollars, 0);
    chips.push({ t: 'AGAINST ' + kk(tot) + ': ' + kk(b.dollars) + ' ' + mkName(b.market) + ' ' + recTxt(b) + ' - ' + st.t, c: st.c === 'red' || st.c === 'grey' ? 'grey' : 'orange' });
  }
  if (bad.length) {
    const b = bad[0], tot = bad.reduce((a, t) => a + t.dollars, 0);
    chips.push({ t: 'COLD wallet against: ' + kk(tot) + ' (' + kk(b.dollars) + ' ' + mkName(b.market) + ' ' + recTxt(b) + ') - not counted', c: 'red' });
  }
  return chips;
}

/* Matchup row (Derek, Nov 17 9:03pm CT: "format is busy", "I especially want to know if there are quality records on one side and cold or
   negative ROI on the other"). One row per game group (ML and spread together, totals on their own): a verdict, then each side's top wallet
   with its record, and a red chip when cold money sits on a side. Quality wallet = 10+ bets here at +15% ROI or better, not cold. */
const wordOf = t => cold(t) ? 'COLD' : status(t).t.split(/[ (]/)[0];
const walletTxt = t => kk(t.dollars) + ' ' + (+t.vsUsual || 0).toFixed(1) + 'x ' + mkName(t.market) + ' ' + recTxt(t) + ' ' + wordOf(t);
const isQuality = t => !cold(t) && betsOf(t.mktRecord) >= 10 && t.mktRoi != null && t.mktRoi >= 15;
const sumD = a => a.reduce((x, t) => x + t.dollars, 0);
function matchupRow(sp, tix, grp) {
  const bySide = {};
  for (const t of tix) {
    const key = grp === 'total' ? (/^over/i.test(t.pick) ? 'Over' : 'Under') : teamOf(t.pick);
    (bySide[key] ||= []).push(t);
  }
  const widsOf = ts => new Set(ts.map(t => t.wid).filter(Boolean));
  const keys = Object.keys(bySide), twoSided = new Set();
  if (keys.length > 1) for (const w of widsOf(bySide[keys[0]])) if (keys.slice(1).some(k2 => widsOf(bySide[k2]).has(w))) twoSided.add(w);
  const sides = Object.entries(bySide).map(([name, ts]) => {
    const good = ts.filter(t => !cold(t)).sort((a, b) => b.dollars - a.dollars), bad = ts.filter(cold).sort((a, b) => b.dollars - a.dollars);
    const q = good.filter(t => isQuality(t) && !twoSided.has(t.wid));
    return { name, good, bad, q, goodD: sumD(good), badD: sumD(bad), thinD: sumD(good.filter(t => betsOf(t.mktRecord) < 5)), top: q[0] || good[0] };
  }).sort((a, b) => b.goodD - a.goodD || b.badD - a.badD);
  const A = sides[0], B = sides[1];
  if (!A) return null;
  const nm = x => grp === 'total' ? x.name : x.name.toUpperCase();
  let verdict;
  if (!B) verdict = { t: 'CLEAN: nothing against', c: 'blue' };
  else {
    const qa = A.q.length > 0, qb = B.q.length > 0;
    const why = x => x.badD > 0 ? 'cold' : x.thinD > 0 ? 'thin' : 'weaker';
    if (qa && qb) { const ia = new Set(A.q.map(t => t.wallet)); const same = B.q.every(t => ia.has(t.wallet)); verdict = same ? { t: 'NO READ: same wallet on both sides', c: 'grey' } : { t: 'SPLIT: quality wallets on both sides', c: 'orange' }; }
    else if (qa || qb) { const w = qa ? A : B, l = qa ? B : A; verdict = { t: 'EDGE ' + nm(w) + ': quality wallets vs ' + why(l) + ' on ' + nm(l), c: 'gold' }; }
    else verdict = { t: 'NO READ: no quality wallet on either side', c: 'grey' };
  }
  const chips = [verdict];
  if (twoSided.size) chips.push({ t: 'TWO-SIDED: ' + [...twoSided].join(', ') + ' bet both sides - never counted as quality', c: 'grey' });
  for (const x of sides.slice(0, 2)) {
    if (x.top) chips.push({ t: nm(x) + ' ' + kk(x.goodD) + ' - ' + x.good.slice(0, 2).map(walletTxt).join('; '), c: x.top.mktRoi != null && isQuality(x.top) && !twoSided.has(x.top.wid) ? (hotWins(x.top.form) >= 8 ? 'gold' : 'green') : 'grey' });
    if (x.bad.length) chips.push({ t: nm(x) + ' COLD ' + kk(x.badD) + ' - ' + walletTxt(x.bad[0]) + ' - not counted', c: 'red' });
  }
  const bet = grp === 'total' ? 'Total ' + (((A.top || A.bad[0] || {}).line) ?? '') : sides.map(x => x.name).join(' vs ');
  return { bet, chips, goodD: A.goodD, sides };
}
module.exports = { formRoi, matchupRow,  isOpposed, againstChips,  status, simpleChips,  cold, coldMkt, coldForm, coldWhy, hotWins, floorFor, sizeChip, segmentChips };
