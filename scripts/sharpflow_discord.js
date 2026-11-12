/* Posts the SharpFlow strong-vs-weak list to Discord (Sharp Signals channel) from flags.json. No Claude.
   Runs on Mon, Thu, Sat, Sun (Central) at the 11am and 4pm CT snapshots. FORCE=1 posts anyway (test). */
const fs = require('fs');
const OUT = process.env.OUT_DIR || 'sf_branch';
const HOOK = process.env.HOOK_SIGNALS;
const force = process.env.FORCE === '1';
const now = new Date();
const ct = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
const dow = ct.find(p => p.type === 'weekday').value, hr = +ct.find(p => p.type === 'hour').value % 24;
if (!force && (!['Mon', 'Thu', 'Sat', 'Sun'].includes(dow) || ![11, 16].includes(hr))) { console.log('not a post slot', dow, hr); process.exit(0); }
if (!HOOK) { console.log('no webhook secret DISCORD_SIGNALS'); process.exit(0); }
let f; try { f = JSON.parse(fs.readFileSync(OUT + '/flags.json', 'utf8')); } catch (e) { console.log('no flags.json'); process.exit(0); }
const ageMin = (now - new Date(f.scannedAt)) / 60000;
if (ageMin > 180) { console.log('snapshot stale', ageMin); process.exit(0); }
const etOffset = (() => { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).format(now); const m = s.match(/GMT([+-]\d+)/); return m ? -parseInt(m[1], 10) : 5; })();
function startUtc(k) { // "Thu, Nov 12, 8:10 PM" (ET)
  const m = (k || '').match(/(\w+), (\w+) (\d+), (\d+):(\d+) (AM|PM)/); if (!m) return null;
  let h = +m[4] % 12 + (m[6] === 'PM' ? 12 : 0);
  const d = new Date(`${m[2]} ${m[3]}, ${now.getUTCFullYear()} ${h}:${m[5]}:00 UTC`);
  return new Date(d.getTime() + etOffset * 3600000);
}
const dayOf = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const ctStr = d => d ? ((dayOf(d) !== dayOf(now) ? d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short' }) + ' ' : '') + d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()) : 'time n/a';
const k = n => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : '$' + n;
const live = f.flags.map(x => ({ ...x, st: startUtc(x.kickoffEt) })).filter(x => !x.st || x.st > now);
const line = x => `**${x.pick}** ${x.market === 'ML' ? 'ML' : x.market} - ${x.matchup} ${ctStr(x.st)} CT - ${k(x.strongDollars)} strong` + (x.oppDollars ? ` vs ${k(x.oppDollars)} opp` + (x.oppWeakDollars ? ' (weak)' : '') : '');
const sw = live.filter(x => x.type === 'STRONG_VS_WEAK');
const un = live.filter(x => x.type === 'STRONG_UNOPPOSED').slice(0, 10);
const ss = live.filter(x => x.type === 'STRONG_VS_STRONG').slice(0, 4);
if (!sw.length && !un.length) { console.log('nothing to post'); process.exit(0); }
const fields = [];
if (sw.length) fields.push({ name: 'Strong vs weak', value: sw.map(line).join('\n').slice(0, 1000) });
if (un.length) fields.push({ name: 'Strong, unopposed', value: un.map(line).join('\n').slice(0, 1000) });
if (ss.length) fields.push({ name: 'Good wallets on both sides (no play)', value: ss.map(line).join('\n').slice(0, 1000) });
const snapCt = new Date(f.scannedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
const payload = { content: `**SharpFlow flags** - ${dow} ${snapCt} CT snapshot`, embeds: [{ title: 'SharpFlow strong vs weak', color: 3447003, fields,
  description: 'Strong = wallet with 30-day ROI 25%+ and market ROI 20%+, $1K+. Weak = colder wallet inside SharpFlow\'s sharp pool (not true losers). Pinnacle and Vegas alignment is added in the hourly run logs. Tracking only, not a recommendation.',
  footer: { text: 'Source: SharpFlow (NHL Savant), self-reported. Games already started are hidden.' } }] };
fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  .then(r => console.log('discord', r.status)).catch(e => console.log('discord error', e.message));
