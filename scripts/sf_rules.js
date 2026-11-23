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
// The specific bet the recommended wallet actually has - team/pick, market label if the pick text doesn't already carry a line
// (ML tickets are usually just the team name), and price when we have it. e.g. "Hornets ML +145" or "Western Michigan -15.5".
const recPlay = t => {
  if (!t) return null;
  const hasLine = /[+-]?\d/.test(t.pick);
  // Spreads: show the signed line (Derek, Nov 21: "Michigan SPREAD -124" hid the spread). Ticket line is signed (+4.5 dog, -3.5 fav).
  const lineTxt = t.market === 'SPREAD' && t.line != null && !isNaN(+t.line) ? (+t.line > 0 ? '+' : '') + (+t.line) : null;
  const base = hasLine ? t.pick : lineTxt ? t.pick + ' ' + lineTxt : t.pick + ' ' + mkName(t.market).toUpperCase();
  return base + (t.price != null && !isNaN(+t.price) ? ' ' + (+t.price > 0 ? '+' : '') + (+t.price) : '');   // price is a string like "+104": use the number or it prints ++104
};
/* Confidence (Derek, Nov 18: "I like confidence as well"): 0-9, built only from what we already know - the quality wallet's
   ROI size and sample size, and whether the signal is one-sided or contradicted. Not a win probability, just how clean the
   read is. EDGE starts at 6 (one side has a real quality wallet, nothing of substance against it) and climbs with a bigger
   ROI edge (+1 at 30%+, +1 more at 50%+) and a deeper sample (+1 at 15+ bets here), capped at 9 - no play is a lock.
   SPLIT (quality wallets disagree) sits at 4, CLEAN-but-thin (nothing against, but no real quality wallet either) at 3,
   NO READ (nothing to lean on, or the same wallet on both sides) at 2. */
