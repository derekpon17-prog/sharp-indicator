"""Render Sharp Signals scorecards (design B) to PNG with headless Chromium.

A scorecard is a dict:
{
  "sport": "NBA", "start": "6:35pm CT", "date": "Wed Oct 21", "matchup": "Hornets @ Nets",
  "bet": "Hornets -1.5", "price": "-109",
  "pinnacle": {"tier": "STRONG", "line1": "...", "line2": "..."} or null,
  "vegas": {"strength": 94, "line1": "...", "bets": 22, "money": 25} or null,
  "novig": {"tier": "LEAN"|"STRONG"|"NEUTRAL"|"AGAINST", "line1": "...", "line2": "..."} or null,
  "record_label": "PINNACLE STRONG + VEGAS 70+ RECORD", "record": "12-8 · +3.1u · 14%",
  "checked": "Checked 6:08pm CT"
}
Agreement count = Pinnacle present (STRONG/MAX) + Vegas strength >= 70 + Novig LEAN/STRONG.
"""
import html, os

GOLD, BLUE, GREEN, GREY = "#F2C14E", "#5AA9FF", "#3DDC97", "#9AA4B2"

def e(x):
    return html.escape(str(x if x is not None else ""))

def agreement(c):
    p = bool(c.get("pinnacle"))
    v = bool(c.get("vegas")) and (c["vegas"].get("strength") or 0) >= 70
    n = bool(c.get("novig")) and str(c["novig"].get("tier", "")).upper() in ("LEAN", "STRONG")
    return p, v, n

def panel(label, color, big, big_color, body):
    return f'''<div class="panel"><div class="pl"><div class="lab" style="color:{color}">{e(label)}</div>
<div class="big" style="color:{big_color}">{e(big)}</div></div><div class="pb">{body}</div></div>'''

