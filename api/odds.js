/* ════════════════════════════════════════════
   Sharp.idx — Hardened signal model
   Pinnacle floor: 2.0pp
   Min books: 5
   Novig + ProphetX: 1.5pp threshold each
   RLM: capped at 35 without opening line
   Soft books: 13 total
   Action Network: real ticket % for RLM (POC)
════════════════════════════════════════════ */

const SHARP_BOOKS = ['pinnacle'];
const EXCHANGE_BOOKS = ['novig','prophetx'];
const SOFT_BOOKS = [
  'draftkings','fanduel','betmgm','betrivers','caesars','williamhill_us',
  'espnbet','betparx','hardrockbet',
  'betonlineag','bovada','mybookieag','betus',
  'lowvig',
];
const MIN_SOFT_BOOKS  = 5;
const MIN_SOFT_ML    = 3;
const PIN_GAP_ML     = 1.0;
const PIN_GAP_STD    = 2.0;
const EX_CONFIRM_GAP = 1.5;

/* ── ML VELOCITY (SHADOW MODE) — provisional thresholds, recalibrate in Phase B ──
   Council build 2026-07-24. State ladder: MID_MOVE (move + books still lagging) >
   STATIC_GAP (gap, no move — existing SI covers) > MOVE_COMPLETE (move done, price gone).
   Shadow only: never touches siScore, never auto-tracks into real records. */
const MLV_MOVE_PP   = 1.5;   // min cumulative open→now devigged Pinnacle move (pp)
const MLV_GAP_PP    = 1.0;   // residual soft-book lag for MID_MOVE (mirrors PIN_GAP_ML)
const MLV_STEAM_MIN = 0.005; // implied-prob rise for a soft book to count toward steam width
const MLV_QUALIFY   = 60;    // shadow-log floor

const SPORT_KEYS = {
  MLB:'baseball_mlb',NFL:'americanfootball_nfl',
  NBA:'basketball_nba',NHL:'icehockey_nhl',
  NCAAFB:'americanfootball_ncaaf',
  NCAAB:'basketball_ncaab',
};

/* ── LINE VELOCITY — Self-generated RLM via Vercel KV ──────────
   Store Pinnacle price on every odds call.
   Next call: compare current vs stored → real line movement.
   No external scraping. No rate limits. No IP blocks.
   Requires Vercel KV (same setup as polymarket-alerts).
──────────────────────────────────────────────────────────────── */
// Upstash Redis REST client (no npm package required)
// BUGFIX: was reading UPSTASH_REDIS_REST_URL/TOKEN, which don't exist in this project's
// Vercel environment — the alerts system (confirmed working) uses KV_REST_API_URL/TOKEN
// instead. This silently made every KV call a no-op forever, regardless of how many times
// the endpoint ran — "gamesTracked: 0" was the permanent, guaranteed result.
async function upstashPost(body) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    return d.result ?? null;
  } catch { return null; }
}

async function loadPrevLines(sport) {
  try {
    const raw = await upstashPost(['GET', `lines:${sport}:prev`]);
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return {}; }
}

async function saveCurrentLines(sport, lines) {
  try {
    await upstashPost(['SET', `lines:${sport}:prev`, JSON.stringify(lines), 'EX', '86400']);
  } catch {}
}

/* Write-once opening-line store. Unlike lines:{sport}:prev (rolling, overwritten every
   fetch), each game's entry here is written on FIRST SIGHT and never touched again —
   this is the baseline that makes cumulative open→now movement measurable at all. */
async function loadOpenLines(sport) {
  try {
    const raw = await upstashPost(['GET', `lines:${sport}:open`]);
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return {}; }
}
async function saveOpenLines(sport, map) {
  try {
    await upstashPost(['SET', `lines:${sport}:open`, JSON.stringify(map), 'EX', '172800']);
  } catch {}
}

/* ── CLOSING-LINE CAPTURE (council rec #1) ────────────────────────────
   CLV against the Pinnacle close is the gold standard listed in the project
   doc, and it was the one thing never actually captured. It matters because it
   converges: CLV tells you whether a signal is real in ~50 plays, where raw
   W/L needs 300+. Without it every pillar we add is unfalsifiable.

   Mechanic: while a game is still PREGAME each fetch overwrites its entry, so
   the stored price is always the most recent pregame quote. Once commenceTime
   passes we stop writing — whatever sits there is, by construction, the last
   price before first pitch: the close. No extra API calls, no new dependency,
   it rides the fetch the cron already performs. */
async function loadCloseLines(sport) {
  try {
    const raw = await upstashPost(['GET', `lines:${sport}:close`]);
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return {}; }
}
async function saveCloseLines(sport, map) {
  try {
    await upstashPost(['SET', `lines:${sport}:close`, JSON.stringify(map), 'EX', '604800']);
  } catch {}
}

function calcLineVelocity(gameId, sharpSide, sharpOutcome, currentPrice, prevLines) {
  const prev = prevLines[gameId];
  if (!prev || !prev[sharpOutcome]) {
    return { score: 35, isReal: false, label: 'No previous line stored yet', movement: 0 };
  }
  const prevPrice = prev[sharpOutcome];
  const movement  = currentPrice - prevPrice; // positive = line got longer (better for bettor)
  const absMove   = Math.abs(movement);

  // Sharp hammer: line moved AGAINST public (shortening on sharp side = books adjusting to sharp)
  // e.g. Dodgers were +200, now +167 → books shortened because sharps bet Dodgers
  const sharpenedToSharp = movement < 0; // price got more negative = shorter odds = more likely

  let score, label;
  if (sharpenedToSharp && absMove >= 15) {
    score = Math.min(90, 55 + absMove * 1.5);
    label = `Strong sharp move: ${prevPrice > 0 ? '+' : ''}${prevPrice} → ${currentPrice > 0 ? '+' : ''}${currentPrice} (${absMove}pt hammer)`;
  } else if (sharpenedToSharp && absMove >= 7) {
    score = Math.min(75, 40 + absMove * 2);
    label = `Moderate sharp move: ${absMove}pt shortening`;
  } else if (sharpenedToSharp && absMove >= 3) {
    score = Math.round(30 + absMove * 2);
    label = `Mild line movement: ${absMove}pts toward sharp side`;
  } else if (!sharpenedToSharp && absMove >= 5) {
    score = Math.max(10, 25 - absMove);
    label = `Line drifted away: public money moving it ${absMove}pts`;
  } else {
    score = 35;
    label = `Stable line (${absMove}pt move)`;
  }

  return { score: Math.min(100, Math.max(0, score)), isReal: true, label, movement, prevPrice };
}

/* ── WEATHER FOR TOTALS (council rec #3) ──────────────────────────────
   Totals are where the edge actually is on this board — h2h sd 0.14 vs totals
   sd 0.52, and every meaningful exchange lean today was a total. Wind and
   temperature move baseball totals more than any other environmental factor.
   OpenWeatherMap's free tier covers this at zero cost.

   Two honesty constraints baked in:
   1. ROOFED PARKS ARE EXCLUDED. Eight MLB venues are domed or retractable;
      reporting a wind lean for a game under a closed roof is worse than
      reporting nothing. Those return {roof:true} and score 0.
   2. NO WIND-DIRECTION LEAN. Whether wind helps or suppresses scoring depends
      on its bearing relative to the park's orientation, and I do not have
      verified center-field bearings for all 30 parks. Inventing them would
      manufacture exactly the kind of false precision this project just spent a
      week removing. v1 therefore scores wind SPEED and temperature only, both
      of which are directionally unambiguous: high wind raises variance, heat
      helps the ball carry, cold suppresses it. Direction-aware scoring is a
      follow-up once park bearings are sourced and verified.

   Requires OPENWEATHER_API_KEY. Absent the key this degrades to state:'NONE'
   and changes nothing. Cached in KV for 2h per game, so ~15 games x 12
   refreshes/day is well inside the 1,000/day free limit (an uncached fetch on
   every 15-minute cron run would be ~1,440/day and would blow it). */
