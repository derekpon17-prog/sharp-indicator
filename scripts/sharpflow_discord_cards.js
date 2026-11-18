/* Posts the pre-rendered SharpFlow checked-play card images (cards/<date>/*.png on the
   sharpflow branch, built by a Claude session's render_cards.js, not by this script) to
   Discord, one message per card, image attached as a real file via multipart form-data -
   not a JSON embed pointing at a URL, since the images have no public host. No Claude
   usage, no MCP calls: this only reads already-committed files and posts them. */
const fs = require('fs');
const path = require('path');
const OUT = process.env.OUT_DIR || 'sf_branch';
const HOOK = process.env.HOOK_SIGNALS;
const DATE = process.env.CARD_DATE || new Date().toISOString().slice(0, 10);
if (!HOOK) { console.log('no webhook secret DISCORD_SIGNALS'); process.exit(0); }
const dir = path.join(OUT, 'cards', DATE);
let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
catch (e) { console.log('no manifest at', dir, e.message); process.exit(0); }
if (!manifest.length) { console.log('manifest empty'); process.exit(0); }

const verdictWord = v => v === 'clear' ? 'Clear' : v === 'caution' ? 'Caution' : 'Context';

async function postOne(m, i) {
  const file = path.join(dir, m.file);
  if (!fs.existsSync(file)) { console.log('missing file', m.file); return; }
  const buf = fs.readFileSync(file);
  const caption = `**${i + 1}/${manifest.length}** - ${m.sport} - ${m.pick} ${m.market} - ${m.matchup} - sfPoints ${m.sfPoints} - ${verdictWord(m.verdict)}`;
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: caption }));
  form.append('files[0]', new Blob([buf], { type: 'image/png' }), m.file);
  const r = await fetch(HOOK, { method: 'POST', body: form });
  console.log(m.file, r.status);
  if (!r.ok) console.log(await r.text());
}

(async () => {
  for (let i = 0; i < manifest.length; i++) {
    await postOne(manifest[i], i);
    await new Promise(res => setTimeout(res, 700)); // stay well under Discord's rate limit
  }
  console.log('posted', manifest.length, 'cards');
})();
