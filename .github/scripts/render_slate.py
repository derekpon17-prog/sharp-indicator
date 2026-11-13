"""Render the Sharp Slate plays card and the returns card (PNG). Rules live in tier.py."""
import html, os
from tier import classify, units, price_txt, has_pin

CSS = """*{box-sizing:border-box}body{margin:0;background:#0b0f17;font-family:Inter,'Segoe UI',Helvetica,Arial,sans-serif;color:#e8ecf3;padding:28px;width:1056px}
.card{background:#141a25;border:1px solid #232c3b;border-radius:22px;padding:30px}
.kick{letter-spacing:.2em;font-size:13px;color:#8b95a7;text-transform:uppercase}h1{margin:6px 0 0;font-size:36px}
.top{display:flex;justify-content:space-between;align-items:center}.pill{background:#e6b93a;color:#1a1400;font-weight:700;border-radius:20px;padding:9px 18px;font-size:15px}
.src{font-size:14px;color:#aab3c2;margin-top:10px}
.sec{margin:26px 0 4px;padding:10px 14px;border-radius:12px;font-size:15px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;display:flex;justify-content:space-between}
.sec small{font-weight:600;letter-spacing:.08em;font-size:12px;opacity:.85}
.s-play{background:#0f3a2a;color:#5be3a0;border-left:6px solid #36c77d;font-size:19px}.s-lean{background:#3a2f12;color:#f0c75a;border-left:6px solid #e6b93a}.s-pass{background:#232c3b;color:#aab3c2;border-left:6px solid #5a6578}
.row{display:grid;grid-template-columns:1fr 90px 110px;gap:10px;align-items:center;padding:15px 0;border-top:1px solid #232c3b}
.b{font-size:22px;font-weight:800}.star{color:#ffd23f;font-size:26px;text-shadow:0 0 12px #ffb300;margin-right:4px}.b.st,.b.st .ln{color:#ffd23f;font-weight:900}.b.st{font-size:24px}.b .ln{color:#5be3a0}.lean .b .ln{color:#f0c75a}.pass .b .ln{color:#aab3c2}
.s{font-size:14px;color:#e8ecf3;margin-top:4px;font-weight:700}
.proof{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.dot{font-size:12px;border-radius:8px;padding:3px 9px;font-weight:600}
.d-g{background:#12352a;color:#36c77d}.d-b{background:#14263f;color:#6aa7ff}.d-n{background:#1c2331;color:#7d879a}.d-r{background:#3a1a1e;color:#ef6a6a}.d-a{background:#3a2f12;color:#e6b93a}
.why{font-size:14px;color:#c4cbd8;margin-top:7px}.num{text-align:right;font-size:18px;font-weight:700}
.vh{font-weight:800;letter-spacing:.1em;font-size:13px;padding:6px 12px;border-radius:10px;text-align:center}
.tg{background:#12352a;color:#36c77d}.ta{background:#3a2f12;color:#e6b93a}.tx{background:#232c3b;color:#aab3c2}.tr{background:#3a1a1e;color:#ef6a6a}
.foot{margin-top:20px;border-top:1px solid #232c3b;padding-top:14px;font-size:13px;color:#8b95a7;display:flex;justify-content:space-between;gap:20px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 0}.stat{background:#0f141d;border:1px solid #232c3b;border-radius:16px;padding:14px 16px}
.stat .l{font-size:11px;letter-spacing:.16em;color:#8b95a7;text-transform:uppercase}.stat .v{font-size:28px;font-weight:700;margin-top:6px}
.g{color:#36c77d}.r{color:#ef6a6a}.m{color:#8b95a7}.sub{font-size:13px;color:#8b95a7;margin-top:3px;font-weight:500}"""

def esc(x): return html.escape(str(x if x is not None else ""))

def bet_html(r):
    b = str(r.get("bet") or "")
    star = '<span class="star">★</span>' if r.get("star") else ""
    import re
    m = re.search(r"([+-]?\d+(\.\d+)?)$", b)
    if m and ("Over" in b or "Under" in b or re.search(r"[+-]\d", b)):
        return f"{star}{esc(b[:m.start()])}<span class=ln>{esc(m.group(1))}</span>"
    return star + esc(b)

def play_row(r, cls, verdict, vcls):
    ds = "".join(f'<span class="dot d-{c}">{esc(t)}</span>' for t, c in r.get("chips", []))
    p = r.get("sf_first_price", r.get("price"))
    return (f'<div class="row {cls}"><div><div class="b{' st' if r.get('star') else ''}">{bet_html(r)}</div><div class="s">{esc(r.get("matchup") or r.get("game"))}</div>'
            f'<div class="proof">{ds}</div><div class="why">{esc(r.get("why"))}</div></div>'
            f'<div class="num">{esc(price_txt(p))}</div><div class="vh {vcls}">{verdict}</div></div>')

