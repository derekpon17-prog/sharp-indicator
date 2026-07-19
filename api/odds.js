/* ============================================================
   SHARP.IDX — api/odds.js ADD-ONS  v2 (POC)
   
   POC DATA STRATEGY:
   - Single RLM source: Action Network public web API
   - Exchange confirmation: Novig + ProphetX price comparison (already in)
   - Line velocity: PARKED until Supabase persistence layer
   
   HOW TO INTEGRATE:
   1. Copy fetchActionNetworkPct() and enrichWithRLM() into api/odds.js
   2. Add the parallel fetch call in your main handler
   3. Merge enriched data into each play before returning
   4. Add 'rlmIsReal' and 'publicBettingPct' fields to your response
   
   VERCEL ENV VARS NEEDED: none (AN is public, no auth)
   ============================================================ */

/* ─────────────────────────────────────────────────────────────
   ACTION NETWORK PUBLIC API
   
   This is the same endpoint AN's website uses for public pages.
   Returns: ticket %, money %, sharp badge per game.
   No API key required. Works across MLB, NFL, NBA, NHL.
   
   Rate limiting: call once per odds refresh cycle (every 10 min).
   Don't hammer it — same cadence as your Odds API calls.
───────────────────────────────────────────────────────────── */
async function fetchActionNetworkPct(sport = 'mlb') {
  const sportMap = { mlb: 'mlb', nfl: 'nfl', nba: 'nba', nhl: 'nhl' };
  const sportSlug = sportMap[sport.toLowerCase()] || 'mlb';
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    const res = await fetch(
      `https://api.actionnetwork.com/web/v1/games?sport=${sportSlug}&date=${today}`,
      {
        headers: {
          'User-Agent':  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept':      'application/json',
          'Referer':     'https://www.actionnetwork.com/',
          'Origin':      'https://www.actionnetwork.com',
        },
      }
    );
    if (!res.ok) {
      console.warn(`[AN] ${sport} fetch failed: ${res.status}`);
      return { games: {}, raw: null, status: res.status };
    }
    const data = await res.json();
    const games = {};

    (data.games || []).forEach(g => {
      // Build a normalize key from both team names for matching
      const teams = g.teams || [];
      if (teams.length < 2) return;

      const awayName = (teams[0].full_name || teams[0].display_name || teams[0].abbr || '').toLowerCase();
      const homeName = (teams[1].full_name || teams[1].display_name || teams[1].abbr || '').toLowerCase();

      // Betting percentages live in different places depending on AN's response shape
      // Try multiple paths — AN has changed their schema before
      const bets = g.consensus || g.betting_percentages || g.public_betting || {};
      const awayBet  = parseFloat(bets.away_bets  || bets.away_bet_pct   || bets.away || 0);
      const homeBet  = parseFloat(bets.home_bets  || bets.home_bet_pct   || bets.home || 0);
      const awayMon  = parseFloat(bets.away_money || bets.away_money_pct || 0);
      const homeMon  = parseFloat(bets.home_money || bets.home_money_pct || 0);
      const sharpBadge = !!(g.sharp_action || bets.sharp || g.is_sharp);

      const record = {
        anGameId:   g.id,
        awayTeam:   awayName,
        homeTeam:   homeName,
        awayBetPct: awayBet,
        homeBetPct: homeBet,
        awayMonPct: awayMon,
        homeMonPct: homeMon,
        totalBets:  parseFloat(bets.total_bets || 0),
        sharpBadge,               // AN's own sharp indicator — opaque but worth logging
        commenceTime: g.start_time || g.scheduled,
      };

      // Store under multiple key formats for matching flexibility
      games[`${awayName}_${homeName}`] = record;
      games[`${homeName}_${awayName}`] = record;
      if (teams[0].abbr) games[teams[0].abbr.toLowerCase()] = record;
      if (teams[1].abbr) games[teams[1].abbr.toLowerCase()] = record;
    });

    return {
      games,
      raw:    data,        // keep raw for debugging
      status: 'ok',
      count:  Object.keys(games).length / 2, // approx unique games
    };
  } catch (e) {
    console.error('[AN] fetch exception:', e.message);
    return { games: {}, raw: null, status: 'error', error: e.message };
  }
}

