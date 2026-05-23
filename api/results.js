/* ─────────────────────────────────────────
   api/results.js
   Fetches completed game scores from
   The Odds API scores endpoint.
   Used by the auto-grader in index.html.
───────────────────────────────────────── */
const SPORT_KEYS={
  MLB:'baseball_mlb',NFL:'americanfootball_nfl',
  NBA:'basketball_nba',NHL:'icehockey_nhl',
};

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS')return res.status(200).end();

  const sport=((req.query&&req.query.sport)||'MLB').toUpperCase();
  const sportKey=SPORT_KEYS[sport];
  if(!sportKey)return res.status(400).json({error:'Unknown sport'});

  const apiKey=process.env.ODDS_API_KEY;
  if(!apiKey)return res.status(200).json({scores:[],error:'ODDS_API_KEY not set'});

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
    res.status(200).json({scores:completed,quota:{remaining:rem,used}});
  }catch(err){
    res.status(200).json({scores:[],error:err.message});
  }
};
