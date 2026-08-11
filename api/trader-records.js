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
      // SAFEGUARD 2026-08-11 (per Derek, real incident): a partial/incomplete push
      // briefly overwrote real records — Formal-Cupcake's genuine 12-5 with 0-3,
      // ferrariChampions2026's genuine 45-43 with 0-1 — and Discord alerted on the wrong
      // numbers for real games during that window, before a later full push corrected it.
      // Since this endpoint always does a full-snapshot replace by design (simpler than
      // merging), a client push that fires before all localStorage data has finished
      // loading can silently corrupt good data with an incomplete subset. Guard: read the
      // current stored snapshot first, and for any wallet whose sample count drops
      // drastically, keep the existing larger record instead — a real correction is
      // usually a small adjustment; a wallet dropping from 88 total plays to 3 is almost
      // certainly a partial push, not genuine new data. Increases and small changes still
      // pass through normally.
      const prevRaw = await upstash(['GET', RECORDS_KEY]);
      let prev = {};
      if (prevRaw) { try { prev = JSON.parse(prevRaw); } catch {} }

      const clean = {};
      let suspiciousDrops = 0;
      for (const wallet in body.records) {
        const r = body.records[wallet];
        if (r && typeof r.W === 'number' && typeof r.L === 'number') {
          const newSample = r.W + r.L;
          const oldSample = prev[wallet] ? (prev[wallet].W + prev[wallet].L) : 0;
          if (oldSample >= 10 && newSample < oldSample * 0.5) {
            clean[wallet] = prev[wallet];
            suspiciousDrops++;
            continue;
          }
          clean[wallet] = {
            name: typeof r.name === 'string' ? r.name : wallet,
            W: r.W, L: r.L,
            roiPct: typeof r.roiPct === 'number' ? r.roiPct : null,
            updatedAt: Date.now(),
          };
        }
      }
      await upstash(['SET', RECORDS_KEY, JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, stored: Object.keys(clean).length, suspiciousDropsBlocked: suspiciousDrops });
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