def slate_html(c):
    t = classify(c.get("rows", []), sf_current=c.get("sf_current", True))
    body = f'<div class="top"><div><div class="kick">Sharp Slate</div><h1>{esc(c.get("title") or "Tonight\'s plays")}</h1></div><div class="pill">{esc(c.get("stamp"))}</div></div>'
    body += f'<div class="src">{esc(c.get("sources"))}</div>'
    body += '<div class="sec s-play"><span>Best plays</span><small>★ = Pinnacle + Vegas 80+ - max 5 - ranked</small></div>'
    body += "".join(play_row(r, "play", "PLAY", "tg") for r in t["plays"]) or '<div class="why">No Pinnacle STRONG/MAX play passes the rules this slot.</div>'
    if t["leans"]:
        body += '<div class="sec s-lean"><span>Lean - sharp wallets</span><small>★ = good tail (2x+ their usual)</small></div>'
        body += "".join(play_row(r, "lean", "LEAN", "ta") for r in t["leans"])
    if t["passes"]:
        body += '<div class="sec s-pass"><span>Pass - sources disagree</span><small>no bet</small></div>'
        body += "".join(play_row(r, "pass", "PASS", "tx") for r in t["passes"])
    body += f'<div class="foot"><span>{esc(c.get("footer") or "Tier rules are fixed until 200 graded plays per tier. Star is a rule-based screen, not a prediction.")}</span><span>Leans, not guarantees</span></div>'
    return f"<html><head><style>{CSS}</style></head><body><div class='card'>{body}</div></body></html>"

def rec(rows):
    w = sum(1 for r in rows if r.get("result") == "W"); l = sum(1 for r in rows if r.get("result") == "L")
    p = len(rows) - w - l
    u = round(sum(units(r.get("sf_first_price", r["price"]), r.get("result")) for r in rows), 2)
    return w, l, p, u

def rec_txt(rows):
    w, l, p, u = rec(rows)
    return f"{w}-{l}" + (f"-{p}" if p else ""), u

def returns_html(c):
    rows = c.get("rows", [])
    posted = [r for r in rows if r.get("posted_tier")]
    if posted:
        play = [r for r in rows if r.get("posted_tier") == "PLAY"]; lean = [r for r in rows if r.get("posted_tier") == "LEAN"]
        pas = [r for r in rows if r.get("posted_tier") == "PASS"]
        t = classify(rows)
    else:
        t = classify(rows); play, lean, pas = t["plays"], t["leans"], t["passes"]
    allp = [r for r in t["all"] if has_pin(r) and r.get("pin_status") == "Stable" and "SF_VS_PIN" not in r.get("buckets", [])]
    flip = [r for r in t["all"] if has_pin(r) and r.get("pin_status") == "Flipped"]
    def tile(label, rr):
        s, u = rec_txt(rr); cls = "g" if u > 0 else "r" if u < 0 else "m"
        return f'<div class="stat"><div class="l">{label}</div><div class="v">{s}</div></div><div class="stat"><div class="l">Units</div><div class="v {cls}">{u:+.2f}u</div></div>'
    body = f'<div class="top"><div><div class="kick">Sharp Slate</div><h1>Yesterday\'s returns</h1></div><div class="pill">{esc(c.get("date_label"))}</div></div>'
    body += f'<div class="stats">{tile("Best plays", play)}{tile("Lean (wallets)", lean)}</div>'
    body += '<div class="sec s-play"><span>What we called</span><small>result - units</small></div>'
    for grp, name in ((play, "PLAY"), (lean, "LEAN"), (pas, "PASS")):
        for r in grp:
            p = r.get("sf_first_price", r["price"]); u = units(p, r.get("result"))
            res = r.get("result"); tag = ("tg", "WIN") if res == "W" else ("tr", "LOSS") if res == "L" else ("tx", "PUSH")
            note = " (skipped, no bet)" if name == "PASS" else ""
            risk = f"risk {abs(p)/100:.2f}u to win 1u" if p < 0 else "risk 1u"
            body += (f'<div class="row {name.lower()}" style="grid-template-columns:1fr 90px 110px"><div><div class="b{' st' if r.get('star') else ''}">{bet_html(r)}</div>'
                     f'<div class="s">{esc(r.get("matchup") or r.get("game"))}</div><div class="sub">{name} · {esc(price_txt(p))} · {risk} · final {esc(r.get("final"))}{note}</div></div>'
                     f'<div><span class="vh {tag[0]}">{tag[1]}</span></div><div class="num {"g" if u>0 else "r" if u<0 else "m"}">{u:+.2f}u</div></div>')
    body += '<div class="sec s-pass"><span>Same rules, everything else</span><small>W-L - units</small></div>'
    for name, rr, sub in (("All Pinnacle STRONG/MAX stable", allp, "Best plays are the ranked top of this group"),
                          ("Pinnacle flipped (not shown as plays)", flip, "Tracked to see whether flipped stays the weaker bucket")):
        s, u = rec_txt(rr)
        body += f'<div class="row" style="grid-template-columns:1fr 200px"><div><div class="b" style="font-size:18px">{name} ({len(rr)})</div><div class="sub">{sub}</div></div><div class="num {"g" if u>0 else "r"}">{s} · {u:+.2f}u</div></div>'
    body += f'<div class="foot"><span>Staking: plus odds risk 1u. Minus odds risk the price in units (-120 = 1.2u) to win 1u. Rules frozen until 200 graded plays per tier.</span><span>{esc(c.get("day_label"))}</span></div>'
    return f"<html><head><style>{CSS}</style></head><body><div class='card'>{body}</div></body></html>"

def _shot(html_text, path):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={"width": 1112, "height": 800}, device_scale_factor=2)
        pg.set_content(html_text); pg.screenshot(path=path, full_page=True); b.close()

def render_slate(card, out_dir):
    os.makedirs(out_dir, exist_ok=True); p = os.path.join(out_dir, "slate.png"); _shot(slate_html(card), p); return [p]

def render_returns(card, out_dir):
    os.makedirs(out_dir, exist_ok=True); p = os.path.join(out_dir, "returns.png"); _shot(returns_html(card), p); return [p]
