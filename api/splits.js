/* ─── BETTING SPLITS PROVIDER ─────────────────────────────────────────
   The missing pillar. Without ticket/handle data reverse line movement is not
   computable — you can only infer sharp action from price, which is what this
   project has been doing and why the board reads so thin. Splits make RLM real.

   SOURCE: VSIN's public betting splits page, which publishes DraftKings and
   Circa action as server-rendered HTML refreshed every ~5 minutes. Chosen over
   the paid APIs deliberately: SportsDataIO's free tier returns scrambled data
   and its self-serve tier is next-day delayed (useless pregame), Sportradar's
   Betting Insights is enterprise-gated, and Sports Insights is $300-500/mo for
   data we can validate for free first. Buy the licensed feed once CLV proves
   the pillars are worth protecting — not before.

   TWO BOOKS, DELIBERATELY. DraftKings is recreational-heavy (good for fading
   the public); Circa is where sharps play. The DIVERGENCE between them is a
   signal no single feed hands you.

   PROVIDER INTERFACE: getSplits(sport) returns a normalized shape. Swapping in
   a licensed API later is a new provider function, not a rewrite.

   PARSING PHILOSOPHY: structure-agnostic and loud. It walks generic <tr>/<td>
   rather than class names, because class names churn and semantic table order
   does not. Every response carries a `parse` block with row/game counts, and a
   zero-game parse is reported as ok:false — a silent parse failure that returns
   an empty array would look exactly like a quiet market, which is the same
   class of invisible breakage that cost this project 19 hours last week. */

const VSIN_BASE = 'https://data.vsin.com/betting-splits/';

// sport key -> [VSIN ?sport= param, team-link path fragment used to scope rows]
const VSIN_MAP = {
  MLB:   ['MLB', '/mlb/teams/'],
  NFL:   ['NFL', '/nfl/teams/'],
  NBA:   ['NBA', '/nba/teams/'],
  NHL:   ['NHL', '/nhl/teams/'],
  WNBA:  ['WNBA', '/wnba/teams/'],
  NCAAF: ['CFB', '/college-football/teams/'],
  NCAAB: ['CBB', '/college-basketball/teams/'],
};

const CACHE_TTL = 600; // 10 min — page refreshes every ~5, cron runs every 15

/* ── KV ── */
async function kv(body) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, result: null };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, result: null };
    const d = await r.json();
    return { ok: true, result: d.result ?? null };
  } catch { return { ok: false, result: null }; }
}

/* ── HTML helpers ── */
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
function pct(s) {
  const m = String(s || '').match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}
