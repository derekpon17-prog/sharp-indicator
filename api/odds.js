/* ════════════════════════════════════════════
   Sharp.idx — Hardened signal model
   Pinnacle floor: 2.0pp
   Min books: 5
   Novig + ProphetX: 1.5pp threshold each
   RLM: capped at 35 without opening line
   Soft books: 13 total
════════════════════════════════════════════ */

const SHARP_BOOKS = ['pinnacle'];
const EXCHANGE_BOOKS = ['novig','prophetx'];  // Both treated as exchange signals
const SOFT_BOOKS = [
  // Tier 1 — major US regulated (slow followers)
  'draftkings','fanduel','betmgm','betrivers','caesars','williamhill_us',
  // Tier 2 — large US regulated
  'espnbet','betparx','hardrockbet',
  // Tier 3 — offshore (independent pricing, good MLB coverage)
  'betonlineag','bovada','mybookieag','betus',
  // Tier 4 — semi-sharp reference
  'lowvig',
];
// Total: 14 soft + 1 sharp + 2 exchanges = 17 books (under 20 = 2x API cost)
const MIN_SOFT_BOOKS  = 5;    // Minimum books required (spread/totals)
const MIN_SOFT_ML    = 3;    // ML needs fewer books (not all price every game)
const PIN_GAP_ML     = 1.0;  // ML floor — inherently smaller gaps, still meaningful
const PIN_GAP_STD    = 2.0;  // Spread/totals floor
const EX_CONFIRM_GAP = 1.5;  // Novig/ProphetX confirmation threshold

const SPORT_KEYS = {
  MLB:'baseball_mlb',NFL:'americanfootball_nfl',
  NBA:'basketball_nba',NHL:'icehockey_nhl',
  NCAAFB:'americanfootball_ncaaf',
  NCAAB:'basketball_ncaab',
};

function toImp(a){return a>=0?100/(100+a):Math.abs(a)/(Math.abs(a)+100);}
function toAm(p){if(p<=0||p>=1)return 0;return p>=0.5?-Math.round(p/(1-p)*100):Math.round((1-p)/p*100);}
function fmt(n){return n>0?'+'+n:String(n);}
function dv(p1,p2){const t=p1+p2;return[p1/t,p2/t];}
function isPublicLean(name,mkey,price,point){
  if(mkey==='totals')return name==='Over';
  if(mkey==='spreads'){
    // Public bets the FAVORITE laying points (point < 0 = -1.5 side)
    // NOT the underdog run line even if priced at heavy juice (e.g. -191 on +1.5)
    if(point!==undefined&&point!==null)return point<0;
    return price<-105; // fallback if no point data
  }
  // h2h (ML): favorite is public lean
  return price<-105;
}

/* RLM — capped at 35 without opening line, full range with it */
function calcRLM(name,mkey,price,open,point){
  const pub=isPublicLean(name,mkey,price,point);
  if(open===null||open===undefined){
    // No opening line — conservative estimate only
    return pub?15:35;
  }
  const abs=Math.abs(price-open);
  if(abs<1)return pub?20:36;
  const harder=price<open;
  // Public side + line got harder (moved against them) = strong RLM
  // Public side + line harder (more juice on public) = sharp books pushing back = strong RLM
  if(pub&&harder){const b=abs>=20?55:abs>=12?46:abs>=7?36:abs>=4?26:abs>=2?15:8;return Math.min(100,28+b);}
  // Counter-public + line SHORTER (odds worsened for bettors) = sharp money bet this side = STRONGEST signal
  // e.g. WSH goes +167 -> +144: books shortened because sharps bet Washington
  if(!pub&&harder){const b=abs>=20?58:abs>=12?48:abs>=7?38:abs>=4?28:abs>=2?16:8;return Math.min(100,44+b);}
  // Counter-public + line got longer (better odds) = moderate signal (books fading public)
  if(!pub&&!harder){const b=abs>=20?42:abs>=12?32:abs>=7?22:abs>=4?14:abs>=2?8:4;return Math.min(100,36+b);}
  // Public side + line got easier = public money moving it = square action, no sharp signal
  if(pub&&!harder)return Math.max(0,18-Math.min(12,abs));
  return 25;
}

/* Pinnacle score — hard floor passed per market */
function calcPin(fairProb,simps,floor){
  if(!simps.length)return 0;
  const avg=simps.reduce((a,b)=>a+b,0)/simps.length;
  const gap=(fairProb-avg/1.048)*100;
  if(gap<floor)return 0; // Hard floor — below this is noise
  // Score from 0 at floor, ramping up
  const adj=gap-floor;
  return Math.min(100,
    adj>=5?90+Math.min(10,adj*1.5):
    adj>=3?74+(adj-3)*8:
    adj>=2?58+(adj-2)*16:
    adj>=1?38+(adj-1)*20:
    adj*38
  );
}