const MLB_PARKS={
  'Arizona Diamondbacks':{lat:33.445,lon:-112.067,roof:true},
  'Atlanta Braves':{lat:33.891,lon:-84.468},
  'Baltimore Orioles':{lat:39.284,lon:-76.622},
  'Boston Red Sox':{lat:42.346,lon:-71.098},
  'Chicago Cubs':{lat:41.948,lon:-87.656},
  'Chicago White Sox':{lat:41.830,lon:-87.634},
  'Cincinnati Reds':{lat:39.097,lon:-84.507},
  'Cleveland Guardians':{lat:41.496,lon:-81.685},
  'Colorado Rockies':{lat:39.756,lon:-104.994},
  'Detroit Tigers':{lat:42.339,lon:-83.049},
  'Houston Astros':{lat:29.757,lon:-95.355,roof:true},
  'Kansas City Royals':{lat:39.051,lon:-94.480},
  'Los Angeles Angels':{lat:33.800,lon:-117.883},
  'Los Angeles Dodgers':{lat:34.074,lon:-118.240},
  'Miami Marlins':{lat:25.778,lon:-80.220,roof:true},
  'Milwaukee Brewers':{lat:43.028,lon:-87.971,roof:true},
  'Minnesota Twins':{lat:44.982,lon:-93.278},
  'New York Mets':{lat:40.757,lon:-73.846},
  'New York Yankees':{lat:40.829,lon:-73.926},
  'Athletics':{lat:38.581,lon:-121.514},
  'Philadelphia Phillies':{lat:39.906,lon:-75.166},
  'Pittsburgh Pirates':{lat:40.447,lon:-80.006},
  'San Diego Padres':{lat:32.707,lon:-117.157},
  'San Francisco Giants':{lat:37.778,lon:-122.389},
  'Seattle Mariners':{lat:47.591,lon:-122.332,roof:true},
  'St. Louis Cardinals':{lat:38.623,lon:-90.193},
  'Tampa Bay Rays':{lat:27.768,lon:-82.653,roof:true},
  'Texas Rangers':{lat:32.747,lon:-97.084,roof:true},
  'Toronto Blue Jays':{lat:43.641,lon:-79.389,roof:true},
  'Washington Nationals':{lat:38.873,lon:-77.007},
};
const WX_WIND_STRONG=15;  // mph — PROVISIONAL
const WX_HOT=85, WX_COLD=50;  // deg F — PROVISIONAL

async function fetchWeather(play){
  const key=process.env.OPENWEATHER_API_KEY;
  if(!key)return{state:'NONE',score:0,label:'OPENWEATHER_API_KEY not set',shadow:true};
  const park=MLB_PARKS[play.home];
  if(!park)return{state:'NONE',score:0,label:'No park coordinates for '+(play.home||'?'),shadow:true};
  if(park.roof)return{state:'ROOF',score:0,roof:true,label:'Roofed venue — weather not a factor',shadow:true};
  const cacheKey='wx:'+play.id;
  try{
    const cached=await upstashPost(['GET',cacheKey]);
    if(cached)return typeof cached==='string'?JSON.parse(cached):cached;
  }catch{}
  try{
    const r=await fetch('https://api.openweathermap.org/data/2.5/weather?lat='+park.lat+'&lon='+park.lon+'&units=imperial&appid='+key);
    if(!r.ok)return{state:'NONE',score:0,label:'Weather fetch failed ('+r.status+')',shadow:true};
    const d=await r.json();
    const temp=d.main&&d.main.temp, wind=d.wind&&d.wind.speed, deg=d.wind&&d.wind.deg;
    const cond=d.weather&&d.weather[0]&&d.weather[0].main;
    let score=0;const notes=[];
    if(typeof wind==='number'&&wind>=WX_WIND_STRONG){
      score+=Math.min(40,Math.round((wind-WX_WIND_STRONG)*4)+20);
      notes.push(Math.round(wind)+' mph wind');
    }
    if(typeof temp==='number'){
      if(temp>=WX_HOT){score+=20;notes.push(Math.round(temp)+'\u00b0F (ball carries)');}
      else if(temp<=WX_COLD){score+=20;notes.push(Math.round(temp)+'\u00b0F (suppresses)');}
    }
    if(cond==='Rain'||cond==='Thunderstorm'){score+=10;notes.push(cond.toLowerCase());}
    const wx={
      state:score>0?'NOTABLE':'NORMAL',
      score:Math.min(100,score),
      tempF:typeof temp==='number'?Math.round(temp):null,
      windMph:typeof wind==='number'?Math.round(wind):null,
      windDeg:typeof deg==='number'?deg:null,
      conditions:cond||null,roof:false,
      // deliberately NOT a totals lean — see the header note on park bearings
      label:notes.length?notes.join(' \u00b7 ')+' \u2014 raises totals variance, direction not modelled'
                        :'No notable weather factors',
      shadow:true,
    };
    try{await upstashPost(['SET',cacheKey,JSON.stringify(wx),'EX','7200']);}catch{}
    return wx;
  }catch(e){
    return{state:'NONE',score:0,label:'Weather error: '+e.message,shadow:true};
  }
}

/* ── P1 SHADOW: RELATIVE BOARD SCORING ────────────────────────────────
   The model has always asked "is this gap large in absolute pp?". Post-devig
   that question has no useful answer in MLB h2h: today's board ran median
   0.39pp, sd 0.14, max 0.47 — every absolute floor from 0.5 to 2.5 either
   passes nothing or would pass everything. The better question is "is this
   game unusual RELATIVE to today's board?" LAA/SF totals at 1.98pp against a
   median of 0.73 and sd of 0.52 is a +2.1 sigma standout that no fixed floor
   can see.

   VP of Trading's objection is built in: relative scoring alone ALWAYS crowns
   a top play, even on a dead slate — the exact failure mode we are trying to
   avoid. So a game must clear BOTH a relative bar and an absolute floor. The
   floors below are PROVISIONAL PLACEHOLDERS for observation only; the whole
   point of shadow mode is to derive the real ones from the distribution this
   code records. Do not read them as validated. SHADOW: never touches siScore. */
const REL_MIN_SAMPLE = 6;    // games needed before a distribution means anything
const REL_MIN_BOOKS  = 4;    // books on the same number, else the gap isn't trustworthy
const REL_ABS_FLOOR  = { h2h: 0.5, spreads: 1.0, totals: 1.0 };  // PROVISIONAL — recalibrate

function computeBoardStats(plays){
  const byMarket={};
  ['h2h','spreads','totals'].forEach(mk=>{
    const gaps=[];
    plays.forEach(p=>{
      const m=p.markets&&p.markets[mk];
      if(!m)return;
      const g=Math.abs(parseFloat(m.gapPP));
      if(!isFinite(g))return;
      if((m.booksOnNumber||0)<REL_MIN_BOOKS)return; // thin base — excluded from the norm
      gaps.push(g);
    });
    if(gaps.length<REL_MIN_SAMPLE){byMarket[mk]=null;return;}
    const sorted=[...gaps].sort((a,b)=>a-b);
    const mean=gaps.reduce((a,b)=>a+b,0)/gaps.length;
    const sd=Math.sqrt(gaps.reduce((t,x)=>t+(x-mean)*(x-mean),0)/gaps.length);
    byMarket[mk]={n:gaps.length,median:sorted[Math.floor(sorted.length/2)],
      mean:Math.round(mean*100)/100,sd:Math.round(sd*100)/100,
      max:sorted[sorted.length-1],sorted};
  });
  return byMarket;
}