function num(s) {
  // line values: +1.5, -1.5, 8.5, +141, -171, PK
  const t = stripTags(s).replace(/[▲▼↑↓]/g, '').trim();
  if (/^pk$/i.test(t)) return 0;
  const m = t.match(/^([+-]?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/* ── Parser ──
   Expected semantic column order per team row (stable across VSIN's leagues):
     [icon] [team] [spread] [spr handle%] [spr bets%]
                   [total]  [tot handle%] [tot bets%]
                   [ml]     [ml handle%]  [ml bets%]
   Rows arrive in pairs: away then home. We scope to the requested league by the
   team-link path so a page carrying several leagues cannot bleed across. */
function parseVsin(html, teamPath) {
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const parsed = [];
  let rowsSeen = 0, rowsWithTeam = 0;

  rows.forEach(row => {
    rowsSeen++;
    if (row.indexOf(teamPath) < 0) return;      // not a team row for this league
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length < 8) return;

    // team name = text of the cell containing the team link
    const linkCell = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
      .find(c => c.indexOf(teamPath) >= 0);
    const team = stripTags(linkCell);
    if (!team) return;
    rowsWithTeam++;

    // Pull the numeric cells after the team cell, in order.
    const teamIdx = cells.findIndex(c => c === team);
    const tail = cells.slice(teamIdx + 1).filter(c => c !== '');
    if (tail.length < 9) return;

    parsed.push({
      team,
      spread: { line: num(tail[0]), handle: pct(tail[1]), bets: pct(tail[2]) },
      total:  { line: num(tail[3]), handle: pct(tail[4]), bets: pct(tail[5]) },
      ml:     { line: num(tail[6]), handle: pct(tail[7]), bets: pct(tail[8]) },
    });
  });

  // Pair consecutive rows into games (away listed first).
  const games = [];
  for (let i = 0; i + 1 < parsed.length; i += 2) {
    const a = parsed[i], h = parsed[i + 1];
    if (!a || !h) continue;
    games.push({ away: a.team, home: h.team, awaySplits: a, homeSplits: h });
  }

  return { games, parse: { rowsSeen, rowsWithTeam, teamRows: parsed.length, games: games.length } };
}

/* Divergence = handle% - bets%. Positive means money is running ahead of tickets
   on that side: fewer, larger wagers, which is the industry's working definition
   of sharp action. This is the number BTL-style reports lead with. */
function withDivergence(game) {
  const side = (s) => ({
    line: s.line,
    handle: s.handle,
    bets: s.bets,
    divergence: (s.handle !== null && s.bets !== null) ? Math.round((s.handle - s.bets) * 10) / 10 : null,
  });
  return {
    away: game.away, home: game.home,
    markets: {
      spread: { away: side(game.awaySplits.spread), home: side(game.homeSplits.spread) },
      total:  { over: side(game.awaySplits.total),  under: side(game.homeSplits.total) },
      ml:     { away: side(game.awaySplits.ml),     home: side(game.homeSplits.ml) },
    },
  };
}

async function fetchSource(sport, source) {
  const map = VSIN_MAP[sport];
  if (!map) return { ok: false, error: 'unsupported sport: ' + sport, games: [] };
  const [vsinSport, teamPath] = map;
  const url = `${VSIN_BASE}?source=${source}&sport=${vsinSport}`;
  try {
    const r = await fetch(url, {
      headers: {
        // Identify honestly rather than impersonating a browser.
        'User-Agent': 'sharp-indicator/1.0 (personal analytics; contact via github.com/derekpon17-prog/sharp-indicator)',
        'Accept': 'text/html',
      },
    });
    if (!r.ok) return { ok: false, error: 'http ' + r.status, games: [], parse: null };
    const html = await r.text();
    const { games, parse } = parseVsin(html, teamPath);
    return {
      ok: games.length > 0,       // zero games == parse failure, NOT a quiet market
      error: games.length ? null : 'parsed 0 games — page structure may have changed',
      games: games.map(withDivergence),
      parse,
      bytes: html.length,
    };
  } catch (e) {
    return { ok: false, error: e.message, games: [], parse: null };
  }
}

/* PROVIDER INTERFACE — the only function callers should depend on. */
async function getSplits(sport) {
  const cacheKey = 'splits:vsin:' + sport;
  const cached = await kv(['GET', cacheKey]);
  if (cached.ok && cached.result) {
    try {
      const d = typeof cached.result === 'string' ? JSON.parse(cached.result) : cached.result;
      d.cached = true;
      return d;
    } catch {}
  }
  const [dk, circa] = await Promise.all([fetchSource(sport, 'DK'), fetchSource(sport, 'CIRCA')]);
  const out = {
    sport, provider: 'vsin', fetchedAt: Date.now(), cached: false,
    dk: { ok: dk.ok, error: dk.error, games: dk.games, parse: dk.parse },
    circa: { ok: circa.ok, error: circa.error, games: circa.games, parse: circa.parse },
    ok: dk.ok || circa.ok,
  };
  if (out.ok) await kv(['SET', cacheKey, JSON.stringify(out), 'EX', String(CACHE_TTL)]);
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const sport = String((req.query && req.query.sport) || 'MLB').toUpperCase();
  try {
    const data = await getSplits(sport);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message, sport, dk: null, circa: null });
  }
};
module.exports.getSplits = getSplits;
module.exports.parseVsin = parseVsin;
module.exports.withDivergence = withDivergence;