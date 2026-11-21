/* scripts/sf_twin.js  (council, Nov 20 2026 - "is SharpFlow money just Polymarket money?")
   For each SharpFlow ticket on today's snapshot, look for a Polymarket wallet that bought the same game and side for
   the same dollars (within 3%, fills added up per wallet). Many SharpFlow wallets are on-chain; if most tickets have a
   Polymarket twin, a Polymarket HOT wallet on the same side is usually the SAME bettor, not a second source - which
   is exactly what the card's "same wallet as SF" check guards against one wallet at a time. This measures it for the
   whole board. Writes <sf>/sf_twin.json: per sport and market, tickets checked, twins found, the twin rate, and the
   matched pairs (SharpFlow id <-> Polymarket wallet). Display/analysis only - nothing on the cards reads it yet.

   How a game is found on Polymarket: Gamma open events for the sport's tag ending in the next 4 days, title naming
   both teams (same teamHit rules as poly_match.js). Then Data API v2 /trades?event_id= ($100+ buys, taker side).
   Throttled: skips if sf_twin.json is under 2 hours old (FORCE=1 to override).

   CLI: node scripts/sf_twin.js <sf_dir> */
const fs = require('fs');
const { teamHit, marketOf } = require('./poly_match.js');
const sfDir = process.argv[2] || 'sf_branch';
const OUTF = sfDir + '/sf_twin.json';
const now = new Date();
const TAGS = { NBA: ['nba'], NFL: ['nfl'], NHL: ['nhl'], MLB: ['mlb'], WNBA: ['wnba'], CFB: ['cfb', 'ncaaf'], CBB: ['ncaa-basketball', 'cbb'] };
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); return r.ok ? await r.json() : null; } catch { return null; } };

