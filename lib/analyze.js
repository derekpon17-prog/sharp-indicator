/* ═══════════════════════════════════════════════════
   Sharp Index (SI) Scoring — Three Pillar Model
   
   Pillar 1 — RLM Score (28%)
   Pillar 2 — Pinnacle Score (40%)  
   Pillar 3 — Money Layer Score (32%)
═══════════════════════════════════════════════════ */

const SHARP_BOOKS = ['pinnacle', 'novig'];
const SOFT_BOOKS  = [
  'draftkings','fanduel','betmgm','betrivers',
  'caesars','pointsbetus','williamhill_us','unibet_us','barstool'
];

/* ── Odds math ── */
function toImp(american) {
  return american >= 0
    ? 100 / (100 + american)
    : Math.abs(american) / (Math.abs(american) + 100);
}
function toAmerican(prob) {
  if (prob <= 0 || prob >= 1) return 0;
  return prob >= 0.5 ? -Math.round(prob / (1 - prob) * 100) : Math.round((1 - prob) / prob * 100);
}
function fmt(n) { return n > 0 ? `+${n}` : String(n); }
function devig(p1, p2) { const t = p1 + p2; return [p1/t, p2/t]; }

/* ── Public lean estimation ──
   Public reliably bets: favorites, Overs, home teams.
   Returns true if this side is the typical public lean.  */
function isPublicLean(outcomeName, mkey, pinPrice, homeTeam) {
  if (mkey === 'totals')   return outcomeName === 'Over';
  if (mkey === 'h2h')      return pinPrice < -105; // Favorite = public
  if (mkey === 'spreads')  return pinPrice < -105; // Laying points = public
  return false;
}

/* ── Line movement analysis ──
   Returns whether the price got "harder" (worse) for this side.
   E.g. -110 → -120 is harder; +110 → +105 is harder.         */
function lineGotHarder(current, open) {
  return current < open; // Lower American odds = harder to bet / worse price
}

/* ══════════════════════════════
   PILLAR 1: RLM Score (0–100)
   Reverse Line Movement estimate
══════════════════════════════ */
function calcRLM(outcomeName, mkey, pinPrice, openPrice, homeTeam) {
  const publicSide = isPublicLean(outcomeName, mkey, pinPrice, homeTeam);

  // No movement history → score on public lean only
  if (openPrice === null || openPrice === undefined) {
    return publicSide ? 18 : 42;
  }

  const absMove = Math.abs(pinPrice - openPrice);
  const moved   = pinPrice !== openPrice;

  if (!moved) return publicSide ? 22 : 38;

  const harder = lineGotHarder(pinPrice, openPrice);

  // Classic RLM: public side AND line got harder (sharps pushed opposite)
  if (publicSide && harder) {
    const bonus = absMove >= 15 ? 48 : absMove >= 8 ? 38 : absMove >= 4 ? 26 : absMove >= 2 ? 14 : 7;
    return Math.min(100, 28 + bonus);
  }
  // Sharp confirmation: counter-public side AND line improved
  if (!publicSide && !harder) {
    const bonus = absMove >= 15 ? 40 : absMove >= 8 ? 30 : absMove >= 4 ? 20 : absMove >= 2 ? 10 : 5;
    return Math.min(100, 40 + bonus);
  }
  // Line moving with public → square action, weak signal
  if (publicSide && !harder) return Math.max(0, 20 - Math.min(10, absMove));
  // Counter-public side but line got harder → mixed signal
  return 30;
}

/* ══════════════════════════════
   PILLAR 2: Pinnacle Score (0–100)
   Pure devigged price gap vs soft books
══════════════════════════════ */
function calcPinnacle(pinFairProb, softImps) {
  if (!softImps.length) return 0;
  const avgSoftRaw  = softImps.reduce((a, b) => a + b, 0) / softImps.length;
  const avgSoftFair = avgSoftRaw / 1.048; // Remove ~4.8% soft book vig
  const gapPP       = (pinFairProb - avgSoftFair) * 100;

  if (gapPP <= 0) return 0;
  return Math.min(100, Math.max(0,
    gapPP >= 7   ? 92 + Math.min(8, (gapPP-7)*1.6) :
    gapPP >= 5   ? 80 + (gapPP-5)*6 :
    gapPP >= 3   ? 60 + (gapPP-3)*10 :
    gapPP >= 2   ? 42 + (gapPP-2)*18 :
    gapPP >= 1   ? 24 + (gapPP-1)*18 :
    gapPP >= 0.5 ? 10 + (gapPP-0.5)*28 :
    gapPP * 20
  ));
}

/* ══════════════════════════════
   PILLAR 3: Money Layer Score (0–100)
   Exchange confirmation + velocity + divergence
══════════════════════════════ */
function calcMoney(novigConfirm, openPrice, currentPrice, softImps) {
  let score = 0;

  // Novig exchange confirmation is the strongest signal (pure market)
  if (novigConfirm) score += 42;

  // Line velocity from opening
  if (openPrice !== null && openPrice !== undefined) {
    const vel = Math.abs(currentPrice - openPrice);
    score += vel >= 20 ? 32 : vel >= 12 ? 26 : vel >= 7 ? 18 : vel >= 3 ? 10 : vel >= 1 ? 4 : 0;
  }

  // Soft book spread: wide spread = books chasing, possible steam
  if (softImps.length > 1) {
    const spread = Math.max(...softImps) - Math.min(...softImps);
    score += spread >= 0.08 ? 26 : spread >= 0.05 ? 20 : spread >= 0.03 ? 12 : spread >= 0.015 ? 6 : 0;
  }

  return Math.min(100, score);
}