function computeRelSignal(play,stats){
  let best=null;
  ['h2h','spreads','totals'].forEach(mk=>{
    const st=stats[mk],m=play.markets&&play.markets[mk];
    if(!st||!m)return;
    const gap=Math.abs(parseFloat(m.gapPP));
    if(!isFinite(gap))return;
    if((m.booksOnNumber||0)<REL_MIN_BOOKS)return;
    const z=st.sd>0?(gap-st.mean)/st.sd:0;
    const below=st.sorted.filter(x=>x<gap).length;
    const pct=Math.round((below/st.sorted.length)*100);
    const absOK=gap>=(REL_ABS_FLOOR[mk]||1.0);
    // z of +2 is the reference standout; scaled to 0-100 for comparability only
    const score=Math.max(0,Math.min(100,Math.round(z*25+50)));
    const cand={market:mk,gapPP:Math.round(gap*100)/100,z:Math.round(z*100)/100,
      percentile:pct,absFloorMet:absOK,score,
      qualifies:absOK&&z>=1.5,   // PROVISIONAL both-bars rule
      side:m.sharpSide&&m.sharpSide!=='—'?m.sharpSide:(m.sharpOutcome||null)};
    if(!best||cand.z>best.z)best=cand;
  });
  if(!best)return{state:'NONE',score:0,label:'No market with a sufficient same-number base',shadow:true};
  best.label=best.qualifies
    ? best.market+' gap '+best.gapPP+'pp is +'+best.z+' sigma vs today\u2019s board (p'+best.percentile+')'
    : (!best.absFloorMet
        ? best.market+' gap '+best.gapPP+'pp ranks p'+best.percentile+' but is below the provisional absolute floor'
        : best.market+' gap '+best.gapPP+'pp is only +'+best.z+' sigma \u2014 not a standout');
  best.state=best.qualifies?'STANDOUT':'NORMAL';
  best.shadow=true;
  return best;
}

/* ── P2 SHADOW: EXCHANGE LEAN AS A SCORED PILLAR ──────────────────────
   Novig and ProphetX carry no vig and run thinner books, so their gaps run
   5-15x the soft-book gaps — on today's board both exchanges agreed on Under 9
   (3.8/3.7), Under 8 (4.0/4.7) and Under 7 (6.3) while every book gap sat under
   2pp. That is the largest untapped signal we have, and it is currently a badge
   rather than a scored input. This measures it so we can see whether it earns a
   place in the 52/38/10 split. Two independent exchanges agreeing is the real
   signal; one exchange alone is a thin book, not a market view.
   SHADOW: never touches siScore. Promotion is a council decision. */
const EXS_MIN_GAP = 2.0;   // PROVISIONAL — below this an exchange gap is noise

function computeExchangeSignal(play){
  let best=null;
  ['h2h','spreads','totals'].forEach(mk=>{
    const m=play.markets&&play.markets[mk];
    const det=m&&m.exchangeLean&&m.exchangeLean.detail;
    if(!det)return;
    const legs=Object.keys(det).map(k=>({book:k,favors:det[k].favors,gapPP:det[k].gapPP}))
      .filter(x=>x.favors&&typeof x.gapPP==='number'&&x.gapPP>=EXS_MIN_GAP);
    if(!legs.length)return;
    // group by the side each exchange favours; agreement across books is the signal
    const bySide={};
    legs.forEach(l=>{(bySide[l.favors]=bySide[l.favors]||[]).push(l);});
    Object.keys(bySide).forEach(side=>{
      const grp=bySide[side];
      const avgGap=grp.reduce((t,x)=>t+x.gapPP,0)/grp.length;
      const agree=grp.length>=2;
      const score=Math.min(100,Math.round(avgGap*8)+(agree?30:0));
      const cand={market:mk,side,books:grp.map(x=>x.book),bookCount:grp.length,
        avgGapPP:Math.round(avgGap*10)/10,agreement:agree,score,
        disagreement:!!(m.exchangeLean&&m.exchangeLean.disagreement),
        qualifies:agree&&avgGap>=EXS_MIN_GAP};   // PROVISIONAL
      if(!best||cand.score>best.score)best=cand;
    });
  });
  if(!best)return{state:'NONE',score:0,label:'No exchange lean above the provisional noise floor',shadow:true};
  best.state=best.qualifies?'CONFIRMED':'SINGLE';
  best.label=best.agreement
    ? 'Both exchanges favour '+best.side+' by '+best.avgGapPP+'pp avg'
    : best.books[0]+' alone favours '+best.side+' by '+best.avgGapPP+'pp (unconfirmed)';
  best.shadow=true;
  return best;
}

/* ── ML VELOCITY (SHADOW) — state-ladder scoring on cumulative open→now movement ──
   Computed for EVERY game including noSignal ones (killing the circular exclusion where
   completed moves erased the gap and thus escaped measurement). h2h only by design.
   Honest labeling: without public ticket %, this is steam/velocity — never call it RLM. */
