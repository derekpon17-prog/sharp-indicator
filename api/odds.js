const SHARP_BOOKS=['pinnacle','novig'];
const SOFT_BOOKS=['draftkings','fanduel','betmgm','betrivers','caesars','pointsbetus','williamhill_us'];
const SPORT_KEYS={MLB:'baseball_mlb',NFL:'americanfootball_nfl',NBA:'basketball_nba',NHL:'icehockey_nhl'};

function toImp(a){return a>=0?100/(100+a):Math.abs(a)/(Math.abs(a)+100);}
function toAm(p){if(p<=0||p>=1)return 0;return p>=0.5?-Math.round(p/(1-p)*100):Math.round((1-p)/p*100);}
function fmt(n){return n>0?'+'+n:String(n);}
function dv(p1,p2){const t=p1+p2;return[p1/t,p2/t];}
function isPublicLean(name,mkey,price){if(mkey==='totals')return name==='Over';return price<-105;}

function calcRLM(name,mkey,price,open){
  const pub=isPublicLean(name,mkey,price);
  if(open===null||open===undefined)return pub?18:42;
  const abs=Math.abs(price-open);
  if(abs<1)return pub?22:38;
  const harder=price<open;
  if(pub&&harder){const b=abs>=15?52:abs>=8?42:abs>=4?28:abs>=2?16:8;return Math.min(100,30+b);}
  if(!pub&&!harder){const b=abs>=15?44:abs>=8?34:abs>=4?22:abs>=2?12:6;return Math.min(100,42+b);}
  if(pub&&!harder)return Math.max(0,22-Math.min(12,abs));
  return 28;
}
function calcPin(fairProb,simps){
  if(!simps.length)return 0;
  const avg=simps.reduce((a,b)=>a+b,0)/simps.length;
  const gap=(fairProb-avg/1.048)*100;
  if(gap<=0)return 0;
  return Math.min(100,gap>=7?92:gap>=5?80+(gap-5)*6:gap>=3?60+(gap-3)*10:gap>=2?42+(gap-2)*18:gap>=1?24+(gap-1)*18:gap>=0.5?10+(gap-0.5)*28:gap*20);
}
function calcMoney(novOk,open,current,simps){
  let s=0;if(novOk)s+=42;
  if(open!==null&&open!==undefined){const v=Math.abs(current-open);s+=v>=20?32:v>=12?26:v>=7?18:v>=3?10:v>=1?4:0;}
  if(simps.length>1){const sp=Math.max(...simps)-Math.min(...simps);s+=sp>=0.08?26:sp>=0.05?20:sp>=0.03?12:sp>=0.015?6:0;}
  return Math.min(100,s);
}
function sigType(rlm,pin,mon,nov){
  if(nov&&pin>=65&&rlm>=55)return'DUAL_CONSENSUS';
  if(rlm>=72&&pin>=60)return'SHARP_RLM';
  if(pin>=78)return'PINNACLE_EDGE';
  if(mon>=75&&nov)return'EXCHANGE_SIGNAL';
  if(rlm>=65)return'RLM_ONLY';
  if(pin>=58)return'MODERATE_EDGE';
  return'WEAK';
}

