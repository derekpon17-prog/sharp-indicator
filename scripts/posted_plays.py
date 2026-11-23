#!/usr/bin/env python3
"""Today's posted PLAY rows, rebuilt with the slate rules (tier.py on the outbox branch) from every slate/late card already sent.
Usage: posted_plays.py <outbox_clone_dir> <YYYY-MM-DD> <out.json>
Display only: sharpflow_alerts.js uses this to say when new wallet money is AGAINST (or WITH) a play we already posted."""
import sys, os, json, glob
ob, day, out = sys.argv[1], sys.argv[2], sys.argv[3]
res = []
try:
    sys.path.insert(0, os.path.join(ob, ".github", "scripts"))
    from tier import classify
    files = sorted(glob.glob(os.path.join(ob, "sent", day + "-*.json")) + glob.glob(os.path.join(ob, "outbox", day + "-*.json")))
    seen = set()
    for f in files:
        try:
            card = json.load(open(f))
        except Exception:
            continue
        sl = card.get("slate")
        if not sl or not sl.get("rows"):
            continue
        hhmm = os.path.basename(f)[len(day) + 1:len(day) + 5]
        label = ""
        if hhmm.isdigit():
            h, m = int(hhmm[:2]), hhmm[2:]
            label = f"{(h % 12) or 12}:{m}{'pm' if h >= 12 else 'am'}"
        for r in classify(sl["rows"], sl.get("sf_current", True))["plays"]:
            k = (r.get("game"), r.get("bet"))
            if k in seen:
                continue
            seen.add(k)
            res.append({"game": r.get("game"), "sport": r.get("sport"), "market": r.get("market"), "side": r.get("side"),
                        "bet": r.get("bet"), "matchup": r.get("matchup"), "card": label})
except Exception as e:
    print("posted_plays: skipped -", e)
json.dump(res, open(out, "w"))
print("posted_plays:", len(res), "posted PLAY rows for", day)
