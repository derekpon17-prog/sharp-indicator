/* scripts/poly_match.js  (Derek, Nov 20 2026)
   Which of our classified Polymarket wallets are on one of the next 3 days' games (every ESPN game in the 7 sports,
   plus SharpFlow's games), and on which side. Buys placed after the game started are dropped (live betting).

   "Classified" = wallets/wallets.json on the `wallets` branch (built by wallet-collector.yml, recalibrated
   ~5x a day by the "Polymarket wallet collector dispatcher" scheduled task): per sport, confirmed_sharp = HOT,
   confirmed_loser = COLD. A wallet only counts in the sport it is classified in - a wallet HOT in NCAAF and
   COLD in NBA is COLD on an NBA game (real case on Nov 20: ic4cream).

   Only real matches are written. No match = nothing on the card (Derek: "only show up if hot or cold wallets
   are on a certain side, not just for the sake of having them").

   Rules for a buy to count:
   - title names BOTH teams of the game (nickname, full name or city), and the slug/event slug date is the game
     date (+-1 day); if the slug has no date, the buy must be within the last 48 hours
   - game-line markets only: moneyline ("A vs. B"), "Spread: Team (x)", or "A vs. B: O/U n". Anything else with a
     colon (1H, player props, etc.) is skipped
   - $500+ on that side after adding up the wallet's fills
   - a wallet on both sides of the same game is flagged twoSided (never counted, same rule as SharpFlow)

   CLI: node scripts/poly_match.js <sf_dir with latest.json> <wallets.json> <out file>
   Uses Polymarket Data API v2 (v1 retired 2026-10-24). Runs in GitHub Actions, which can reach Polymarket. */
const fs = require('fs');

const DATA_API = 'https://data-api.polymarket.com';
const MIN_USD = +(process.env.POLY_MIN_USD || 500);
const BATCH = 6;
const SPORT_KEY = { NFL: 'NFL', CFB: 'NCAAF', NBA: 'NBA', CBB: 'NCAAB', NHL: 'NHL', WNBA: 'WNBA', MLB: 'MLB' };

let NICK = {};
try { NICK = require('../api/kalshi.js').NICKNAME_TO_CITY || {}; } catch { /* table optional */ }

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const WEAK_LAST = new Set(['state', 'st', 'university', 'college', 'city', 'tech']);
function teamHit(text, team) {
  const t = ' ' + norm(text) + ' ';
  const n = norm(team);
  if (!n) return false;
  const opts = [n];
  const alias = NICK[n.replace(/\s/g, '')];
  if (alias) opts.push(alias);
  const words = n.split(' ');
  const last = words[words.length - 1];
  if (words.length > 1 && last.length > 3 && !WEAK_LAST.has(last)) opts.push(last);
  return opts.some(o => t.includes(' ' + o + ' '));
}

function marketOf(title) {
  const ti = String(title || '');
  if (/^spread:/i.test(ti)) return 'SPREAD';
  const i = ti.indexOf(':');
  if (i === -1) return 'ML';
  return /^\s*O\/U\s+[\d.]+\s*$/i.test(ti.slice(i + 1)) ? 'TOTAL' : null;
}

const etDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
function slugDate(b) {
  const m = String(b.slug || b.event_slug || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function startUtc(k) { // "Fri, Nov 20, 8:10 PM" (ET)
  // FIX Nov 20: the first version accepted the first UTC offset whose ET *date* matched, which picked the
  // daylight-time offset in November and put every start an hour early (a 9:10pm CT game looked started at 8:15).
  // Now the candidate must read back as the same ET clock time, so EST/EDT is decided by the date itself.
  if (!k) return null;
  const m = String(k).match(/(\w{3}) (\d{1,2}), (\d{1,2}):(\d{2}) (AM|PM)/);
  if (!m) return null;
  const mon = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3;
  let h = +m[3] % 12; if (m[5] === 'PM') h += 12;
  const want = `${String(h).padStart(2, '0')}:${m[4]}`;
  const etClock = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const now = new Date(), y = now.getUTCFullYear();
  for (const yy of [y, y + 1, y - 1]) {
    for (const off of [5, 4]) {
      const d = new Date(Date.UTC(yy, mon, +m[2], h + off, +m[4]));
      const ds = `${yy}-${String(mon + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
      if (etDate(d) === ds && etClock(d) === want && Math.abs(d - now) < 200 * 86400000) return d;
    }
  }
  return null;
}

async function fetchBuys(wallet) {
  const url = `${DATA_API}/v2/trades?user=${wallet}&side=BUY&taker_only=true&limit=100`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, err: 'HTTP ' + r.status, buys: [] };
    const j = await r.json();
    return { ok: true, buys: Array.isArray(j && j.data) ? j.data : [] };
  } catch (e) { return { ok: false, err: e.message, buys: [] }; }
}

const shortName = (name, w) => (!name || /^0x[0-9a-f]{40}/i.test(name)) ? w.slice(0, 6) + '…' + w.slice(-4) : name;
function recFor(entry, mkt) {
  const bm = ((entry.byMarket || {})[mkt] || {}).post;
  const src = bm && bm.n ? bm : entry.post || {};
  return { rec: src.record || null, roi: src.roi ?? null, n: src.n || 0, scope: bm && bm.n ? mkt : 'all markets' };
}

/* BET-TYPE CHECK (Derek, Nov 20 2026 - "add bet type check", same rule as SharpFlow: money only counts from a wallet
   that is profitable in THIS sport AND THIS bet type). The sport class comes from wallets.json; this narrows it to the
   market actually bet, using the wallet's last-45-day record in that market (byMarket[mkt].post):
   - sport HOT: HOT only with 5+ bets in this market at positive ROI. Losing in this market (5+ bets) = COLD here
     (shown like SharpFlow's "COLD - not counted"). Under 5 bets in this market = not shown (unproven in this bet type).
   - sport COLD: stays COLD unless the wallet is profitable in this market with 5+ bets (then not shown). Under 5
     bets in this market falls back to the sport verdict. */
const MKT_MIN = 5;
function betTypeClass(sportCls, entry, mkt) {
  const p = ((entry.byMarket || {})[mkt] || {}).post;
  const n = (p && p.n) || 0, roi = p ? p.roi : null;
  if (sportCls === 'HOT') {
    if (n < MKT_MIN) return { cls: null, note: `HOT overall, only ${n} ${mkt} bets` };
    return roi > 0 ? { cls: 'HOT', note: null } : { cls: 'COLD', note: `HOT overall but cold in ${mkt} (${p.record}, ${roi}% ROI)` };
  }
  if (n >= MKT_MIN && roi > 0) return { cls: null, note: `COLD overall but profitable in ${mkt}` };
  return { cls: 'COLD', note: n < MKT_MIN ? `COLD overall, thin in ${mkt} (${n} bets)` : null };
}

const SLUG_PREFIX = { NBA: ['nba'], NFL: ['nfl'], NHL: ['nhl'], MLB: ['mlb'], WNBA: ['wnba'], CFB: ['cfb', 'ncaaf'], CBB: ['cbb', 'ncaab'] };
const ALL_PREFIXES = new Set(Object.values(SLUG_PREFIX).flat());

/* ALL GAMES (Derek, Nov 20 2026 - "have Polymarket check all games"): the game list is every game on ESPN's schedule
   for the next 3 ET days in all 7 sports, not only games SharpFlow has a ticket on. SharpFlow games keep their own
   matchup text and tickets (the same-bettor test and onCard need them); an ESPN game that SharpFlow doesn't have is
   added with no tickets (onCard false). Pro teams use the nickname ("Rockets", as SharpFlow writes them), college
   teams the school ("Texas Tech"). */
const ESPN_PATH = { NFL: 'football/nfl', CFB: 'football/college-football', NBA: 'basketball/nba', CBB: 'basketball/mens-college-basketball',
  NHL: 'hockey/nhl', WNBA: 'basketball/wnba', MLB: 'baseball/mlb' };
async function espnGames(now = new Date(), days = 3) {
  const out = [], errs = [];
  const dates = [...Array(days)].map((_, i) => etDate(new Date(+now + i * 86400000)).replace(/-/g, ''));
  await Promise.all(Object.entries(ESPN_PATH).flatMap(([sp, path]) => dates.map(async d => {
    const extra = sp === 'CBB' ? '&groups=50&limit=400' : sp === 'CFB' ? '&groups=80&limit=300' : '&limit=300';
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}${extra}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { errs.push(`espn ${sp} ${d}: HTTP ${r.status}`); return; }
      const j = await r.json();
      for (const e of j.events || []) {
        const cs = ((e.competitions || [])[0] || {}).competitors || [];
        const A = cs.find(c => c.homeAway === 'away'), Hm = cs.find(c => c.homeAway === 'home');
        if (!A || !Hm || !e.date) continue;
        const college = sp === 'CFB' || sp === 'CBB';
        const nm = t => (college ? t.location : t.name) || t.shortDisplayName || t.displayName;
        out.push({ sport: sp, matchup: `${nm(A.team)} at ${nm(Hm.team)}`, start: new Date(e.date), tickets: [], source: 'espn', espnId: e.id,
          // college nicknames repeat (Wildcats), so college games are merged on the school name only
          names: [A.team, Hm.team].map(t => (college ? [t.displayName, t.location, t.shortDisplayName] : [t.displayName, t.name, t.shortDisplayName]).filter(Boolean)) });
      }
    } catch (e) { errs.push(`espn ${sp} ${d}: ${e.message}`); }
  })));
  return { games: out, errs };
}
// An ESPN game is the same as a SharpFlow game when the sport matches and both ESPN teams are named in SharpFlow's matchup.
function sameGame(sfGame, eg) {
  if (sfGame.sport !== eg.sport) return false;
  // nicknames repeat across schools (Wildcats, Bulldogs), so a SharpFlow game with a known start must be within 12h
  if (sfGame.start && Math.abs(new Date(sfGame.start) - eg.start) > 12 * 3600000) return false;
  // whole-name hits only (no last-word fallback): "Kentucky Wildcats" must not match "Arizona Wildcats"
  const t = ' ' + norm(sfGame.matchup) + ' ';
  return eg.names.every(alts => alts.some(n => norm(n) && t.includes(' ' + norm(n) + ' ')));
}

/* games: [{sport, matchup, start}] ; roster: wallets.json ; buysByWallet: {wallet: [v2 trade rows]} */
let inGameSkipped = 0;
function matchPoly(games, roster, buysByWallet, now = new Date()) {
  const out = [];
  inGameSkipped = 0;
  for (const g of games) {
    const key = SPORT_KEY[g.sport];
    const sp = key && (roster.sports || {})[key];
    if (!sp) continue;
    const [away, home] = String(g.matchup).split(' at ');
    if (!away || !home) continue;
    const gd = g.start ? etDate(g.start) : null;
    // College games with ESPN names: whole-name hits only (school, full or short name), so "North Carolina" never
    // picks up "Spread: South Carolina" through a shared last word. Pro teams and games without ESPN names keep teamHit.
    const college = g.sport === 'CFB' || g.sport === 'CBB';
    const strict = (text, alts) => { const t = ' ' + norm(text) + ' '; return alts.some(n => norm(n) && t.includes(' ' + norm(n) + ' ')); };
    const hitA = text => (college && g.names) ? strict(text, g.names[0]) : teamHit(text, away);
    const hitH = text => (college && g.names) ? strict(text, g.names[1]) : teamHit(text, home);
    const classes = [['HOT', sp.confirmed_sharp || []], ['COLD', sp.confirmed_loser || []]];
    for (const [sportCls, list] of classes) {
      for (const entry of list) {
        const buys = buysByWallet[entry.wallet] || [];
        const agg = {};
        const startMs = g.start ? +new Date(g.start) : null;
        for (const b of buys) {
          const title = b.title || '';
          const mkt = marketOf(title);
          if (!mkt) continue;
          // Other sport on the same nicknames (NBA Kings vs NHL Kings): when the slug names a sport, it must be this one.
          const slug = String(b.slug || b.event_slug || '').toLowerCase();
          if (slug && /^[a-z]+-/.test(slug) && ALL_PREFIXES.has(slug.split('-')[0]) && !(SLUG_PREFIX[g.sport] || []).includes(slug.split('-')[0])) continue;
          // IN-GAME BUYS DON'T COUNT (council, Nov 20): a buy at or after the start is live betting on a game in progress,
          // not a pre-game read, and its price reflects the score. Dropped before the dollars are added up.
          if (startMs && (+b.timestamp || 0) * 1000 >= startMs) { inGameSkipped++; continue; }
          const sd = slugDate(b);
          // FIX Nov 20: Polymarket spread titles name ONE team ("Spread: UCF (-1.5)"), so the both-teams test never
          // matched a spread. A spread now matches on that team plus the slug's game date (a team plays once a day);
          // ML and totals still need both teams in the title.
          if (mkt === 'SPREAD') {
            if (!(hitA(title) || hitH(title))) continue;
            if (!sd || !gd || Math.abs(new Date(sd) - new Date(gd)) > 86400000) continue;
          } else {
            if (!(hitA(title) && hitH(title))) continue;
            if (sd && gd) { if (Math.abs(new Date(sd) - new Date(gd)) > 86400000) continue; }
            else if (now / 1000 - (+b.timestamp || 0) > 48 * 3600) continue;
          }
          let side;
          if (mkt === 'TOTAL') side = /^over/i.test(b.outcome) ? 'Over' : /^under/i.test(b.outcome) ? 'Under' : null;
          else {
            // ML and spread outcomes are the team name on Polymarket; anything else (Yes/No, Draw) is skipped.
            const oc = b.outcome || '';
            side = hitA(oc) && !hitH(oc) ? away : hitH(oc) && !hitA(oc) ? home : null;
          }
          if (!side) continue;
          const grp = mkt === 'TOTAL' ? 'total' : 'team';
          const k2 = grp + '|' + side + '|' + mkt;
          const a = (agg[k2] ||= { grp, side, market: mkt, usd: 0, fills: 0, lastTs: 0, firstTs: Infinity, title, prices: [], conds: {} });
          const usd = (+b.size || 0) * (+b.price || 0);
          a.usd += usd; a.fills += 1; a.lastTs = Math.max(a.lastTs, +b.timestamp || 0); a.firstTs = Math.min(a.firstTs, +b.timestamp || Infinity); a.prices.push(+b.price || 0);
          // Per market (condition) totals, so the record can grade the exact market the wallet bought (the biggest one
          // when a wallet bought two lines of the same total, e.g. O/U 218.5 and 219.5).
          const ck = b.condition_id || b.conditionId || title;
          const c = (a.conds[ck] ||= { conditionId: b.condition_id || b.conditionId || null, outcome: b.outcome || null, tokenId: b.asset || b.token_id || b.asset_id || null, title, usd: 0, shares: 0 });
          c.usd += usd; c.shares += (+b.size || 0);
        }
        const sidesByGrp = {};
        for (const a of Object.values(agg)) (sidesByGrp[a.grp] ||= new Set()).add(a.side);
        for (const a of Object.values(agg)) {
          if (a.usd < MIN_USD) continue;
          const gate = betTypeClass(sportCls, entry, a.market);
          if (!gate.cls) continue;
          const cls = gate.cls;
          const r = recFor(entry, a.market);
          // Same bettor check: SharpFlow tracks on-chain wallets too, many of them Polymarket. A SharpFlow ticket on the
          // same game/side/market within 3% of this wallet's dollars is almost surely the same wallet (Nov 20: ic4cream
          // $8,211 on Texas Tech ML vs a SharpFlow ticket of $8,210) - shown, but never counted as a second source.
          const sameT = (g.tickets || []).find(t => t.market === a.market && (a.grp === 'total' ? (/^over/i.test(t.pick) ? 'Over' : 'Under') === a.side : teamHit(t.pick, a.side))
            && Math.abs((t.dollars || 0) - a.usd) <= 0.03 * a.usd);
          const main = Object.values(a.conds).sort((x, y) => y.usd - x.usd)[0] || {};
          const onCard = (g.tickets || []).some(t => (t.market === 'TOTAL' ? 'total' : 'team') === a.grp);
          out.push({
            sport: g.sport, matchup: g.matchup, grp: a.grp, side: a.side, market: a.market, cls,
            startUtc: g.start ? new Date(g.start).toISOString() : null, gameDate: gd,
            conditionId: main.conditionId || null, outcome: main.outcome || null, tokenId: main.tokenId || null, gradeTitle: main.title || a.title,
            gradePrice: main.shares ? +(main.usd / main.shares).toFixed(4) : null, onCard,
            wallet: entry.wallet, name: shortName(entry.name, entry.wallet),
            usd: Math.round(a.usd), fills: a.fills, avgPrice: +(a.prices.reduce((x, y) => x + y, 0) / a.prices.length).toFixed(3),
            lastBuyUtc: a.lastTs ? new Date(a.lastTs * 1000).toISOString() : null,
            firstBuyUtc: isFinite(a.firstTs) ? new Date(a.firstTs * 1000).toISOString() : null,
            hoursBeforeStart: isFinite(a.firstTs) && startMs ? +((startMs - a.firstTs * 1000) / 3600000).toFixed(1) : null,
            gameSource: g.source || 'sharpflow', title: a.title,
            rec: r.rec, roi: r.roi, n: r.n, recScope: `${key} ${r.scope}, last ${roster.cutoffDays || 45} days`,
            twoSided: sidesByGrp[a.grp].size > 1, sportCls, gateNote: gate.note,
            sameAsSF: sameT ? { sfWallet: sameT.wallet, sfDollars: sameT.dollars } : null,
          });
        }
      }
    }
  }
  return out;
}

/* L10 form (Derek, Nov 20 2026 - "like Sharp Flow, L10 4-6"): the wallet's last 10 SETTLED game-line bets in this
   sport, newest resolution first. Win = the held outcome resolved at 1 (current_price >= 0.99), loss = resolved at 0
   (<= 0.01); exits before settlement have no verdict and are skipped (same rule as api/trader-stats.js). A market
   where the wallet held both outcomes is skipped (market making, not a pick). Sport-specific, unlike SharpFlow's
   all-sports L10, because our HOT/COLD classification is per sport. Only fetched for wallets that matched a side. */
async function fetchSettled(wallet) {
  const rows = [];
  for (const status of ['CLOSED', 'REDEEMABLE', 'REDEEMABLE_LOST']) {
    try {
      const r = await fetch(`${DATA_API}/v2/positions?user=${wallet}&status=${status}&sort_by=TIMESTAMP&limit=200`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const j = await r.json();
      for (const p of (j && j.data) || []) rows.push(p);
    } catch { /* one status failing just narrows the sample */ }
  }
  return rows;
}
function l10For(positions, sport) {
  const pre = SLUG_PREFIX[sport] || [];
  const byCond = {};
  for (const p of positions) {
    const slug = String(p.slug || p.event_slug || '').toLowerCase();
    if (!pre.some(x => slug.startsWith(x + '-'))) continue;
    if (!marketOf(p.title)) continue;
    const cp = parseFloat(p.current_price ?? p.cur_price);
    if (!(cp >= 0.99 || cp <= 0.01)) continue;
    const k = p.condition_id || slug + '|' + p.title;
    (byCond[k] ||= []).push({ win: cp >= 0.99, outcome: p.outcome, end: p.end_date || p.timestamp || '' });
  }
  const settled = Object.values(byCond).filter(a => new Set(a.map(x => x.outcome)).size === 1).map(a => a[0])
    .sort((a, b) => String(b.end).localeCompare(String(a.end))).slice(0, 10);
  if (!settled.length) return null;
  const w = settled.filter(x => x.win).length;
  return { w, l: settled.length - w, n: settled.length, txt: `L${settled.length} ${sport === 'CFB' ? 'NCAAF' : sport === 'CBB' ? 'NCAAB' : sport} ${w}-${settled.length - w}` };
}
async function addL10(matches) {
  const ws = [...new Set(matches.map(m => m.wallet))], cache = {};
  for (let i = 0; i < ws.length; i += BATCH) {
    const batch = ws.slice(i, i + BATCH);
    const res = await Promise.all(batch.map(fetchSettled));
    batch.forEach((w, j) => { cache[w] = res[j]; });
  }
  for (const m of matches) m.l10 = l10For(cache[m.wallet] || [], m.sport);
  return matches;
}

/* Running record (Derek, Nov 20 2026 - "track their bets"). Every match is logged once per game date in
   <sf>/polylog/<gameDate ET>.json, keyed sport|matchup|market|side|wallet. First sighting is frozen (firstSeenAt,
   firstPrice = the wallet's average fill price for the graded market at that time, firstUsd, cls at that time); later
   runs only raise maxUsd and lastSeenAt, so a reclassified wallet keeps the class it had when we called it.
   scripts/poly_grade.js grades these once the market settles on Polymarket. */
function logMatches(sfDir, matches, at) {
  const byDate = {};
  for (const m of matches) if (m.gameDate) (byDate[m.gameDate] ||= []).push(m);
  fs.mkdirSync(sfDir + '/polylog', { recursive: true });
  for (const [d, ms] of Object.entries(byDate)) {
    const f = `${sfDir}/polylog/${d}.json`;
    let log = { date: d, entries: {} };
    try { log = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    for (const m of ms) {
      const k = [m.sport, m.matchup, m.market, m.side, m.wallet].join('|');
      const e = log.entries[k];
      if (!e) {
        log.entries[k] = { sport: m.sport, matchup: m.matchup, market: m.market, side: m.side, grp: m.grp, wallet: m.wallet, name: m.name,
          cls: m.cls, sportCls: m.sportCls || m.cls, gateNote: m.gateNote || null, startUtc: m.startUtc, conditionId: m.conditionId, outcome: m.outcome, title: m.gradeTitle,
          firstSeenAt: at, firstPrice: m.gradePrice ?? m.avgPrice, firstUsd: m.usd, maxUsd: m.usd, lastSeenAt: at,
          rec: m.rec, roi: m.roi, n: m.n, recScope: m.recScope, l10: m.l10 ? m.l10.txt : null,
          onCard: !!m.onCard, sameAsSF: !!m.sameAsSF, twoSided: !!m.twoSided,
          tokenId: m.tokenId || null, firstBuyUtc: m.firstBuyUtc || null, hoursBeforeStart: m.hoursBeforeStart ?? null, gameSource: m.gameSource || null };
      } else {
        e.maxUsd = Math.max(e.maxUsd || 0, m.usd); e.lastSeenAt = at;
        if (m.twoSided) e.twoSided = true;   // once seen on both sides, never counted
        if (!e.conditionId && m.conditionId) { e.conditionId = m.conditionId; e.outcome = m.outcome; e.title = m.gradeTitle; }
        if (!e.tokenId && m.tokenId) e.tokenId = m.tokenId;
        if (!e.firstBuyUtc && m.firstBuyUtc) { e.firstBuyUtc = m.firstBuyUtc; e.hoursBeforeStart = m.hoursBeforeStart; }
      }
    }
    fs.writeFileSync(f, JSON.stringify(log, null, 1));
  }
}

module.exports = { matchPoly, teamHit, marketOf, SPORT_KEY, l10For, fetchSettled, logMatches, espnGames, sameGame };

if (require.main === module) {
  (async () => {
    const [sfDir = 'sf_branch', rosterFile = 'wallets.json', outFile = sfDir + '/poly_matches.json'] = process.argv.slice(2);
    const result = { at: new Date().toISOString(), ok: false, minUsd: MIN_USD, matches: [], errors: [] };
    try {
      const latest = JSON.parse(fs.readFileSync(sfDir + '/latest.json', 'utf8'));
      const roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
      result.rosterGeneratedAt = roster.generatedAt || null;
      result.sfScannedAt = latest.scannedAt || null;
      const now = new Date();
      const seen = {}, games = [];
      for (const t of latest.tickets || []) {
        const st = startUtc(t.kickoffEt);
        const k = t.sport + '|' + t.matchup;
        if (seen[k]) { seen[k].tickets.push(t); if (!seen[k].start && st) seen[k].start = st; continue; }
        seen[k] = { sport: t.sport, matchup: t.matchup, start: st, tickets: [t], source: 'sharpflow' };
        games.push(seen[k]);
      }
      let espnAdded = 0;
      if (!process.env.ESPN_OFF) {
        const { games: eg, errs } = await espnGames(now);
        result.espnGames = eg.length; result.espnErrors = errs;
        for (const e of eg) {
          const sf = games.find(g => sameGame(g, e));
          if (sf) { if (!sf.start) sf.start = e.start; sf.espnId = e.espnId; sf.names = e.names; continue; }
          if (games.some(g => g.source === 'espn' && g.espnId === e.espnId)) continue;
          games.push(e); espnAdded++;
        }
      }
      result.espnAdded = espnAdded;
      // keep games that started in the last 3h so a late rerun still sees them (their in-game buys are dropped anyway)
      for (let i = games.length - 1; i >= 0; i--) if (!games[i].start || games[i].start < now - 3 * 3600000) games.splice(i, 1);
      const wallets = new Set();
      for (const g of games) {
        const sp = (roster.sports || {})[SPORT_KEY[g.sport]];
        if (!sp) continue;
        for (const e of [...(sp.confirmed_sharp || []), ...(sp.confirmed_loser || [])]) wallets.add(e.wallet);
      }
      const list = [...wallets], buysByWallet = {};
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const res = await Promise.all(batch.map(fetchBuys));
        batch.forEach((w, j) => { buysByWallet[w] = res[j].buys; if (!res[j].ok) result.errors.push(w + ': ' + res[j].err); });
      }
      result.games = games.length; result.walletsChecked = list.length;
      result.matches = await addL10(matchPoly(games, roster, buysByWallet, now));
      result.inGameSkipped = inGameSkipped;
      result.offCardMatches = result.matches.filter(m => m.gameSource === 'espn').length;
      result.ok = result.errors.length < list.length || !list.length;
    } catch (e) { result.errors.push(e.message); }
    fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
    try { logMatches(sfDir, result.matches, result.at); } catch (e) { console.log('polylog write failed:', e.message); }
    console.log(`poly_match: ${result.games || 0} games (${result.espnAdded || 0} from ESPN only), ${result.walletsChecked || 0} wallets, ${result.matches.length} matches (${result.offCardMatches || 0} on games SharpFlow doesn't have), ${result.inGameSkipped || 0} in-game buys dropped, ${result.errors.length} errors`);
    for (const m of result.matches) console.log(`  ${m.cls} ${m.name} ${m.matchup} ${m.market} ${m.side} $${m.usd} ${m.l10 ? m.l10.txt : 'L10 n/a'}${m.twoSided ? ' TWO-SIDED' : ''}${m.sameAsSF ? ' SAME-AS-SF ' + m.sameAsSF.sfWallet : ''}`);
    // games carry their tickets only for matching; keep the file small
    
  })();
}
