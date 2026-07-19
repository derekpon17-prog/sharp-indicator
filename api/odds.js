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

/* ── ACTION NETWORK — Real ticket % for RLM (POC) ──────────────
   Calls the same endpoint AN's website uses. No auth required.
   Rate: once per odds refresh cycle — same cadence as Odds API.
──────────────────────────────────────────────────────────────── */
async function fetchActionNetworkPct(sport = 'mlb') {
  const sportSlug = ({ mlb:'mlb', nfl:'nfl', nba:'nba', nhl:'nhl' })[sport.toLowerCase()] || 'mlb';
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await fetch(
      `https://api.actionnetwork.com/web/v1/games?sport=${sportSlug}&date=${today}`,
      { headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept':     'application/json',
        'Referer':    'https://www.actionnetwork.com/',
        'Origin':     'https://www.actionnetwork.com',
      }}
    );
    if (!res.ok) return { games: {}, status: res.status };
    const data = await res.json();
    const games = {};
    (data.games || []).forEach(g => {
      const teams = g.teams || [];
      if (teams.length < 2) return;
      const awayName = (teams[0].full_name || teams[0].display_name || teams[0].abbr || '').toLowerCase();
      const homeName = (teams[1].full_name || teams[1].display_name || teams[1].abbr || '').toLowerCase();
      const bets = g.consensus || g.betting_percentages || g.public_betting || {};
      const record = {
        anGameId:    g.id,
        awayTeam:    awayName,
        homeTeam:    homeName,
        awayBetPct:  parseFloat(bets.away_bets  || bets.away_bet_pct  || bets.away || 0),
        homeBetPct:  parseFloat(bets.home_bets  || bets.home_bet_pct  || bets.home || 0),
        awayMonPct:  parseFloat(bets.away_money || bets.away_money_pct || 0),
        homeMonPct:  parseFloat(bets.home_money || bets.home_money_pct || 0),
        totalBets:   parseFloat(bets.total_bets || 0),
        sharpBadge:  !!(g.sharp_action || bets.sharp || g.is_sharp),
        commenceTime: g.start_time || g.scheduled,
      };
      games[`${awayName}_${homeName}`] = record;
      games[`${homeName}_${awayName}`] = record;
      if (teams[0].abbr) games[teams[0].abbr.toLowerCase()] = record;
      if (teams[1].abbr) games[teams[1].abbr.toLowerCase()] = record;
    });
    return { games, status: 'ok', count: Object.keys(games).length / 2 };
  } catch (e) {
    console.warn('[AN] fetch failed:', e.message);
    return { games: {}, status: 'error', error: e.message };
  }
}

function matchToAN(awayTeam, homeTeam, anGames) {
  const norm = s => (s||'').toLowerCase()
    .replace(/\b(new york|los angeles|san francisco|san diego|kansas city|st\.?\s*louis|tampa bay)\b/gi,'')
    .replace(/[^a-z]/g,'').trim();
  const aN = norm(awayTeam), hN = norm(homeTeam);
  if (anGames[`${awayTeam.toLowerCase()}_${homeTeam.toLowerCase()}`])
    return anGames[`${awayTeam.toLowerCase()}_${homeTeam.toLowerCase()}`];
  for (const [key, rec] of Object.entries(anGames)) {
    const kN = norm(key);
    if (kN.includes(aN) || kN.includes(hN)) return rec;
    if ((aN && norm(rec.awayTeam||'').includes(aN)) || (hN && norm(rec.homeTeam||'').includes(hN))) return rec;
  }
  return null;
}

