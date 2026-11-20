/* scripts/poly_match.js  (Derek, Nov 20 2026)
   Which of our classified Polymarket wallets are on one of today's SharpFlow games, and on which side.

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
function startUtc(k) { // "Fri, Nov 20, 8:10 PM" (ET) - same parse as sharpflow_preview.js
  if (!k) return null;
  const m = String(k).match(/(\w{3}) (\d{1,2}), (\d{1,2}):(\d{2}) (AM|PM)/);
  if (!m) return null;
  const mon = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3;
  let h = +m[3] % 12; if (m[5] === 'PM') h += 12;
  const now = new Date(), y = now.getUTCFullYear();
  for (const yy of [y, y + 1, y - 1]) {
    for (const off of [4, 5]) {
      const d = new Date(Date.UTC(yy, mon, +m[2], h + off, +m[4]));
      if (etDate(d) === `${yy}-${String(mon + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` && Math.abs(d - now) < 200 * 86400000) return d;
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

/* games: [{sport, matchup, start}] ; roster: wallets.json ; buysByWallet: {wallet: [v2 trade rows]} */
function matchPoly(games, roster, buysByWallet, now = new Date()) {
  const out = [];
  for (const g of games) {
    const key = SPORT_KEY[g.sport];
    const sp = key && (roster.sports || {})[key];
    if (!sp) continue;
    const [away, home] = String(g.matchup).split(' at ');
    if (!away || !home) continue;
    const gd = g.start ? etDate(g.start) : null;
    const classes = [['HOT', sp.confirmed_sharp || []], ['COLD', sp.confirmed_loser || []]];
    for (const [cls, list] of classes) {
      for (const entry of list) {
        const buys = buysByWallet[entry.wallet] || [];
        const agg = {};
        for (const b of buys) {
          const title = b.title || '';
          if (!(teamHit(title, away) && teamHit(title, home))) continue;
          const mkt = marketOf(title);
          if (!mkt) continue;
          const sd = slugDate(b);
          if (sd && gd) { if (Math.abs(new Date(sd) - new Date(gd)) > 86400000) continue; }
          else if (now / 1000 - (+b.timestamp || 0) > 48 * 3600) continue;
          let side;
          if (mkt === 'TOTAL') side = /^over/i.test(b.outcome) ? 'Over' : /^under/i.test(b.outcome) ? 'Under' : null;
          else {
            // ML and spread outcomes are the team name on Polymarket; anything else (Yes/No, Draw) is skipped.
            const oc = b.outcome || '';
            side = teamHit(oc, away) && !teamHit(oc, home) ? away : teamHit(oc, home) && !teamHit(oc, away) ? home : null;
          }
          if (!side) continue;
          const grp = mkt === 'TOTAL' ? 'total' : 'team';
          const k2 = grp + '|' + side + '|' + mkt;
          const a = (agg[k2] ||= { grp, side, market: mkt, usd: 0, fills: 0, lastTs: 0, title, prices: [] });
          const usd = (+b.size || 0) * (+b.price || 0);
          a.usd += usd; a.fills += 1; a.lastTs = Math.max(a.lastTs, +b.timestamp || 0); a.prices.push(+b.price || 0);
        }
        const sidesByGrp = {};
        for (const a of Object.values(agg)) (sidesByGrp[a.grp] ||= new Set()).add(a.side);
        for (const a of Object.values(agg)) {
          if (a.usd < MIN_USD) continue;
          const r = recFor(entry, a.market);
          // Same bettor check: SharpFlow tracks on-chain wallets too, many of them Polymarket. A SharpFlow ticket on the
          // same game/side/market within 3% of this wallet's dollars is almost surely the same wallet (Nov 20: ic4cream
          // $8,211 on Texas Tech ML vs a SharpFlow ticket of $8,210) - shown, but never counted as a second source.
          const sameT = (g.tickets || []).find(t => t.market === a.market && (a.grp === 'total' ? (/^over/i.test(t.pick) ? 'Over' : 'Under') === a.side : teamHit(t.pick, a.side))
            && Math.abs((t.dollars || 0) - a.usd) <= 0.03 * a.usd);
          out.push({
            sport: g.sport, matchup: g.matchup, grp: a.grp, side: a.side, market: a.market, cls,
            wallet: entry.wallet, name: shortName(entry.name, entry.wallet),
            usd: Math.round(a.usd), fills: a.fills, avgPrice: +(a.prices.reduce((x, y) => x + y, 0) / a.prices.length).toFixed(3),
            lastBuyUtc: a.lastTs ? new Date(a.lastTs * 1000).toISOString() : null, title: a.title,
            rec: r.rec, roi: r.roi, n: r.n, recScope: `${key} ${r.scope}, last ${roster.cutoffDays || 45} days`,
            twoSided: sidesByGrp[a.grp].size > 1,
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
const SLUG_PREFIX = { NBA: ['nba'], NFL: ['nfl'], NHL: ['nhl'], MLB: ['mlb'], WNBA: ['wnba'], CFB: ['cfb', 'ncaaf'], CBB: ['cbb', 'ncaab'] };
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

module.exports = { matchPoly, teamHit, marketOf, SPORT_KEY, l10For };

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
        if (!st || st < now - 3 * 3600000) continue; // keep games that started in the last 3h so a late rerun still sees them
        const k = t.sport + '|' + t.matchup;
        if (seen[k]) { seen[k].tickets.push(t); continue; }
        seen[k] = { sport: t.sport, matchup: t.matchup, start: st, tickets: [t] };
        games.push(seen[k]);
      }
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
      result.ok = result.errors.length < list.length || !list.length;
    } catch (e) { result.errors.push(e.message); }
    fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
    console.log(`poly_match: ${result.games || 0} games, ${result.walletsChecked || 0} wallets, ${result.matches.length} matches, ${result.errors.length} errors`);
    for (const m of result.matches) console.log(`  ${m.cls} ${m.name} ${m.matchup} ${m.market} ${m.side} $${m.usd} ${m.l10 ? m.l10.txt : 'L10 n/a'}${m.twoSided ? ' TWO-SIDED' : ''}${m.sameAsSF ? ' SAME-AS-SF ' + m.sameAsSF.sfWallet : ''}`);
    // games carry their tickets only for matching; keep the file small
    
  })();
}