function computeMLVelocity(play,openEntry,prevMap){
  const cur=play.bookH2h;
  if(!cur||!cur.pinnacle)return{state:'NONE',score:0,label:'No Pinnacle h2h line',shadow:true};
  if(!openEntry||!openEntry.h2h||!openEntry.h2h.pinnacle)return{state:'NONE',score:0,label:'No opening line stored yet — baseline starts this fetch',shadow:true};
  const names=Object.keys(cur.pinnacle);
  if(names.length<2)return{state:'NONE',score:0,label:'Insufficient outcomes',shadow:true};
  const n0=names[0],n1=names[1];
  const oPin=openEntry.h2h.pinnacle,cPin=cur.pinnacle;
  if(oPin[n0]===undefined||oPin[n1]===undefined||cPin[n0]===undefined||cPin[n1]===undefined)
    return{state:'NONE',score:0,label:'Outcome mismatch vs opening snapshot',shadow:true};
  const od=dv(toImp(oPin[n0]),toImp(oPin[n1]));
  const cd=dv(toImp(cPin[n0]),toImp(cPin[n1]));
  const mv0=(cd[0]-od[0])*100,mv1=(cd[1]-od[1])*100;
  const idx=mv0>=mv1?0:1;
  const name=idx===0?n0:n1;
  const movementPP=idx===0?mv0:mv1;
  // steam width: soft books whose devig-free implied prob for the moving side rose ≥ MLV_STEAM_MIN
  let width=0;const softNow=[];
  Object.keys(cur).forEach(bk=>{
    if(bk==='pinnacle')return;
    const nowP=cur[bk][name],openP=openEntry.h2h[bk]&&openEntry.h2h[bk][name];
    if(cur[bk][n0]!==undefined&&cur[bk][n1]!==undefined){
      const sd=dv(toImp(cur[bk][n0]),toImp(cur[bk][n1]));
      softNow.push(idx===0?sd[0]:sd[1]);
    }
    if(nowP!==undefined&&openP!==undefined&&(toImp(nowP)-toImp(openP))>=MLV_STEAM_MIN)width++;
  });
  const softFairNow=softNow.length>=2?meanArr(softNow):null;
  const curFair=idx===0?cd[0]:cd[1];
  const residualGap=softFairNow!==null?(curFair-softFairNow)*100:null;
  // Lag detection is PER-BOOK, not vs the average: once most books follow, the average
  // dilutes to nothing while stragglers still hang a bettable price — the exact same
  // averaging-dilutes-signal flaw fixed twice elsewhere in this project. A book "lags"
  // if its own fair prob sits ≥ MLV_GAP_PP below Pinnacle's; ≥2 lagging books = a real
  // window (one book alone is a stale feed, not a market).
  let laggingBooks=0,bestLag=0;
  softNow.forEach(function(f){const lag=(curFair-f)*100;if(lag>=MLV_GAP_PP){laggingBooks++;if(lag>bestLag)bestLag=lag;}});
  const booksLagging=laggingBooks>=2;
  // still moving? (rolling 30-min prev snapshot)
  let activeNow=false;
  if(prevMap&&prevMap[name]!==undefined&&movementPP>0){
    activeNow=(toImp(cPin[name])-toImp(prevMap[name]))>=0.004;
  }
  let state='NONE';
  if(movementPP>=MLV_MOVE_PP&&booksLagging)state='MID_MOVE';
  else if(movementPP>=MLV_MOVE_PP)state='MOVE_COMPLETE';
  else if(booksLagging)state='STATIC_GAP';
  let score=0;
  if(state==='MID_MOVE'||state==='MOVE_COMPLETE'){
    score=Math.min(60,Math.round(movementPP*18))+Math.min(20,width*3)+(activeNow?12:0)+(state==='MID_MOVE'?8:0);
    score=Math.min(100,score);
    if(state==='MOVE_COMPLETE')score=Math.min(70,score); // CLV already eaten — capped pending Phase B momentum evidence
  }
  const hrs=openEntry.ts?Math.round((Date.now()-openEntry.ts)/360000)/10:null;
  let label;
  if(state==='NONE')label='No significant ML movement ('+movementPP.toFixed(1)+'pp since first seen)';
  else if(state==='STATIC_GAP')label='Static '+residualGap.toFixed(1)+'pp gap, no movement — covered by SI score';
  else label=fmt(oPin[name])+' \u2192 '+fmt(cPin[name])+' since first seen ('+movementPP.toFixed(1)+'pp'+(hrs!==null?', '+hrs+'h':'')+')'
    +(width?' \u00b7 '+width+' books moved':'')
    +(state==='MID_MOVE'?' \u00b7 '+laggingBooks+' books still lagging (best +'+bestLag.toFixed(1)+'pp)':' \u00b7 move complete, price gone')
    +(activeNow?' \u00b7 still moving':'');
  return{state,score,side:name,movementPP:Math.round(movementPP*10)/10,steamWidth:width,
    residualGap:residualGap!==null?Math.round(residualGap*10)/10:null,
    laggingBooks,bestLag:Math.round(bestLag*10)/10,activeNow,
    openPin:oPin[name],nowPin:cPin[name],hoursTracked:hrs,label,shadow:true};
}

/* ── Original signal math (unchanged) ─────────────────────── */
function toImp(a){return a>=0?100/(100+a):Math.abs(a)/(Math.abs(a)+100);}
function toAm(p){if(p<=0||p>=1)return 0;return p>=0.5?-Math.round(p/(1-p)*100):Math.round((1-p)/p*100);}
function fmt(n){return n>0?'+'+n:String(n);}
function dv(p1,p2){const t=p1+p2;return[p1/t,p2/t];}
/* P0 POINT-MATCH FIX (council build 2026-07-25): every soft-book and exchange
   comparison below used to match outcomes on NAME ALONE, ignoring the line value.
   On h2h that is harmless (one outcome per team). On spreads and totals it compares
   different bets: Pinnacle quoting Braves +1.5 at -211 against a soft book quoting
   Braves -1.5 at +187 was reported as an 18pp edge. Four of today's fourteen games
   showed 11.6-19.6pp "gaps" from exactly this; the real spread median is 0.45pp.
   Totals were contaminated the same way wherever books sat on different numbers.
   A book that isn't on Pinnacle's number is now excluded from the average rather
   than silently mispriced into it. pointDrops counts the exclusions so a thin
   comparison base is visible instead of invisible. */
function samePoint(a,b){
  const an=(a===undefined||a===null), bn=(b===undefined||b===null);
  if(an&&bn)return true;          // h2h: neither side carries a point
  if(an||bn)return false;
  return Math.abs(a-b)<1e-9;
}
function findOut(outcomes,name,point){
  if(!outcomes)return null;
  return outcomes.find(o=>o.name===name&&samePoint(o.point,point))||null;
}
/* DEVIG FIX (council build): soft-book fair probs via proper per-book two-way devig,
   replacing the flat /1.048 vig approximation that created a ~1-1.4pp phantom gap —
   noise the same size as a real ML move. Books listing only one side fall back to the
   legacy approximation so qualification counts don't silently change. */
function softFairPair(sms,name0,name1,point0,point1){
  const f0=[],f1=[];let dropped=0;
  sms.forEach(sm=>{
    const o0=findOut(sm.outcomes,name0,point0);
    const o1=findOut(sm.outcomes,name1,point1);
    if(!o0||!o1){dropped++;return;}   // book is on a different number — not comparable
    const[a,b]=dv(toImp(o0.price),toImp(o1.price));
    f0.push(a);f1.push(b);
  });
  return{f0,f1,dropped};
}
function meanArr(a){return a.reduce((x,y)=>x+y,0)/a.length;}
function isPublicLean(name,mkey,price,point){
  if(mkey==='totals')return name==='Over';
  if(mkey==='spreads'){if(point!==undefined&&point!==null)return point<0;return price<-105;}
  return price<-105;
}

function calcRLM(name,mkey,price,open,point){
  const pub=isPublicLean(name,mkey,price,point);
  if(open===null||open===undefined){return pub?15:35;}
  const abs=Math.abs(price-open);
  if(abs<1)return pub?20:36;
  const harder=price<open;
  if(pub&&harder){const b=abs>=20?55:abs>=12?46:abs>=7?36:abs>=4?26:abs>=2?15:8;return Math.min(100,28+b);}
  if(!pub&&harder){const b=abs>=20?58:abs>=12?48:abs>=7?38:abs>=4?28:abs>=2?16:8;return Math.min(100,44+b);}
  if(!pub&&!harder){const b=abs>=20?42:abs>=12?32:abs>=7?22:abs>=4?14:abs>=2?8:4;return Math.min(100,36+b);}
  if(pub&&!harder)return Math.max(0,18-Math.min(12,abs));
  return 25;
}

function calcPin(fairProb,avgSoftFair,floor){
  if(avgSoftFair===null||avgSoftFair===undefined)return 0;
  const gap=(fairProb-avgSoftFair)*100;
  if(gap<floor)return 0;
  const adj=gap-floor;
  return Math.min(100,adj>=5?90+Math.min(10,adj*1.5):adj>=3?74+(adj-3)*8:adj>=2?58+(adj-2)*16:adj>=1?38+(adj-1)*20:adj*38);
}

function calcMoney(exchanges,open,current,simps,avgSoftFairIn){
  let s=0;
  const avgSoftFair=(avgSoftFairIn!==undefined&&avgSoftFairIn!==null)?avgSoftFairIn:(simps.reduce((a,b)=>a+b,0)/simps.length)/1.048;
  let exConfirms=0;
  exchanges.forEach(ex=>{if(ex&&(ex.fairProb-avgSoftFair)*100>EX_CONFIRM_GAP)exConfirms++;});
  if(exConfirms>=2)s+=55;else if(exConfirms===1)s+=36;
  if(open!==null&&open!==undefined){const v=Math.abs(current-open);s+=v>=20?32:v>=12?26:v>=7?18:v>=3?10:v>=1?4:0;}
  if(simps.length>1){const sp=Math.max(...simps)-Math.min(...simps);s+=sp>=0.09?28:sp>=0.06?22:sp>=0.03?13:sp>=0.015?6:0;}
  return Math.min(100,s);
}