function calcRLMWithAN(sharpSide, awayTeam, anRecord, currentRLM) {
  // If no AN data available, keep the existing inferred RLM value
  if (!anRecord || (!anRecord.awayBetPct && !anRecord.homeBetPct)) {
    return { score: currentRLM, isReal: false, label: 'Inferred (no ticket data)' };
  }
  const sharpIsAway = (sharpSide||'').toLowerCase().includes(
    (awayTeam||'').toLowerCase().split(' ').pop()
  );
  const sharpBetPct  = sharpIsAway ? anRecord.awayBetPct : anRecord.homeBetPct;
  const sharpMonPct  = sharpIsAway ? anRecord.awayMonPct : anRecord.homeMonPct;
  const publicBetPct = 100 - sharpBetPct;
  const div = publicBetPct - 50; // positive = public leaning against sharp
  let score, label;
  if      (div > 25) { score = Math.min(60 + Math.round(div*1.2), 100); label = `Strong RLM (${publicBetPct.toFixed(0)}% public vs sharp)`; }
  else if (div > 10) { score = Math.round(35 + div*1.5);                label = `Moderate RLM (${publicBetPct.toFixed(0)}% public vs sharp)`; }
  else if (div >  0) { score = Math.round(20 + div);                    label = 'Mild divergence'; }
  else               { score = Math.round(Math.max(10, 20+div));         label = 'No RLM (public agrees with sharp)'; }
  if (sharpMonPct > 0 && sharpMonPct > sharpBetPct + 10) { score = Math.min(score+10, 100); label += ' + money divergence'; }
  return {
    score, isReal: true, label,
    sharpBetPct, publicBetPct, sharpMonPct,
    sharpBadgeAN: anRecord.sharpBadge,
  };
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
    const avgAm=s0.length?Math.round(toAm(s0.reduce((a,b)=>a+b,0)/s0.length)):0;
    return{pinnacle:fmt(o0.price),novig:null,softAvg:fmt(avgAm),softRange:'—'};
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
    return{market:mkey,sharpSide:'—',siScore:0,sharpOutcome:null,pillars:{rlm:0,pinnacle:0,money:0},signalType:'NONE',exConfirms:0,exLines:{},novigConfirm:false,lines:fallbackLines(),currentPinPrice:pm.outcomes[0].price,currentSoftAvg:null,gapPP:'0.00',numBooks:sms.length,publicLean:false,rawPrices};
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
    // +1.5 run line: only qualify at -150 or better odds (not -151 to -900 chalk juice)
    if(pt!==null&&pt>0&&px>=-150)spreadQualified=true;
    if(pt!==null&&pt<0)spreadMkt.needsSteam=true;
  }
  const noSignal=!best||best.siScore===0;
  if(noSignal){
    return{id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,siScore:0,sharpSide:'—',signalType:'NONE',novigConfirm:false,exConfirms:0,exLines:{},lines:{pinnacle:'—',novig:null,softAvg:'—',softRange:'—'},gapPP:'0.00',pillars:{rlm:0,pinnacle:0,money:0},numBooks:0,publicLean:false,activeMarket:'h2h',markets,noSignal:true,mlScore:mlMkt?mlMkt.siScore:0,spreadQualified:false};
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
    // Fetch odds + Action Network in parallel — no added latency
    const [up, anData] = await Promise.all([
      fetch(url),
      fetchActionNetworkPct(sport.toLowerCase()),
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
      return ct>now-4*3600000&&ct<now+86400000;
    });

    const rawPlays=upcoming.map(analyzeAll).filter(Boolean);

    // Enrich each play with real RLM from Action Network
    const enrichedPlays = rawPlays.map(play => {
      if (play.noSignal || !play.sharpSide || play.sharpSide === '—') return play;
      const anRecord = matchToAN(play.away, play.home, anData.games || {});
      if (!anRecord) return play;
      const rlmResult = calcRLMWithAN(play.sharpSide, play.away, anRecord, play.pillars.rlm);

      // Recalculate siScore with real RLM (same weights: Pinnacle 52% / Money 38% / RLM 10%)
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
          label:        rlmResult.label,
          sharpBetPct:  rlmResult.sharpBetPct,
          publicBetPct: rlmResult.publicBetPct,
          sharpMonPct:  rlmResult.sharpMonPct,
          sharpBadgeAN: rlmResult.sharpBadgeAN,
          isReal:       rlmResult.isReal,
        },
        publicBettingPct: {
          awayBets:  anRecord.awayBetPct,
          homeBets:  anRecord.homeBetPct,
          awayMoney: anRecord.awayMonPct,
          homeMoney: anRecord.homeMonPct,
        },
      };
    });

    // Re-sort after enrichment (RLM may change scores)
    const plays=[
      ...enrichedPlays.filter(p=>p.siScore>0).sort((a,b)=>b.siScore-a.siScore),
      ...enrichedPlays.filter(p=>p.siScore===0).sort((a,b)=>a.away.localeCompare(b.away)),
    ];

    res.status(200).json({
      plays,
      total: upcoming.length,
      quota: { remaining: rem, used },
      anStatus:     anData.status,
      anGamesFound: anData.count || 0,
    });

  }catch(err){
    console.error('odds error:',err.message);
    res.status(200).json({plays:[],error:err.message,quota:{remaining:null,used:null}});
  }
};