(async () => {
  try { const old = JSON.parse(fs.readFileSync(OUTF, 'utf8')); if (!process.env.FORCE && now - new Date(old.at) < 2 * 3600000) { console.log('sf_twin: fresh (', old.at, ') - skipped'); return; } } catch {}
  const latest = JSON.parse(fs.readFileSync(sfDir + '/latest.json', 'utf8'));
  const tix = (latest.tickets || []).filter(t => t.dollars >= 500 && TAGS[t.sport]);
  const sports = [...new Set(tix.map(t => t.sport))];
  const evBySport = {};
  const maxEnd = new Date(+now + 4 * 86400000).toISOString(), minEnd = new Date(+now - 6 * 3600000).toISOString();
  for (const sp of sports) {
    const seen = {};
    for (const tag of TAGS[sp]) {
      for (let off = 0; off < 500; off += 100) {
        const ev = await get(`https://gamma-api.polymarket.com/events?tag_slug=${tag}&closed=false&end_date_min=${encodeURIComponent(minEnd)}&end_date_max=${encodeURIComponent(maxEnd)}&limit=100&offset=${off}`);
        if (!Array.isArray(ev) || !ev.length) break;
        for (const e of ev) seen[e.id] = e;
        if (ev.length < 100) break;
      }
    }
    evBySport[sp] = Object.values(seen);
  }
  const games = {};
  for (const t of tix) (games[t.sport + '|' + t.matchup] ||= []).push(t);
  const pairs = [], checked = [], stats = {};
  for (const [gk, ts] of Object.entries(games)) {
    const [sp, matchup] = gk.split('|');
    const [away, home] = matchup.split(' at ');
    const ev = (evBySport[sp] || []).find(e => teamHit(e.title, away) && teamHit(e.title, home));
    // FIX Nov 20: the cash filter applies per FILL, and a $8K position is often many small fills - so the filter
    // stays at $100 and the fills are added up per wallet below (first version filtered at half the ticket and
    // missed the known ic4cream $8,211 = SharpFlow $8,210 Texas Tech ML twin).
    let trades = [];
    // v2 pages with a cursor (pagination.next_cursor), not offset - an offset param returned nothing (Nov 20 run)
    if (ev) { let cursor = null; for (let pg = 0; pg < 10; pg++) {
      const d = await get(`https://data-api.polymarket.com/v2/trades?event_id=${ev.id}&side=BUY&taker_only=true&filter_type=CASH&filter_amount=100&limit=500` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
      const rows = (d && d.data) || [];
      trades.push(...rows);
      cursor = d && d.pagination && d.pagination.next_cursor;
      if (!cursor || !rows.length) break;
    } }
    // add up fills per wallet, market and outcome
    const agg = {};
    for (const b of trades) {
      const mkt = marketOf(b.title); if (!mkt) continue;
      const k = [b.proxy_wallet, mkt, b.outcome].join('|');
      const a = (agg[k] ||= { wallet: b.proxy_wallet, name: b.name || null, market: mkt, outcome: b.outcome, usd: 0, title: b.title });
      a.usd += (+b.size || 0) * (+b.price || 0);
    }
    for (const t of ts) {
      const S = ((stats[sp] ||= {})[t.market] ||= { tickets: 0, onPoly: 0, twins: 0 });
      S.tickets++;
      if (!ev) { checked.push({ sfTag: t.wallet, sport: sp, matchup, market: t.market, pick: t.pick, usd: t.dollars, poly: 'no event found' }); continue; }
      S.onPoly++;
      const sideOk = a => a.market === t.market && (t.market === 'TOTAL' ? String(a.outcome).toLowerCase().startsWith(/^over/i.test(t.pick) ? 'over' : 'under') : teamHit(a.outcome, String(t.pick).replace(/\s[+-]?\d.*$/, '').replace(/\sML$/i, '')));
      const twin = Object.values(agg).filter(a => sideOk(a) && Math.abs(a.usd - t.dollars) <= 0.03 * t.dollars).sort((x, y) => Math.abs(x.usd - t.dollars) - Math.abs(y.usd - t.dollars))[0];
      if (twin) { S.twins++; pairs.push({ sport: sp, matchup, market: t.market, pick: t.pick, sfTag: t.wallet, sfUsd: t.dollars, polyWallet: twin.wallet, polyName: twin.name, polyUsd: Math.round(twin.usd) }); }
      const near = Object.values(agg).filter(sideOk).sort((x, y) => Math.abs(x.usd - t.dollars) - Math.abs(y.usd - t.dollars))[0];
      checked.push({ sfTag: t.wallet, sport: sp, matchup, market: t.market, pick: t.pick, usd: t.dollars, poly: twin ? twin.wallet : 'no twin', polyTrades: trades.length, event: ev.title,
        closest: near ? { wallet: near.wallet, usd: Math.round(near.usd), outcome: near.outcome } : null });
      if (process.env.TWIN_DEBUG) console.log(`  . ${sp} ${matchup} ${t.market} ${t.pick} $${t.dollars} | event "${ev.title}" ${trades.length} fills | closest ${near ? Math.round(near.usd) + ' ' + near.outcome : 'none'}`);
    }
  }
  for (const m of Object.values(stats)) for (const s of Object.values(m)) s.twinRate = s.onPoly ? +(s.twins / s.onPoly).toFixed(2) : null;
  const all = pairs.length, onPoly = Object.values(stats).flatMap(m => Object.values(m)).reduce((a, s) => a + s.onPoly, 0);
  const out = { at: now.toISOString(), sfScannedAt: latest.scannedAt, tickets: tix.length, onPoly, twins: all, twinRate: onPoly ? +(all / onPoly).toFixed(2) : null,
    note: 'Twin = a Polymarket wallet with the same game, market and side within 3% of the SharpFlow ticket dollars (fills added up). onPoly = tickets whose game has a Polymarket event.', stats, pairs, checked };
  fs.writeFileSync(OUTF, JSON.stringify(out, null, 1));
  console.log(`sf_twin: ${tix.length} SharpFlow tickets, ${onPoly} on a Polymarket game, ${all} with a Polymarket twin (${out.twinRate ?? 'n/a'})`);
  for (const [sp, m] of Object.entries(stats)) for (const [mk, s] of Object.entries(m)) console.log(`  ${sp} ${mk}: ${s.twins}/${s.onPoly} twins (${s.tickets} tickets)`);
})().catch(e => { console.log('sf_twin failed:', e.message); });
