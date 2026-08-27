/* TEMP DIAGNOSTIC 2026-08-27 (per Derek): pulls one real recent day of Novig's free,
   public, no-auth data (data.novig.com) and summarizes it -- meant to actually show real
   data rather than just describe documentation. Not wired into anything, not a committed
   build, safe to delete once reviewed. */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const idxRes = await fetch('https://data.novig.com/reporting/trade-data/index.json');
    const idx = await idxRes.json();
    const dates = idx.dates || [];
    const marketDates = idx.marketDates || [];
    const latestTradeDate = dates[dates.length - 1];
    const latestMarketDate = marketDates[marketDates.length - 1];

    const out = { availableDateRange: { trades: [dates[0], latestTradeDate], markets: [marketDates[0], latestMarketDate] } };

    // Markets file for the latest available day
    if (latestMarketDate) {
      const mRes = await fetch(`https://data.novig.com/reporting/trade-data/${latestMarketDate}/markets.csv`);
      const mText = await mRes.text();
      const mLines = mText.trim().split('\n');
      const mHeader = mLines[0].split(',');
      const mRows = mLines.slice(1).map(l => {
        const vals = l.split(',');
        const row = {};
        mHeader.forEach((h, i) => row[h] = vals[i]);
        return row;
      });
      const sportsRows = mRows.filter(r => /^(MLB|NFL|NCAAF|NBA|NHL)-/.test(r.reportTicker || ''));
      const byLeague = {};
      sportsRows.forEach(r => {
        const league = (r.reportTicker || '').split('-')[0];
        byLeague[league] = (byLeague[league] || 0) + 1;
      });
      out.marketsFile = {
        date: latestMarketDate,
        totalMarketsListed: mRows.length,
        sportsMarketsListed: sportsRows.length,
        byLeague,
        sampleRows: sportsRows.slice(0, 5),
        mostVolumeToday: sportsRows
          .filter(r => parseFloat(r.dailyVolume) > 0)
          .sort((a, b) => parseFloat(b.dailyVolume) - parseFloat(a.dailyVolume))
          .slice(0, 5),
      };
    }

    // Trades file for the latest available day -- summarize, don't dump (could be large)
    if (latestTradeDate) {
      const tRes = await fetch(`https://data.novig.com/reporting/trade-data/${latestTradeDate}/trades.csv`);
      const tText = await tRes.text();
      const tLines = tText.trim().split('\n');
      const tHeader = tLines[0].split(',');
      const takerRows = [];
      for (let i = 1; i < tLines.length; i++) {
        const vals = tLines[i].split(',');
        const row = {};
        tHeader.forEach((h, j) => row[h] = vals[j]);
        if (row.side === 'TAKER' && /^(MLB|NFL|NCAAF|NBA|NHL)$/.test(row.league || '')) takerRows.push(row);
      }
      const byLeagueTrades = {};
      takerRows.forEach(r => { byLeagueTrades[r.league] = (byLeagueTrades[r.league] || 0) + 1; });
      out.tradesFile = {
        date: latestTradeDate,
        totalRowsInFile: tLines.length - 1,
        sportsTakerTrades: takerRows.length,
        byLeagueTradeCounts: byLeagueTrades,
        sampleRows: takerRows.slice(0, 5),
      };
    }

    return res.status(200).json(out);
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
};