/* ══════════════════════════════
   Signal type from three pillars
══════════════════════════════ */
function signalType(rlm, pinnacle, money, novigConfirm) {
  const si = rlm * 0.28 + pinnacle * 0.40 + money * 0.32;
  if (novigConfirm && pinnacle >= 65 && rlm >= 55) return 'DUAL_CONSENSUS';
  if (rlm >= 72 && pinnacle >= 60)                 return 'SHARP_RLM';
  if (pinnacle >= 78)                              return 'PINNACLE_EDGE';
  if (money >= 75 && novigConfirm)                 return 'EXCHANGE_SIGNAL';
  if (rlm >= 65)                                   return 'RLM_ONLY';
  if (pinnacle >= 58)                              return 'MODERATE_EDGE';
  return 'WEAK';
}

/* ══════════════════════════════
   Main game analyser
══════════════════════════════ */
function analyzeGame(game) {
  const pin  = game.bookmakers.find(b => b.key === 'pinnacle');
  const nov  = game.bookmakers.find(b => b.key === 'novig');
  const soft = game.bookmakers.filter(b => SOFT_BOOKS.includes(b.key));

  if (!pin || !soft.length) return null;

  let best = null, bestSI = -1;

  for (const mkey of ['h2h', 'spreads', 'totals']) {
    const pinMkt  = pin.markets?.find(m => m.key === mkey);
    const novMkt  = nov?.markets?.find(m => m.key === mkey);
    const softMkts = soft.map(b => b.markets?.find(m => m.key === mkey)).filter(Boolean);
    if (!pinMkt || pinMkt.outcomes.length < 2 || !softMkts.length) continue;

    const [pf0, pf1] = devig(toImp(pinMkt.outcomes[0].price), toImp(pinMkt.outcomes[1].price));
    const pinFair = [pf0, pf1];

    for (let idx = 0; idx < pinMkt.outcomes.length; idx++) {
      const outcome   = pinMkt.outcomes[idx];
      const pinPrice  = outcome.price;
      const softImps  = softMkts.map(sm => {
        const o = sm.outcomes.find(o => o.name === outcome.name);
        return o ? toImp(o.price) : null;
      }).filter(x => x !== null);
      if (!softImps.length) continue;

      // Get stored opening line from game data (passed through from server)
      const openPrice = game._openLines?.[mkey]?.[outcome.name] ?? null;

      // Novig check
      let novigConfirm = false, novigLine = null;
      if (novMkt) {
        const no = novMkt.outcomes.find(o => o.name === outcome.name);
        if (no) {
          const [nf0, nf1] = devig(toImp(novMkt.outcomes[0].price), toImp(novMkt.outcomes[1].price));
          const novFair = idx === 0 ? nf0 : nf1;
          const avgSoftFair = (softImps.reduce((a,b)=>a+b,0)/softImps.length) / 1.048;
          novigConfirm = (novFair - avgSoftFair) * 100 > 0.3;
          novigLine    = fmt(no.price);
        }
      }

      // ── Three pillars ──
      const rlmScore  = calcRLM(outcome.name, mkey, pinPrice, openPrice, game.home_team);
      const pinScore  = calcPinnacle(pinFair[idx], softImps);
      const monScore  = calcMoney(novigConfirm, openPrice, pinPrice, softImps);
      const siScore   = Math.round(rlmScore*0.28 + pinScore*0.40 + monScore*0.32);

      if (siScore > bestSI && pinScore > 0) {
        bestSI = siScore;

        let sideLabel = outcome.name;
        if (mkey === 'spreads' && outcome.point !== undefined)
          sideLabel = `${outcome.name} ${outcome.point > 0 ? '+' : ''}${outcome.point}`;
        else if (mkey === 'totals' && outcome.point !== undefined)
          sideLabel = `${outcome.name} ${outcome.point}`;

        const avgSoftAmerican = toAmerican(softImps.reduce((a,b)=>a+b,0)/softImps.length);
        const softRange = softImps.length > 1
          ? `${fmt(Math.round(toAmerican(Math.min(...softImps))))}–${fmt(Math.round(toAmerican(Math.max(...softImps))))}`
          : fmt(avgSoftAmerican);

        const gapPP = ((pinFair[idx] - (softImps.reduce((a,b)=>a+b,0)/softImps.length)/1.048)*100).toFixed(2);

        best = {
          id:           game.id,
          away:         game.away_team,
          home:         game.home_team,
          commenceTime: game.commence_time,
          sharpSide:    sideLabel,
          market:       mkey,
          siScore,
          pillars: { rlm: rlmScore, pinnacle: Math.round(pinScore), money: Math.round(monScore) },
          signalType:   signalType(rlmScore, pinScore, monScore, novigConfirm),
          novigConfirm,
          lines: {
            pinnacle:  fmt(pinPrice),
            novig:     novigLine,
            softAvg:   fmt(avgSoftAmerican),
            softRange,
          },
          gapPP,
          numBooks: softImps.length,
          openPrice,
          publicLean: isPublicLean(outcome.name, mkey, pinPrice, game.home_team),
        };
      }
    }
  }
  return best;
}

module.exports = { analyzeGame, SHARP_BOOKS, SOFT_BOOKS };