const confFor = q => Math.min(9, 6 + (q.mktRoi >= 30 ? 1 : 0) + (q.mktRoi >= 50 ? 1 : 0) + (betsOf(q.mktRecord) >= 15 ? 1 : 0));
const CONF_LEGEND = 'Confidence (0-9): how clean the read is - a bigger ROI edge and a deeper sample push it up, a contradicted or thin signal pulls it down. Not a win probability.';
// One row for the image card (Nov 18 design): team/wallet/market/record always shown, ROI% + status on their own line, dollars
// and context (x usual, sample size, form) as a note. Never implies a number - Derek's rule after the Hornets/Lakers mix-up.
const noteOf = t => {
  const parts = [(+t.vsUsual || 0).toFixed(1) + 'x usual'];
  const nb = betsOf(t.mktRecord);
  if (nb < 5) parts.push('only ' + nb + ' bet' + (nb === 1 ? '' : 's') + ' here');
  else if (t.form) parts.push(t.form);
  return parts.join(', ');
};
const rowOf = t => {
  const st = status(t);
  const pr = t.price != null && !isNaN(+t.price) ? (+t.price > 0 ? '+' : '') + (+t.price) : '';
  const ln = t.line != null && !isNaN(+t.line) ? (+t.line > 0 ? '+' : '') + (+t.line) : '';
  const betTxt = t.market === 'TOTAL' ? String(t.pick).toUpperCase() + (pr ? ' ' + pr : '')            // UNDER 224.5 -113
    : t.market === 'SPREAD' ? 'SPREAD' + (ln ? ' ' + ln : '') + (pr ? ' ' + pr : '')                   // SPREAD +1.5 -104
    : 'ML' + (pr ? ' ' + pr : '');                                                                     // ML -113
  return { team: teamOf(t.pick) || t.pick, wallet: t.wallet, wid: t.wid, market: betTxt, mk: mkName(t.market).toUpperCase(), record: t.mktRecord,
    roi: t.mktRoi, dollars: t.dollars, note: noteOf(t), status: cold(t) ? { t: st.t + ' - not counted', c: 'red' } : st };
};
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
  // Default headline is just the matchup (or the total); only an EDGE verdict earns a specific recommended play up top.
  let bet = grp === 'total' ? 'Total ' + (((A.top || A.bad[0] || {}).line) ?? '') : sides.map(x => x.name).join(' vs ');
  let verdict, confidence, rec = null, forSide = A, againstSide = B || null;
  if (!B) {
    verdict = { t: 'CLEAN: nothing against', c: 'blue' };
    if (A.q[0]) { confidence = confFor(A.q[0]); rec = recPlay(A.q[0]); bet = rec; } else confidence = 3;
  } else {
    const qa = A.q.length > 0, qb = B.q.length > 0;
    const why = x => x.badD > 0 ? 'cold' : x.thinD > 0 ? 'thin' : 'weaker';
    if (qa && qb) {
      const ia = new Set(A.q.map(t => t.wallet)); const same = B.q.every(t => ia.has(t.wallet));
      verdict = same ? { t: 'NO READ: same wallet on both sides', c: 'grey' } : { t: 'SPLIT: quality wallets on both sides', c: 'orange' };
      confidence = same ? 2 : 4;
    } else if (qa || qb) {
      const w = qa ? A : B, l = qa ? B : A;
      verdict = { t: 'EDGE ' + nm(w) + ': quality wallets vs ' + why(l) + ' on ' + nm(l), c: 'gold' };
      confidence = confFor(w.q[0]);
      rec = recPlay(w.q[0]); bet = rec;
      forSide = w; againstSide = l;
    } else { verdict = { t: 'NO READ: no quality wallet on either side', c: 'grey' }; confidence = 2; }
  }
  const chips = [verdict];
  if (twoSided.size) chips.push({ t: 'TWO-SIDED: ' + [...twoSided].join(', ') + ' bet both sides - never counted as quality', c: 'grey' });
  for (const x of sides.slice(0, 2)) {
    if (x.top) chips.push({ t: nm(x) + ' ' + kk(x.goodD) + ' - ' + x.good.slice(0, 2).map(walletTxt).join('; '), c: x.top.mktRoi != null && isQuality(x.top) && !twoSided.has(x.top.wid) ? (hotWins(x.top.form) >= 8 ? 'gold' : 'green') : 'grey' });
    if (x.bad.length) chips.push({ t: nm(x) + ' COLD ' + kk(x.badD) + ' - ' + walletTxt(x.bad[0]) + ' - not counted', c: 'red' });
  }

  /* Image-card view (Nov 18): tag/for/against/moneyBar/price/callout ready for sharpflow_html. "For it" is always the side the
     headline backs (the quality wallet's side on an EDGE/CLEAN read, else the bigger-money side); "Against it" is the other side,
     when there is one. Rows always carry team/wallet/market/record/ROI/dollars/status - never implied (Derek, Nov 18). */
  const tag = rec ? { t: 'EDGE - ' + nm(forSide), icon: '\u{1F3AF}' }
    : verdict.t.startsWith('SPLIT') ? { t: 'SPLIT - BOTH SIDES', icon: '⚖️' }
    : verdict.t.startsWith('NO READ') ? { t: 'NO READ', icon: '⚠️' }
    : { t: 'LIGHT SIGNAL - ' + nm(A), icon: '\u{1F440}' };
  const rowsOf = x => !x ? null : { team: nm(x), rows: x.good.concat(x.bad).sort((a, b) => b.dollars - a.dollars).slice(0, 4).map(rowOf) };
  const forView = rowsOf(forSide), againstView = rowsOf(againstSide);
  const totalD = sides.reduce((a, x) => a + x.goodD + x.badD, 0) || 1;
  const moneyBar = sides.slice(0, 2).map(x => ({ team: nm(x), dollars: x.goodD + x.badD, pct: Math.round(((x.goodD + x.badD) / totalD) * 100),
    c: x === forSide ? (hotWins((x.top || {}).form) >= 8 ? 'gold' : 'green') : (x.badD > 0 ? 'red' : 'grey') }));
  const rq = rec ? (forSide.q[0] || forSide.top) : null;
  const price = rq && rq.price != null && !isNaN(+rq.price) ? (+rq.price > 0 ? '+' : '') + (+rq.price) : null;
  let callout = null;
  if (rec) {
    const base = 'Quality wallet ' + rq.mktRecord + ' (' + (rq.mktRoi >= 0 ? '+' : '') + Math.round(rq.mktRoi) + '% ROI) on ' + nm(forSide);
    callout = (againstSide && againstSide.bad.length) ? { plain: base + ' vs a cold wallet on ' + nm(againstSide) + ' - ', highlight: 'nothing quality against it.' }
      : { plain: base + ' - ', highlight: 'nothing quality against it.' };
  } else if (verdict.t.startsWith('SPLIT')) callout = { plain: 'Quality wallets on both sides - ', highlight: 'no clean lean here.' };

  return { bet, rec, confidence, chips, goodD: A.goodD, sides, tag, for: forView, against: againstView, moneyBar, price, callout };
}
/* Site lock text (Derek, Nov 21: council COUNCIL_2026-11-21_site-locks). Display-only, never changes a tier.
   grp: 'total' or 'team' (same split the cards use). Returns '' when the Sharp Flow site has no staked lock on that game and market group. */
