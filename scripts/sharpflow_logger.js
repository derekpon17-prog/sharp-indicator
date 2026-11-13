/* SharpFlow logger: runs in GitHub Actions, no Claude. Calls the SharpFlow MCP server (Streamable HTTP),
   compacts today's tickets and locks, appends a snapshot to sf_branch/data/YYYY-MM-DD.json and writes latest.json.
   Always writes probe.json so connection problems are visible. */
const fs = require('fs');
const path = require('path');
const OUT = process.env.OUT_DIR || 'sf_branch';
const BASE = (process.env.SF_URL || 'https://sharpflowmcp-lviwud3q2q-uc.a.run.app').replace(/\/+$/, '');
const CANDS = process.env.SF_URL ? [BASE] : [BASE + '/mcp', BASE + '/sse', BASE];
const probe = { at: new Date().toISOString(), tried: [] };

async function rpc(url, body, sid) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
  if (sid) headers['mcp-session-id'] = sid;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  const text = await r.text();
  let json = null;
  const ct = r.headers.get('content-type') || '';
  try {
    if (ct.includes('event-stream')) {
      const datas = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      for (const d of datas) { try { const j = JSON.parse(d); if (j.id === body.id || j.result || j.error) json = j; } catch {} }
    } else json = JSON.parse(text);
  } catch {}
  return { status: r.status, sid: r.headers.get('mcp-session-id'), ct, json, head: text.slice(0, 300) };
}