function sigType(rlm,pin,mon,exConfirms){
  if(exConfirms>=2&&pin>=60&&rlm>=50)return'DUAL_CONSENSUS';
  if(rlm>=72&&pin>=62)return'SHARP_RLM';
  if(pin>=72)return'PINNACLE_EDGE';
  if(mon>=65&&exConfirms>=1)return'EXCHANGE_SIGNAL';
  if(rlm>=62)return'RLM_ONLY';
  if(pin>=45)return'MODERATE_EDGE';
  return'WEAK';
}

// Independently determines which side EACH exchange favors, separate from which side
// wins the overall SI score. Previously this was computed internally per-outcome but only
// the WINNING side's aggregate exConfirms count (0/1/2) survived to output — you could
// never tell whether it was Novig or ProphetX confirming, or whether they disagreed
// entirely. This surfaces the real per-book breakdown that already existed in the math.
function detectExchangeLean(pm,sms,exBooks,mkey){
  const result={};
  EXCHANGE_BOOKS.forEach(key=>{result[key]={favors:null,gapPP:null}});
  for(let i=0;i<pm.outcomes.length;i++){
    const out=pm.outcomes[i];
    const simps=sms.map(sm=>{const o=findOut(sm.outcomes,out.name,out.point);return o?toImp(o.price):null;}).filter(x=>x!==null);
    if(simps.length<2)continue; // need at least 2 soft books ON THIS NUMBER for a baseline
    const lp=softFairPair(sms,pm.outcomes[0].name,pm.outcomes[1].name,pm.outcomes[0].point,pm.outcomes[1].point);
    const lf=i===0?lp.f0:lp.f1;
    const avgSoftFair=lf.length>=2?meanArr(lf):(simps.reduce((a,b)=>a+b,0)/simps.length)/1.048;
    let side=out.name;
    if(mkey==='spreads'&&out.point!==undefined)side=out.name+' '+(out.point>0?'+':'')+out.point;
    if(mkey==='totals'&&out.point!==undefined)side=out.name+' '+out.point;
    exBooks.forEach(eb=>{
      const em=eb.markets&&eb.markets.find(m=>m.key===mkey);
      if(!em)return;
      const eo=findOut(em.outcomes,out.name,out.point);
      if(!eo)return;
      // Devig the exchange against ITS OWN matching pair at Pinnacle's numbers —
      // em.outcomes[0]/[1] may be a different line entirely.
      const ex0=findOut(em.outcomes,pm.outcomes[0].name,pm.outcomes[0].point);
      const ex1=findOut(em.outcomes,pm.outcomes[1].name,pm.outcomes[1].point);
      if(!ex0||!ex1)return;
      const[ef0,ef1]=dv(toImp(ex0.price),toImp(ex1.price));
      const fairProb=i===0?ef0:ef1;
      const gapPP=(fairProb-avgSoftFair)*100;
      if(gapPP>EX_CONFIRM_GAP&&(result[eb.key].gapPP===null||gapPP>result[eb.key].gapPP)){
        result[eb.key]={favors:side,gapPP:Math.round(gapPP*10)/10};
      }
    });
  }
  const keys=Object.keys(result);
  const bothLean=keys.length===2&&result[keys[0]].favors&&result[keys[1]].favors;
  const disagreement=!!(bothLean&&result[keys[0]].favors!==result[keys[1]].favors);
  return{detail:result,disagreement};
}
// Derives a standalone "exchange confirms, Pinnacle doesn't" signal directly from the
// already-computed exchangeLean data — no restructuring of the Pinnacle-gated scoring
// loop needed. Kept explicitly separate from the main Money Score per council review:
// an exchange-only signal is real information (Novig/ProphetX diverging from soft books)
// but inherently thinner than a Pinnacle-confirmed one — lower liquidity, easier for a
// single trader to move — so it must never be silently merged in at equal weight.
function exchangeOnlySignal(lean){
  const cands=Object.entries(lean.detail).filter(([k,v])=>v.favors&&v.gapPP!==null);
  if(!cands.length)return null;
  cands.sort((a,b)=>b[1].gapPP-a[1].gapPP);
  const[book,d]=cands[0];
  return{book,favors:d.favors,gapPP:d.gapPP,disagreement:lean.disagreement};
}

