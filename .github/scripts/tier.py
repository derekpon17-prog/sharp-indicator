"""Sharp Slate tiering. Fixed rules (Derek, Nov 13 2026). Input: ledger-style rows. Output: plays / leans / passes.
Rules are frozen until ~200 graded plays per tier. Never tune from one day."""
import re

PLAY_CAP, LEAN_CAP, PASS_CAP, PER_GAME_PLAYS = 5, 3, 3, 2

def money(n):
    n = float(n or 0)
    return f"${n/1000:.1f}K".replace(".0K", "K") if n >= 1000 else f"${int(n)}"

def price_txt(p):
    return "" if p is None else f"{int(p):+d}"

def units(price, result):
    """Derek's staking: plus odds risk 1u (win = price/100). Minus odds risk |price|/100 to win 1u."""
    if result in ("P", "PUSH", None, ""):
        return 0.0
    p = float(price)
    if result == "W":
        return round(p / 100.0, 2) if p > 0 else 1.0
    return -1.0 if p > 0 else round(-abs(p) / 100.0, 2)

def merge(rows):
    """One record per game+market+side: pin fields from the pin row, SF fields from the SF row, Vegas from either."""
    by = {}
    for r in rows:
        k = (r.get("game"), r.get("market"), r.get("side"))
        m = by.setdefault(k, {})
        for f, v in r.items():
            if f == "buckets":
                m["buckets"] = sorted(set(m.get("buckets", [])) | set(v or []))
            elif v is not None and (f not in m or m[f] in (None, "")):
                m[f] = v
    return list(by.values())

def has_pin(r):
    return r.get("pin_tier") in ("Strong", "Max")

def sf_in(r):
    return float(r.get("sf_dollars") or 0)

def vegas_ok(r):
    return (r.get("vegas_strength") or 0) >= 70

def sf_agrees(r):
    d, o = sf_in(r), float(r.get("sf_opp") or 0)
    return d >= 2000 and o < 0.5 * d

def conflict_row(r, recs):
    """The SharpFlow-side record that opposes this Pinnacle record, if any."""
    if "SF_VS_PIN" not in (r.get("buckets") or []):
        return None
    c = [x for x in recs if x.get("game") == r.get("game") and x.get("market") == r.get("market")
         and x.get("side") != r.get("side") and sf_in(x) > 0]
    return max(c, key=sf_in) if c else {}

def chips(r):
    out = []
    if has_pin(r):
        out.append((f"PIN {r['pin_tier'].upper()} {str(r.get('pin_status') or '').lower()}".strip(),
                    "g" if r.get("pin_status") == "Stable" else "a"))
    else:
        out.append(("PIN no lean", "n"))
    v = r.get("vegas_strength")
    out.append((f"VEGAS {int(v)}", "b") if v and v >= 70 else (f"VEGAS {int(v)} (under 70)", "n") if v else ("VEGAS none", "n"))
    d = sf_in(r)
    if d >= 1000:
        o = float(r.get("sf_opp") or 0)
        out.append((f"WALLETS {money(d)} vs {money(o)}", "a" if o >= 0.5 * d else "g" if has_pin(r) else "b"))
        vs = float(r.get("sf_max_vs_usual") or 0)
        if vs > 1:
            out.append((f"{vs:.1f}x their usual", "a"))
        if (r.get("sf_wallets") or 0) >= 2:
            out.append((f"{int(r['sf_wallets'])} wallets", "b"))
    else:
        out.append(("WALLETS none", "n"))
    return out

def classify(rows, sf_current=True):
    recs = merge(rows)
    if not sf_current:
        for r in recs:
            for f in ("sf_dollars", "sf_opp", "sf_max_vs_usual", "sf_wallets"):
                r.pop(f, None)
            r["buckets"] = [b for b in r.get("buckets", []) if not b.startswith("SF_")]
    plays, passes, leans = [], [], []
    for r in recs:
        if has_pin(r):
            c = conflict_row(r, recs)
            if c is not None:
                o = c or {}
                r["tier"] = "PASS"
                r["why"] = (f"Pinnacle says {r.get('bet')}, but sharp wallets have {money(o.get('sf_dollars') or r.get('sf_opp'))} "
                            f"on {o.get('bet') or 'the other side'}"
                            + (f" at {float(o['sf_max_vs_usual']):.1f}x their usual" if o.get("sf_max_vs_usual") else "") + ". Pass.")
                r["chips"] = chips(r)[:2] + [(f"WALLETS {money(o.get('sf_dollars') or r.get('sf_opp'))} on {o.get('bet') or 'other side'}", "r")]
                passes.append(r)
            elif r.get("pin_status") == "Stable":
                r["agree"] = int(vegas_ok(r)) + int(sf_agrees(r))
                plays.append(r)
    plays.sort(key=lambda r: (0 if r["pin_tier"] == "Max" else 1, -r["agree"], r.get("first_seen") or "99"))
    kept, per = [], {}
    for r in plays:
        if per.get(r["game"], 0) >= PER_GAME_PLAYS:
            continue
        per[r["game"]] = per.get(r["game"], 0) + 1
        kept.append(r)
    plays = kept[:PLAY_CAP]
    for r in plays:
        r["tier"] = "PLAY"
        bits = [f"Pinnacle {r['pin_tier']} and steady"]
        if vegas_ok(r): bits.append(f"Vegas {int(r['vegas_strength'])} agrees")
        if sf_agrees(r): bits.append(f"sharp wallets {money(sf_in(r))} agree")
        r["why"] = ", ".join(bits) + ". Nothing against it."
        r["chips"] = chips(r)
    seen = {r["game"] for r in plays} | {r["game"] for r in passes}
    tails = {}
    for r in recs:
        if has_pin(r) or "SF_VS_PIN" in (r.get("buckets") or []):
            continue
        d, o, vs = sf_in(r), float(r.get("sf_opp") or 0), float(r.get("sf_max_vs_usual") or 0)
        p = r.get("sf_first_price", r.get("price"))
        if d >= 5000 and o < 0.25 * d and vs >= 1.5 and p is not None and -190 <= p <= 300:
            if r["game"] not in tails or d > sf_in(tails[r["game"]]):
                tails[r["game"]] = r
    leans = sorted(tails.values(), key=sf_in, reverse=True)[:LEAN_CAP]
    for r in leans:
        r["tier"] = "LEAN"
        r["star"] = float(r.get("sf_max_vs_usual") or 0) >= 2.0
        r["why"] = ("Real money, little against it, bigger than their usual bet, price still takeable."
                    if r["star"] else "Sharp money is real and mostly unopposed. Sizing under 2x, so no star.")
        r["chips"] = chips(r)
    return {"plays": plays, "leans": leans, "passes": passes[:PASS_CAP], "all": recs}