def card_html(c):
    p, v, n = agreement(c)
    count = p + v + n
    seg = lambda on, col: f'<div class="seg" style="background:{col if on else "#1B212B"};{"" if on else "border:1px solid #263041;"}"></div>'
    panels = []
    if c.get("pinnacle"):
        pc = c["pinnacle"]
        panels.append(panel("PINNACLE", GOLD, pc.get("tier", "STRONG"), "#E8ECF2",
                            f'<div>{e(pc.get("line1"))}</div><div class="muted">{e(pc.get("line2"))}</div>'))
    else:
        panels.append(panel("PINNACLE", GOLD, "NO LEAN", GREY, '<div class="muted">No Strong or Max lean on this side</div>'))
    if c.get("vegas"):
        vc = c["vegas"]
        bars = ""
        for name, val in (("Bets", vc.get("bets")), ("Money", vc.get("money"))):
            if val is None:
                continue
            w = max(0, min(100, float(val)))
            bars += f'<div>{name}</div><div class="track"><div class="fill" style="width:{w}%"></div></div><div class="pct">{int(round(w))}%</div>'
        strong = (vc.get("strength") or 0) >= 70
        panels.append(panel("VEGAS", BLUE, f'{vc.get("strength")}/100', "#E8ECF2" if strong else GREY,
                            f'<div>{e(vc.get("line1"))}</div>' + (f'<div class="bars">{bars}</div>' if bars else "")))
    else:
        panels.append(panel("VEGAS", BLUE, "NO SIGNAL", GREY, '<div class="muted">No Vegas signal on this side</div>'))
    if c.get("novig"):
        nc = c["novig"]
        t = str(nc.get("tier", "NEUTRAL")).upper()
        col = "#E8ECF2" if t in ("LEAN", "STRONG") else ("#FF8A65" if t == "AGAINST" else GREY)
        panels.append(panel("NOVIG", GREEN, t, col,
                            f'<div>{e(nc.get("line1"))}</div><div class="muted">{e(nc.get("line2"))}</div>'))
    else:
        panels.append(panel("NOVIG", GREEN, "NO DATA", GREY, '<div class="muted">No Novig book read for this market</div>'))
    top = "TOP PLAY" if count >= 2 else "SIGNAL"
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
body{{margin:0;background:#0B0E13}}
#card{{width:800px;box-sizing:border-box;background:#0B0E13;font-family:Inter,system-ui,sans-serif;color:#E8ECF2;padding:48px;display:flex;flex-direction:column;gap:28px}}
.row{{display:flex;justify-content:space-between;align-items:center}}
.brand{{font-size:13px;font-weight:700;letter-spacing:3px;color:{GOLD}}}
.meta{{font-size:13px;color:{GREY}}}
.match{{font-size:18px;color:{GREY};font-weight:500}}
.bet{{display:flex;align-items:baseline;gap:20px;flex-wrap:wrap}}
.betname{{font-size:72px;font-weight:900;letter-spacing:-2px;line-height:1.02}}
.price{{font-family:'JetBrains Mono',monospace;font-size:34px;font-weight:700;color:#C9D1DC}}
.agree{{display:flex;justify-content:space-between;font-size:13px;color:{GREY};font-weight:600;letter-spacing:1px}}
.segs{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}}
.seg{{height:14px;border-radius:7px;box-sizing:border-box}}
.panels{{display:flex;flex-direction:column;gap:14px}}
.panel{{display:grid;grid-template-columns:150px minmax(0,1fr);gap:20px;background:#131820;border:1px solid #222936;border-radius:14px;padding:20px 22px}}
.pl{{display:flex;flex-direction:column;gap:6px}}
.lab{{font-size:12px;font-weight:700;letter-spacing:2px}}
.big{{font-size:26px;font-weight:800}}
.pb{{display:flex;flex-direction:column;gap:8px;font-size:16px;line-height:1.45}}
.muted{{color:{GREY}}}
.bars{{display:grid;grid-template-columns:70px minmax(0,1fr) 44px;align-items:center;gap:10px;font-size:13px;color:{GREY}}}
.track{{height:8px;border-radius:4px;background:#1B212B}}
.fill{{height:8px;border-radius:4px;background:{BLUE}}}
.pct{{text-align:right;color:#E8ECF2}}
.foot{{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #222936;padding-top:16px}}
.rl{{font-size:12px;color:#7D8796}}
.rec{{font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:700}}
.chk{{font-size:12px;color:#7D8796;text-align:right}}
</style></head><body><div id="card">
<div class="row"><div class="brand">SHARP SIGNALS · {top}</div><div class="meta">{e(c.get("sport"))} · {e(c.get("date"))} · {e(c.get("start"))}</div></div>
<div style="display:flex;flex-direction:column;gap:10px"><div class="match">{e(c.get("matchup"))}</div>
<div class="bet"><div class="betname">{e(c.get("bet"))}</div><div class="price">{e(c.get("price"))}</div></div></div>
<div style="display:flex;flex-direction:column;gap:10px"><div class="agree"><div>SIGNAL AGREEMENT</div><div style="color:#E8ECF2">{count} OF 3</div></div>
<div class="segs">{seg(p, GOLD)}{seg(v, BLUE)}{seg(n, GREEN)}</div></div>
<div class="panels">{"".join(panels)}</div>
<div class="foot"><div style="display:flex;flex-direction:column;gap:4px"><div class="rl">{e(c.get("record_label") or "SIGNAL RECORD")}</div>
<div class="rec">{e(c.get("record") or "tracking started Oct 21")}</div></div>
<div class="chk">{e(c.get("checked"))}<br>Lean, not a guarantee</div></div>
</div></body></html>'''

def render(cards, out_dir):
    """Render each scorecard to out_dir/card_<i>.png; returns the file paths."""
    from playwright.sync_api import sync_playwright
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 800, "height": 1200}, device_scale_factor=1.5)
        for i, c in enumerate(cards):
            page.set_content(card_html(c), wait_until="networkidle")
            path = os.path.join(out_dir, f"card_{i + 1}.png")
            page.locator("#card").screenshot(path=path)
            paths.append(path)
        browser.close()
    return paths


RED = "#FF6B6B"

def summary_html(c):
    """Summary card: {"title","subtitle","sections":[{"heading","rows":[{"label","w","l","p","units"}]}],"footer"}.
    Each row: label, W-L(-P), win-rate bar with a 52.4% breakeven tick, and units (green/red)."""
    secs = ""
    for sec in c.get("sections", []):
        rows = ""
        for r in sec.get("rows", []):
            w, l, pu = int(r.get("w", 0)), int(r.get("l", 0)), int(r.get("p", 0))
            n = w + l
            rate = (100.0 * w / n) if n else 0.0
            u = float(r.get("units", 0))
            col = GREEN if u > 0 else (RED if u < 0 else GREY)
            rec = f"{w}-{l}" + (f"-{pu}" if pu else "")
            thin = n < 8
            bar = (f'<div class="bt"><div class="bf" style="width:{rate:.0f}%;background:{BLUE if not thin else "#3B4A63"}"></div><div class="tick"></div></div>'
                   if n else '<div class="bt"></div>')
            rows += (f'<div class="r"><div class="rl2">{e(r.get("label"))}</div><div class="rr">{rec}</div>{bar}'
                     f'<div class="rp">{rate:.0f}%</div><div class="ru" style="color:{col}">{u:+.2f}u</div></div>')
        secs += f'<div class="sec"><div class="sh">{e(sec.get("heading"))}</div>{rows}</div>'
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
body{{margin:0;background:#0B0E13}}
#card{{width:800px;box-sizing:border-box;background:#0B0E13;font-family:Inter,system-ui,sans-serif;color:#E8ECF2;padding:44px;display:flex;flex-direction:column;gap:24px}}
.brand{{font-size:13px;font-weight:700;letter-spacing:3px;color:{GOLD}}}
.ttl{{font-size:44px;font-weight:900;letter-spacing:-1px;line-height:1.05}}
.sub{{font-size:16px;color:{GREY}}}
.sec{{display:flex;flex-direction:column;gap:9px;background:#131820;border:1px solid #222936;border-radius:14px;padding:18px 22px}}
.sh{{font-size:12px;font-weight:700;letter-spacing:2px;color:{GREY};margin-bottom:4px}}
.r{{display:grid;grid-template-columns:200px 78px minmax(0,1fr) 44px 86px;align-items:center;gap:12px;font-size:15px}}
.rl2{{font-weight:600}}
.rr{{font-family:'JetBrains Mono',monospace;color:#C9D1DC;font-size:14px}}
.bt{{position:relative;height:10px;border-radius:5px;background:#1B212B}}
.bf{{height:10px;border-radius:5px}}
.tick{{position:absolute;left:52.4%;top:-3px;width:2px;height:16px;background:{GOLD}}}
.rp{{text-align:right;font-family:'JetBrains Mono',monospace;font-size:13px;color:#C9D1DC}}
.ru{{text-align:right;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:15px}}
.foot{{display:flex;justify-content:space-between;font-size:12px;color:#7D8796;border-top:1px solid #222936;padding-top:14px}}
</style></head><body><div id="card">
<div><div class="brand">{e(c.get("brand") or "SHARP SIGNALS")}</div></div>
<div style="display:flex;flex-direction:column;gap:8px"><div class="ttl">{e(c.get("title"))}</div><div class="sub">{e(c.get("subtitle"))}</div></div>
{secs}
<div class="foot"><div>Gold tick = 52.4% breakeven at -110 · dim bars = under 8 graded</div><div>{e(c.get("footer") or "Leans, not guarantees")}</div></div>
</div></body></html>'''

def render_summaries(cards, out_dir):
    from playwright.sync_api import sync_playwright
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 800, "height": 1400}, device_scale_factor=1.5)
        for i, c in enumerate(cards):
            page.set_content(summary_html(c), wait_until="networkidle")
            path = os.path.join(out_dir, f"summary_{i + 1}.png")
            page.locator("#card").screenshot(path=path)
            paths.append(path)
        browser.close()
    return paths
