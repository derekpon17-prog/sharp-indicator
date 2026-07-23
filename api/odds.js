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

/* ── Original signal math (unchanged) ─────────────────────── */
function toImp(a){return a>=0?100/(100+a):Math.abs(a)/(Math.abs(a)+100);}
function toAm(p){if(p<=0||p>=1)return 0;return p>=0.5?-Math.round(p/(1-p)*100):Math.round((1-p)/p*100);}
function fmt(n){return n>0?'+'+n:String(n);}
function dv(p1,p2){const t=p1+p2;return[p1/t,p2/t];}
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

function calcPin(fairProb,simps,floor){
  if(!simps.length)return 0;
  const avg=simps.reduce((a,b)=>a+b,0)/simps.length;
  const gap=(fairProb-avg/1.048)*100;
  if(gap<floor)return 0;
  const adj=gap-floor;
  return Math.min(100,adj>=5?90+Math.min(10,adj*1.5):adj>=3?74+(adj-3)*8:adj>=2?58+(adj-2)*16:adj>=1?38+(adj-1)*20:adj*38);
}

function calcMoney(exchanges,open,current,simps){
  let s=0;
  const avgSoftFair=(simps.reduce((a,b)=>a+b,0)/simps.length)/1.048;
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
    const si2=sms.map(sm=>{const oo=sm.outcomes&&sm.outcomes.find(o=>o.name===out.name);return oo?toImp(oo.price):null;}).filter(x=>x!==null);
    if(si2.length)softAvgMap[out.name]=Math.round(toAm(si2.reduce((a,b)=>a+b,0)/si2.length));
  });
  const fallbackLines=()=>{
    const o0=pm.outcomes[0];
    const s0=sms.map(sm=>{const oo=sm.outcomes&&sm.outcomes.find(o=>o.name===o0.name);return oo?toImp(oo.price):null;}).filter(x=>x!==null);
    const hasSoft=s0.length>0;
    const avgAm=hasSoft?Math.round(toAm(s0.reduce((a,b)=>a+b,0)/s0.length)):0;
    // BUGFIX: avgAmNum/avgFairProb expose the real computed numbers so the caller can
    // populate currentSoftAvg/gapPP correctly instead of hardcoding null/0.00 even when
    // real soft-book data was available (it was already being shown as a display string).
    const avgFairProb=hasSoft?(s0.reduce((a,b)=>a+b,0)/s0.length)/1.048:null;
    return{pinnacle:fmt(o0.price),novig:null,softAvg:hasSoft?fmt(avgAm):'—',softRange:'—',avgAmNum:hasSoft?avgAm:null,avgFairProb};
  };
  let best=null,bestSI=-1;
  for(let i=0;i<pm.outcomes.length;i++){
    const out=pm.outcomes[i];
    const simps=sms.map(sm=>{const o=sm.outcomes&&sm.outcomes.find(o=>o.name===out.name);return o?toImp(o.price):null;}).filter(x=>x!==null);
    if(!enoughForSignal||simps.length<minBooks)continue;
    const avgSoftFair=(simps.reduce((a,b)=>a+b,0)/simps.length)/1.048;
    const gapPP=(pf[i]-avgSoftFair)*100;
    if(gapPP<gapFloor)continue;
    const exchanges=exBooks.map(eb=>{
      const em=eb.markets&&eb.markets.find(m=>m.key===mkey);
      if(!em)return null;
      const eo=em.outcomes&&em.outcomes.find(o=>o.name===out.name);
      if(!eo)return null;
      const[ef0,ef1]=dv(toImp(em.outcomes[0].price),toImp(em.outcomes[1].price));
      return{key:eb.key,price:eo.price,fairProb:i===0?ef0:ef1};
    }).filter(Boolean);
    const exConfirms=exchanges.filter(ex=>(ex.fairProb-avgSoftFair)*100>EX_CONFIRM_GAP).length;
    const exLines=exchanges.reduce((acc,ex)=>{acc[ex.key]=fmt(ex.price);return acc;},{});
    // MLB spread filter: reject any spread outcome with juice worse than -150
    // e.g. +1.5 at -225 or -1.5 at -175 — not worth the juice
    if(mkey==='spreads'&&out.price<-150)continue;

    const rlm=calcRLM(out.name,mkey,out.price,null,out.point);
    const ps=calcPin(pf[i],simps,gapFloor);
    const ms=calcMoney(exchanges,null,out.price,simps);
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
        currentPinPrice:out.price,currentSoftAvg:softAvgMap[out.name]||null,
        gapPP:gapPP.toFixed(2),numBooks:simps.length,
        publicLean:isPublicLean(out.name,mkey,out.price,out.point),rawPrices,
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
    return{market:mkey,sharpSide:'—',siScore:0,sharpOutcome:null,pillars:{rlm:0,pinnacle:0,money:0},signalType:'NONE',exConfirms:0,exLines:{},novigConfirm:false,lines:{pinnacle:fb.pinnacle,novig:fb.novig,softAvg:fb.softAvg,softRange:fb.softRange},currentPinPrice:pm.outcomes[0].price,currentSoftAvg:fb.avgAmNum,gapPP:realGapPP.toFixed(2),numBooks:sms.length,publicLean:false,rawPrices};
  }
  return best;
}

