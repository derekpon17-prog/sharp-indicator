/* Posts SharpFlow sides to Discord in the new format, with the wallet-profile and
   hot_vs_slipping check annotations (council recs #1-#2, Nov 18) when flags.json carries
   a `checks` field on a side. GH Actions can't call the MCP tools that produce `checks`
   (authenticated connector, session-only), so this script never computes them - it only
   renders whatever a Claude puller run already wrote onto the side. Sides with no `checks`
   field post in the old plain format, no verdict line. No Claude usage, no MCP calls. */
const fs = require('fs');
const OUT = process.env.OUT_DIR || 'sf_branch';
const HOOK = process.env.HOOK_SIGNALS;
const force = process.env.FORCE === '1';
if (!HOOK) { console.log('no webhook secret DISCORD_SIGNALS'); process.exit(0); }
let f; try { f = JSON.parse(fs.readFileSync(OUT + '/flags.json', 'utf8')); } catch (e) { console.log('no flags.json'); process.exit(0); }
const now = new Date();
const ageMin = (now - new Date(f.scannedAt)) / 60000;
if (!force && ageMin > 180) { console.log('snapshot stale', ageMin); process.exit(0); }

const k = n => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : '$' + n;
const ctStr = k2 => k2 || 'time n/a';

const sides = (f.sides || []).slice().sort((a, b) => b.sfPoints - a.sfPoints);
const checked = sides.filter(s => s.checks);
const unchecked = sides.filter(s => !s.checks).slice(0, 8);

function checkedBlock(s) {
  const c = s.checks;
  const head = `**${s.pick}** ${s.market} ${s.price || ''} - ${s.matchup} ${ctStr(s.kickoffEt)} - ${k(s.dollars)}, ${s.wallets} wallet(s), sfPoints ${s.sfPoints}`;
  const wc = `Wallet check (..${c.walletId}): ${c.walletCheck.text}`;
  const mc = `Momentum check: ${c.momentumCheck.text}`;
  const verdict = (c.walletCheck.pass && c.momentumCheck.pass)
    ? '**Verdict: clear - no sizing or cooling flag**'
    : '**Verdict: CAUTION - hold for review, see flag above**';
  return [head, wc, mc, verdict].join('\n');
}
function plainLine(s) {
  return `**${s.pick}** ${s.market} ${s.price || ''} - ${s.matchup} ${ctStr(s.kickoffEt)} - ${k(s.dollars)}, ${s.wallets} wallet(s), sfPoints ${s.sfPoints}`;
}

const fields = [];
if (checked.length) fields.push({ name: 'Checked (wallet-profile + hot/slipping, new Nov 18)', value: checked.map(checkedBlock).join('\n\n').slice(0, 1020) });
if (unchecked.length) fields.push({ name: 'Not yet checked (top sides by sfPoints)', value: unchecked.map(plainLine).join('\n').slice(0, 1020) });
if (!fields.length) { console.log('nothing to post'); process.exit(0); }

const snapCt = new Date(f.scannedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
const payload = { content: `**SharpFlow sides - v2 format test** - ${snapCt} CT snapshot`, embeds: [{
  title: 'SharpFlow sharp money (checked)', color: 15844367, fields,
  description: 'New: top sides get a wallet-profile size-bucket check and a hot_vs_slipping momentum check before the verdict. No thresholds changed - this only adds a pass/fail annotation and a hold-for-review path when a check fails. Tracking only, not a recommendation.',
  footer: { text: 'Source: SharpFlow (NHL Savant) via MCP puller. Games already started are hidden by the normal pipeline, not filtered here in this manual test.' } }] };
fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  .then(r => console.log('discord v2', r.status))
  .catch(e => console.log('discord v2 error', e.message));