async function connect(url) {
  const t = { url };
  probe.tried.push(t);
  try {
    const init = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sharp-signals-logger', version: '1' } } });
    t.init = { status: init.status, ct: init.ct, head: init.head, ok: !!(init.json && init.json.result) };
    if (!init.json || !init.json.result) return null;
    const sid = init.sid;
    try { await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid); } catch {}
    const tl = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
    const tools = (tl.json && tl.json.result && tl.json.result.tools) || [];
    t.tools = tools.map(x => x.name);
    return { url, sid, tools };
  } catch (e) { t.error = e.message; return null; }
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  let conn = null;
  for (const u of CANDS) { conn = await connect(u); if (conn) break; }
  if (!conn) { probe.ok = false; fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(probe, null, 1)); console.log('no connection', JSON.stringify(probe).slice(0, 600)); return; }
  const tool = conn.tools.find(n => /today$/.test(n)) || 'today';
  const call = await rpc(conn.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: {} } }, conn.sid);
  probe.call = { status: call.status, head: call.head.slice(0, 200) };
  let payload = null;
  try {
    const c = call.json.result.content;
    const txt = c.map(x => x.text || '').join('');
    payload = JSON.parse(txt.slice(txt.indexOf('{')));
  } catch (e) { probe.parseError = e.message; }
  probe.ok = !!payload;
  fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(probe, null, 1));
  if (!payload) { console.log('no payload', JSON.stringify(probe).slice(0, 600)); return; }

  const KEEP = new Set(['NFL', 'NBA', 'NHL', 'CFB', 'CBB', 'WNBA', 'MLB']); // NFL, NBA, NHL, NCAAF, NCAAB, WNBA, MLB only
  const tickets = (payload.actionTab || []).filter(a => KEEP.has(String(a.sport || '').toUpperCase())).map(a => ({
    sport: a.sport, matchup: a.matchup, kickoffEt: a.kickoffEt, market: a.market, pick: a.pick, line: a.line == null ? null : a.line,
    opposed: a.opposed, opposedBy: a.opposedBy, recordOf: a.recordOf, wallet: a.sameNight, dollars: a.dollars, price: a.price,
    size: a.sharp && a.sharp.size, vsUsual: a.sharp && a.sharp.vsUsual, form: a.sharp && a.sharp.form,
    l30Roi: a.sharp && a.sharp.l30 && a.sharp.l30.returnPct, mktRecord: a.sharp && a.sharp.market && a.sharp.market.record,
    mktRoi: a.sharp && a.sharp.market && a.sharp.market.returnPct, lineMove: a.lineMove || null,
    l30Rec: a.sharp && a.sharp.l30 && a.sharp.l30.record, l30Dollars: a.sharp && a.sharp.l30 && a.sharp.l30.dollars,
    mktL30Rec: a.sharp && a.sharp.market && a.sharp.market.l30 && a.sharp.market.l30.record, mktL30Dollars: a.sharp && a.sharp.market && a.sharp.market.l30 && a.sharp.market.l30.dollars,
    wid: a.id || (a.sharp && a.sharp.id) || null, usualSport: a.sharp && a.sharp.usualSport, usualAll: a.sharp && a.sharp.usualAll,
    fp: [a.sharp && a.sharp.l30 && a.sharp.l30.record, a.sharp && a.sharp.l30 && a.sharp.l30.dollars, a.sharp && a.sharp.market && a.sharp.market.record].join('|'),
  }));
  const plays = (payload.plays || []).filter(p => KEEP.has(String(p.sport || '').toUpperCase())).map(p => ({
    sport: p.sport, matchup: p.matchup, kickoffEt: p.kickoffEt, market: p.market, side: p.side, pick: p.pick, line: p.line, units: p.units, odds: p.odds,
    status: p.status, score: p.score, alignment: p.alignment,
    money: p.money ? { dollars: p.money.dollars, confirmed: p.money.confirmed, record: p.money.record, opposed: p.money.opposed } : null,
    price: p.price ? { fair: p.price.fair, best: p.price.best, bestBook: p.price.bestBook, hitEdge: p.price.hitEdge, n: p.price.actualWinN } : null,
  }));
  const snap = { at: new Date().toISOString(), scannedAt: payload.scannedAt, record: payload.record && payload.record.all, tickets, plays };
  const date = payload.date || new Date().toISOString().slice(0, 10);
  const f = path.join(OUT, 'data', date + '.json');
  let day = { date, snapshots: [] };
  try { day = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const last = day.snapshots[day.snapshots.length - 1];
  if (!last || last.scannedAt !== snap.scannedAt) day.snapshots.push(snap);
  fs.writeFileSync(f, JSON.stringify(day));
  fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify({ date, ...snap }));
  // Strong-vs-weak flags: strong = confirmed wallet with hot 30-day and market stats; weak = confirmed wallet with cold stats. Not true losers (the feed has none).
  const strong = x => x.dollars >= 1000 && (x.l30Roi || 0) >= 25 && (x.mktRoi == null || x.mktRoi >= 20);
  const weak = x => x.dollars >= 500 && ((x.l30Roi != null && x.l30Roi <= 8) || (x.mktRoi != null && x.mktRoi < 0));
  const games = {};
  for (const x of tickets) { const k = x.matchup + '|' + x.market; (games[k] = games[k] || {})[x.pick] = (games[k][x.pick] || []).concat(x); }
  const flags = [];
  for (const k of Object.keys(games)) {
    const sides = Object.keys(games[k]);
    for (const sd of sides) {
      const mine = games[k][sd], strongT = mine.filter(strong);
      if (!strongT.length) continue;
      const other = sides.filter(o => o !== sd).flatMap(o => games[k][o]);
      const weakOpp = other.filter(weak), strongOpp = other.filter(strong);
      const sum = a => a.reduce((n, y) => n + y.dollars, 0);
      flags.push({ matchup: k.split('|')[0], market: k.split('|')[1], pick: sd, kickoffEt: mine[0].kickoffEt, sport: mine[0].sport,
        type: strongOpp.length ? 'STRONG_VS_STRONG' : weakOpp.length ? 'STRONG_VS_WEAK' : other.length ? 'STRONG_VS_OTHER' : 'STRONG_UNOPPOSED',
        strongDollars: sum(strongT), oppDollars: sum(other), oppWeakDollars: sum(weakOpp), fp: strongT.map(y => y.fp), bestPrice: strongT[0].price });
    }
  }
  flags.sort((a, b) => b.strongDollars - a.strongDollars);
  for (const fl of flags) { const ts = (games[fl.matchup + '|' + fl.market] || {})[fl.pick] || []; fl.maxVsUsual = Math.max(0, ...ts.map(y => y.vsUsual || 0)); }
  // Sized-up tickets: any confirmed wallet betting above its usual size (vsUsual > 1), $1K+
  const sizedUp = tickets.filter(x => (x.vsUsual || 0) > 1 && x.dollars >= 1000)
    .map(x => ({ matchup: x.matchup, market: x.market, pick: x.pick, kickoffEt: x.kickoffEt, sport: x.sport, dollars: x.dollars, price: x.price, vsUsual: x.vsUsual, size: x.size, form: x.form, l30Roi: x.l30Roi, mktRecord: x.mktRecord, mktRoi: x.mktRoi, opposed: x.opposed, fp: x.fp }))
    .sort((a, b) => b.vsUsual - a.vsUsual || b.dollars - a.dollars);
  // Called-out log: first time each flagged side appeared today (price and time frozen at first sight), for grading by sport.
  try {
    fs.mkdirSync(path.join(OUT, 'flaglog'), { recursive: true });
    const lf = path.join(OUT, 'flaglog', date + '.json');
    let lg = { date, sides: {} }; try { lg = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch {}
    const upd = (x, tag, extra) => {
      const key = [x.matchup, x.market, x.pick].join('|');
      const r = lg.sides[key] || (lg.sides[key] = { sport: x.sport, matchup: x.matchup, market: x.market, pick: x.pick, kickoffEt: x.kickoffEt, firstSeenAt: new Date().toISOString(), firstPrice: x.price || x.bestPrice || null, tags: [], maxVsUsual: 0, maxDollars: 0, opposedSeen: false, snapshots: 0 });
      if (!r.tags.includes(tag)) r.tags.push(tag);
      r.maxVsUsual = Math.max(r.maxVsUsual, extra.vs || 0); r.maxDollars = Math.max(r.maxDollars, extra.d || 0); r.snapshots++;
      if (extra.opp) r.opposedSeen = true;
    };
    for (const fl of flags) upd(fl, fl.type, { vs: fl.maxVsUsual, d: fl.strongDollars, opp: fl.type !== 'STRONG_UNOPPOSED' });
    for (const z of sizedUp) upd(z, z.vsUsual >= 2 ? 'SIZED_2X' : z.vsUsual >= 1.5 ? 'SIZED_15X' : 'SIZED_UP', { vs: z.vsUsual, d: z.dollars, opp: z.opposed === 'contested' });
    fs.writeFileSync(lf, JSON.stringify(lg, null, 1));
  } catch (e) { console.log('flaglog error', e.message); }
  // SF points (0-45): money tier (max 20) + sizing vs usual (12) + wallet quality (6) + pooled wallets (4) + unopposed (3); contested -8.
  const nBets = r => (String(r || '').match(/\d+/g) || []).reduce((a, b) => a + (+b), 0);
  const sidesMap = {};
  for (const x of tickets) { if (x.dollars < 500) continue; const key = [x.matchup, x.market, x.pick].join('|'); (sidesMap[key] = sidesMap[key] || []).push(x); }
  const sides = [];
  for (const key of Object.keys(sidesMap)) {
    const ts = sidesMap[key]; const total = ts.reduce((n, y) => n + y.dollars, 0); if (total < 1000) continue;
    const mkt = key.split('|').slice(0, 2).join('|');
    const oppT = Object.keys(sidesMap).filter(k2 => k2.startsWith(mkt + '|') && k2 !== key).flatMap(k2 => sidesMap[k2]);
    const opp = oppT.reduce((n, y) => n + y.dollars, 0);
    const maxVs = Math.max(0, ...ts.filter(y => y.dollars >= total * 0.25).map(y => y.vsUsual || 0)); // sizing of the tickets that carry the money
    const wallets = new Set(ts.map(y => y.fp)).size;
    const bestQ = Math.max(0, ...ts.map(y => (y.mktRoi != null && y.mktRoi >= 30 && nBets(y.mktRecord) >= 10) ? 6 : (y.mktRoi != null && y.mktRoi >= 20 && (y.l30Roi || 0) >= 25) ? 4 : 0));
    const money = total >= 30000 ? 20 : total >= 15000 ? 16 : total >= 5000 ? 12 : total >= 2000 ? 8 : 4;
    const sizing = maxVs >= 2.5 ? 12 : maxVs >= 2 ? 10 : maxVs >= 1.5 ? 7 : maxVs > 1 ? 4 : 0;
    const contested = opp >= total * 0.5;
    const pts = Math.max(0, Math.min(45, money + sizing + bestQ + (wallets >= 2 ? 4 : 0) + (opp === 0 ? 3 : 0) - (contested ? 8 : 0)));
    const top = ts.slice().sort((a, b) => b.dollars - a.dollars)[0];
    // Good tail (star): real money, other side small, above-usual size or a proven wallet, price you can still take, not a thin/steep line.
    const am = parseInt(String(top.price || '').replace('+', ''), 10);
    const priceOk = !isNaN(am) && am >= -190 && am <= 300;
    const tail = pts >= 26 && total >= 5000 && opp < total * 0.25 && (maxVs >= 1.5 || bestQ >= 4) && priceOk;
    sides.push({ tail, sport: top.sport, matchup: top.matchup, market: top.market, pick: top.pick, kickoffEt: top.kickoffEt, dollars: total, oppDollars: opp, wallets, maxVsUsual: maxVs,
      price: top.price, size: top.size, mktRecord: top.mktRecord, mktRoi: top.mktRoi, l30Roi: top.l30Roi, contested, sfPoints: pts, parts: { money, sizing, quality: bestQ, pooled: wallets >= 2 ? 4 : 0, unopposed: opp === 0 ? 3 : 0, contested: contested ? -8 : 0 } });
  }
  sides.sort((a, b) => b.sfPoints - a.sfPoints || b.dollars - a.dollars);
  fs.writeFileSync(path.join(OUT, 'flags.json'), JSON.stringify({ date, scannedAt: payload.scannedAt, sides, flags, sizedUp }, null, 1));
  console.log('logged', date, 'tickets', tickets.length, 'plays', plays.length, 'snapshots', day.snapshots.length);
})();