function siteLockTxt(plays, sport, matchup, grp) {
  const hit = (plays || []).filter(p => p.sport === sport && p.matchup === matchup && (p.market === 'TOTAL' ? 'total' : 'team') === grp && p.status === 'locked');
  return hit.map(p => 'SITE LOCK: ' + p.pick + (p.market === 'ML' ? ' ML' : '') + ' ' + p.units + 'u (' + (p.alignment === 'none' || !p.alignment ? 'no wallet money' : 'wallet money ' + (p.alignment === 'with' ? 'behind it' : 'AGAINST it')) + ')').join(' | ');
}
/* Polymarket wallet rows for a SharpFlow matchup row (moved here from sharpflow_preview.js Nov 22 2026 so the SharpFlow alert and the
   Poly late-money alert use the same rows as the pre-game card). poly = poly_matches.json matches. Display only. */
function polyFor(poly, sp, matchup, grp, r) {
  const ms = (poly || []).filter(m => m.sport === sp && m.matchup === matchup && m.grp === grp);
  if (!ms.length) return { for: r.for, against: r.against, sources: ['SHARP FLOW'], ms };
  const label = side => grp === 'total' ? side : String(side).toUpperCase();
  const amer = p => !(p > 0 && p < 1) ? null : Math.round(p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p);
  const polyBet = m => {   // the real bet: line and price paid (Derek, Nov 22: the card must show what the wallet actually bought)
    const px = amer(m.avgPrice), pc = m.avgPrice > 0 && m.avgPrice < 1 ? ' @ ' + Math.round(m.avgPrice * 100) + 'c (' + (px > 0 ? '+' : '') + px + ')' : '';
    if (m.market === 'TOTAL') { const l = String(m.title || '').match(/O\/U\s+([\d.]+)/i); return 'TOTAL ' + String(m.side).toUpperCase() + (l ? ' ' + l[1] : '') + pc; }
    if (m.market === 'SPREAD') { const l = String(m.title || '').match(/\(([+-][\d.]+)\)/); if (!l) return 'SPREAD' + pc;
      const v = parseFloat(l[1]), fav = String(m.title || '').replace(/^spread:\s*/i, '').replace(/\(.*$/, '').trim(), mine = fav.toLowerCase() === String(m.side).toLowerCase();
      const sv = mine ? v : -v; return 'SPREAD ' + (sv > 0 ? '+' : '') + sv + pc; }
    return 'ML' + pc;
  };
  const altNote = m => { if (m.market !== 'SPREAD') return null; const l = String(m.title || '').match(/\(([+-][\d.]+)\)/); return l && Math.abs(parseFloat(l[1])) >= 8 ? 'far-off alt line, not a read on the main spread' : null; };
  const row = m => ({ src: 'POLYMARKET', team: m.side, wallet: m.name, market: polyBet(m), mk: m.market, record: m.rec, recLabel: m.recScope ? m.recScope.replace(/, last (\d+) days/, ' \u00b7 last $1d') + ' record' : null, roi: m.roi, dollars: m.usd,
    note: ['Polymarket', m.vsUsual != null ? (+m.vsUsual).toFixed(1) + 'x usual' : null, altNote(m), m.gateNote && m.sportCls !== m.cls ? m.gateNote : null, m.l10 ? m.l10.txt : null, m.n < 10 ? 'thin' : null, m.sameAsSF ? 'same wallet as Sharp Flow ' + m.sameAsSF.sfWallet + ' above' : null].filter(Boolean).join(' \u00b7 '),
    status: m.twoSided ? { t: 'POLY TWO-SIDED - not counted', c: 'grey' }
      : m.cls === 'HOT' ? (m.sameAsSF ? { t: 'POLY HOT - same wallet, not a 2nd source', c: 'grey' } : { t: 'POLY HOT', c: 'green' })
      : m.sportCls === 'HOT' ? { t: 'POLY COLD in this bet type - not counted', c: 'red' } : { t: 'POLY COLD - fade flag', c: 'red' } });
  const f = r.for ? { ...r.for, rows: [...(r.for.rows || [])] } : null;
  let a = r.against ? { ...r.against, rows: [...(r.against.rows || [])] } : null;
  for (const m of ms.slice().sort((x, y) => y.usd - x.usd)) {
    const t = label(m.side);
    if (f && f.team === t) f.rows.push(row(m));
    else if (a && a.team === t) a.rows.push(row(m));
    else if (!a) a = { team: t, rows: [row(m)] };
  }
  return { for: f, against: a, sources: ['SHARP FLOW', 'POLYMARKET'], ms };
}

// Record label under each row's record number (the row's market field now carries the bet line and price).
/* Wallet identity (Derek, Nov 23 2026): the A/B/C letter is reshuffled every board, so show the stable wallet id next to it and say
   when one wallet is on more than one row of the same card (ML + spread). SharpFlow does not publish names - the id is the identity. */
let WNAMES = {};
try { WNAMES = JSON.parse(require('fs').readFileSync(process.env.WALLET_NAMES || 'wallet_names.json', 'utf8')); } catch (e) { /* names are best effort */ }
const tagWallets = rows => {
  const cnt = {}; rows.forEach(x => { if (x.wid) (cnt[x.wid] ||= []).push(x); });
  return rows.map(x => {
    if (!x.wid) return x;
    const mine = cnt[x.wid], others = mine.filter(y => y !== x).map(y => y.mk || y.market);
    return { ...x, wallet: (WNAMES[x.wid] ? WNAMES[x.wid] + ' ' : x.wallet + ' ') + '#' + x.wid, note: (x.note ? x.note + ' \u00b7 ' : '') + (others.length ? 'SAME WALLET as its ' + others.join(' + ') + ' row' : ''), };
  }).map(x => ({ ...x, note: String(x.note || '').replace(/ \u00b7 $/, '') }));
};
const labRows = (sp, v) => v && v.rows ? { ...v, rows: tagWallets(v.rows).map(x => ({ ...x, recLabel: x.recLabel || `${sp} ${x.mk || x.market} \u00b7 all-time record` })) } : v;
/* Posted-play cross-check (Derek, Nov 22 2026): when new wallet money lands after a card went out, say whether it is WITH or AGAINST a
   PLAY we already posted for that game. posted = scripts/posted_plays.py output. Team sides only (ML/spread); totals are not matched.
   Display only - it never changes a tier. */
function postedNote(posted, sport, matchup, pick, market) {
  if (!posted || !posted.length || !['ML', 'SPREAD'].includes(market)) return null;
  const sp = sport === 'CBB' ? 'NCAAB' : sport, ml = String(matchup).toLowerCase();
  const mine = String(pick).replace(/\s*[+-]\d+(\.\d+)?\s*$/, '').trim().toLowerCase();
  for (const p of posted) {
    if (p.sport !== sp || !['ML', 'SPREAD'].includes(p.market)) continue;
    const pt = String(p.bet).replace(/\s+(ML|[+-]\d+(\.\d+)?)\s*$/, '').trim().toLowerCase();
    if (!pt || !ml.includes(pt)) continue;
    const same = pt === mine || mine.includes(pt) || pt.includes(mine);
    return (same ? 'WITH OUR POSTED PLAY: ' : 'AGAINST OUR POSTED PLAY: ') + p.bet + (p.card ? ' (' + p.card + ' slate)' : '');
  }
  return null;
}

module.exports = { tagWallets, postedNote, labRows, polyFor, siteLockTxt, formRoi, matchupRow, isOpposed, againstChips, status, simpleChips, cold, coldMkt, coldForm, coldWhy, hotWins, floorFor, sizeChip, segmentChips, recPlay, confFor, CONF_LEGEND };
