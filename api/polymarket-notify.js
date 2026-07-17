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

const VERCEL_URL = 'https://sharp-indicator-a34j.vercel.app';

async function sendAlert(topic, buy) {
  const usd = Math.round(buy.usdValue).toLocaleString();
  const price = (buy.price * 100).toFixed(1);
  const body =
    `💰 $${usd} BUY — ${buy.traderName}\n` +
    `Market: ${buy.title || 'Unknown'}\n` +
    `Outcome: ${buy.outcome} @ ${price}¢\n` +
    `${buy.eventSlug ? 'polymarket.com/event/' + buy.eventSlug : ''}`;

  // Log to alert history
  try {
    await fetch(`${VERCEL_URL}/api/polymarket-alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buy),
    });
  } catch (e) { console.error('alert log error:', e.message); }

  // Send ntfy push
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body });
    return true;
  } catch { return false; }
}