function analyzeMarket(game,mkey,pin,exBooks,soft){
  const pm=pin.markets&&pin.markets.find(m=>m.key===mkey);
  const sms=soft.map(b=>b.markets&&b.markets.find(m=>m.key===mkey)).filter(Boolean);
  const minBooks=mkey==='h2h'?MIN_SOFT_ML:MIN_SOFT_BOOKS;
  const gapFloor=mkey==='h2h'?PIN_GAP_ML:PIN_GAP_STD;
  if(!pm||pm.outcomes.length<2)return null;
  if(sms.length<2)return null;
  const enoughForSignal=sms.length>=minBooks;
  const[pf0,pf1]=dv(toImp(pm.outcomes[0].price),toImp(pm.outcomes[1].price));
  const pf=[pf0,pf1];
  const rawPrices=pm.outcomes.map(o=>({name:o.name,price:o.price,point:o.point}));
  const softAvgMap={};
  pm.outcomes.forEach((out,oi)=>{
    const si2=sms.map(sm=>{const oo=findOut(sm.outcomes,out.name,out.point);return oo?toImp(oo.price):null;}).filter(x=>x!==null);
    if(si2.length)softAvgMap[out.name]=Math.round(toAm(si2.reduce((a,b)=>a+b,0)/si2.length));
  });
  const fallbackLines=()=>{
    const o0=pm.outcomes[0];
    const s0=sms.map(sm=>{const oo=findOut(sm.outcomes,o0.name,o0.point);return oo?toImp(oo.price):null;}).filter(x=>x!==null);
    const hasSoft=s0.length>0;
    const avgAm=hasSoft?Math.round(toAm(s0.reduce((a,b)=>a+b,0)/s0.length)):0;
    // BUGFIX: avgAmNum/avgFairProb expose the real computed numbers so the caller can
    // populate currentSoftAvg/gapPP correctly instead of hardcoding null/0.00 even when
    // real soft-book data was available (it was already being shown as a display string).
    const fbPair=softFairPair(sms,pm.outcomes[0].name,pm.outcomes[1].name,pm.outcomes[0].point,pm.outcomes[1].point);
    const avgFairProb=fbPair.f0.length>=2?meanArr(fbPair.f0):(hasSoft?(s0.reduce((a,b)=>a+b,0)/s0.length)/1.048:null);
    return{pinnacle:fmt(o0.price),novig:null,softAvg:hasSoft?fmt(avgAm):'—',softRange:'—',avgAmNum:hasSoft?avgAm:null,avgFairProb};
  };
  let best=null,bestSI=-1;
  const mainPair=softFairPair(sms,pm.outcomes[0].name,pm.outcomes[1].name,pm.outcomes[0].point,pm.outcomes[1].point);
  const exchangeLean=detectExchangeLean(pm,sms,exBooks,mkey);
  for(let i=0;i<pm.outcomes.length;i++){
    const out=pm.outcomes[i];
    const simps=sms.map(sm=>{const o=findOut(sm.outcomes,out.name,out.point);return o?toImp(o.price):null;}).filter(x=>x!==null);
    // minBooks now counts books ACTUALLY ON THIS NUMBER, not books on the game.
    // A thin same-number base is a real reason to withhold a signal, not to invent one.
    if(!enoughForSignal||simps.length<minBooks)continue;
    const mFair=i===0?mainPair.f0:mainPair.f1;
    const avgSoftFair=mFair.length>=2?meanArr(mFair):(simps.reduce((a,b)=>a+b,0)/simps.length)/1.048;
    const booksOnNumber=simps.length, booksDropped=mainPair.dropped||0;
    /* BOOK DISPERSION (council rec #2). We average the soft books and discard the
       spread, but the spread IS the signal: 13 books inside 3 cents is consensus;
       13 books spanning 15 cents means someone is mispriced, and Pinnacle's position
       within that range says who. pinPctile is the other half — a wide range only
       matters if Pinnacle sits at an extreme of it. Computed from the devigged
       per-book probabilities, so it is vig-free and directly comparable. This data
       was already being fetched and thrown away; it costs nothing to keep. */
    let dispersion=null;
    if(mFair.length>=3){
      const dm=meanArr(mFair);
      const sd=Math.sqrt(mFair.reduce((t,x)=>t+(x-dm)*(x-dm),0)/mFair.length);
      const lo=Math.min.apply(null,mFair), hi=Math.max.apply(null,mFair);
      const below=mFair.filter(x=>x<pf[i]).length;
      dispersion={
        n:mFair.length,
        sdPP:Math.round(sd*10000)/100,
        rangePP:Math.round((hi-lo)*10000)/100,
        pinPctile:Math.round((below/mFair.length)*100),
        pinOutsideRange:pf[i]>hi||pf[i]<lo,
      };
    }
    const gapPP=(pf[i]-avgSoftFair)*100;
    if(gapPP<gapFloor)continue;
    const exchanges=exBooks.map(eb=>{
      const em=eb.markets&&eb.markets.find(m=>m.key===mkey);
      if(!em)return null;
      const eo=findOut(em.outcomes,out.name,out.point);
      if(!eo)return null;
      const ex0=findOut(em.outcomes,pm.outcomes[0].name,pm.outcomes[0].point);
      const ex1=findOut(em.outcomes,pm.outcomes[1].name,pm.outcomes[1].point);
      if(!ex0||!ex1)return null;
      const[ef0,ef1]=dv(toImp(ex0.price),toImp(ex1.price));
      return{key:eb.key,price:eo.price,fairProb:i===0?ef0:ef1};
    }).filter(Boolean);
    const exConfirms=exchanges.filter(ex=>(ex.fairProb-avgSoftFair)*100>EX_CONFIRM_GAP).length;
    const exLines=exchanges.reduce((acc,ex)=>{acc[ex.key]=fmt(ex.price);return acc;},{});
    // MLB spread filter: reject any spread outcome with juice worse than -150 —
    // confirmed as intentional design, not a leftover default. Do not change without
    // explicit request.
    if(mkey==='spreads'&&out.price<-150)continue;

    const rlm=calcRLM(out.name,mkey,out.price,null,out.point);
    const ps=calcPin(pf[i],avgSoftFair,gapFloor);
    const ms=calcMoney(exchanges,null,out.price,simps,avgSoftFair);
    const si=Math.round(rlm*0.10+ps*0.52+ms*0.38);
    if(si>bestSI&&ps>0){
      bestSI=si;
      let side=out.name;
      if(mkey==='spreads'&&out.point!==undefined)side=out.name+' '+(out.point>0?'+':'')+out.point;
      if(mkey==='totals'&&out.point!==undefined)side=out.name+' '+out.point;
      const asr=simps.reduce((a,b)=>a+b,0)/simps.length;
      const sr=simps.length>1?fmt(Math.round(toAm(Math.min(...simps))))+'–'+fmt(Math.round(toAm(Math.max(...simps)))):fmt(Math.round(toAm(asr)));
      best={
        market:mkey,sharpSide:side,siScore:si,sharpOutcome:out.name,
        pillars:{rlm,pinnacle:Math.round(ps),money:Math.round(ms)},
        signalType:sigType(rlm,ps,ms,exConfirms),
        exConfirms,exLines,novigConfirm:exConfirms>=1,
        lines:{pinnacle:fmt(out.price),novig:exLines['novig']||exLines['prophetx']||null,softAvg:fmt(Math.round(toAm(asr))),softRange:sr},
        booksOnNumber,booksDropped,dispersion,
        currentPinPrice:out.price,currentSoftAvg:softAvgMap[out.name]||null,
        gapPP:gapPP.toFixed(2),numBooks:simps.length,
        publicLean:isPublicLean(out.name,mkey,out.price,out.point),rawPrices,exchangeLean,exchangeOnly:exchangeOnlySignal(exchangeLean),
      };
    }
  }
  if(!best){
    const fb=fallbackLines();
    const pf0=pf[0];
    // BUGFIX: gapPP used to be hardcoded '0.00' here even when a real (sub-floor) gap
    // was computed — indistinguishable from "no divergence at all" in Signal Lab.
    // Now shows the real gap whenever soft-book data exists, still gated at siScore:0.
    const realGapPP=fb.avgFairProb!==null?((pf0-fb.avgFairProb)*100):0;
    /* The no-signal path must carry the SAME diagnostics as a qualifying play.
       P1 scores each game against the whole board, and on a quiet slate every
       game exits here — if booksOnNumber/dispersion were only attached to plays
       clearing the absolute floor, computeBoardStats would see an empty board
       and relative scoring would never fire on exactly the days it exists for.
       (Caught by executing this path rather than trusting a syntax check.) */
    const fbFair=mainPair.f0;
    let fbDisp=null;
    if(fbFair.length>=3){
      const dm=meanArr(fbFair);
      const sd=Math.sqrt(fbFair.reduce((t,x)=>t+(x-dm)*(x-dm),0)/fbFair.length);
      const lo=Math.min.apply(null,fbFair), hi=Math.max.apply(null,fbFair);
      fbDisp={n:fbFair.length,sdPP:Math.round(sd*10000)/100,
        rangePP:Math.round((hi-lo)*10000)/100,
        pinPctile:Math.round((fbFair.filter(x=>x<pf0).length/fbFair.length)*100),
        pinOutsideRange:pf0>hi||pf0<lo};
    }
    return{market:mkey,sharpSide:'—',siScore:0,sharpOutcome:null,pillars:{rlm:0,pinnacle:0,money:0},signalType:'NONE',exConfirms:0,exLines:{},novigConfirm:false,lines:{pinnacle:fb.pinnacle,novig:fb.novig,softAvg:fb.softAvg,softRange:fb.softRange},booksOnNumber:fbFair.length,booksDropped:mainPair.dropped||0,dispersion:fbDisp,currentPinPrice:pm.outcomes[0].price,currentSoftAvg:fb.avgAmNum,gapPP:realGapPP.toFixed(2),numBooks:sms.length,publicLean:false,rawPrices,exchangeLean};
  }
  return best;
}

