// Wallet names (Derek, Nov 23 2026): Sharp Flow rows carry only the last 6 characters of a Polymarket address ("wid").
// The Sharp Flow site publishes whale_profiles.json (address -> public Polymarket name) and sharp_positions.json (positions with names).
// Writes wallet_names.json {wid: name}; a suffix shared by two different wallets is dropped (ambiguous). Best effort - cards fall back to the letter + id.
const fs = require('fs');
const OUT = process.argv[2] || 'wallet_names.json';
const get = async u => { const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); };
(async () => {
  const byAddr = {};
  try { const w = await get('https://nhlsavant.com/whale_profiles.json'); for (const [a, v] of Object.entries(w)) if (v && v.name) byAddr[a.toLowerCase()] = v.name; } catch (e) { console.log('whale_profiles:', e.message); }
  try {
    const p = await get('https://nhlsavant.com/sharp_positions.json');
    for (const sp of Object.values(p)) if (sp && typeof sp === 'object') for (const g of Object.values(sp)) for (const x of (g && g.positions) || []) if (x.wallet && x.name) byAddr[x.wallet.toLowerCase()] = x.name;
  } catch (e) { console.log('sharp_positions:', e.message); }
  const bySuf = {}, dup = new Set();
  for (const [a, n] of Object.entries(byAddr)) { const s = a.slice(-6); if (bySuf[s] && bySuf[s] !== n) dup.add(s); bySuf[s] = n; }
  dup.forEach(s => delete bySuf[s]);
  // keep the last good file if this fetch came back empty
  if (!Object.keys(bySuf).length) { console.log('wallet names: nothing fetched, keeping existing file'); return; }
  fs.writeFileSync(OUT, JSON.stringify(bySuf));
  console.log('wallet names:', Object.keys(bySuf).length, 'ids,', dup.size, 'ambiguous dropped');
})();