/* Money layer — Novig AND ProphetX now both counted */
function calcMoney(exchanges,open,current,simps){
  let s=0;
  const avgSoftFair=(simps.reduce((a,b)=>a+b,0)/simps.length)/1.048;

  // Count exchange confirmations (Novig + ProphetX)
  let exConfirms=0;
  exchanges.forEach(ex=>{
    if(ex&&(ex.fairProb-avgSoftFair)*100>EX_CONFIRM_GAP)exConfirms++;
  });
  if(exConfirms>=2)s+=55; // Both confirm = strongest signal
  else if(exConfirms===1)s+=36; // One confirms = solid

  // Line velocity (requires opening)
  if(open!==null&&open!==undefined){
    const v=Math.abs(current-open);
    s+=v>=20?32:v>=12?26:v>=7?18:v>=3?10:v>=1?4:0;
  }

  // Soft book divergence (books disagreeing = steam chasing)
  if(simps.length>1){
    const sp=Math.max(...simps)-Math.min(...simps);
    s+=sp>=0.09?28:sp>=0.06?22:sp>=0.03?13:sp>=0.015?6:0;
  }
  return Math.min(100,s);
}

function sigType(rlm,pin,mon,exConfirms){
  if(exConfirms>=2&&pin>=60&&rlm>=50)return'DUAL_CONSENSUS';
  if(rlm>=72&&pin>=62)return"SHARP_RLM";;
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
  // Always need Pinnacle + at least 2 soft books to show anything
  if(!pm||pm.outcomes.length<2)return null;
  // If not enough books for a qualified signal, return display-only
  if(sms.length<2){return null;}
  const enoughForSignal=sms.length>=minBooks;

  const[pf0,pf1]=dv(toImp(pm.outcomes[0].price),toImp(pm.outcomes[1].price));
  const pf=[pf0,pf1];
  const rawPrices=pm.outcomes.map(o=>({name:o.name,price:o.price,point:o.point}));
  // SoftAvg per outcome for multi-book steam detection
  const softAvgMap={};
  pm.outcomes.forEach((out,oi)=>{
    const si2=sms.map(sm=>{const oo=sm.outcomes&&sm.outcomes.find(o=>o.name===out.name);return oo?toImp(oo.price):null;}).filter(x=>x!==null);
    if(si2.length)softAvgMap[out.name]=Math.round(toAm(si2.reduce((a,b)=>a+b,0)/si2.length));
  });

  // Pre-build fallback display data (used when no outcome meets gap floor)
  const fallbackLines=()=>{
    const o0=pm.outcomes[0],o1=pm.outcomes[1];
    const s0=sms.map(sm=>{const oo=sm.outcomes&&sm.outcomes.find(o=>o.name===o0.name);return oo?toImp(oo.price):null;}).filter(x=>x!==null);
    const avgAm=s0.length?Math.round(toAm(s0.reduce((a,b)=>a+b,0)/s0.length)):0;
    return{pinnacle:fmt(o0.price),novig:null,softAvg:fmt(avgAm),softRange:'—'};
  };

  let best=null,bestSI=-1;

  for(let i=0;i<pm.outcomes.length;i++){
    const out=pm.outcomes[i];
    const simps=sms.map(sm=>{
      const o=sm.outcomes&&sm.outcomes.find(o=>o.name===out.name);
      return o?toImp(o.price):null;
    }).filter(x=>x!==null);
    if(!enoughForSignal||simps.length<minBooks)continue;

    const avgSoftFair=(simps.reduce((a,b)=>a+b,0)/simps.length)/1.048;
    const gapPP=(pf[i]-avgSoftFair)*100;
    if(gapPP<gapFloor)continue; // Hard floor

    // Gather exchange data
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

    const rlm=calcRLM(out.name,mkey,out.price,null,out.point); // client overrides with real open
    const ps =calcPin(pf[i],simps,gapFloor);
    const ms =calcMoney(exchanges,null,out.price,simps);
    const si =Math.round(rlm*0.10+ps*0.52+ms*0.38);

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
        exConfirms,exLines,
        novigConfirm:exConfirms>=1,
        lines:{
          pinnacle:fmt(out.price),
          novig:exLines['novig']||exLines['prophetx']||null,
          softAvg:fmt(Math.round(toAm(asr))),softRange:sr,
        },
        currentPinPrice:out.price,
        currentSoftAvg:softAvgMap[out.name]||null,
        gapPP:gapPP.toFixed(2),
        numBooks:simps.length,
        publicLean:isPublicLean(out.name,mkey,out.price,out.point),
        rawPrices,
      };
    }
  }
  // If no sharp signal found, still return display data so the tab isn't locked
  if(!best){
    return{
      market:mkey,sharpSide:'—',siScore:0,sharpOutcome:null,
      pillars:{rlm:0,pinnacle:0,money:0},
      signalType:'NONE',exConfirms:0,exLines:{},novigConfirm:false,
      lines:fallbackLines(),currentPinPrice:pm.outcomes[0].price,
      currentSoftAvg:null,gapPP:'0.00',numBooks:sms.length,
      publicLean:false,rawPrices,
    };
  }
  return best;
}

