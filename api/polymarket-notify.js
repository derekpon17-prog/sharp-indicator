/* ═══════════════════════════════════════════════════════════
   api/polymarket-notify.js
   Cron-triggered smart money alert endpoint.

   VERCEL ENV VARS REQUIRED:
     NTFY_TOPIC      — your ntfy topic (e.g. sharpidx-derek-2026)
     PM_THRESHOLD    — min buy in USD (default 5000)
     PM_CATEGORY     — all | OVERALL | SPORTS (default all)

   CRON SETUP (cron-job.org):
     URL:      https://sharp-indicator-a34j.vercel.app/api/polymarket-notify
     Schedule: every 15 minutes
     Method:   GET

   HOW DEDUP WORKS (no database needed):
   Only alerts trades timestamped in [now-900s, now-30s].
   15-min cron interval means each trade falls in exactly
   one window. 30s buffer lets trades fully confirm on-chain.

   SPORTS FILTER:
   Only fires for NBA, WNBA, MLB, NFL, NHL, college football,
   college basketball. All other markets are ignored.
═══════════════════════════════════════════════════════════ */

const DATA_API  = 'https://data-api.polymarket.com';
const VERCEL_URL = 'https://sharp-indicator-a34j.vercel.app';
const LB_SIZE   = 20;

/* ── Leaderboard fetch ── */
async function fetchLeaderboard(category) {
  try {
    const r = await fetch(
      `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${LB_SIZE}`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/* ── Recent buys for one wallet ── */
async function fetchWalletBuys(wallet) {
  try {
    const r = await fetch(
      `${DATA_API}/trades?user=${wallet}&side=BUY&takerOnly=true&limit=20`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/* ── Sports filter — only these markets trigger alerts ── */
const SPORT_KEYWORDS = [
  'nba','wnba','mlb','nfl','nhl',
  'ncaa','college football','college basketball',
  'basketball','baseball','football','hockey',
  'nba finals','world series','super bowl',
  'stanley cup','march madness','cfp','championship',
  'playoffs','world cup',
];
function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return SPORT_KEYWORDS.some(k => t.includes(k));
}

/* ── Send ntfy push + log to alert history ── */
async function sendAlert(topic, buy) {
  const usd   = Math.round(buy.usdValue).toLocaleString();
  const price = (parseFloat(buy.price || 0) * 100).toFixed(1);
  const body  =
    `💰 $${usd} BUY — ${buy.traderName}\n` +
    `Market: ${buy.title || 'Unknown'}\n` +
    `Outcome: ${buy.outcome || '—'} @ ${price}¢\n` +
    `${buy.eventSlug ? 'polymarket.com/event/' + buy.eventSlug : ''}`;

  // 1. Log to alert history endpoint (so site can show what fired overnight)
  try {
    await fetch(`${VERCEL_URL}/api/polymarket-alerts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(buy),
    });
  } catch (e) { console.error('alert log error:', e.message); }

  // 2. Push to phone via ntfy (server-side — no mode:no-cors needed here)
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method:  'POST',
      headers: {
        'Title':        `💰 $${usd} Smart Money Buy`,
        'Priority':     buy.usdValue >= 10000 ? 'urgent' : 'high',
        'Tags':         'money_bag,chart_with_upwards_trend',
        'Content-Type': 'text/plain',
      },
      body,
    });
    return true;
  } catch { return false; }
}

/* ── Main handler ── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const topic     = process.env.NTFY_TOPIC;
  const threshold = parseInt(process.env.PM_THRESHOLD || '5000');
  const category  = (process.env.PM_CATEGORY || 'all').toUpperCase();

  if (!topic) {
    return res.status(200).json({
      ok: false,
      message: 'NTFY_TOPIC not set in Vercel environment variables',
    });
  }

  // 15-minute dedup window (matches cron interval)
  const now    = Math.floor(Date.now() / 1000);
  const winMin = now - 900; // 15 min ago
  const winMax = now - 30;  // 30 sec buffer

  try {
    // Pull both leaderboards in parallel
    const [overallLB, sportsLB] = await Promise.all([
      fetchLeaderboard('OVERALL'),
      fetchLeaderboard('SPORTS'),
    ]);

    // Merge + dedupe wallets, tag which leaderboard(s) they appear on
    const walletMap = {};
    overallLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] || {
        wallet: t.proxyWallet,
        name: t.userName || t.pseudonym,
        categories: [],
      };
      walletMap[t.proxyWallet].categories.push({ cat: 'OVERALL', rank: t.rank });
    });
    sportsLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] || {
        wallet: t.proxyWallet,
        name: t.userName || t.pseudonym,
        categories: [],
      };
      walletMap[t.proxyWallet].categories.push({ cat: 'SPORTS', rank: t.rank });
    });

    // Apply category filter
    const wallets = Object.values(walletMap).filter(w => {
      if (category === 'ALL') return true;
      return w.categories.some(c => c.cat === category);
    });

    // Fetch buys for all wallets in parallel
    const results = await Promise.all(wallets.map(w => fetchWalletBuys(w.wallet)));

    // Build alert list — filter by window, threshold, and sports
    const toAlert = [];
    wallets.forEach((w, i) => {
      (results[i] || []).forEach(t => {
        const ts  = parseInt(t.timestamp) || 0;
        const usd = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);

        if (ts < winMin || ts > winMax) return;  // outside 15-min window
        if (usd < threshold)            return;  // below dollar threshold
        if (!isSportsMarket(t.title))   return;  // not a sports market

        toAlert.push({
          wallet:          w.wallet,
          traderName:      t.name || t.pseudonym || w.name || w.wallet.slice(0, 8),
          categories:      w.categories,
          title:           t.title,
          slug:            t.slug,
          eventSlug:       t.eventSlug,
          outcome:         t.outcome,
          price:           t.price,
          usdValue:        usd,
          timestamp:       ts,
          transactionHash: t.transactionHash,
        });
      });
    });

    // Sort biggest buys first
    toAlert.sort((a, b) => b.usdValue - a.usdValue);

    // Fire alerts
    let sent = 0;
    for (const buy of toAlert) {
      const ok = await sendAlert(topic, buy);
      if (ok) sent++;
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      ok:              true,
      walletsChecked:  wallets.length,
      buysInWindow:    toAlert.length,
      alertsSent:      sent,
      threshold,
      category,
      window: {
        from: new Date(winMin * 1000).toISOString(),
        to:   new Date(winMax * 1000).toISOString(),
      },
    });

  } catch (err) {
    console.error('polymarket-notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
