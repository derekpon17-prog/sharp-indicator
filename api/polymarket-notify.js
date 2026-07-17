/* ═══════════════════════════════════════════════════════════
   api/polymarket-notify.js
   Cron-triggered smart money alert endpoint.

   SETUP:
   1. Add to Vercel env vars:
      NTFY_TOPIC      = your ntfy topic (e.g. sharpidx-derek-kc2026)
      PM_THRESHOLD    = min buy in USD (e.g. 5000)
      PM_CATEGORY     = all | OVERALL | SPORTS (default: all)

   2. Deploy, then go to cron-job.org → New cron job:
      URL: https://sharp-indicator-a34j.vercel.app/api/polymarket-notify
      Schedule: every 5 minutes
      Method: GET

   DEDUP LOGIC (no database needed):
   Only alert trades timestamped in the window:
     [now - 300s, now - 30s]   (1-5 minutes ago)
   A 5-min cron interval means each trade falls in exactly
   one window. The 30s buffer lets trades fully confirm.
═══════════════════════════════════════════════════════════ */

const DATA_API = 'https://data-api.polymarket.com';
const LEADERBOARD_SIZE = 20;

async function fetchLeaderboard(category) {
  try {
    const r = await fetch(
      `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=ALL&orderBy=PNL&limit=${LEADERBOARD_SIZE}`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

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

async function sendAlert(topic, buy) {
  const usd = Math.round(buy.usdValue).toLocaleString();
  const price = (buy.price * 100).toFixed(1);
  const body =
    `💰 $${usd} BUY — ${buy.traderName}\n` +
    `Market: ${buy.title || 'Unknown'}\n` +
    `Outcome: ${buy.outcome} @ ${price}¢\n` +
    `${buy.eventSlug ? 'polymarket.com/event/' + buy.eventSlug : ''}`;

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      mode: 'no-cors',
      body,
    });
    return true;
  } catch { return false; }
}


/* ── Sports filter — only alert on these markets ── */
const ALLOWED_SPORTS = [
  'nba','wnba','mlb','nfl','nhl',
  'ncaa','college football','college basketball',
  'basketball','baseball','football','hockey',
  // Common Polymarket title patterns
  'nba finals','world series','super bowl','stanley cup',
  'march madness','cfp','championship',
];

function isSportsMarket(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return ALLOWED_SPORTS.some(s => t.includes(s));
}

module.exports = async function handler(req, res) {
  // Validate cron secret if set (optional but recommended)
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const topic     = process.env.NTFY_TOPIC;
  const threshold = parseInt(process.env.PM_THRESHOLD || '5000');
  const category  = (process.env.PM_CATEGORY || 'all').toUpperCase();

  if (!topic) {
    return res.status(200).json({
      ok: false,
      message: 'NTFY_TOPIC not set — add it in Vercel environment variables',
    });
  }

  const now     = Math.floor(Date.now() / 1000);
  const winMin  = now - 900; // 15 minutes ago (matches cron interval)
  const winMax  = now - 30;  // 30 sec buffer for confirmation

  try {
    // ── Pull both leaderboards in parallel ──
    const [overallLB, sportsLB] = await Promise.all([
      fetchLeaderboard('OVERALL'),
      fetchLeaderboard('SPORTS'),
    ]);

    // Merge + dedupe wallets
    const walletMap = {};
    overallLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] ||
        { wallet: t.proxyWallet, name: t.userName || t.pseudonym, categories: [] };
      walletMap[t.proxyWallet].categories.push({ cat: 'OVERALL', rank: t.rank, pnl: t.pnl });
    });
    sportsLB.forEach(t => {
      walletMap[t.proxyWallet] = walletMap[t.proxyWallet] ||
        { wallet: t.proxyWallet, name: t.userName || t.pseudonym, categories: [] };
      walletMap[t.proxyWallet].categories.push({ cat: 'SPORTS', rank: t.rank, pnl: t.pnl });
    });

    const wallets = Object.values(walletMap).filter(w => {
      if (category === 'ALL') return true;
      return w.categories.some(c => c.cat === category);
    });

    // ── Fetch recent buys for all wallets in parallel ──
    const results = await Promise.all(wallets.map(w => fetchWalletBuys(w.wallet)));

    // ── Filter to this cron window + threshold ──
    const toAlert = [];
    wallets.forEach((w, i) => {
      (results[i] || []).forEach(t => {
        const ts  = parseInt(t.timestamp) || 0;
        const usd = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
        if (ts < winMin || ts > winMax) return; // outside this cron window
        if (usd < threshold) return;             // below dollar threshold
        // Only alert on allowed sports markets
        if (!isSportsMarket(t.title)) return;

        toAlert.push({
          wallet: w.wallet,
          traderName: t.name || t.pseudonym || w.name || w.wallet.slice(0, 8),
          categories: w.categories,
          title: t.title,
          slug: t.slug,
          eventSlug: t.eventSlug,
          outcome: t.outcome,
          price: t.price,
          usdValue: usd,
          timestamp: ts,
          transactionHash: t.transactionHash,
        });
      });
    });

    // Sort by size descending — alert biggest buys first
    toAlert.sort((a, b) => b.usdValue - a.usdValue);

    // ── Fire alerts ──
    let sent = 0;
    for (const buy of toAlert) {
      const ok = await sendAlert(topic, buy);
      if (ok) sent++;
      // Small delay to avoid ntfy rate limiting
      if (toAlert.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      ok: true,
      walletsChecked: wallets.length,
      buysInWindow: toAlert.length,
      alertsSent: sent,
      window: { from: new Date(winMin * 1000).toISOString(), to: new Date(winMax * 1000).toISOString() },
      threshold,
      category,
    });

  } catch (err) {
    console.error('polymarket-notify error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
