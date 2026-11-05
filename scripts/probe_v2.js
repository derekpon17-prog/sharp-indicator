/* One-off probe of Polymarket Data API v2: saves trimmed real responses so the collector can be ported. */
const fs = require('fs');
const B = 'https://data-api.polymarket.com/v2';
const out = {};
async function g(name, url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    const t = await r.text();
    out[name] = { url, status: r.status, body: t.slice(0, 2500) };
    try { return JSON.parse(t); } catch { return null; }
  } catch (e) { out[name] = { url, error: e.message }; return null; }
}
(async () => {
  const spec = await g('openapi', 'https://data-api.polymarket.com/v2/openapi.json');
  if (spec && spec.paths) {
    out.paths = Object.keys(spec.paths);
    for (const p of ['/v2/leaderboard', '/v2/positions', '/v2/trades']) {
      const op = spec.paths[p] && spec.paths[p].get;
      if (op) out['params ' + p] = (op.parameters || []).map(x => `${x.name}${x.required ? '*' : ''}: ${JSON.stringify(x.schema || {}).slice(0, 140)} ${String(x.description || '').slice(0, 110)}`);
    }
    const sc = (spec.components && spec.components.schemas) || {};
    for (const n of ['Position', 'UserStats', 'LeaderboardUserEntry']) if (sc[n]) out['schema ' + n] = Object.entries(sc[n].properties || {}).map(([k, v]) => `${k}: ${String(v.description || '').slice(0, 130)}`);
  }
  const lb = await g('leaderboard_sports', `${B}/leaderboard?category=SPORTS&limit=5`);
  const lb2 = await g('leaderboard_params2', `${B}/leaderboard?category=SPORTS&time_period=ALL&order_by=PNL&limit=3`);
  await g('trades', `${B}/trades?limit=3`);
  const rows = (lb && (lb.data || lb)) || [];
  const w = rows[0] && (rows[0].user_id || rows[0].proxy_wallet || rows[0].user || rows[0].address);
  out.walletUsed = w || null;
  if (w) {
    await g('closed_positions', `${B}/positions?user=${w}&status=CLOSED&limit=3&sort_by=TIMESTAMP`);
    await g('user_stats', `${B}/user-stats?user=${w}`);
  }
  fs.mkdirSync('wallets', { recursive: true });
  fs.writeFileSync('wallets/probe.json', JSON.stringify(out, null, 1));
  console.log('probe done', Object.keys(out).join(','));
})();