function analyzeMarket(game,mkey,pin,nov,soft){
  const pm=pin.markets&&pin.markets.find(m=>m.key===mkey);
  const nm=nov&&nov.markets&&nov.markets.find(m=>m.key===mkey);
  const sms=soft.map(b=>b.markets&&b.markets.find(m=>m.key===mkey)).filter(Boolean);
  if(!pm||pm.outcomes.length<2||!sms.length)return null;

  const[pf0,pf1]=dv(toImp(pm.outcomes[0].price),toImp(pm.outcomes[1].price));
  const pf=[pf0,pf1];
  let best=null,bestSI=-1;

  // Store raw Pinnacle prices for opening line tracking
  const rawPrices=pm.outcomes.map(o=>({name:o.name,price:o.price,point:o.point}));

  for(let i=0;i<pm.outcomes.length;i++){
    const out=pm.outcomes[i];
    const simps=sms.map(sm=>{const o=sm.outcomes&&sm.outcomes.find(o=>o.name===out.name);return o?toImp(o.price):null;}).filter(x=>x!==null);
    if(!simps.length)continue;

    let novOk=false,novLine=null;
    if(nm){const no=nm.outcomes&&nm.outcomes.find(o=>o.name===out.name);if(no){const[nf0,nf1]=dv(toImp(nm.outcomes[0].price),toImp(nm.outcomes[1].price));const nf=i===0?nf0:nf1;const as=simps.reduce((a,b)=>a+b,0)/simps.length/1.048;novOk=(nf-as)*100>0.3;novLine=fmt(no.price);}}

    const rlm=calcRLM(out.name,mkey,out.price,null); // client overrides with real opening
    const ps=calcPin(pf[i],simps);
    const ms=calcMoney(novOk,null,out.price,simps);
    const si=Math.round(rlm*0.28+ps*0.40+ms*0.32);

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
        signalType:sigType(rlm,ps,ms,novOk),novigConfirm:novOk,
        lines:{pinnacle:fmt(out.price),novig:novLine,softAvg:fmt(Math.round(toAm(asr))),softRange:sr},
        currentPinPrice:out.price,
        gapPP:((pf[i]-asr/1.048)*100).toFixed(2),
        numBooks:simps.length,
        publicLean:isPublicLean(out.name,mkey,out.price),
        rawPrices, // ← raw Pinnacle prices for opening line storage
      };
    }
  }
  return best;
}

function analyzeAll(game){
  const pin=game.bookmakers.find(b=>b.key==='pinnacle');
  const nov=game.bookmakers.find(b=>b.key==='novig');
  const soft=game.bookmakers.filter(b=>SOFT_BOOKS.includes(b.key));
  if(!pin||!soft.length)return null;
  const markets={};
  for(const mkey of['h2h','spreads','totals']){markets[mkey]=analyzeMarket(game,mkey,pin,nov,soft);}
  const all=Object.values(markets).filter(Boolean);
  if(!all.length)return null;
  const best=all.sort((a,b)=>b.siScore-a.siScore)[0];
  return{
    id:game.id,away:game.away_team,home:game.home_team,commenceTime:game.commence_time,
    siScore:best.siScore,sharpSide:best.sharpSide,signalType:best.signalType,
    novigConfirm:best.novigConfirm,lines:best.lines,gapPP:best.gapPP,
    pillars:best.pillars,numBooks:best.numBooks,publicLean:best.publicLean,
    activeMarket:best.market,markets,
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
  const books=[...SHARP_BOOKS,...SOFT_BOOKS].join(',');
  const url='https://api.the-odds-api.com/v4/sports/'+sportKey+'/odds?apiKey='+apiKey+'&regions=us&markets=h2h,spreads,totals&bookmakers='+books+'&oddsFormat=american';
  try{
    const up=await fetch(url);
    const rem=up.headers.get('x-requests-remaining'),used=up.headers.get('x-requests-used');
    if(rem)res.setHeader('x-requests-remaining',rem);
    if(used)res.setHeader('x-requests-used',used);
    if(up.status===401)return res.status(200).json({plays:[],error:'Invalid API key',quota:{remaining:null,used:null}});
    if(up.status===422)return res.status(200).json({plays:[],message:sport+' not in season',quota:{remaining:rem,used}});
    if(!up.ok)return res.status(200).json({plays:[],error:'Odds API error '+up.status,quota:{remaining:rem,used}});
    const games=await up.json();
    const now=Date.now();
    const upcoming=(Array.isArray(games)?games:[]).filter(g=>{const ct=new Date(g.commence_time).getTime();return ct>now&&ct<now+86400000;});
    const plays=upcoming.map(analyzeAll).filter(p=>p!==null&&p.siScore>0).sort((a,b)=>b.siScore-a.siScore);
    res.status(200).json({plays,total:upcoming.length,quota:{remaining:rem,used}});
  }catch(err){
    console.error('odds error:',err.message);
    res.status(200).json({plays:[],error:err.message,quota:{remaining:null,used:null}});
  }
};