function analyzeAll(game){
  const pin=game.bookmakers.find(b=>b.key==='pinnacle');
  const exBks=game.bookmakers.filter(b=>EXCHANGE_BOOKS.includes(b.key));
  const soft=game.bookmakers.filter(b=>SOFT_BOOKS.includes(b.key));
  // Per-book h2h prices — feeds the write-once opening store + ML Velocity steam width
  const bookH2h={};
  [pin,...soft].forEach(b=>{
    if(!b)return;
    const m=b.markets&&b.markets.find(m=>m.key==='h2h');
    if(!m||!m.outcomes||m.outcomes.length<2)return;
    const e={};m.outcomes.forEach(o=>{e[o.name]=o.price;});
    bookH2h[b.key]=e;
  });
  const markets={};
  if(pin&&soft.length>=2){
    for(const mkey of['h2h','spreads','totals']){markets[mkey]=analyzeMarket(game,mkey,pin,exBks,soft);}
  }
  const all=Object.values(markets).filter(Boolean);
  const withSignal=all.filter(m=>m.siScore>0);
  const mlMkt=markets['h2h'];
  const spreadMkt=markets['spreads'];
  const mlHasSignal=mlMkt&&mlMkt.siScore>0&&mlMkt.signalType!=='NONE';
  const best=mlHasSignal?(mlMkt):(withSignal.length?withSignal:all).sort((a,b)=>b.siScore-a.siScore)[0];
  let spreadQualified=false;
  if(spreadMkt&&spreadMkt.siScore>0){
    const sr=spreadMkt.rawPrices&&spreadMkt.rawPrices.find(r=>r.name===spreadMkt.sharpOutcome);
    const pt=sr?sr.point:null,px=sr?sr.price:0;
    // Spread: only qualify at -150 or better odds on either side (-151 to -900 = too much juice)
    if(pt!==null&&px>=-150)spreadQualified=true;
    if(pt!==null&&pt<0)spreadMkt.needsSteam=true;
  }
  const noSignal=!best||best.siScore===0;
  if(noSignal){
    // BUGFIX: previously hardcoded numBooks:0/gapPP:'0.00'/pillars all-zero here even
    // though `best` (computed above) already holds the real Pinnacle price, soft-book
    // average, book count, and gap for whichever market got furthest — just with a
    // score of 0 because nothing cleared its threshold. Signal Lab reads these exact
    // top-level fields, so it was showing "0 books, no data" for games that were fully
    // assessed and simply didn't qualify. siScore/signalType/sharpSide remain explicitly
    // zero/none — this only restores the diagnostic numbers, not the qualification.
    return{id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,siScore:0,sharpSide:'—',signalType:'NONE',novigConfirm:best?best.novigConfirm:false,exConfirms:best?best.exConfirms:0,exLines:best?best.exLines:{},exchangeLean:best?best.exchangeLean:null,exchangeOnly:best?best.exchangeOnly:null,lines:best?best.lines:{pinnacle:'—',novig:null,softAvg:'—',softRange:'—'},gapPP:best?best.gapPP:'0.00',pillars:best?best.pillars:{rlm:0,pinnacle:0,money:0},numBooks:best?best.numBooks:0,publicLean:best?best.publicLean:false,activeMarket:best?best.market:'h2h',markets,bookH2h,noSignal:true,mlScore:mlMkt?mlMkt.siScore:0,spreadQualified:false};
  }
  return{id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,siScore:best.siScore,sharpSide:best.sharpSide,signalType:best.signalType,novigConfirm:best.novigConfirm,exConfirms:best.exConfirms,exLines:best.exLines,exchangeLean:best.exchangeLean,exchangeOnly:best.exchangeOnly,lines:best.lines,gapPP:best.gapPP,pillars:best.pillars,numBooks:best.numBooks,publicLean:best.publicLean,activeMarket:best.market,markets,bookH2h,noSignal:false,mlScore:mlMkt?mlMkt.siScore:0,spreadQualified};
}

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS')return res.status(200).end();

  const sport=((req.query&&req.query.sport)||'MLB').toUpperCase();
  const sportKey=SPORT_KEYS[sport];
  if(!sportKey)return res.status(400).json({error:'Unknown sport: '+sport});

  const apiKey=process.env.ODDS_API_KEY;
  if(!apiKey)return res.status(200).json({plays:[],error:'ODDS_API_KEY not set',quota:{remaining:null,used:null}});

  const softKeys=SOFT_BOOKS.join(',');
  const exKeys=EXCHANGE_BOOKS.join(',');
  const allBooks='pinnacle,'+exKeys+','+softKeys;
  const url='https://api.the-odds-api.com/v4/sports/'+sportKey+'/odds'
    +'?apiKey='+apiKey
    +'&markets=h2h,spreads,totals'
    +'&bookmakers='+allBooks
    +'&oddsFormat=american';

  try{
    // Fetch odds + previous lines from KV in parallel
    const [up, prevLines, openMap, closeMap] = await Promise.all([
      fetch(url),
      loadPrevLines(sport),
      loadOpenLines(sport),
      loadCloseLines(sport),
    ]);

    const rem=up.headers.get('x-requests-remaining');
    const used=up.headers.get('x-requests-used');
    if(rem)res.setHeader('x-requests-remaining',rem);
    if(used)res.setHeader('x-requests-used',used);

    if(up.status===401){
      let body='';try{const j=await up.clone().json();body=j.message||'';}catch{}
      const exhausted=body.toLowerCase().includes('exceed')||body.toLowerCase().includes('limit');
      return res.status(200).json({plays:[],error:exhausted?'API quota exhausted':'Invalid API key',quota:{remaining:0,used}});
    }
    if(up.status===422)return res.status(200).json({plays:[],message:sport+' not in season',quota:{remaining:rem,used}});
    if(!up.ok)return res.status(200).json({plays:[],error:'Odds API error '+up.status,quota:{remaining:rem,used}});

    const games=await up.json();
    const now=Date.now();
    const upcoming=(Array.isArray(games)?games:[]).filter(g=>{
      const ct=new Date(g.commence_time).getTime();
      return ct>now&&ct<now+86400000; // pre-game only — live lines are misleading
    });

    const rawPlays=upcoming.map(analyzeAll).filter(Boolean);
    // Tag each play with pre-game status for the site to use
    rawPlays.forEach(p=>{p.isLive=new Date(p.commenceTime).getTime()<now;});

    // Build current line snapshot for storage
    // BUGFIX: previously skipped every noSignal:true game — but that's backwards. We need
    // a saved baseline price for a game BEFORE it has a signal, so future calls can detect
    // it moving INTO one. Gating this on noSignal meant only already-qualifying games ever
    // got snapshotted, so nothing new could ever start accumulating real RLM history.
    const currentLines = {};
    rawPlays.forEach(play => {
      if (!play.id) return;
      currentLines[play.id] = {};
      if (play.markets) {
        Object.values(play.markets).forEach(mkt => {
          if (!mkt || !mkt.rawPrices) return;
          mkt.rawPrices.forEach(rp => { currentLines[play.id][rp.name] = rp.price; });
        });
      }
    });

    // Enrich with line velocity (self-generated RLM)
    const enrichedPlays = rawPlays.map(play => {
      if (play.noSignal || !play.sharpSide || play.sharpSide === '—') return play;
      const rlmResult = calcLineVelocity(
        play.id, play.sharpSide, play.sharpOutcome || play.sharpSide.split(' ')[0],
        play.currentPinPrice || play.lines?.pinnacle, prevLines
      );
      const newSI = Math.round(
        play.pillars.pinnacle * 0.52 +
        play.pillars.money    * 0.38 +
        rlmResult.score       * 0.10
      );
      return {
        ...play,
        siScore: newSI,
        pillars: { ...play.pillars, rlm: rlmResult.score, rlmIsReal: rlmResult.isReal },
        rlmDetail: {
          label:     rlmResult.label,
          movement:  rlmResult.movement,
          prevPrice: rlmResult.prevPrice,
          isReal:    rlmResult.isReal,
        },
      };
    });

    // Write-once opening store: add entries ONLY for games not yet seen. Existing
    // entries are never overwritten — that immutability is the whole point.
    let openChanged=false;
    rawPlays.forEach(play=>{
      if(play.id&&play.bookH2h&&Object.keys(play.bookH2h).length&&!openMap[play.id]){
        openMap[play.id]={ts:now,h2h:play.bookH2h};
        openChanged=true;
      }
    });
    if(openChanged)saveOpenLines(sport,openMap);

    /* CLOSING-LINE CAPTURE: refresh the stored price for every game still PREGAME,
       and never touch it once first pitch has passed. The entry left behind is by
       construction the last quote before the game started — the close. */
    let closeChanged=false;
    rawPlays.forEach(play=>{
      if(!play.id||!play.commenceTime)return;
      const startTs=new Date(play.commenceTime).getTime();
      if(!isFinite(startTs))return;
      // NOTE: `now` in this file is Date.now() — MILLISECONDS. (api/polymarket-notify.js
      // uses seconds; mixing the two conventions is what broke this on first deploy:
      // now*1000 made every game look already-started, so no close was ever captured.)
      // NOTE: the slate is filtered to ct>now upstream, so a started game never reaches
      // this loop at all — which is exactly why the entry can't be corrupted after first
      // pitch, and why an explicit "seal" branch here would be dead code. Frozen state is
      // therefore DERIVED from the stored commenceTime at read time (see closeFrozen),
      // not stored as a flag that nothing would ever set.
      if(now>=startTs)return;
      const pinH2h=play.bookH2h&&play.bookH2h.pinnacle;
      if(!pinH2h)return;
      closeMap[play.id]={ts:now,commenceTime:play.commenceTime,
        away:play.away,home:play.home,h2h:pinH2h,
        markets:Object.keys(play.markets||{}).reduce((a,mk)=>{
          const m=play.markets[mk];
          if(m&&m.currentPinPrice!==undefined)a[mk]={price:m.currentPinPrice,rawPrices:m.rawPrices||null};
          return a;},{})};
      closeChanged=true;
    });
    if(closeChanged)saveCloseLines(sport,closeMap);

    // ML Velocity (shadow) — computed for ALL plays, gap signal or not
    const velPlays=enrichedPlays.map(p=>({...p,mlVelocity:computeMLVelocity(p,openMap[p.id],prevLines[p.id])}));

    // P1/P2 shadow — board stats need the WHOLE slate, so this runs after the map above.
    // Both are observation-only: siScore, signalType and auto-track are untouched.
    const boardStats=computeBoardStats(velPlays);
    // Weather only for games starting within 12h — no point costing an API call on
    // a game two days out whose forecast will be stale long before first pitch.
    const wxMap={};
    if(sport==='MLB'&&process.env.OPENWEATHER_API_KEY){
      const soon=velPlays.filter(p=>{
        const t=p.commenceTime?new Date(p.commenceTime).getTime():0;
        return isFinite(t)&&t>Date.now()&&t-Date.now()<=12*3600000;
      });
      const wxres=await Promise.all(soon.map(p=>fetchWeather(p)));
      soon.forEach((p,i)=>{wxMap[p.id]=wxres[i];});
    }
    const finalPlays=velPlays.map(p=>({...p,
      relSignal:computeRelSignal(p,boardStats),
      exSignal:computeExchangeSignal(p),
      weather:wxMap[p.id]||null,
      /* BUGFIX: this exposed only closeMap[id].h2h[p.sharpSide], but sharpSide is the
         literal string '—' on every no-signal game — which is the overwhelming majority
         of the board — so the lookup always missed and closeLine.pinnacle came back null
         on all 14 games while the stored data was perfectly fine. CLV needs a price for
         BOTH sides regardless of whether a signal exists (you grade the side you bet,
         not the side the engine liked), so away/home are always exposed and sharpSide is
         resolved only when it names a real team. */
      closeLine:closeMap[p.id]?(function(){
        const h=closeMap[p.id].h2h||{};
        const ct=closeMap[p.id].commenceTime?new Date(closeMap[p.id].commenceTime).getTime():0;
        const validSide=p.sharpSide&&p.sharpSide!=='—'&&h[p.sharpSide]!==undefined;
        return{
          away:h[p.away]!==undefined?h[p.away]:null,
          home:h[p.home]!==undefined?h[p.home]:null,
          sharpSide:validSide?p.sharpSide:null,
          pinnacle:validSide?h[p.sharpSide]:null,
          capturedAt:closeMap[p.id].ts,
          frozen:!!(ct&&now>=ct),   // derived, not a stored flag
        };
      })():null,
    }));

    // Shadow log: first time a game enters a qualifying state, append to KV (server-side,
    // device-independent). NX seen-key dedupes across cron runs. Never touches SI/auto-track.
    const mlvCands=finalPlays.filter(p=>p.mlVelocity&&(p.mlVelocity.state==='MID_MOVE'||p.mlVelocity.state==='MOVE_COMPLETE')&&p.mlVelocity.score>=MLV_QUALIFY).slice(0,5);
    for(const p of mlvCands){
      const seenKey='mlv:seen:'+p.id+':'+p.mlVelocity.state;
      const first=await upstashPost(['SET',seenKey,'1','NX','EX','172800']);
      if(first==='OK'){
        await upstashPost(['LPUSH','mlv:shadow:'+sport,JSON.stringify({ts:now,id:p.id,away:p.away,home:p.home,gameTime:p.commenceTime,state:p.mlVelocity.state,score:p.mlVelocity.score,side:p.mlVelocity.side,movementPP:p.mlVelocity.movementPP,steamWidth:p.mlVelocity.steamWidth,residualGap:p.mlVelocity.residualGap,openPin:p.mlVelocity.openPin,nowPin:p.mlVelocity.nowPin})]);
        await upstashPost(['LTRIM','mlv:shadow:'+sport,'0','299']);
      }
    }

    // Save current lines for next call (async, don't await — no latency hit)
    saveCurrentLines(sport, currentLines);

    // Re-sort after enrichment (RLM may change scores)
    const plays=[
      ...finalPlays.filter(p=>p.siScore>0).sort((a,b)=>b.siScore-a.siScore),
      ...finalPlays.filter(p=>p.siScore===0).sort((a,b)=>a.away.localeCompare(b.away)),
    ];

    res.status(200).json({
      plays,
      total:       upcoming.length,
      quota:       { remaining: rem, used },
      rlmSource:   Object.keys(prevLines).length > 0 ? 'line_velocity' : 'inferred_first_run',
      gamesTracked: Object.keys(prevLines).length,
      mlvBaselines: Object.keys(openMap).length,
      mlvActive:    finalPlays.filter(p=>p.mlVelocity&&p.mlVelocity.state!=='NONE').length,
      // P1/P2 shadow observability — this distribution is exactly what the council
      // needs to set real thresholds instead of inventing them.
      boardStats:   Object.keys(boardStats).reduce((a,k)=>{
                      const v=boardStats[k];
                      a[k]=v?{n:v.n,median:v.median,mean:v.mean,sd:v.sd,max:v.max}:null;
                      return a;},{}),
      relStandouts: finalPlays.filter(p=>p.relSignal&&p.relSignal.state==='STANDOUT').length,
      exConfirmed:  finalPlays.filter(p=>p.exSignal&&p.exSignal.state==='CONFIRMED').length,
      closesStored: Object.keys(closeMap).length,
      closesFrozen: Object.keys(closeMap).filter(k=>{
                      const ct=closeMap[k].commenceTime?new Date(closeMap[k].commenceTime).getTime():0;
                      return !!(ct&&now>=ct);
                    }).length,
      wxFetched:    Object.keys(wxMap).length,
    });

  }catch(err){
    console.error('odds error:',err.message);
    res.status(200).json({plays:[],error:err.message,quota:{remaining:null,used:null}});
  }
};