/* ─────────────────────────────────────────────────────────────
   MATCH SHARP.IDX GAME → ACTION NETWORK GAME
   
   Sharp.idx uses full team names (e.g. "Baltimore Orioles")
   AN may use abbreviations or slightly different names.
   This handles the fuzzy matching.
───────────────────────────────────────────────────────────── */
function matchToAN(awayTeam, homeTeam, anGames) {
  const normalize = s => (s || '').toLowerCase()
    .replace(/\b(new york|los angeles|san francisco|san diego|kansas city|st\.?\s*louis|tampa bay)\b/gi, '')
    .replace(/[^a-z]/g, '').trim();

  const awayNorm = normalize(awayTeam);
  const homeNorm = normalize(homeTeam);

  // Try direct lookup first
  const directKey = `${awayTeam.toLowerCase()}_${homeTeam.toLowerCase()}`;
  if (anGames[directKey]) return anGames[directKey];

  // Try normalized match
  for (const [key, record] of Object.entries(anGames)) {
    const kNorm = normalize(key);
    if (kNorm.includes(awayNorm) || kNorm.includes(homeNorm)) return record;
    const rAway = normalize(record.awayTeam || '');
    const rHome = normalize(record.homeTeam || '');
    if ((awayNorm && rAway.includes(awayNorm)) || (homeNorm && rHome.includes(homeNorm))) return record;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────
   CALCULATE REAL RLM SCORE
   
   NOW using actual ticket data from Action Network.
   
   True RLM = public tickets going one way, line going other.
   
   Score breakdown:
   - 0-20:  Line and tickets agree (no RLM)
   - 21-40: Mild divergence  
   - 41-60: Moderate RLM — worth noting
   - 61-80: Strong RLM — meaningful signal
   - 81-100: Maximum RLM — sharp money clearly overriding public
   
   The "sharpBadge" from AN is logged separately — we don't
   blindly trust it but track it for correlation analysis.
───────────────────────────────────────────────────────────── */
function calcRLMScore(sharpSide, awayTeam, anRecord) {
  // If no AN data, return the old inferred value
  if (!anRecord || (!anRecord.awayBetPct && !anRecord.homeBetPct)) {
    return { score: 35, isReal: false, label: 'Inferred (no ticket data)' };
  }

  // Determine if sharp side is away or home
  const sharpIsAway = (sharpSide || '').toLowerCase().includes(
    (awayTeam || '').toLowerCase().split(' ').pop() // last word of team name
  );
  const sharpBetPct  = sharpIsAway ? anRecord.awayBetPct : anRecord.homeBetPct;
  const sharpMonPct  = sharpIsAway ? anRecord.awayMonPct : anRecord.homeMonPct;
  const publicBetPct = 100 - sharpBetPct;  // % of tickets against sharp side

  // Core RLM calculation
  // If >55% of tickets are AGAINST the sharp side = potential RLM
  const ticketDivergence = publicBetPct - 50; // positive = public leaning against sharp

  let score;
  let label;

  if (ticketDivergence > 25) {
    // Strong RLM: 75%+ of public against sharp side
    score = Math.min(60 + Math.round(ticketDivergence * 1.2), 100);
    label = `Strong RLM (${publicBetPct.toFixed(0)}% public vs sharp)`;
  } else if (ticketDivergence > 10) {
    // Moderate RLM: 60-75% public against sharp side
    score = Math.round(35 + ticketDivergence * 1.5);
    label = `Moderate RLM (${publicBetPct.toFixed(0)}% public vs sharp)`;
  } else if (ticketDivergence > 0) {
    // Mild divergence
    score = Math.round(20 + ticketDivergence);
    label = `Mild divergence`;
  } else {
    // Public agrees with sharp = no RLM (they might both be right, but it's not RLM)
    score = Math.round(Math.max(10, 20 + ticketDivergence));
    label = `No RLM (public agrees with sharp)`;
  }

  // Money % adds conviction — if money % diverges MORE than ticket %, sharps are bigger bettors
  const moneyBonusCondition = sharpMonPct > 0 && sharpMonPct > sharpBetPct + 10;
  if (moneyBonusCondition) {
    score = Math.min(score + 10, 100);
    label += ' + money divergence';
  }

  return {
    score,
    isReal:        true,
    label,
    sharpBetPct,
    publicBetPct,
    sharpMonPct,
    sharpBadgeAN:  anRecord.sharpBadge, // log AN's own indicator separately
    ticketDivergence,
  };
}

/* ─────────────────────────────────────────────────────────────
   ENRICH PLAYS WITH RLM DATA
   
   Drop-in function — pass your plays array and AN data,
   get back plays with updated pillars.rlm and new fields.
───────────────────────────────────────────────────────────── */
function enrichWithRLM(plays, anData) {
  const { games: anGames } = anData;
  return plays.map(play => {
    if (!play.away || !play.home) return play;
    const anRecord = matchToAN(play.away, play.home, anGames);
    if (!anRecord) return play; // no match — keep inferred value

    const rlm = calcRLMScore(play.sharpSide, play.away, anRecord);

    return {
      ...play,
      pillars: {
        ...play.pillars,
        rlm:       rlm.score,
        rlmIsReal: rlm.isReal,
      },
      rlmDetail: {
        label:          rlm.label,
        sharpBetPct:    rlm.sharpBetPct,
        publicBetPct:   rlm.publicBetPct,
        sharpMonPct:    rlm.sharpMonPct,
        sharpBadgeAN:   rlm.sharpBadgeAN,  // track AN's indicator separately
        isReal:         rlm.isReal,
      },
      publicBettingPct: {
        awayBets:  anRecord.awayBetPct,
        homeBets:  anRecord.homeBetPct,
        awayMoney: anRecord.awayMonPct,
        homeMoney: anRecord.homeMonPct,
      },
      // Recalculate siScore with real RLM (Pinnacle 52% / Money 38% / RLM 10%)
      siScore: Math.round(
        play.pillars.pinnacle * 0.52 +
        play.pillars.money    * 0.38 +
        rlm.score             * 0.10
      ),
    };
  });
}

/* ─────────────────────────────────────────────────────────────
   INTEGRATION SNIPPET — paste into api/odds.js handler
   
   In your main handler function, after you have your plays array:
───────────────────────────────────────────────────────────── */
/*
  // Fetch AN data in parallel with odds (no extra latency)
  const [oddsData, anData] = await Promise.all([
    fetchAllOdds(),   // your existing function
    fetchActionNetworkPct('mlb'),
  ]);
  
  // Enrich plays with real RLM
  const enrichedPlays = enrichWithRLM(oddsData.plays, anData);
  
  // Return enriched data — new fields added per play:
  //   play.pillars.rlm       → now real ticket data (not 35)
  //   play.pillars.rlmIsReal → true when AN data available
  //   play.rlmDetail         → full breakdown for transparency
  //   play.publicBettingPct  → raw AN percentages
  //   play.siScore           → recalculated with real RLM
  
  return res.json({
    plays:  enrichedPlays,
    total:  enrichedPlays.length,
    anStatus: anData.status,    // 'ok' or 'error'
    anGamesFound: anData.count, // how many AN games matched
    quota:  { remaining, used },
  });
*/

/* ─────────────────────────────────────────────────────────────
   DEBUGGING — call this endpoint to verify AN is working:
   
   GET /api/an-debug
   Returns raw AN response so you can see their field names
   and verify matching is working.
───────────────────────────────────────────────────────────── */
/*
  // Add to vercel.json routes + create api/an-debug.js:
  module.exports = async (req, res) => {
    const data = await fetchActionNetworkPct('mlb');
    return res.json({
      status:     data.status,
      gamesFound: data.count,
      sampleGame: Object.values(data.games)[0] || null,
      rawSample:  data.raw?.games?.[0] || null,  // see exact AN field names
    });
  };
*/

/* ─────────────────────────────────────────────────────────────
   PARKING LOT (implement after POC validates)
   
   1. Line Velocity Tracker
      - Needs: Supabase/Vercel KV for persistence across cold starts
      - Purpose: self-generated sharp move detection
      - Effort: 2-3 days after DB layer is set up
   
   2. BetQL Integration  
      - When: after AN POC shows RLM adds signal
      - Why: cleaner data sourced from actual sportsbook partners
      - Cost: $19-39/mo when commercially justified
   
   3. Don Best
      - When: commercial launch with paying subscribers
      - Why: the gold standard used by actual sportsbooks
      - Cost: $500+/mo — needs revenue to justify
   ────────────────────────────────────────────────────────── */

module.exports = {
  fetchActionNetworkPct,
  enrichWithRLM,
  matchToAN,
  calcRLMScore,
};
