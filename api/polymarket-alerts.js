/* ═══════════════════════════════════════════════════
   api/polymarket-alerts.js
   Alert log storage. Called by polymarket-notify.js
   when an alert fires. Site reads from here to show
   history. Stores in memory — survives within warm
   container. Site backs up to localStorage on read.
═══════════════════════════════════════════════════ */

const MAX_ALERTS = 200;
let alertLog = [];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const alerts = Array.isArray(body) ? body : [body];
      alerts.forEach(a => {
        if (a && a.transactionHash) {
          // No dupes
          if (!alertLog.find(x => x.transactionHash === a.transactionHash)) {
            alertLog.unshift({ ...a, loggedAt: Date.now() });
          }
        }
      });
      alertLog = alertLog.slice(0, MAX_ALERTS);
      return res.status(200).json({ ok: true, total: alertLog.length });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message });
    }
  }

  // GET — return log, optionally filtered
  const limit = parseInt(req.query?.limit || '100');
  return res.status(200).json({
    alerts: alertLog.slice(0, limit),
    total: alertLog.length,
    fetchedAt: Date.now(),
  });
};
