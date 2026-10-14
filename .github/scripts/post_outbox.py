"""Post each outbox/*.json card to Discord, then move it to sent/.
Card format: {"parts": ["NFL Props ...", "..."]} - 1 to 6 parts, first starts with "NFL Props".
Exits 1 if any card fails (the file stays in outbox/ and GitHub marks the run failed)."""
import glob, json, os, shutil, sys, time, urllib.request, urllib.error

hook = os.environ.get("HOOK", "").strip()
if not hook:
    sys.exit("DISCORD_NFLPROPS secret is not set")

def post(text):
    body = json.dumps({"content": text, "allowed_mentions": {"parse": []}}).encode()
    for attempt in range(3):
        req = urllib.request.Request(hook, data=body, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "discord-outbox"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                wait = float(json.loads(e.read() or b"{}").get("retry_after", 2))
                time.sleep(min(wait, 10))
                continue
            raise RuntimeError(f"Discord returned {e.code}")
    raise RuntimeError("Discord rate limit")

failed = 0
os.makedirs("sent", exist_ok=True)
for path in sorted(glob.glob("outbox/*.json")):
    name = os.path.basename(path)
    try:
        parts = json.load(open(path)).get("parts")
        if not isinstance(parts, list) or not 1 <= len(parts) <= 6 or not all(isinstance(p, str) and p.strip() for p in parts):
            raise ValueError("parts must be a list of 1-6 non-empty strings")
        if not parts[0].lstrip().startswith("NFL Props"):
            raise ValueError('first part must start with "NFL Props"')
        for p in parts:
            post(p.strip()[:1990])
            time.sleep(1)
        shutil.move(path, os.path.join("sent", name))
        print(f"posted {name} ({len(parts)} parts)")
    except Exception as e:
        failed += 1
        print(f"FAILED {name}: {e}")
sys.exit(1 if failed else 0)