function analyzeAll(game){
  const pin=game.bookmakers.find(b=>b.key==='pinnacle');
  const exBks=game.bookmakers.filter(b=>EXCHANGE_BOOKS.includes(b.key));
  const soft=game.bookmakers.filter(b=>SOFT_BOOKS.includes(b.key));
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
    return{id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,siScore:0,sharpSide:'—',signalType:'NONE',novigConfirm:best?best.novigConfirm:false,exConfirms:best?best.exConfirms:0,exLines:best?best.exLines:{},lines:best?best.lines:{pinnacle:'—',novig:null,softAvg:'—',softRange:'—'},gapPP:best?best.gapPP:'0.00',pillars:best?best.pillars:{rlm:0,pinnacle:0,money:0},numBooks:best?best.numBooks:0,publicLean:best?best.publicLean:false,activeMarket:best?best.market:'h2h',markets,noSignal:true,mlScore:mlMkt?mlMkt.siScore:0,spreadQualified:false};
  }
  return{id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,siScore:best.siScore,sharpSide:best.sharpSide,signalType:best.signalType,novigConfirm:best.novigConfirm,exConfirms:best.exConfirms,exLines:best.exLines,lines:best.lines,gapPP:best.gapPP,pillars:best.pillars,numBooks:best.numBooks,publicLean:best.publicLean,activeMarket:best.market,markets,noSignal:false,mlScore:mlMkt?mlMkt.siScore:0,spreadQualified};
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
    const [up, prevLines] = await Promise.all([
      fetch(url),
      loadPrevLines(sport),
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
    const currentLines = {};
    rawPlays.forEach(play => {
      if (!play.id || play.noSignal) return;
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

    // Save current lines for next call (async, don't await — no latency hit)
    saveCurrentLines(sport, currentLines);

    // Re-sort after enrichment (RLM may change scores)
    const plays=[
      ...enrichedPlays.filter(p=>p.siScore>0).sort((a,b)=>b.siScore-a.siScore),
      ...enrichedPlays.filter(p=>p.siScore===0).sort((a,b)=>a.away.localeCompare(b.away)),
    ];

    res.status(200).json({
      plays,
      total:       upcoming.length,
      quota:       { remaining: rem, used },
      rlmSource:   Object.keys(prevLines).length > 0 ? 'line_velocity' : 'inferred_first_run',
      gamesTracked: Object.keys(prevLines).length,
    });

  }catch(err){
    console.error('odds error:',err.message);
    res.status(200).json({plays:[],error:err.message,quota:{remaining:null,used:null}});
  }
};