function analyzeAll(game){
  const pin =game.bookmakers.find(b=>b.key==='pinnacle');
  const exBks=game.bookmakers.filter(b=>EXCHANGE_BOOKS.includes(b.key));
  const soft =game.bookmakers.filter(b=>SOFT_BOOKS.includes(b.key));

  const markets={};
  if(pin&&soft.length>=2){
    for(const mkey of['h2h','spreads','totals']){
      markets[mkey]=analyzeMarket(game,mkey,pin,exBks,soft);
    }
  }
  const all=Object.values(markets).filter(Boolean);

  // Always return the game — even with no signal
  const withSignal=all.filter(m=>m.siScore>0);
  const mlMkt=markets['h2h'];
  const spreadMkt=markets['spreads'];

  // Prefer ML when it has any qualifying signal
  // Only fall back to spread/totals if ML has no signal at all
  const mlHasSignal=mlMkt&&mlMkt.siScore>0&&mlMkt.signalType!=='NONE';
  const best=mlHasSignal
    ? mlMkt
    : (withSignal.length?withSignal:all).sort((a,b)=>b.siScore-a.siScore)[0];

  // Spread quality: only worth surfacing if cheap juice underdog OR steam on favorite
  let spreadQualified=false;
  if(spreadMkt&&spreadMkt.siScore>0){
    const sr=spreadMkt.rawPrices&&spreadMkt.rawPrices.find(r=>r.name===spreadMkt.sharpOutcome);
    const pt=sr?sr.point:null;
    const px=sr?sr.price:0;
    // +1.5 at -150 or better (cheap underdog juice) — value run line
    if(pt!==null&&pt>0&&px<=-150)spreadQualified=true;
    // -1.5 side: only qualified if confirmed steam (detected client-side, mark tentative)
    if(pt!==null&&pt<0)spreadMkt.needsSteam=true;
  }

  const noSignal=!best||best.siScore===0;
  if(noSignal){
    return{
      id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,
      siScore:0,sharpSide:'—',signalType:'NONE',novigConfirm:false,exConfirms:0,
      exLines:{},lines:{pinnacle:'—',novig:null,softAvg:'—',softRange:'—'},
      gapPP:'0.00',pillars:{rlm:0,pinnacle:0,money:0},numBooks:0,
      publicLean:false,activeMarket:'h2h',markets,noSignal:true,
      mlScore:mlMkt?mlMkt.siScore:0,spreadQualified:false,
    };
  }
  return{
    id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,
    siScore:best.siScore,sharpSide:best.sharpSide,signalType:best.signalType,
    novigConfirm:best.novigConfirm,exConfirms:best.exConfirms,exLines:best.exLines,
    lines:best.lines,gapPP:best.gapPP,pillars:best.pillars,
    numBooks:best.numBooks,publicLean:best.publicLean,
    activeMarket:best.market,markets,noSignal:false,
    mlScore:mlMkt?mlMkt.siScore:0,
    spreadQualified,
  };
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

  // Request both us and us_ex regions to get exchanges
  const softKeys=SOFT_BOOKS.join(',');
  const exKeys=EXCHANGE_BOOKS.join(',');
  const allBooks='pinnacle,'+exKeys+','+softKeys;

  const url='https://api.the-odds-api.com/v4/sports/'+sportKey+'/odds'+
    '?apiKey='+apiKey+
    '&regions=us,us_ex'+
    '&markets=h2h,spreads,totals'+
    '&bookmakers='+allBooks+
    '&oddsFormat=american';

  try{
    const up=await fetch(url);
    const rem=up.headers.get('x-requests-remaining');
    const used=up.headers.get('x-requests-used');
    if(rem)res.setHeader('x-requests-remaining',rem);
    if(used)res.setHeader('x-requests-used',used);
    if(up.status===401)return res.status(200).json({plays:[],error:'Invalid API key',quota:{remaining:null,used:null}});
    if(up.status===422)return res.status(200).json({plays:[],message:sport+' not in season',quota:{remaining:rem,used}});
    if(!up.ok)return res.status(200).json({plays:[],error:'Odds API error '+up.status,quota:{remaining:rem,used}});

    const games=await up.json();
    const now=Date.now();
    const upcoming=(Array.isArray(games)?games:[]).filter(g=>{
      const ct=new Date(g.commence_time).getTime();
      // Include games started up to 4 hours ago + all upcoming today
      return ct>now-4*3600000&&ct<now+86400000;
    });
    const rawPlays=upcoming.map(analyzeAll).filter(Boolean);
    // Sort: signal plays first (by score), then no-signal games alphabetically
    const plays=[
      ...rawPlays.filter(p=>p.siScore>0).sort((a,b)=>b.siScore-a.siScore),
      ...rawPlays.filter(p=>p.siScore===0).sort((a,b)=>a.away.localeCompare(b.away)),
    ];
    res.status(200).json({plays,total:upcoming.length,quota:{remaining:rem,used}});
  }catch(err){
    console.error('odds error:',err.message);
    res.status(200).json({plays:[],error:err.message,quota:{remaining:null,used:null}});
  }
};
