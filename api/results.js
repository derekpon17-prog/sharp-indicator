/* ─────────────────────────────────────────
   api/results.js
   Fetches completed game scores from
   The Odds API scores endpoint.
   Used by the auto-grader in index.html.

   FIX 2026-08-27 (per Derek, real incident): quota hit 19,998/20,000 with days left in
   the month. The documented Aug 19/21 fix only ever covered api/odds.js's endpoint --
   this file calls a DIFFERENT Odds API endpoint (/scores, not /odds), client-triggered
   on every view of the auto-grader tab, with ZERO caching. That's a second real consumer
   of the same shared quota that was never addressed. Adding the same KV-cache pattern
   odds.js already uses. Completed scores don't change once posted, so caching here is
   lower-risk than odds.js's live-price caching was -- there's no "staleness" tradeoff for
   a game that's already over, only a bounded delay (<=TTL) before a JUST-completed game
   shows as graded. 15 min chosen as a first-cut default, not tuned.
───────────────────────────────────────── */
const SPORT_KEYS={
  MLB:'baseball_mlb',NFL:'americanfootball_nfl',
  NBA:'basketball_nba',NHL:'icehockey_nhl',
};
const RESULTS_CACHE_TTL = 900; // 15 min -- first-cut default

async function kvGet(key){
  const url=process.env.KV_REST_API_URL, token=process.env.KV_REST_API_TOKEN;
  if(!url||!token)return null;
  try{
    const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(['GET',key])});
    if(!r.ok)return null;
    const d=await r.json();
    return d.result??null;
  }catch{return null;}
}
async function kvSet(key,value,ttlSec){
  const url=process.env.KV_REST_API_URL, token=process.env.KV_REST_API_TOKEN;
  if(!url||!token)return;
  try{
    await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(['SET',key,JSON.stringify(value),'EX',String(ttlSec)])});
  }catch{}
}

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS')return res.status(200).end();

  const sport=((req.query&&req.query.sport)||'MLB').toUpperCase();
  const sportKey=SPORT_KEYS[sport];
  if(!sportKey)return res.status(400).json({error:'Unknown sport'});

  const apiKey=process.env.ODDS_API_KEY;
  if(!apiKey)return res.status(200).json({scores:[],error:'ODDS_API_KEY not set'});

  const cacheKey='results-cache:'+sport;
  try{
    const cached=await kvGet(cacheKey);
    if(cached){
      const parsed=typeof cached==='string'?JSON.parse(cached):cached;
      if(parsed)return res.status(200).json({...parsed,cached:true});
    }
  }catch{}

  // daysFrom=3 covers last 3 days of completed games
  const url=`https://api.the-odds-api.com/v4/sports/${sportKey}/scores?apiKey=${apiKey}&daysFrom=3`;

  try{
    const up=await fetch(url);
    const rem=up.headers.get('x-requests-remaining');
    const used=up.headers.get('x-requests-used');
    if(rem)res.setHeader('x-requests-remaining',rem);
    if(used)res.setHeader('x-requests-used',used);
    if(!up.ok)return res.status(200).json({scores:[],error:'Scores API error '+up.status});

    const games=await up.json();
    const completed=(Array.isArray(games)?games:[]).filter(g=>g.completed&&g.scores&&g.scores.length>=2);
    const payload={scores:completed,quota:{remaining:rem,used}};
    await kvSet(cacheKey,payload,RESULTS_CACHE_TTL);
    res.status(200).json({...payload,cached:false});
  }catch(err){
    res.status(200).json({scores:[],error:err.message});
  }
};
