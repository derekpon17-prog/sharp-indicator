/* =========================================================
   api/trader-records.js
   Upstash Redis — same KV_REST_API_URL / KV_REST_API_TOKEN as everything else.

   PURPOSE (per Derek, 2026-08-05): Discord/ntfy showed win rates from Polymarket's own
   specialistRecord field — but that field only exists for wallets Polymarket tags as
   SPECIALIST, and it's null for every whale-type wallet (leaderboard-ranked), even though
   Derek's own Tracking tab has real, graded W-L for those same wallets. The data existed,
   it just lived in the wrong place (browser localStorage) for the server-side cron to
   reach. This endpoint is the bridge: the client pushes its computed by-trader summary
   here after grading, and the cron reads it back when building Discord/ntfy messages —
   Derek's own tracked record becomes the primary source, with Polymarket's stat as a
   fallback only for wallets Derek hasn't graded yet.

   GET  → returns the current stored summary: { records: {wallet: {name,W,L,roiPct,updatedAt}}, configured }
   POST → overwrites the whole summary. The client always computes its full current
          picture from localStorage and sends that whole snapshot — simpler and safer
          than trying to merge partial updates, since the client is the one authoritative
          source for this data (no cross-device merge logic needed here, that's a
          separate, larger piece of work already scoped elsewhere).
   ========================================================= */

const RECORDS_KEY = 'pm:trader-records';

async function upstash(body) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV_NOT_CONFIGURED');
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) {
    if (req.method === 'GET') return res.status(200).json({ records: {}, configured: false });
    return res.status(200).json({ ok: false, error: 'KV not configured' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await upstash(['GET', RECORDS_KEY]);
      let records = {};
      if (raw) { try { records = JSON.parse(raw); } catch {} }
      return res.status(200).json({ records, configured: true });
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.records) {
        return res.status(400).json({ error: 'Expected { records: {...} }' });
      }
      // Basic shape guard — only keep entries that look like real trader records, so a
      // malformed client payload can't corrupt what the cron reads back.
      const clean = {};
      for (const wallet in body.records) {
        const r = body.records[wallet];
        if (r && typeof r.W === 'number' && typeof r.L === 'number') {
          clean[wallet] = {
            name: typeof r.name === 'string' ? r.name : wallet,
            W: r.W, L: r.L,
            roiPct: typeof r.roiPct === 'number' ? r.roiPct : null,
            updatedAt: Date.now(),
          };
        }
      }
      await upstash(['SET', RECORDS_KEY, JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, stored: Object.keys(clean).length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err.message === 'KV_NOT_CONFIGURED') {
      if (req.method === 'GET') return res.status(200).json({ records: {}, configured: false });
      return res.status(200).json({ ok: false, error: 'KV not configured' });
    }
    console.error('[trader-records]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
