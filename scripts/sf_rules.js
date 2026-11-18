/* Sharp Flow rules, shared by preview and alerts. Recalibrated Nov 17 (Derek) after the owner's note that the top sharps cooled
   (Oct 116-56, Nov 105-87) and our own Sharp Flow called sides ran 53-52 -12.2u since Nov 14.
   1. Form gate: a wallet counts only if its all-time ROI in this sport+market AND its last-30-day ROI in the sport are not negative.
   2. Size-ups: a big bet vs the wallet's usual size is NOT extra strength. Sizing up while hot (L10 8+ wins) is flagged, never gold.
   3. Wallet count is shown but not treated as extra confirmation (several sharps pile onto the same side together).
   4. Floors by segment: base $1K; NHL x2.5 (cold); spreads x1.5 (our spreads ran 12-18). NBA ML and NFL keep the base floor. */
const coldMkt = t => t.mktRoi != null && t.mktRoi <= 0;
const coldForm = t => t.l30Roi != null && t.l30Roi <= 0;
const cold = t => coldMkt(t) || coldForm(t);
const coldWhy = t => coldMkt(t) ? `${t.mktRecord} here, ${Math.round(t.mktRoi)}% ROI` : `cold form ${t.l30Rec || ''} L30, ${Math.round(t.l30Roi)}% ROI`;
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
  if ((t.mktRoi != null && t.mktRoi <= 0) || (t.l30Roi != null && t.l30Roi <= 0) || (w != null && w <= 3)) return { t: 'COLD', c: 'red' };
  if (w != null && w >= 8) return { t: 'HOT (last 10: ' + w + '-' + l + ')', c: 'gold' };
  return { t: 'GOOD', c: 'green' };
}
function simpleChips({ sp, mk, moneyTxt, orange, vs, big, sportRec }) {
  const chips = [{ t: moneyTxt, c: orange ? 'orange' : 'blue' }];
  chips.push({ t: (+vs).toFixed(1) + 'x their bet', c: 'grey' });
  const mrec = big.mktRecord ? mk + ' ' + big.mktRecord + (big.mktRoi != null ? ' (' + (big.mktRoi >= 0 ? '+' : '') + Math.round(big.mktRoi) + '%)' : '') : 'no ' + mk + ' record';
  const srec = sportRec ? sp + ' ' + sportRec + ' | ' : big.l30Rec ? sp + ' L30 ' + big.l30Rec + ' | ' : '';
  chips.push({ t: srec + mrec, c: 'grey' });
  chips.push(status(big));
  return chips;
}
module.exports = { status, simpleChips,  cold, coldMkt, coldForm, coldWhy, hotWins, floorFor, sizeChip, segmentChips };
