"""Post each outbox/*.json card to Discord, then move it to sent/.

Two card formats:
  Text:   {"parts": ["<prefix> ...", "..."]}  - 1 to 6 plain-text messages.
  Embeds: {"route": "<prefix>", "content": "optional header line",
           "embeds": [ {Discord embed}, ... ]} - posted 10 embeds per message.
The prefix picks the channel:
  "NFL Props"     -> secret DISCORD_NFLPROPS
  "Sharp Signals" -> secret DISCORD_SIGNALS
Exits 1 if any card fails (the file stays in outbox/ and GitHub marks the run failed)."""
import glob, json, os, shutil, sys, time, urllib.request, urllib.error

ROUTES = {"NFL Props": "HOOK", "Sharp Signals": "HOOK_SIGNALS"}

def post(hook, payload):
    payload = dict(payload, allowed_mentions={"parse": []})
    body = json.dumps(payload).encode()
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
            detail = e.read()[:300].decode("utf-8", "replace")
            raise RuntimeError(f"Discord returned {e.code}: {detail}")
    raise RuntimeError("Discord rate limit")

def clean_embed(e):
    if not isinstance(e, dict):
        raise ValueError("each embed must be an object")
    e = dict(e)
    if "title" in e: e["title"] = str(e["title"])[:256]
    if "description" in e: e["description"] = str(e["description"])[:4096]
    fields = e.get("fields") or []
    if len(fields) > 25:
        raise ValueError("an embed can have at most 25 fields")
    e["fields"] = [{"name": str(f.get("name") or "-")[:256], "value": str(f.get("value") or "-")[:1024],
                    "inline": bool(f.get("inline", False))} for f in fields]
    if "footer" in e and isinstance(e["footer"], dict):
        e["footer"] = {"text": str(e["footer"].get("text", ""))[:2048]}
    return e

def embed_size(e):
    n = len(e.get("title", "")) + len(e.get("description", "")) + len((e.get("footer") or {}).get("text", ""))
    return n + sum(len(f["name"]) + len(f["value"]) for f in e["fields"])

failed = 0
os.makedirs("sent", exist_ok=True)
for path in sorted(glob.glob("outbox/*.json")):
    name = os.path.basename(path)
    try:
        card = json.load(open(path))
        embeds = card.get("embeds")
        parts = card.get("parts")
        if embeds is not None:
            if not isinstance(embeds, list) or not 1 <= len(embeds) <= 30:
                raise ValueError("embeds must be a list of 1-30 embeds")
            route = str(card.get("route", ""))
        else:
            if not isinstance(parts, list) or not 1 <= len(parts) <= 6 or not all(isinstance(p, str) and p.strip() for p in parts):
                raise ValueError("parts must be a list of 1-6 non-empty strings")
            route = parts[0].lstrip()
        prefix = next((k for k in ROUTES if route.startswith(k)), None)
        if not prefix:
            raise ValueError("card must route to one of: " + ", ".join(ROUTES))
        hook = os.environ.get(ROUTES[prefix], "").strip()
        if not hook:
            raise ValueError(f"no webhook secret set for {prefix} cards")
        if embeds is not None:
            embeds = [clean_embed(e) for e in embeds]
            batch, size, first = [], 0, True
            def flush(batch, first):
                payload = {"embeds": batch}
                if first and card.get("content"):
                    payload["content"] = str(card["content"])[:1990]
                post(hook, payload)
                time.sleep(1)
            for e in embeds:
                s = embed_size(e)
                if batch and (len(batch) == 10 or size + s > 5800):
                    flush(batch, first); first = False; batch, size = [], 0
                batch.append(e); size += s
            if batch:
                flush(batch, first)
            print(f"posted {name} ({len(embeds)} embeds)")
        else:
            for p in parts:
                post(hook, {"content": p.strip()[:1990]})
                time.sleep(1)
            print(f"posted {name} ({len(parts)} parts)")
        shutil.move(path, os.path.join("sent", name))
    except Exception as e:
        failed += 1
        print(f"FAILED {name}: {e}")
sys.exit(1 if failed else 0)
