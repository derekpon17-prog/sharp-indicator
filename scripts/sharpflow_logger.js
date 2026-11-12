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

  const tickets = (payload.actionTab || []).map(a => ({
    sport: a.sport, matchup: a.matchup, kickoffEt: a.kickoffEt, market: a.market, pick: a.pick, line: a.line == null ? null : a.line,
    opposed: a.opposed, opposedBy: a.opposedBy, recordOf: a.recordOf, wallet: a.sameNight, dollars: a.dollars, price: a.price,
    size: a.sharp && a.sharp.size, vsUsual: a.sharp && a.sharp.vsUsual, form: a.sharp && a.sharp.form,
    l30Roi: a.sharp && a.sharp.l30 && a.sharp.l30.returnPct, mktRecord: a.sharp && a.sharp.market && a.sharp.market.record,
    mktRoi: a.sharp && a.sharp.market && a.sharp.market.returnPct, lineMove: a.lineMove || null,
    l30Rec: a.sharp && a.sharp.l30 && a.sharp.l30.record, l30Dollars: a.sharp && a.sharp.l30 && a.sharp.l30.dollars,
    mktL30Rec: a.sharp && a.sharp.market && a.sharp.market.l30 && a.sharp.market.l30.record, mktL30Dollars: a.sharp && a.sharp.market && a.sharp.market.l30 && a.sharp.market.l30.dollars,
    fp: [a.sharp && a.sharp.l30 && a.sharp.l30.record, a.sharp && a.sharp.l30 && a.sharp.l30.dollars, a.sharp && a.sharp.market && a.sharp.market.record].join('|'),
  }));
  const plays = (payload.plays || []).map(p => ({
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
  console.log('logged', date, 'tickets', tickets.length, 'plays', plays.length, 'snapshots', day.snapshots.length);
})();
