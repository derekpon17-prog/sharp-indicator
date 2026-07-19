<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Sharp Money — Polymarket Smart Money Tracker</title>
<meta name="description" content="Real-time Polymarket smart money alerts. Track top traders, converging plays, and large sports buys.">
<!-- Open Graph (iMessage, WhatsApp, Twitter previews) -->
<meta property="og:title" content="Sharp Money — Smart Money Tracker">
<meta property="og:description" content="Real-time Polymarket alerts. Top trader buys, converging plays, sport-specific PnL leaderboards.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://sharp-indicator-a34j.vercel.app/polymarket.html">
<meta property="og:image" content="https://sharp-indicator-a34j.vercel.app/og-polymarket.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Sharp Money — Smart Money Tracker">
<meta name="twitter:description" content="Polymarket top trader alerts. Converging plays, sport PnL leaderboards.">
<meta name="theme-color" content="#E5A00D">
<!-- Apple mobile -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sharp Money">
<!-- Open Graph / Link Preview -->
<meta property="og:type" content="website">
<meta property="og:url" content="https://sharp-indicator-a34j.vercel.app/polymarket.html">
<meta property="og:title" content="Sharp Money — Polymarket Smart Money Tracker">
<meta property="og:description" content="Real-time tracking of top Polymarket sports traders. Converging plays, smart money alerts, and sport-specific PnL.">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Sharp Money">
<meta name="twitter:description" content="Smart money tracking for sports prediction markets.">
<meta name="description" content="Real-time Polymarket smart money tracker for sports markets.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.26.0/dist/tabler-icons.min.css">
<style>

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0B0C10;--s1:#131519;--s2:#1A1C22;--s3:#22252E;--s4:#2D3040;
  --b1:rgba(255,255,255,.05);--b2:rgba(255,255,255,.09);--b3:rgba(255,255,255,.16);
  --t1:#F5F6FA;--t2:rgba(245,246,250,.7);--t3:rgba(245,246,250,.42);--t4:rgba(245,246,250,.2);
  --gold:#E5A00D;--gl:rgba(229,160,13,.12);--gm:rgba(229,160,13,.3);
  --green:#00C896;--grl:rgba(0,200,150,.1);
  --red:#FF3D5A;--rl:rgba(255,61,90,.1);
  --blue:#40B4FF;--bl:rgba(64,180,255,.1);
  --purple:#9B6DFF;--pl:rgba(155,109,255,.12);
  --mono:"JetBrains Mono",monospace;
  --sans:"Inter",system-ui,sans-serif;
  --r:8px;--rl2:14px;--rxl:20px;
}
html,body{background:var(--bg);color:var(--t1);font-family:var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased;font-size:14px;overflow-x:hidden}
button,input,select{font-family:inherit;outline:none}
::-webkit-scrollbar{width:3px;height:3px}::-webkit-scrollbar-thumb{background:var(--s4);border-radius:3px}
a{color:inherit;text-decoration:none}
.view{display:none}.view.on{display:block}
.nav{position:sticky;top:0;z-index:100;height:58px;display:flex;align-items:center;padding:0 28px;background:rgba(11,12,16,.93);backdrop-filter:blur(24px);border-bottom:1px solid var(--b1);gap:24px}
.logo{display:flex;align-items:center;gap:9px;font-weight:900;font-size:15px;flex-shrink:0}
.logo-mark{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--gold),#B87800);display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 12px rgba(229,160,13,.3)}
.nav-tabs{display:flex;gap:3px;flex:1;justify-content:center}
.ntab{display:flex;align-items:center;gap:6px;padding:7px 18px;border-radius:100px;border:none;background:transparent;color:var(--t3);font-size:13px;font-weight:500;cursor:pointer;transition:all .15s}
.ntab:hover{color:var(--t2);background:var(--b1)}
.ntab.on{background:var(--s3);color:var(--t1);font-weight:700;border:1px solid var(--b2)}
.ntab i{font-size:15px}
.nav-r{display:flex;align-items:center;gap:8px;flex-shrink:0}
.live-pill{display:flex;align-items:center;gap:5px;padding:4px 11px;border-radius:100px;background:rgba(0,200,150,.1);border:1px solid rgba(0,200,150,.22);font-size:11px;font-weight:700;color:var(--green);font-family:var(--mono)}
.ldot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s ease infinite}
.cd{font-size:11px;font-family:var(--mono);color:var(--t4)}
.ibtn{width:32px;height:32px;border-radius:var(--r);border:1px solid var(--b1);background:transparent;color:var(--t3);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;font-size:15px}
.ibtn:hover{background:var(--s2);color:var(--t1);border-color:var(--b2)}
.page{max-width:1320px;margin:0 auto;padding:0 28px 80px}
.hero{position:relative;border-radius:var(--rxl);overflow:hidden;margin:22px 0 26px;min-height:210px;background:linear-gradient(140deg,#0F1624 0%,#162040 50%,#0D0F1A 100%);display:flex;align-items:flex-end;padding:30px 34px;gap:20px}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 15% 60%,rgba(229,160,13,.1) 0%,transparent 55%),radial-gradient(ellipse at 85% 20%,rgba(64,180,255,.07) 0%,transparent 45%);pointer-events:none}
.hero-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:100px;background:var(--gl);border:1px solid var(--gm);font-size:10px;font-weight:800;color:var(--gold);letter-spacing:.09em;text-transform:uppercase;margin-bottom:10px;width:fit-content}
.hero-size{font-size:54px;font-weight:900;font-family:var(--mono);color:var(--gold);line-height:1}
.hero-market{font-size:16px;font-weight:700;color:var(--t1);margin:6px 0 4px;max-width:520px;line-height:1.4}
.hero-meta{font-size:12px;color:var(--t2);display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.hero-divider{width:1px;height:16px;background:var(--b2)}
.hero-cta{display:inline-flex;align-items:center;gap:6px;margin-top:14px;padding:10px 22px;border-radius:100px;background:var(--gold);color:#0B0C10;font-size:13px;font-weight:800;border:none;cursor:pointer;transition:all .2s;width:fit-content}
.hero-cta:hover{background:#F5B820;transform:scale(1.03)}
.hero-stats{margin-left:auto;display:flex;gap:28px;flex-shrink:0;align-self:center}
.hs{text-align:center}
.hs-val{font-size:26px;font-weight:900;font-family:var(--mono);color:var(--t1)}
.hs-lbl{font-size:10px;font-weight:700;color:var(--t4);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.hero-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px;position:relative}
.hero-empty h2{font-size:24px;font-weight:900;color:var(--t1);margin-bottom:8px}
.hero-empty p{font-size:14px;color:var(--t3);line-height:1.7;max-width:340px}
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:30px}
.sc{background:var(--s1);border:1px solid var(--b1);border-radius:var(--rl2);padding:18px 20px;border-top:2px solid transparent}
.sc.gold{border-top-color:var(--gold)}.sc.green{border-top-color:var(--green)}.sc.blue{border-top-color:var(--blue)}.sc.purple{border-top-color:var(--purple)}
.sc-lbl{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--t3);margin-bottom:10px;display:flex;align-items:center;gap:5px}
.sc-val{font-size:26px;font-weight:900;font-family:var(--mono);color:var(--t1);line-height:1}
.sc-sub{font-size:11px;color:var(--t4);margin-top:4px}
.row-s{margin-bottom:34px}
.row-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.row-ttl{font-size:18px;font-weight:800;color:var(--t1);display:flex;align-items:center;gap:8px}
.row-ttl em{font-size:20px;font-style:normal}
.row-all{font-size:12px;font-weight:600;color:var(--t3);cursor:pointer;display:flex;align-items:center;gap:3px;transition:color .15s}
.row-all:hover{color:var(--gold)}
.row-scr{display:flex;gap:13px;overflow-x:auto;padding-bottom:10px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.row-scr::-webkit-scrollbar{display:none}
.acard{flex:0 0 265px;width:265px;background:var(--s1);border:1px solid var(--b1);border-radius:var(--rl2);padding:15px;cursor:pointer;transition:transform .2s,border-color .2s;position:relative;overflow:hidden}
.acard::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:transparent}
.acard:hover{transform:translateY(-4px);border-color:var(--b3)}
.acard.big::before{background:var(--gold)}
.acard.big{border-color:rgba(229,160,13,.2)}
.acard-trader{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.acard-av,.acard-av-fb{width:30px;height:30px;border-radius:50%;flex-shrink:0}
.acard-av{object-fit:cover;background:var(--s3)}
.acard-av-fb{background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:var(--t2)}
.acard-tname{font-size:12px;font-weight:700;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acard-mkt{font-size:13px;font-weight:700;color:var(--t1);line-height:1.4;margin-bottom:7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.acard-oc{font-size:11px;color:var(--t3);margin-bottom:3px;font-family:var(--mono)}
.sb{background:var(--s2);border-radius:8px;padding:8px 10px;margin:8px 0;min-height:28px}
.acard-ft{display:flex;align-items:flex-end;justify-content:space-between;margin-top:4px}
.acard-size{font-size:22px;font-weight:900;font-family:var(--mono);color:var(--gold)}
.acard-time{font-size:10px;color:var(--t4);font-family:var(--mono);margin-top:2px}
.acard-btn{padding:6px 13px;border-radius:100px;background:var(--gold);color:#0B0C10;font-size:11px;font-weight:800;border:none;cursor:pointer}
.acard-btn:hover{background:#F5B820}
.poster{flex:0 0 160px;width:160px;border-radius:var(--rl2);background:var(--s1);border:1px solid var(--b1);overflow:hidden;cursor:pointer;transition:transform .2s,box-shadow .2s,border-color .2s}
.poster:hover{transform:scale(1.05);box-shadow:0 10px 36px rgba(0,0,0,.55);border-color:var(--b3)}
.poster.hot{border-color:rgba(229,160,13,.35);box-shadow:0 0 0 1px rgba(229,160,13,.2)}
.poster-img{height:104px;background:linear-gradient(135deg,var(--s3),var(--s4));display:flex;align-items:center;justify-content:center;position:relative}
.poster-img::after{content:"";position:absolute;bottom:0;left:0;right:0;height:44px;background:linear-gradient(to top,var(--s1),transparent)}
.p-av,.p-av-fb{width:54px;height:54px;border-radius:50%;border:2px solid var(--b2)}
.p-av{object-fit:cover}
.p-av-fb{background:var(--s4);display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:800;color:var(--t2)}
.p-live{position:absolute;top:8px;right:8px;background:var(--gold);color:#0B0C10;font-size:9px;font-weight:900;padding:2px 7px;border-radius:100px;letter-spacing:.05em}
.poster-body{padding:11px 12px 13px}
.p-rank{font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;letter-spacing:.04em;margin-bottom:5px;display:inline-block}
.p-rank.sports{background:var(--grl);color:var(--green)}.p-rank.overall{background:var(--pl);color:var(--purple)}.p-rank.hot-tag{background:var(--gl);color:var(--gold);margin-left:4px}
.p-name{font-size:12px;font-weight:700;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px}
.p-pnl{font-size:15px;font-weight:900;font-family:var(--mono);color:var(--green)}
.tcard{flex:0 0 228px;width:228px;background:var(--s1);border:1px solid var(--b1);border-radius:var(--rl2);padding:15px}
.tcard.open{border-left:3px solid var(--purple)}.tcard.win{border-left:3px solid var(--green)}.tcard.loss{border-left:3px solid var(--red)}
.tc-mkt{font-size:13px;font-weight:700;color:var(--t1);margin-bottom:6px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tc-det{font-size:11px;color:var(--t3);font-family:var(--mono);margin-bottom:12px}
.tc-ft{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.tc-status{font-size:10px;font-weight:700;padding:3px 9px;border-radius:100px}
.tc-status.open{background:var(--pl);color:var(--purple)}.tc-status.win{background:var(--grl);color:var(--green)}.tc-status.loss{background:var(--rl);color:var(--red)}
.tc-pnl{font-size:16px;font-weight:900;font-family:var(--mono)}
.tc-pnl.pos{color:var(--green)}.tc-pnl.neg{color:var(--red)}.tc-pnl.neu{color:var(--t3)}
.tc-btns{display:flex;gap:5px}
.tc-btn{flex:1;padding:5px 0;border-radius:6px;border:1px solid var(--b2);background:transparent;color:var(--t3);font-size:11px;font-weight:700;font-family:var(--mono);cursor:pointer;text-align:center}
.tc-btn.W{background:var(--grl);border-color:rgba(0,200,150,.25);color:var(--green)}
.tc-btn.L{background:var(--rl);border-color:rgba(255,61,90,.25);color:var(--red)}
.fbar{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.sw{position:relative;flex:1;min-width:160px;max-width:240px}
.sw i{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--t4);font-size:14px;pointer-events:none}
.sinput{width:100%;padding:8px 12px 8px 34px;border:1px solid var(--b1);border-radius:100px;background:var(--s1);color:var(--t1);font-size:12px}
.sinput:focus{border-color:var(--b3);outline:none}.sinput::placeholder{color:var(--t4)}
.fp{padding:6px 15px;border-radius:100px;border:1px solid var(--b1);background:transparent;color:var(--t3);font-size:12px;font-weight:600;font-family:var(--mono);cursor:pointer;transition:all .15s}
.fp.on{background:var(--gold);border-color:var(--gold);color:#0B0C10;font-weight:800}
.al-list{display:flex;flex-direction:column;gap:8px}
.al-row{display:flex;align-items:center;gap:13px;background:var(--s1);border:1px solid var(--b1);border-radius:var(--rl2);padding:14px 18px;transition:border-color .2s}
.al-row:hover{border-color:var(--b2)}
.al-row.big{border-left:3px solid var(--gold)}
.al-av,.al-av-fb{width:36px;height:36px;border-radius:50%;flex-shrink:0}
.al-av{object-fit:cover;background:var(--s3)}
.al-av-fb{background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:var(--t2)}
.al-main{flex:1;min-width:0}
.al-trader{font-size:12px;font-weight:700;color:var(--t1);display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:2px}
.al-mkt{font-size:13px;font-weight:600;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.al-meta{font-size:11px;color:var(--t4);font-family:var(--mono)}
.al-r{text-align:right;flex-shrink:0;margin-left:8px}
.al-size{font-size:20px;font-weight:900;font-family:var(--mono);color:var(--gold)}
.al-time{font-size:10px;color:var(--t4);font-family:var(--mono);margin-top:2px}
.al-follow{margin-top:5px;padding:5px 12px;border-radius:100px;background:var(--gold);color:#0B0C10;font-size:11px;font-weight:800;border:none;cursor:pointer}
.perf{display:flex;gap:12px;margin-bottom:26px;flex-wrap:wrap}
.pc{background:var(--s1);border:1px solid var(--b1);border-radius:var(--rl2);padding:16px 20px;min-width:120px;flex:1}
.pc-val{font-size:24px;font-weight:900;font-family:var(--mono);color:var(--t1)}
.pc-lbl{font-size:10px;font-weight:700;color:var(--t4);text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
.hot-wrap{background:linear-gradient(135deg,rgba(229,160,13,.07) 0%,rgba(229,160,13,.02) 100%);border:1px solid rgba(229,160,13,.22);border-radius:var(--rxl);padding:18px 22px;margin-bottom:26px}
.hot-hdr{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.hot-ttl{font-size:15px;font-weight:800;color:var(--gold)}
.hot-sub{font-size:11px;color:rgba(229,160,13,.6);margin-left:auto;font-family:var(--mono)}
.hot-row{display:flex;align-items:center;gap:11px;background:rgba(255,255,255,.03);border-radius:var(--r);padding:10px 13px;margin-bottom:7px;transition:background .15s}
.hot-row:last-child{margin-bottom:0}
.hot-row:hover{background:rgba(255,255,255,.06)}
.hot-av{width:32px;height:32px;border-radius:50%;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:var(--t2);flex-shrink:0}
.hot-info{flex:1;min-width:0}
.hot-name{font-size:12px;font-weight:700;color:var(--t1)}
.hot-mkt{font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hot-sz{font-size:17px;font-weight:900;font-family:var(--mono);color:var(--gold);flex-shrink:0}
.lb-wrap{background:var(--s1);border:1px solid var(--b1);border-radius:var(--rxl);overflow:hidden;margin-bottom:30px}
.lb-tabs{display:flex;border-bottom:1px solid var(--b1)}
.lb-tab{flex:1;padding:13px;border:none;background:transparent;color:var(--t3);font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;border-bottom:2px solid transparent}
.lb-tab:hover{color:var(--t2)}.lb-tab.on{color:var(--gold);border-bottom-color:var(--gold)}
.lb-row{display:flex;align-items:center;gap:13px;padding:13px 20px;border-bottom:1px solid var(--b1);transition:background .1s}
.lb-row:last-child{border-bottom:none}.lb-row:hover{background:var(--s2)}
.lb-rank{width:34px;font-size:14px;font-weight:900;font-family:var(--mono);color:var(--t4);text-align:center;flex-shrink:0}
.lb-rank.t3{color:var(--gold)}
.lb-av,.lb-av-fb{width:38px;height:38px;border-radius:50%;flex-shrink:0}
.lb-av{object-fit:cover;background:var(--s3)}
.lb-av-fb{background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:var(--t2)}
.lb-info{flex:1;min-width:0}
.lb-name{font-size:13px;font-weight:700;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb-meta{font-size:11px;color:var(--t3);font-family:var(--mono);margin-top:1px;display:flex;gap:10px}
.lb-pnl-col{text-align:right;flex-shrink:0;margin-right:10px}
.lb-pnl{font-size:16px;font-weight:900;font-family:var(--mono);color:var(--green)}
.lb-pnl-lbl{font-size:10px;color:var(--t4);font-family:var(--mono);margin-top:1px}
.lb-add{padding:6px 14px;border-radius:100px;border:1px solid var(--b2);background:transparent;color:var(--t3);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;flex-shrink:0}
.lb-add:hover{border-color:var(--gm);color:var(--gold);background:var(--gl)}
.lb-add.w{border-color:rgba(0,200,150,.25);color:var(--green);background:var(--grl);cursor:default}
.wgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:13px;margin-top:22px}
.wcard{background:var(--s1);border:1px solid var(--b1);border-radius:var(--rxl);overflow:hidden}
.wcard-hdr{background:linear-gradient(135deg,var(--s2),var(--s3));padding:15px 18px;display:flex;align-items:center;gap:11px}
.wc-av-fb{width:42px;height:42px;border-radius:50%;background:var(--s4);display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;color:var(--t2);flex-shrink:0}
.wc-name{font-size:14px;font-weight:800;color:var(--t1)}
.wc-bdg{display:flex;gap:4px;margin-top:3px;flex-wrap:wrap}
.wcard-body{padding:14px 18px}
.wpnl-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--b1)}
.wpnl-row:last-child{border-bottom:none}
.wpnl-lbl{font-size:11px;font-weight:600;color:var(--t3)}
.wpnl-val{font-size:15px;font-weight:900;font-family:var(--mono)}
.wrec-lbl{font-size:10px;font-weight:700;color:var(--t4);text-transform:uppercase;letter-spacing:.05em;margin:12px 0 6px}
.wrec-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--b1);font-size:12px}
.wrec-row:last-child{border-bottom:none}
.wrec-mkt{color:var(--t2);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wrec-sz{color:var(--t1);font-weight:700;font-family:var(--mono);flex-shrink:0;margin-left:8px}
.wcard-ft{padding:11px 18px;border-top:1px solid var(--b1);display:flex;align-items:center;gap:8px}
.wcard-link{font-size:11px;color:var(--blue);font-family:var(--mono)}
.wcard-rm{margin-left:auto;padding:5px 11px;border-radius:6px;border:1px solid var(--b1);background:transparent;color:var(--t4);font-size:11px;cursor:pointer}
.wcard-rm:hover{color:var(--red);background:var(--rl);border-color:var(--rl)}
.badge{font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.03em}
.badge-o{background:var(--pl);color:var(--purple)}
.badge-s{background:var(--grl);color:var(--green)}
.oc-y{color:var(--green);font-weight:800}
.oc-n{color:var(--red);font-weight:800}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);z-index:999;display:none;align-items:center;justify-content:center;padding:16px}
.overlay.open{display:flex}
.modal{background:var(--s1);border:1px solid var(--b2);border-radius:var(--rxl);width:100%;max-width:460px;box-shadow:0 24px 64px rgba(0,0,0,.7);animation:slidein .2s ease}
.mhdr{display:flex;align-items:center;justify-content:space-between;padding:20px 24px 0}
.mttl{font-size:16px;font-weight:800;color:var(--t1)}
.mx{width:28px;height:28px;border-radius:50%;border:1px solid var(--b2);background:transparent;color:var(--t3);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.mx:hover{background:var(--s2);color:var(--t1)}
.mbody{padding:18px 24px 24px;display:flex;flex-direction:column;gap:14px}
.fg{display:flex;flex-direction:column;gap:5px}
.flbl{font-size:10px;font-weight:700;color:var(--t3);letter-spacing:.07em;text-transform:uppercase}
.finput{padding:10px 13px;border:1px solid var(--b2);border-radius:var(--r);background:var(--s2);color:var(--t1);font-size:13px;width:100%;transition:border .15s}
.finput:focus{border-color:var(--gold);outline:none}
.finput::placeholder{color:var(--t4)}
select.finput option{background:var(--s2)}
.fhint{font-size:11px;color:var(--t4);line-height:1.5;margin-top:2px}
.fhint a{color:var(--gold)}
.frow2{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.mft{display:flex;gap:8px;margin-top:4px}
.btn-x{padding:10px 16px;border-radius:var(--r);border:1px solid var(--b2);background:transparent;color:var(--t2);font-size:13px;cursor:pointer}
.btn-x:hover{background:var(--s2)}
.btn-p{flex:1;padding:10px;border-radius:var(--r);border:none;background:var(--gold);color:#0B0C10;font-size:13px;font-weight:800;cursor:pointer}
.btn-p:hover{background:#F5B820}
.btn-t{padding:10px 14px;border-radius:var(--r);border:1px solid var(--b2);background:transparent;color:var(--t2);font-size:13px;cursor:pointer}
.btn-t:hover{background:var(--s2)}
.minfo{font-size:11px;font-family:var(--mono);text-align:center;min-height:16px}
.thr-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.thr-val{font-size:13px;font-family:var(--mono);font-weight:700;color:var(--gold)}
.empty{padding:56px 20px;text-align:center}
.empty-ico{font-size:38px;opacity:.25;margin-bottom:14px}
.empty h3{font-size:16px;font-weight:700;color:var(--t2);margin-bottom:7px}
.empty p{font-size:13px;color:var(--t4);max-width:280px;margin:0 auto;line-height:1.7}
.tl-row{display:flex;align-items:center;gap:13px;background:var(--s1);border:1px solid var(--b1);border-radius:var(--rl2);padding:15px 18px}
.tl-row.open{border-left:3px solid var(--purple)}.tl-row.win{border-left:3px solid var(--green)}.tl-row.loss{border-left:3px solid var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes slidein{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:none}}
@media(max-width:700px){
  .strip{grid-template-columns:1fr 1fr}
  .ntab span{display:none}
  .hero-size{font-size:38px}
  .hero-stats{display:none}
  .perf{gap:8px}
  .trend-card{flex:0 0 240px;width:240px}
  .row-scr{gap:10px;padding-left:2px;padding-right:2px}
  .page{padding:0 14px 80px}
  .hero{padding:20px 20px;min-height:180px}
  .hero-size{font-size:32px}
  .strip{gap:8px}
  .strip .sc{padding:12px 14px}
  .sc-val{font-size:20px}
}


/* Trending plays */
.trend-card{flex:0 0 280px;width:280px;background:var(--s1);border:1px solid var(--b1);border-radius:var(--rl2);padding:15px;position:relative;overflow:hidden;transition:transform .2s,border-color .2s}
.trend-card:hover{transform:translateY(-3px);border-color:var(--b3)}
.trend-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px}
.trend-card.sig-1{border-color:rgba(229,160,13,.2)}.trend-card.sig-1::before{background:linear-gradient(90deg,var(--gold),transparent)}
.trend-card.sig-2{border-color:rgba(0,200,150,.25)}.trend-card.sig-2::before{background:linear-gradient(90deg,var(--green),transparent)}
.trend-card.sig-3{border-color:rgba(155,109,255,.35);box-shadow:0 0 20px rgba(155,109,255,.1)}.trend-card.sig-3::before{background:linear-gradient(90deg,var(--purple),var(--green))}
.trend-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.trend-buyers{font-size:10px;font-weight:700;font-family:var(--mono);letter-spacing:.05em}
.trend-buyers.sig-1{color:var(--gold)}.trend-buyers.sig-2{color:var(--green)}.trend-buyers.sig-3{color:var(--purple)}
.trend-age{font-size:10px;color:var(--t4);font-family:var(--mono)}
.trend-market{font-size:13px;font-weight:700;color:var(--t1);line-height:1.4;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.trend-outcome{display:inline-flex;align-items:center;gap:6px;margin-bottom:10px}
.trend-vol{font-size:22px;font-weight:900;font-family:var(--mono);color:var(--gold);margin-bottom:8px}
.trend-bar-wrap{background:rgba(255,255,255,.06);border-radius:100px;height:4px;margin-bottom:10px;overflow:hidden}
.trend-bar{height:100%;border-radius:100px;transition:width .4s ease}
.trend-bar.sig-1{background:var(--gold)}.trend-bar.sig-2{background:var(--green)}.trend-bar.sig-3{background:linear-gradient(90deg,var(--purple),var(--green))}
.trend-traders{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}
.trend-trader-chip{font-size:10px;font-family:var(--mono);padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.06);color:var(--t3)}
.trend-follow{width:100%;padding:8px;border-radius:var(--r);background:var(--gold);color:#0B0C10;border:none;font-size:12px;font-weight:800;cursor:pointer;transition:all .15s}
.trend-follow:hover{background:#F5B820}
.trend-signal-lbl{font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px}
.trend-signal-lbl.sig-1{color:var(--gold)}.trend-signal-lbl.sig-2{color:var(--green)}.trend-signal-lbl.sig-3{color:var(--purple)}

</style>
</head>
<body>

<nav class="nav">
  <div class="logo"><div class="logo-mark">&#x1F4B0;</div>Sharp Money</div>
  <div class="nav-tabs">
    <button class="ntab on" onclick="showV('dashboard',this)"><i class="ti ti-layout-dashboard"></i><span>Dashboard</span></button>
    <button class="ntab" onclick="showV('alerts',this)"><i class="ti ti-bell"></i><span>Alerts<span id="acnt" style="display:none;background:var(--gold);color:#0B0C10;padding:1px 7px;border-radius:100px;font-size:10px;font-weight:800;margin-left:4px">0</span></span></button>
    <button class="ntab" onclick="showV('tracking',this)"><i class="ti ti-chart-bar"></i><span>Tracking</span></button>
    <button class="ntab" onclick="showV('traders',this)"><i class="ti ti-users"></i><span>Traders</span></button>
  </div>
  <div class="nav-r">
    <span class="cd" id="cdt"></span>
    <div class="live-pill"><div class="ldot" id="ldot"></div><span id="ltxt">Live</span></div>
    <button class="ibtn" onclick="doRef()"><i class="ti ti-refresh"></i></button>
    <button class="ibtn" onclick="openCfg()"><i class="ti ti-settings"></i></button>
  </div>
</nav>
<div class="page">
  <div id="v-dashboard" class="view on">
    <div class="hero" id="hero"><div class="hero-empty"><div style="font-size:44px;margin-bottom:12px">&#x1F4B0;</div><h2>Watching Smart Money</h2><p>Tracking top Polymarket traders for large sports buys. First alert fires automatically when a qualifying trade happens.</p></div></div>
    <div class="strip">
      <div class="sc gold"><div class="sc-lbl"><i class="ti ti-bell" style="font-size:12px"></i>Alerts</div><div class="sc-val" id="d-al">0</div><div class="sc-sub">all time</div></div>
      <div class="sc blue"><div class="sc-lbl"><i class="ti ti-coin" style="font-size:12px"></i>Volume</div><div class="sc-val" id="d-vo">$0</div><div class="sc-sub">in logged alerts</div></div>
      <div class="sc green"><div class="sc-lbl"><i class="ti ti-trophy" style="font-size:12px"></i>Win Rate</div><div class="sc-val" id="d-wr">&#8212;</div><div class="sc-sub" id="d-ws">no trades yet</div></div>
      <div class="sc purple"><div class="sc-lbl"><i class="ti ti-cash" style="font-size:12px"></i>P&amp;L</div><div class="sc-val" id="d-pl">&#8212;</div><div class="sc-sub">USDC est.</div></div>
    </div>
    <div class="row-s" id="trending-row" style="display:none">
      <div class="row-hdr">
        <div class="row-ttl"><em>&#x1F4A1;</em>Signal Strength</div>
        <div style="font-size:11px;color:var(--t3);font-family:var(--mono)">Multiple traders same side</div>
      </div>
      <div class="row-scr" id="d-trend"></div>
    </div>
    <div class="row-s"><div class="row-hdr"><div class="row-ttl"><em>&#x1F514;</em>Recent Alerts</div><div class="row-all" onclick="showV('alerts',document.querySelectorAll('.ntab')[1])">See all <i class="ti ti-chevron-right" style="font-size:12px"></i></div></div><div class="row-scr" id="d-ar"><div style="color:var(--t4);font-size:13px;padding:20px 4px">Waiting for alerts&#x2026;</div></div></div>
    <div class="row-s"><div class="row-hdr"><div class="row-ttl"><em>&#x1F4C8;</em>Open Trades</div><div class="row-all" onclick="showV('tracking',document.querySelectorAll('.ntab')[2])">See all <i class="ti ti-chevron-right" style="font-size:12px"></i></div></div><div class="row-scr" id="d-tr"><div style="color:var(--t4);font-size:13px;padding:20px 4px">No open trades yet</div></div></div>
    <div class="row-s"><div class="row-hdr"><div class="row-ttl"><em>&#x1F3C6;</em>Top Sports Traders</div><div class="row-all" onclick="showV('traders',document.querySelectorAll('.ntab')[3])">See all <i class="ti ti-chevron-right" style="font-size:12px"></i></div></div><div class="row-scr" id="d-tp"><div style="color:var(--t4);font-size:13px;padding:20px 4px">Loading&#x2026;</div></div></div>
  </div>
  <div id="v-alerts" class="view">
    <div class="fbar">
      <div class="sw"><i class="ti ti-search"></i><input class="sinput" id="asearch" placeholder="Search markets or traders&#x2026;" oninput="renderAlerts()"></div>
      <button class="fp on" onclick="setAF('all',this)">All</button>
      <button class="fp" onclick="setAF('1k',this)">$1K+</button>
      <button class="fp" onclick="setAF('5k',this)">$5K+</button>
      <button class="fp" onclick="setAF('10k',this)">$10K+</button>
      <button class="fp" onclick="setAF('25k',this)">$25K+</button>
      <button onclick="purgeLosers()" style="padding:6px 12px;border-radius:100px;border:1px solid rgba(255,61,90,.3);background:rgba(255,61,90,.08);color:#FF3D5A;font-size:11px;font-weight:700;cursor:pointer;margin-left:auto" title="Remove alerts from losing traders">&#x1F5D1; Purge Losers</button>
    </div>
    <div class="al-list" id="al-list"></div>
  </div>
  <div id="v-tracking" class="view">

    <!-- Signal Strength Auto-Track -->
    <div style="margin-bottom:28px">
      <div class="row-hdr" style="margin-bottom:14px">
        <div class="row-ttl" style="font-size:16px"><em>&#x26A1;</em>Signal Strength Plays <span style="font-size:11px;color:var(--t3);font-weight:500;margin-left:6px">auto-tracked at 70+ score</span></div>
        <div id="sig-record" style="font-size:12px;font-family:var(--mono);color:var(--t3)">0W-0L</div>
      </div>
      <div id="sig-plays" style="display:flex;flex-direction:column;gap:8px"></div>
      <div id="sig-empty" class="empty" style="padding:30px"><div class="empty-ico">&#x26A1;</div><h3>No auto-tracked plays yet</h3><p>Signal Strength plays scoring 70+ are logged here automatically</p></div>
    </div>

    <div style="height:1px;background:var(--b1);margin:0 0 24px"></div>

    <!-- Manual Picks -->
    <div class="perf">
      <div class="pc"><div class="pc-val" id="tp-r">0&#x2013;0</div><div class="pc-lbl">My Picks Record</div></div>
      <div class="pc"><div class="pc-val" id="tp-w" style="color:var(--t4)">&#8212;</div><div class="pc-lbl">Win Rate</div></div>
      <div class="pc"><div class="pc-val" id="tp-p" style="color:var(--t4)">$0</div><div class="pc-lbl">Net P&amp;L</div></div>
    </div>
    <div class="row-hdr" style="margin-bottom:14px">
      <div class="row-ttl" style="font-size:16px"><em>&#x1F4CB;</em>My Picks</div>
      <button onclick="openTM()" style="padding:8px 18px;border-radius:100px;background:var(--gold);color:#0B0C10;border:none;font-size:13px;font-weight:800;cursor:pointer">+ Log Pick</button>
    </div>
    <div id="tl" style="display:flex;flex-direction:column;gap:9px"></div>
    <div id="tl-empty" class="empty" style="display:none;padding:30px"><div class="empty-ico">&#x1F4CB;</div><h3>No picks yet</h3><p>Follow a Polymarket alert or log manually</p></div>
  </div>
  <div id="v-traders" class="view">
    <div class="hot-wrap"><div class="hot-hdr"><span style="font-size:20px">&#x1F525;</span><span class="hot-ttl">Hot Right Now</span><span class="hot-sub" id="hot-sub">&#8212;</span></div><div id="hot-list"><div style="font-size:12px;color:var(--t4);text-align:center;padding:8px">Loading&#x2026;</div></div></div>
    <div class="row-hdr" style="margin-bottom:13px">
      <div class="row-ttl" style="font-size:16px"><em>&#x1F3C6;</em>Leaderboard</div>
      <button onclick="openAT()" style="padding:7px 16px;border-radius:100px;border:1px solid var(--b2);background:transparent;color:var(--t2);font-size:12px;font-weight:600;cursor:pointer">+ Watch Wallet</button>
    </div>
    <div class="lb-wrap">
      <div class="lb-tabs" style="overflow-x:auto;display:flex;flex-wrap:nowrap">
        <button class="lb-tab on" id="lbt-sports" onclick="setLT('sports',this)">&#x1F3C5; Sports</button>
        <button class="lb-tab" id="lbt-overall" onclick="setLT('overall',this)">&#x1F4B0; All-Time</button>
        <button class="lb-tab" id="lbt-mlb" onclick="setLT('mlb',this)">&#x26BE; MLB</button>
        <button class="lb-tab" id="lbt-nba" onclick="setLT('nba',this)">&#x1F3C0; NBA</button>
        <button class="lb-tab" id="lbt-nfl" onclick="setLT('nfl',this)">&#x1F3C8; NFL</button>
        <button class="lb-tab" id="lbt-nhl" onclick="setLT('nhl',this)">&#x1F3D2; NHL</button>
      </div>
      <div id="lb-list"></div>
    </div>
    <div class="row-hdr" style="margin:28px 0 14px"><div class="row-ttl" style="font-size:16px"><em>&#x1F441;&#xFE0F;</em>Watched Wallets</div></div>
    <div class="wgrid" id="wgrid"></div>
    <div id="wempty" class="empty" style="display:none"><div class="empty-ico">&#x1F441;&#xFE0F;</div><h3>No wallets tracked</h3><p>Add wallets from the leaderboard above</p></div>
  </div>
</div>
<div class="overlay" id="tm-ov" onclick="if(event.target===this)closeTM()">
  <div class="modal"><div class="mhdr"><span class="mttl" id="tm-ttl">Log a Trade</span><button class="mx" onclick="closeTM()">&#xD7;</button></div>
  <div class="mbody">
  <div class="fg"><label class="flbl">Market / Team</label><input class="finput" id="tm-mkt" placeholder="e.g. Milwaukee Brewers ML"></div>
  <div class="frow2">
    <div class="fg">
      <label class="flbl">American Odds</label>
      <input class="finput" id="tm-pr" placeholder="-110 or +150" oninput="updateOddsPreview()">
      <span id="tm-odds-preview" style="font-size:10px;color:var(--t3);font-family:var(--mono);margin-top:3px;display:block"></span>
    </div>
    <div class="fg"><label class="flbl">Bet Amount ($)</label><input class="finput" id="tm-am" type="number" min="0" placeholder="100"></div>
  </div>
  <div class="frow2">
    <div class="fg"><label class="flbl">Book</label>
      <select class="finput" id="tm-book">
        <option value="Novig">Novig</option>
        <option value="ProphetX">ProphetX</option>
        <option value="DraftKings">DraftKings</option>
        <option value="FanDuel">FanDuel</option>
        <option value="BetMGM">BetMGM</option>
        <option value="Caesars">Caesars</option>
        <option value="Pinnacle">Pinnacle</option>
        <option value="Other">Other</option>
      </select>
    </div>
    <div class="fg"><label class="flbl">Bet Type</label>
      <select class="finput" id="tm-type">
        <option value="ML">Moneyline</option>
        <option value="Spread">Spread</option>
        <option value="Total">Total (O/U)</option>
        <option value="Prop">Prop</option>
      </select>
    </div>
  </div>
  <div class="fg"><label class="flbl">Source / Notes</label><input class="finput" id="tm-tr" placeholder="e.g. Sharp alert, Polymarket signal, manual pick"></div>
  <div class="mft"><button class="btn-x" onclick="closeTM()">Cancel</button><button class="btn-p" onclick="saveTrade()">Save Trade</button></div>
</div></div>
</div>
<div class="overlay" id="at-ov" onclick="if(event.target===this)closeAT()">
  <div class="modal"><div class="mhdr"><span class="mttl">Watch a Wallet</span><button class="mx" onclick="closeAT()">&#xD7;</button></div>
  <div class="mbody"><div class="fg"><label class="flbl">Wallet Address</label><input class="finput" id="at-w" placeholder="0x&#x2026;"><span class="fhint">Copy from Polymarket profile URL</span></div><div class="fg"><label class="flbl">Display Name</label><input class="finput" id="at-n" placeholder="Optional"></div><div class="mft"><button class="btn-x" onclick="closeAT()">Cancel</button><button class="btn-p" onclick="saveTrader()">Add</button></div><div class="minfo" id="at-msg"></div></div></div>
</div>
<div class="overlay" id="cfg-ov" onclick="if(event.target===this)closeCfg()">
  <div class="modal"><div class="mhdr"><span class="mttl">Alert Settings</span><button class="mx" onclick="closeCfg()">&#xD7;</button></div>
  <div class="mbody"><div class="fg"><label class="flbl">ntfy.sh Topic</label><input class="finput" id="cfg-tp" placeholder="sharpidx-derek-2026"><span class="fhint">Download <a href="https://ntfy.sh" target="_blank">ntfy app</a> &#x2192; subscribe to this topic</span></div><div class="fg"><div class="thr-row"><label class="flbl">Min Alert Size</label><span class="thr-val" id="cfg-tv">$5,000</span></div><input type="range" min="1000" max="25000" value="5000" step="500" id="cfg-th" oninput="document.getElementById('cfg-tv').textContent='$'+parseInt(this.value).toLocaleString()" style="accent-color:var(--gold);width:100%"></div><div class="fg"><label class="flbl">Trader Pool</label><select class="finput" id="cfg-cat"><option value="all">All Tracked Traders</option><option value="OVERALL">Overall PnL Leaders</option><option value="SPORTS">Sports PnL Leaders</option></select></div><div class="mft"><button class="btn-t" onclick="testNotif()">Test</button><button class="btn-p" onclick="saveCfg()">Save</button></div><div class="minfo" id="cfg-msg"></div></div></div>
</div>

<script>

const ls=(k,d)=>{try{const v=localStorage.getItem(k);return v!==null?JSON.parse(v):d;}catch{return d;}};
const ss=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}};
const el=id=>document.getElementById(id);

// Migrate old keys
(function(){const m=[["pm:al","pm:alert-log"],["pm:wallets","pm:traders"],["pm:tp","pm:ntfy-topic"],["pm:th","pm:ntfy-thresh"],["pm:cat","pm:ntfy-cat"]];m.forEach(([o,n])=>{if(localStorage.getItem(o)!==null&&localStorage.getItem(n)===null){localStorage.setItem(n,localStorage.getItem(o));localStorage.removeItem(o);}});})();

let alerts=ls("pm:alert-log",[]),trades=ls("pm:trades",[]),wallets=ls("pm:traders",[]);
let af="all",lbTab="sports",lbData={overall:[],sports:[]},allBuys=[];
let cd=0,cdT,view="dashboard";
const REFRESH=10*60*1000;

// Sport detection
// ── APPROVED SPORTS WHITELIST ──
// ONLY these sports will show alerts, Signal Strength, or leaderboard entries.
// Everything else returns null and is silently excluded.

const MLB_TEAMS=["yankees","red sox","dodgers","cubs","mets","astros","braves","phillies","padres","giants","cardinals","brewers","guardians","royals","twins","orioles","rays","blue jays","mariners","rangers","angels","athletics","tigers","white sox","reds","pirates","rockies","marlins","nationals","diamondbacks"];

// Hard block list — checked FIRST, return null immediately
const BLOCKED_KW=["dota","valorant","cs2","counter-strike","league of legends","lol:","esports","starcraft","overwatch","fortnite","pubg","apex legends","rainbow six","rocket league","dota 2","hearthstone","call of duty","warzone","fifa esport","rl:","rl champ","esport","gaming","chess","poker","politics","election","crypto","bitcoin","ethereum","trump","biden","president","prime minister","economy","inflation","fed rate","will the fed","stock","s&p","nasdaq"];

function detectSport(title){
  var t=(title||"").toLowerCase();

  // 1. Hard block — esports, crypto, politics, etc.
  if(BLOCKED_KW.some(function(x){return t.includes(x);}))return null;

  // 2. WHITELIST — only these return a value. Everything else → null.

  // MLB / World Baseball Classic
  if(t.includes("mlb")||t.includes("world baseball classic")||t.includes("wbc")||MLB_TEAMS.some(function(x){return t.includes(x);}))return"MLB";

  // NBA
  if(t.includes("nba")||t.includes("nba finals")||t.includes("nba championship"))return"NBA";

  // NFL
  if(t.includes("nfl")||t.includes("super bowl")||t.includes("afc championship")||t.includes("nfc championship"))return"NFL";

  // NHL
  if(t.includes("nhl")||t.includes("stanley cup"))return"NHL";

  // College Football
  if(t.includes("ncaaf")||t.includes("college football playoff")||t.includes("cfp")||t.includes("cfb")||t.includes("rose bowl")||t.includes("orange bowl")||t.includes("sugar bowl")||t.includes("cotton bowl")||t.includes("fiesta bowl"))return"NCAAF";

  // College Basketball
  if(t.includes("ncaab")||t.includes("march madness")||t.includes("ncaa tournament")||t.includes("ncaa basketball")||t.includes("final four"))return"NCAAB";

  // PGA Golf
  if(t.includes("pga")||t.includes("masters ")||t.includes("ryder cup")||t.includes("the open championship")||t.includes("us open golf")||t.includes("pga championship")||t.includes("liv golf")||t.includes("jon rahm")||t.includes("rory mcilroy")||t.includes("tiger woods")||t.includes("scottie scheffler"))return"Golf";

  // FIFA World Cup (soccer) — ONLY World Cup, not club leagues
  if(t.includes("fifa world cup")||t.includes("world cup winner")||t.includes("world cup champion")||t.includes("gold cup")||t.includes("copa america")||t.includes("concacaf"))return"Soccer";

  // Olympics
  if(t.includes("olympic")||t.includes("olympics")||t.includes("paris 2024")||t.includes("la 2028")||t.includes("summer games")||t.includes("winter games"))return"Olympics";

  // Professional Tennis — Grand Slams + ATP/WTA only
  if(t.includes("wimbledon")||t.includes("us open tennis")||t.includes("french open")||t.includes("australian open")||t.includes("roland garros")||t.includes("atp ")||t.includes("wta ")||t.includes("grand slam")||(t.includes("tennis")&&!t.includes("table tennis")))return"Tennis";

  // Everything else is rejected
  return null;
}

// Async trader stats fetcher
const _sc={};
async function fetchTraderStats(wallet){
  if(_sc[wallet]!==undefined)return _sc[wallet];
  _sc[wallet]=null;
  try{
    const r=await fetch("https://data-api.polymarket.com/closed-positions?user="+wallet+"&limit=500");
    const pos=await r.json();
    if(!Array.isArray(pos)||!pos.length){_sc[wallet]={pnl:0,trades:0,wins:0,losses:0,sp:{},spW:{},spL:{}};return _sc[wallet];}
    let pnl=0,wins=0,losses=0;
    const sp={},spW={},spL={};
    pos.forEach(function(p){
      const v=parseFloat(p.cashPnl||p.pnl||0);
      pnl+=v;
      if(v>0)wins++;else if(v<0)losses++;
      const s=detectSport(p.title||p.question||"");
      if(s){
        sp[s]=(sp[s]||0)+v;
        if(v>0)spW[s]=(spW[s]||0)+1;
        else if(v<0)spL[s]=(spL[s]||0)+1;
      }
    });
    _sc[wallet]={pnl,trades:pos.length,wins,losses,sp,spW,spL};
    return _sc[wallet];
  }catch(e){_sc[wallet]={pnl:null,trades:0,wins:0,losses:0,sp:{},spW:{},spL:{}};return _sc[wallet];}
}

// Get trader's top sports from current buy feed
function getTraderSports(wallet) {
  const sportVol = {};
  allBuys.filter(function(b){return b.wallet===wallet;}).forEach(function(b){
    const sp = detectSport(b.title||'');
    if(sp) sportVol[sp]=(sportVol[sp]||0)+(b.usdValue||0);
  });
  return Object.entries(sportVol)
    .sort(function(a,b){return b[1]-a[1];})
    .slice(0,3)
    .map(function(e){return e[0];});
}

// Build stat block HTML
function winPct(w,l){var t=w+l;return t===0?null:Math.round(w/t*100);}
function buildSB(oe,se,fetched,sport){
  var rows=[],G="#00C896",R="#FF3D5A",T="rgba(245,246,250,.42)";
  function pnlRow(lbl,val){
    if(!val||val===0)return null;
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)"><span style="font-size:10px;color:'+T+';font-family:var(--mono)">'+lbl+'</span><span style="font-size:11px;font-family:var(--mono);font-weight:800;color:'+(val>=0?G:R)+'">'+fp(val)+'</span></div>';
  }
  function recRow(lbl,w,l){
    var tot=w+l;if(!tot)return null;
    var p=Math.round(w/tot*100);var c=p>=55?G:p>=50?"#E5A00D":R;
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)"><span style="font-size:10px;color:'+T+';font-family:var(--mono)">'+lbl+'</span><span style="font-size:11px;font-family:var(--mono);font-weight:800;color:'+c+'">'+p+'% ('+w+'W-'+l+'L)</span></div>';
  }
  function sportTag(s){return '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="font-size:10px;color:'+T+';font-family:var(--mono)">Market</span><span style="font-size:10px;font-family:var(--mono);font-weight:700;padding:2px 8px;background:rgba(64,180,255,.12);color:#40B4FF;border-radius:4px">'+s+'</span></div>';}
  if(oe&&oe.pnl)rows.push(pnlRow("All-Time PnL · #"+oe.rank,oe.pnl));
  else if(fetched&&fetched.pnl&&fetched.pnl!==0)rows.push(pnlRow("All-Time PnL",fetched.pnl));
  if(fetched&&(fetched.wins||fetched.losses))rows.push(recRow("All-Time Record",fetched.wins||0,fetched.losses||0));
  if(se&&se.pnl)rows.push(pnlRow("Sports PnL · #"+se.rank,se.pnl));
  if(sport&&fetched){
    var spPnl=fetched.sp?fetched.sp[sport]:null;
    var spW=fetched.spW?fetched.spW[sport]||0:0;
    var spL=fetched.spL?fetched.spL[sport]||0:0;
    if(spPnl)rows.push(pnlRow(sport+" PnL",spPnl));
    if(spW||spL)rows.push(recRow(sport+" Record",spW,spL));
  }
  if(sport)rows.push(sportTag(sport));
  var valid=rows.filter(Boolean);
  return valid.length?'<div style="background:var(--s2);border-radius:8px;padding:8px 11px;margin:8px 0">'+valid.join("")+'</div>':"";
}

async function enrichCards(){
  const cards=document.querySelectorAll("[data-wallet]");
  const seen=new Set();
  for(const card of cards){
    const w=card.dataset.wallet,sp=card.dataset.sport;
    if(!w||seen.has(w))continue;seen.add(w);
    const oe=lbData.overall.find(function(x){return x.wallet===w;});
    const se=lbData.sports.find(function(x){return x.wallet===w;});
    if(oe||se){
      const e=card.querySelector(".sb");if(e)e.innerHTML=buildSB(oe,se,_sc[w]||null,sp)||'<div style="font-size:10px;color:rgba(245,246,250,.3);text-align:center;padding:4px;font-family:var(--mono)">No leaderboard data</div>';
    }else{
      fetchTraderStats(w).then(function(f){
        const e=card.querySelector(".sb");
        if(!e)return;
        // Dim losing traders, skip their stats
        if(f&&f.pnl!==null&&f.pnl<0){
          // Aggressively mark and dim losing traders
          var lossStr=fp(Math.abs(f.pnl));
          var wr=f.wins+f.losses>0?Math.round(f.wins/(f.wins+f.losses)*100):null;
          e.innerHTML='<div style="background:rgba(255,61,90,.08);border:1px solid rgba(255,61,90,.2);border-radius:6px;padding:6px 8px;text-align:center">'
            +'<div style="font-size:11px;font-weight:800;color:#FF3D5A;margin-bottom:2px">&#x26A0; LOSING ACCOUNT</div>'
            +'<div style="font-size:10px;color:rgba(245,246,250,.5);font-family:var(--mono)">-'+lossStr+' all-time'+(wr!==null?' · '+wr+'% win rate':'')+'</div>'
            +'</div>';
          var c2=e.closest("[data-wallet]");
          if(c2){c2.style.opacity="0.3";c2.style.filter="grayscale(0.6)";}
          return;
        }
        const b=buildSB(null,null,f,sp);
        e.innerHTML=b||'<div style="font-size:10px;color:rgba(245,246,250,.25);text-align:center;padding:4px;font-family:var(--mono)">No history</div>';
      });
    }
  }
}

// Helpers
function timeAgo(ts){const s=Math.floor((Date.now()-(ts>1e12?ts:ts*1000))/1000);if(s<60)return s+"s ago";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago";}
function fu(n){return"$"+Math.round(n).toLocaleString();}
function fp(n){if(!n&&n!==0)return"$0";const abs=Math.abs(n);const v=abs>=1e6?"$"+(n/1e6).toFixed(1)+"M":abs>=1e3?"$"+(n/1e3).toFixed(1)+"K":"$"+Math.round(n).toLocaleString();return v;}
function bdg(cats){return(cats||[]).map(function(c){const ct=c.category||c.cat||"";return'<span class="badge badge-'+(ct==="OVERALL"?"o":"s")+'">'+(ct==="OVERALL"?"Overall":"Sports")+" #"+c.rank+"</span>";}).join("");}
function oc(o){const l=(o||"").toLowerCase();return l==="yes"?'<span class="oc-y">YES</span>':l==="no"?'<span class="oc-n">NO</span>':"<span>"+(o||"&#8212;")+"</span>";}
function calcP(t){
  const amt=parseFloat(t.amount)||0;
  // Support both new American odds and legacy Polymarket price format
  if(t.odds){
    const odds=parseInt(t.odds)||0;
    if(t.status==="WIN"){
      return odds<0
        ?Math.round(amt*(100/Math.abs(odds))*100)/100
        :Math.round(amt*(odds/100)*100)/100;
    }
    if(t.status==="LOSS")return -amt;
    return 0;
  }
  // Legacy Polymarket format (price in cents)
  const price=parseFloat(t.price)||50;
  if(t.status==="WIN")return Math.round(amt*(100/price-1)*100)/100;
  if(t.status==="LOSS")return -amt;
  return 0;
}

function showV(v,btn){view=v;document.querySelectorAll(".view").forEach(function(e){e.classList.remove("on");});document.querySelectorAll(".ntab").forEach(function(b){b.classList.remove("on");});el("v-"+v).classList.add("on");if(btn)btn.classList.add("on");if(v==="dashboard")renderDash();if(v==="alerts")renderAlerts();if(v==="tracking")renderTracking();if(v==="traders"){renderHot();renderLB();renderWallets();}}

async function fetchData(){
  el("ldot").style.background="#E5A00D";el("ltxt").textContent="Scanning";
  try{
    const[br,lr]=await Promise.all([fetch("/api/polymarket").then(function(r){return r.json();}).catch(function(){return{buys:[]};}),fetch("/api/polymarket-alerts").then(function(r){return r.json();}).catch(function(){return{alerts:[]};})]);
    allBuys=br.buys||[];
    if(br.leaderboard)lbData=br.leaderboard;
    const sa=lr.alerts||[];const eh=new Set(alerts.map(function(a){return a.transactionHash;}));
    sa.forEach(function(a){if(!eh.has(a.transactionHash))alerts.unshift(a);});
    alerts=alerts.slice(0,200);ss("pm:alert-log",alerts);
    const cnt=alerts.length;if(cnt){el("acnt").style.display="";el("acnt").textContent=cnt>99?"99+":cnt;}
    if(view==="dashboard")renderDash();if(view==="alerts")renderAlerts();if(view==="traders"){renderHot();renderLB();}
    el("ldot").style.background="#00C896";el("ltxt").textContent="Live";cd=REFRESH;
  }catch(e){el("ldot").style.background="var(--red)";el("ltxt").textContent="Error";}
}
function doRef(){fetchData();}

function renderHero(){
  const rec=alerts.filter(function(a){return(a.loggedAt||a.timestamp*1000)>Date.now()-86400000;}).sort(function(a,b){return b.usdValue-a.usdValue;});
  const t=rec[0];if(!t)return;
  const pr=(parseFloat(t.price||0)*100).toFixed(1);
  el("hero").innerHTML='<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 15% 60%,rgba(229,160,13,.1) 0%,transparent 55%),radial-gradient(ellipse at 85% 20%,rgba(64,180,255,.07) 0%,transparent 45%);pointer-events:none"></div>'
    +'<div style="position:relative">'
    +'<div class="hero-badge">&#x1F525; Biggest Buy Today</div>'
    +'<div class="hero-size">'+fu(t.usdValue)+'</div>'
    +'<div class="hero-market">'+(t.title||"Unknown")+'</div>'
    +'<div class="hero-meta"><strong>'+(t.traderName||"Anon")+'</strong><div class="hero-divider"></div><span>Bought '+(t.outcome||"").toUpperCase()+' @ '+pr+'&#xa2;</span><div class="hero-divider"></div><span>'+timeAgo(t.loggedAt||t.timestamp*1000)+'</span></div>'
    +'<button class="hero-cta" id="hero-follow-btn"><i class="ti ti-chart-bar" style="font-size:13px"></i>Follow This Trade</button>'
    +'</div>'
    +'<div class="hero-stats"><div class="hs"><div class="hs-val">'+alerts.length+'</div><div class="hs-lbl">Total Alerts</div></div><div class="hs"><div class="hs-val">'+fu(rec.reduce(function(a,b){return a+b.usdValue;},0))+'</div><div class="hs-lbl">Today&#x2019;s Vol</div></div></div>';
  window._heroAlert=t;
  document.getElementById("hero-follow-btn").onclick=function(){followAlert(t);};
}


// Check if wallet is a known loser from our stat cache
function isLosingTrader(wallet){
  if(!wallet)return false;
  var c=_sc[wallet];
  return c&&c.pnl!==null&&c.pnl<0;
}

// Build converging plays — ONLY from verified profitable traders
function buildTrending(){
  var cutoff=Date.now()-24*60*60*1000;
  var groups={};
  alerts.forEach(function(a){
    var ts=a.loggedAt||(a.timestamp*1000);
    if(ts<cutoff)return;
    // ── WHITELIST: skip if not an approved sport ──
    if(!detectSport(a.title))return;
    // Skip known losing traders
    if(isLosingTrader(a.wallet))return;
    // Skip if stats fetched and PnL is zero or negative (non-leaderboard loser)
    var inLB=lbData.overall.some(function(x){return x.wallet===a.wallet;})||lbData.sports.some(function(x){return x.wallet===a.wallet;});
    var cached=_sc[a.wallet];
    if(!inLB&&cached!==undefined&&cached!==null&&(cached.pnl===null||cached.pnl<=0))return;
    var key=(a.title||"")+"||"+(a.outcome||"");
    if(!key||key==="||")return;
    if(!groups[key]){groups[key]={title:a.title||"Unknown",outcome:a.outcome||"—",eventSlug:a.eventSlug,buys:[],totalVol:0,latestTs:0};}
    groups[key].buys.push(a);
    groups[key].totalVol+=(a.usdValue||0);
    if(ts>groups[key].latestTs)groups[key].latestTs=ts;
  });
  return Object.values(groups)
    .filter(function(g){return g.buys.length>=2||g.totalVol>=1000;})
    .sort(function(a,b){return(b.buys.length*b.buys.length*b.totalVol)-(a.buys.length*a.buys.length*a.totalVol);})
    .slice(0,8);
}

function sigClass(buyCount, vol) {
  if (buyCount >= 5 || vol >= 15000) return 'sig-3';
  if (buyCount >= 3 || vol >= 5000)  return 'sig-2';
  return 'sig-1';
}

function sigLabel(buyCount, vol) {
  if (buyCount >= 5 || vol >= 15000) return '&#x1F525; Very Strong';
  if (buyCount >= 3 || vol >= 5000)  return '&#x26A1; Strong';
  return '&#x26A0;&#xFE0F; Moderate';
}

function renderTrending() {
  const trends = buildTrending();
  const row = document.getElementById('trending-row');
  const cont = document.getElementById('d-trend');
  if (!trends.length) { if(row) row.style.display = 'none'; return; }
  if(row) row.style.display = '';

  // Max vol for bar scaling
  const maxVol = Math.max.apply(null, trends.map(function(t){return t.totalVol;}));

  autoTrackSignalPlays(trends);
  cont.innerHTML = trends.map(function(g) {
    const sc = sigClass(g.buys.length, g.totalVol);
    const barPct = Math.round((g.totalVol / maxVol) * 100);
    const uniqueTraders = g.buys
      .map(function(b){return b.traderName||'Anon';})
      .filter(function(v,i,a){return a.indexOf(v)===i;})
      .slice(0, 4);
    const link = g.eventSlug ? 'https://polymarket.com/event/'+g.eventSlug : '#';
    const ocStyle = (g.outcome||'').toLowerCase()==='yes'?'color:#00C896;font-weight:800':'color:#FF3D5A;font-weight:800';
    const sport = detectSport(g.title);
    const sportTag = sport ? ('<span style="font-size:9px;font-weight:700;padding:1px 6px;background:rgba(64,180,255,.12);color:#40B4FF;border-radius:3px;font-family:var(--mono);margin-left:5px">'+sport+'</span>') : '';

    return '<div class="trend-card '+sc+'">'
      +'<div class="trend-header">'
      +'<div><div class="trend-signal-lbl '+sc+'">'+sigLabel(g.buys.length,g.totalVol)+'</div>'
      +'<span class="trend-buyers '+sc+'">'+g.buys.length+' buyer'+(g.buys.length>1?'s':'')+' &middot; '+fu(g.totalVol)+' total</span></div>'
      +'<span class="trend-age">'+timeAgo(g.latestTs)+'</span>'
      +'</div>'
      +'<div class="trend-market">'+g.title+sportTag+'</div>'
      +'<div class="trend-outcome">Buying <span style="'+ocStyle+'">'+(g.outcome||'—')+'</span></div>'
      +'<div class="trend-bar-wrap"><div class="trend-bar '+sc+'" style="width:'+barPct+'%"></div></div>'
      +'<div class="trend-traders">'+uniqueTraders.map(function(n){
      // Truncate hex wallet addresses for display
      const display=n&&n.startsWith('0x')?(n.slice(0,6)+'...'+n.slice(-4)):n;
      return'<span class="trend-trader-chip">'+display+'</span>';
    }).join('')+'</div>'
      +'<a href="'+(g.eventSlug?'https://polymarket.com/event/'+g.eventSlug:'#')+'" target="_blank" class="trend-follow" style="display:block;text-align:center;text-decoration:none">View on Polymarket →</a>'
      +'</div>';
  }).join('');
}


/* ═══ SIGNAL STRENGTH AUTO-TRACKING ═══ */
let sigPlays = ls("pm:sig-plays", []);

// 0-100 convergence score
function convergenceScore(group) {
  var buyers = group.buys.length;
  var vol = group.totalVol;
  // Buyer score: 0-60 pts. Each buyer beyond first worth more (diminishing returns)
  var bs = Math.min(buyers <= 1 ? 0 : 10 + (buyers-2)*12, 60);
  // Volume score: 0-40 pts. $1K=5, $5K=15, $25K=30, $100K=40
  var vs = Math.min(Math.max(0, Math.log10(Math.max(vol,1000)/1000)*20), 40);
  return Math.round(bs + vs);
}

function sigLabel(score) {
  if (score >= 85) return {lbl:"&#x1F525; Elite",cls:"sig-3"};
  if (score >= 70) return {lbl:"&#x26A1; Strong",cls:"sig-2"};
  if (score >= 50) return {lbl:"&#x26A0;&#xFE0F; Moderate",cls:"sig-1"};
  return {lbl:"Weak",cls:""};
}

// Auto-log Signal Strength plays that hit 70+
function autoTrackSignalPlays(groups) {
  var changed = false;
  groups.forEach(function(g) {
    var score = convergenceScore(g);
    if (score < 70) return;
    // Check if already tracked
    var key = (g.title||"") + "||" + (g.outcome||"");
    var exists = sigPlays.some(function(p){return p.key===key;});
    if (exists) return;
    // Auto-log it
    sigPlays.unshift({
      key:       key,
      title:     g.title,
      outcome:   g.outcome,
      eventSlug: g.eventSlug,
      score:     score,
      buyers:    g.buys.length,
      totalVol:  g.totalVol,
      traders:   g.buys.map(function(b){return b.traderName||"Anon";}).filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,5),
      sport:     detectSport(g.title),
      loggedAt:  Date.now(),
      status:    "OPEN",
      resolution:null,
    });
    changed = true;
  });
  if (changed) ss("pm:sig-plays", sigPlays);
}

// Auto-grade: check Polymarket resolution
async function checkResolution(play) {
  if (play.status !== "OPEN" || !play.eventSlug) return null;
  try {
    const r = await fetch("https://data-api.polymarket.com/markets?eventSlug=" + play.eventSlug + "&limit=10");
    const data = await r.json();
    const markets = Array.isArray(data) ? data : (data.data||[]);
    // Find the matching market
    for (const m of markets) {
      if (!m.question || !m.question.toLowerCase().includes((play.title||"").toLowerCase().slice(0,20))) continue;
      if (m.resolution !== null && m.resolution !== undefined) {
        const res = String(m.resolution).toLowerCase();
        const ourOutcome = (play.outcome||"").toLowerCase();
        if (res === "yes" || res === "1" || res === "true") {
          return ourOutcome === "yes" ? "WIN" : "LOSS";
        }
        if (res === "no" || res === "0" || res === "false") {
          return ourOutcome === "no" ? "WIN" : "LOSS";
        }
      }
    }
  } catch(e) {}
  // Fallback: try ESPN scoreboard for team win markets
  return await checkESPN(play);
}

// ESPN scoreboard fallback
async function checkESPN(play) {
  const sport = play.sport;
  const espnSports = {MLB:"baseball/mlb",NBA:"basketball/nba",NFL:"football/nfl",NHL:"hockey/nhl"};
  const espnKey = espnSports[sport];
  if (!espnKey) return null;
  try {
    const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/" + espnKey + "/scoreboard");
    const data = await r.json();
    const events = data.events || [];
    const title = (play.title||"").toLowerCase();
    for (const ev of events) {
      if (!ev.status?.type?.completed) continue;
      const comps = ev.competitions?.[0]?.competitors || [];
      const homeTeam = (comps.find(c=>c.homeAway==="home")?.team?.name||"").toLowerCase();
      const awayTeam = (comps.find(c=>c.homeAway==="away")?.team?.name||"").toLowerCase();
      // Check if this game matches the play title
      if (!title.includes(homeTeam) && !title.includes(awayTeam)) continue;
      const homeScore = parseFloat(comps.find(c=>c.homeAway==="home")?.score||0);
      const awayScore = parseFloat(comps.find(c=>c.homeAway==="away")?.score||0);
      const homeWon = homeScore > awayScore;
      const outcome = (play.outcome||"").toLowerCase();
      // Team win: did our team win?
      if (outcome.includes(homeTeam)) return homeWon ? "WIN" : "LOSS";
      if (outcome.includes(awayTeam)) return homeWon ? "LOSS" : "WIN";
      // O/U total
      const total = homeScore + awayScore;
      const ouMatch = play.title.match(/o\/u\s*([0-9.]+)/i) || play.title.match(/([0-9.]+)\s*runs/i);
      if (ouMatch) {
        const line = parseFloat(ouMatch[1]);
        if (outcome === "over") return total > line ? "WIN" : "LOSS";
        if (outcome === "under") return total < line ? "WIN" : "LOSS";
      }
    }
  } catch(e) {}
  return null;
}

// Grade all open signal plays
async function gradeSignalPlays() {
  let changed = false;
  for (const play of sigPlays) {
    if (play.status !== "OPEN") continue;
    const result = await checkResolution(play);
    if (result) { play.status = result; play.gradedAt = Date.now(); changed = true; }
  }
  if (changed) { ss("pm:sig-plays", sigPlays); renderTracking(); }
}

function setSigStatus(key, status) {
  const p = sigPlays.find(function(x){return x.key===key;});
  if (p) { p.status=status; p.gradedAt=Date.now(); }
  ss("pm:sig-plays", sigPlays);
  renderTracking();
}

function renderTracking() {
  // Grade open plays in background
  gradeSignalPlays();

  // Signal Strength section
  const W=sigPlays.filter(function(p){return p.status==="WIN";}).length;
  const L=sigPlays.filter(function(p){return p.status==="LOSS";}).length;
  const wr=W+L>0?Math.round(W/(W+L)*100):null;
  const sigRec=el("sig-record");
  if(sigRec) sigRec.textContent=(W+L>0?W+"W-"+L+"L"+(wr!==null?" ("+wr+"%)":""):"0W-0L")+(W+L>0?" on "+sigPlays.length+" plays":"");
  if(sigRec&&wr!==null) sigRec.style.color=wr>=55?"#00C896":wr>=50?"#E5A00D":"#FF3D5A";

  const sigEl=el("sig-plays");
  const sigEmpty=el("sig-empty");
  if(sigEl){
    if(!sigPlays.length){if(sigEmpty)sigEmpty.style.display="";sigEl.innerHTML="";} 
    else {
      if(sigEmpty)sigEmpty.style.display="none";
      sigEl.innerHTML=sigPlays.map(function(p){
        var sc=sigLabel(p.score);
        var sport=p.sport||"";
        var sportTag=sport?'<span style="font-size:9px;font-weight:700;padding:1px 6px;background:rgba(64,180,255,.12);color:#40B4FF;border-radius:3px;font-family:var(--mono);margin-left:5px">'+sport+'</span>':"";
        var statusColor=p.status==="WIN"?"var(--green)":p.status==="LOSS"?"var(--red)":p.status==="PUSH"?"var(--t3)":"var(--purple)";
        var statusLabel=p.status==="OPEN"?"&#x23F3; Open":p.status==="WIN"?"&#x2705; WIN":p.status==="LOSS"?"&#x274C; LOSS":"&#x1F7F0; PUSH";
        var idx2=sigPlays.indexOf(p);
        var btns=p.status==="OPEN"
          ?('<div style="display:flex;gap:5px;margin-top:8px">'
            +'<button data-si="'+idx2+'" data-st="WIN" class="sgb" style="flex:1;padding:5px;border-radius:6px;border:1px solid rgba(0,200,150,.25);background:var(--grl);color:var(--green);font-size:11px;font-weight:700;cursor:pointer">W</button>'
            +'<button data-si="'+idx2+'" data-st="LOSS" class="sgb" style="flex:1;padding:5px;border-radius:6px;border:1px solid rgba(255,61,90,.25);background:var(--rl);color:var(--red);font-size:11px;font-weight:700;cursor:pointer">L</button>'
            +'<button data-si="'+idx2+'" data-st="PUSH" class="sgb" style="flex:1;padding:5px;border-radius:6px;border:1px solid var(--b2);background:transparent;color:var(--t3);font-size:11px;font-weight:700;cursor:pointer">P</button>'
            +'<button data-si="'+idx2+'" class="sdb" style="padding:5px 8px;border-radius:6px;border:1px solid var(--b1);background:transparent;color:var(--t4);font-size:11px;cursor:pointer">&#x1F5D1;</button>'
            +'</div>')
          :('<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center">'
            +'<span style="font-size:12px;font-weight:700;color:'+statusColor+'">'+statusLabel+'</span>'
            +'<button data-si="'+idx2+'" class="sdb" style="padding:3px 8px;border-radius:6px;border:1px solid var(--b1);background:transparent;color:var(--t4);font-size:11px;cursor:pointer">&#x1F5D1;</button>'
            +'</div>');
        return '<div style="background:var(--s1);border:1px solid '+(p.status==="WIN"?"var(--green)":p.status==="LOSS"?"var(--red)":"var(--b1)")+ ';border-left:3px solid '+(p.status==="WIN"?"var(--green)":p.status==="LOSS"?"var(--red)":p.status==="OPEN"?"var(--purple)":"var(--t3)")+';border-radius:var(--rl2);padding:13px 16px">'
          +'<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">'
          +'<div><span style="font-size:10px;font-weight:800;color:'+(p.score>=85?"var(--purple)":"var(--green)")+'">'+sc.lbl+'</span><span style="font-size:10px;font-family:var(--mono);color:var(--t3);margin-left:6px">Score: '+p.score+'</span>'+sportTag+'</div>'
          +'<span style="font-size:10px;color:var(--t4);font-family:var(--mono)">'+timeAgo(p.loggedAt)+'</span>'
          +'</div>'
          +'<div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:4px">'+p.title+'</div>'
          +'<div style="font-size:12px;color:var(--t3);margin-bottom:6px">Buying <strong style="color:var(--t1)">'+(p.outcome||"—")+'</strong> &middot; '+p.buyers+' buyer'+(p.buyers>1?"s":"")+" &middot; "+fu(p.totalVol)+' total</div>'
          +'<div style="display:flex;gap:4px;flex-wrap:wrap">'
          +(p.traders||[]).map(function(n){return'<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(255,255,255,.05);color:var(--t3);font-family:var(--mono)">'+n+'</span>';}).join("")
          +'</div>'
          +btns
          +"</div>";
      }).join("");
    }
  }

  // Manual picks section (existing trades logic)
  const W2=trades.filter(function(t){return t.status==="WIN";}).length;
  const L2=trades.filter(function(t){return t.status==="LOSS";}).length;
  const wr2=W2+L2>0?Math.round(W2/(W2+L2)*100):null;
  let pnl=0;trades.filter(function(t){return t.status!=="OPEN";}).forEach(function(t){pnl+=calcP(t);});
  el("tp-r").textContent=W2+"–"+L2;
  el("tp-w").textContent=wr2!==null?wr2+"%":"&#8212;";el("tp-w").style.color=wr2===null?"var(--t4)":wr2>=55?"var(--green)":wr2>=50?"var(--gold)":"var(--red)";
  el("tp-p").textContent=(pnl>=0?"+":"")+fu(pnl);el("tp-p").style.color=pnl>0?"var(--green)":pnl<0?"var(--red)":"var(--t4)";
  if(!trades.length){el("tl").innerHTML="";el("tl-empty").style.display="";return;}
  el("tl-empty").style.display="none";
  el("tl").innerHTML=trades.map(function(t){
    const p=calcP(t);
    const btns=t.status==="OPEN"
      ?('<button onclick="setSt(this)" data-id="'+t.id+'" data-st="WIN" style="padding:5px 11px;border-radius:6px;border:1px solid rgba(0,200,150,.25);background:var(--grl);color:var(--green);font-size:11px;font-weight:700;cursor:pointer">W</button>'
      +'<button onclick="setSt(this)" data-id="'+t.id+'" data-st="LOSS" style="padding:5px 11px;border-radius:6px;border:1px solid rgba(255,61,90,.25);background:var(--rl);color:var(--red);font-size:11px;font-weight:700;cursor:pointer;margin-left:4px">L</button>'
      +'<button onclick="setSt(this)" data-id="'+t.id+'" data-st="PUSH" style="padding:5px 11px;border-radius:6px;border:1px solid var(--b2);background:transparent;color:var(--t3);font-size:11px;font-weight:700;cursor:pointer;margin-left:4px">P</button>')
      :"";
    return'<div class="tl-row '+t.status.toLowerCase()+'">'
      +'<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+t.market+'</div><div style="font-size:11px;color:var(--t3);font-family:var(--mono)">'+(t.odds||t.price+"&#xa2;")+' · '+fu(parseFloat(t.amount)||0)+' · '+(t.book||"")+(t.notes?" · "+t.notes:"")+"</div></div>"
      +'<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">'+btns+'<span style="font-size:16px;font-weight:900;font-family:var(--mono);color:'+(p>0?"var(--green)":p<0?"var(--red)":"var(--t4)")+'">'+(t.status==="OPEN"?"Open":(p>=0?"+":"")+fu(p))+"</span>"
      +'<button data-del="'+t.id+'" class="tdb" style="background:transparent;border:none;color:var(--t4);cursor:pointer;font-size:15px;padding:4px"><i class="ti ti-trash"></i></button></div>'
      +"</div>";
  }).join("");
}

function deleteSigPlay(key){sigPlays=sigPlays.filter(function(p){return p.key!==key;});ss("pm:sig-plays",sigPlays);renderTracking();}

function renderDash(){
  renderHero();
  const set=trades.filter(function(t){return t.status!=="OPEN";});
  const W=set.filter(function(t){return t.status==="WIN";}).length,L=set.filter(function(t){return t.status==="LOSS";}).length;
  const wr=W+L>0?Math.round(W/(W+L)*100):null;
  let pnl=0;set.forEach(function(t){pnl+=calcP(t);});
  const vol=alerts.reduce(function(a,b){return a+(b.usdValue||0);},0);
  el("d-al").textContent=alerts.length;el("d-vo").textContent=fp(vol);
  el("d-wr").textContent=wr!==null?wr+"%":"&#8212;";el("d-wr").style.color=wr===null?"var(--t4)":wr>=55?"var(--green)":wr>=50?"var(--gold)":"var(--red)";
  el("d-ws").textContent=W+L>0?W+"W\u2013"+L+"L":"no trades yet";
  el("d-pl").textContent=pnl!==0?(pnl>0?"+":"")+fu(pnl):"&#8212;";el("d-pl").style.color=pnl>0?"var(--green)":pnl<0?"var(--red)":"var(--t4)";
  el("d-ar").innerHTML=alerts.slice(0,8).map(acardHTML).join("")||'<div style="color:var(--t4);font-size:13px;padding:20px 4px">No alerts yet</div>';
  el("d-tr").innerHTML=trades.filter(function(t){return t.status==="OPEN";}).slice(0,6).map(tcardHTML).join("")||'<div style="color:var(--t4);font-size:13px;padding:20px 4px">No open trades</div>';
  el("d-tp").innerHTML=(lbData.sports||[]).slice(0,10).map(posterHTML).join("")||'<div style="color:var(--t4);font-size:13px;padding:20px 4px">Loading&#x2026;</div>'; renderTrending();
  // Fetch closed positions for top traders to show sport PnL breakdown
  (lbData.sports||[]).slice(0,10).forEach(function(t){
    if(!_sc[t.wallet]){
      fetchTraderStats(t.wallet).then(function(){
        // Re-render just this poster if still visible
        const tp=el("d-tp");
        if(tp&&tp.children.length)tp.innerHTML=(lbData.sports||[]).slice(0,10).map(posterHTML).join("");
      });
    }
  });
  setTimeout(enrichCards,50);
}

window._al={};
function acardHTML(b){
  const pr=(parseFloat(b.price||0)*100).toFixed(1);
  const big=(b.usdValue||0)>=5000;
  const init=(b.traderName||"?").slice(0,2).toUpperCase();
  const sport=detectSport(b.title);
  const key=b.transactionHash||(b.wallet+(b.timestamp||""));
  window._al[key]=b;
  const oe=lbData.overall.find(function(x){return x.wallet===b.wallet;});
  const se=lbData.sports.find(function(x){return x.wallet===b.wallet;});
  const sbContent=(oe||se)?buildSB(oe,se,null,sport)||'<div style="font-size:10px;color:rgba(245,246,250,.3);text-align:center;padding:4px;font-family:var(--mono)">No record data</div>':'<div style="font-size:10px;color:rgba(245,246,250,.3);text-align:center;padding:4px;font-family:var(--mono)">Loading stats&#x2026;</div>';
  const avPart=b.profileImage
    ?('<img class="acard-av" src="'+b.profileImage+'" alt="'+init+'" onerror="this.outerHTML=\'<div class=\\"acard-av-fb\\">&init;</div>\'">')
    :('<div class="acard-av-fb">'+init+'</div>');
  return '<div class="acard'+(big?" big":"")+'" data-wallet="'+(b.wallet||"")+'" data-sport="'+(sport||"")+'">'
    +'<div class="acard-trader">'+avPart+'<div style="min-width:0"><div class="acard-tname">'+(b.traderName||"Anon")+'</div><div style="display:flex;gap:3px;margin-top:2px">'+bdg(b.categories)+'</div></div></div>'
    +'<div class="acard-mkt">'+(b.title||"Unknown")+'</div>'
    +'<div class="acard-oc">Bought '+oc(b.outcome)+' @ '+pr+'&#xa2;</div>'
    +'<div class="sb">'+sbContent+'</div>'
    +'<div class="acard-ft"><div><div class="acard-size">'+fu(b.usdValue||0)+'</div><div class="acard-time">'+timeAgo(b.loggedAt||b.timestamp*1000)+'</div></div>'
    +'<button class="acard-btn" data-key="'+key+'">Follow</button></div>'
    +'</div>';
}

// Event delegation for follow buttons
document.addEventListener("click",function(e){
  const btn=e.target.closest(".acard-btn");
  if(btn&&btn.dataset.key){followAlert(window._al[btn.dataset.key]);}
});

function tcardHTML(t){
  const p=calcP(t);const pc=p>0?"pos":p<0?"neg":"neu";
  return '<div class="tcard '+(t.status.toLowerCase())+'">'
    +'<div class="tc-mkt">'+t.market+'</div>'
    +'<div class="tc-det">'+(t.odds||t.price+'&#xa2;')+' · '+fu(parseFloat(t.amount)||0)+' · '+(t.book||'')+(t.notes?' · '+t.notes:'')+
    +'<div class="tc-ft"><span class="tc-status '+(t.status.toLowerCase())+'">'+t.status+'</span><span class="tc-pnl '+pc+'">'+(t.status==="OPEN"?"Open":(p>=0?"+":"")+fu(p))+'</span></div>'
    +(t.status==="OPEN"?'<div class="tc-btns"><button class="tc-btn" onclick="setSt(\''+t.id+'\',\'WIN\')">W</button><button class="tc-btn" onclick="setSt(\''+t.id+'\',\'LOSS\')">L</button><button class="tc-btn" onclick="setSt(\''+t.id+'\',\'PUSH\')">P</button></div>':"")
    +'</div>';
}

function posterHTML(t){
  const hot=alerts.some(function(a){return a.wallet===t.wallet&&(Date.now()-(a.loggedAt||a.timestamp*1000))<86400000;});
  const init=(t.name||"?").slice(0,2).toUpperCase();
  const isSp=t.category==="SPORTS"||t.category==="sports";
  const avPart=t.image?('<img class="p-av" src="'+t.image+'" alt="'+init+'">'):('<div class="p-av-fb">'+init+'</div>');
  const other=isSp?lbData.overall.find(function(x){return x.wallet===t.wallet;}):lbData.sports.find(function(x){return x.wallet===t.wallet;});
  const otherRow=other?('<div style="margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.06)"><div style="font-size:9px;color:rgba(245,246,250,.35);font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em">'+(isSp?"All-Time":"Sports")+' PnL</div><div style="font-size:13px;font-weight:800;font-family:var(--mono);color:'+(other.pnl>=0?"#00C896":"#FF3D5A")+';margin-top:1px">'+fp(other.pnl)+'</div></div>'):"";
  const topSports=getTraderSports(t.wallet);
  // Sport PnL breakdown from closed positions cache
  const cached=_sc[t.wallet];
  const sportPnlRows=cached&&cached.sp&&Object.keys(cached.sp).length
    ?Object.entries(cached.sp).filter(function(e){return e[1]!==0;}).sort(function(a,b){return Math.abs(b[1])-Math.abs(a[1]);}).slice(0,3).map(function(e){return'<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="font-size:9px;color:rgba(245,246,250,.4);font-family:var(--mono)">'+e[0]+'</span><span style="font-size:9px;font-weight:700;font-family:var(--mono);color:'+(e[1]>=0?'#00C896':'#FF3D5A')+'">'+fp(e[1])+'</span></div>';}).join('')
    :(topSports.length?('<div style="display:flex;gap:3px;flex-wrap:wrap">'+topSports.map(function(s){return'<span style="font-size:9px;font-weight:700;padding:2px 6px;background:rgba(64,180,255,.12);color:#40B4FF;border-radius:3px;font-family:var(--mono)">'+s+'</span>';}).join('')+'</div>'):'');
  const sportsRow=sportPnlRows?('<div style="margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,.06)"><div style="font-size:9px;color:rgba(245,246,250,.35);font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Sport Breakdown</div>'+sportPnlRows+'</div>'):"";
  return '<div class="poster'+(hot?" hot":"")+'">'
    +'<div class="poster-img">'+avPart+(hot?'<div class="p-live">LIVE</div>':"")+'</div>'
    +'<div class="poster-body">'
    +'<span class="p-rank '+(isSp?"sports":"overall")+'">#'+t.rank+' '+(isSp?"Sports":"Overall")+'</span>'+(hot?'<span class="p-rank hot-tag">&#x1F525;</span>':"")
    +'<div class="p-name">'+(t.name||t.wallet.slice(0,8)+"…")+'</div>'
    +'<div style="margin-top:5px"><div style="font-size:9px;color:rgba(245,246,250,.35);font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em">'+(isSp?"Sports":"Overall")+' PnL</div><div class="p-pnl" style="font-size:15px;margin-top:1px">'+fp(t.pnl)+'</div></div>'
    +otherRow+sportsRow
    +'</div></div>';
}

async function purgeLosers(){
  if(!confirm("This will remove all alerts from accounts with negative all-time PnL. Continue?"))return;
  // Fetch stats for all unique wallets in alert log, then remove losers
  const uniqueWallets=[...new Set(alerts.map(function(a){return a.wallet;}).filter(Boolean))];
  let purged=0;
  for(const w of uniqueWallets){
    const f=await fetchTraderStats(w);
    if(f&&f.pnl!==null&&f.pnl<0){
      const before=alerts.length;
      alerts=alerts.filter(function(a){return a.wallet!==w;});
      purged+=before-alerts.length;
    }
  }
  ss("pm:alert-log",alerts);
  renderAlerts();renderDash();
  alert("Removed "+purged+" alerts from losing accounts.");
}

function setAF(f,btn){af=f;document.querySelectorAll(".fp").forEach(function(b){b.classList.remove("on");});if(btn)btn.classList.add("on");renderAlerts();}
function renderAlerts(){
  const q=(el("asearch")?el("asearch").value||"":"").toLowerCase();
  const m={all:0,"1k":1000,"5k":5000,"10k":10000,"25k":25000};
  const fil=alerts.filter(function(b){if((b.usdValue||0)<(m[af]||0))return false;if(q&&!(b.title||"").toLowerCase().includes(q)&&!(b.traderName||"").toLowerCase().includes(q))return false;return true;});
  fil.forEach(function(b){window._al[b.transactionHash||(b.wallet+(b.timestamp||""))]=b;});
  const list=el("al-list");
  if(!fil.length){list.innerHTML='<div class="empty"><div class="empty-ico">&#x1F514;</div><h3>No alerts match</h3><p>Try a different filter</p></div>';return;}
  list.innerHTML=fil.map(function(b){
    const pr=(parseFloat(b.price||0)*100).toFixed(1);const big=(b.usdValue||0)>=5000;
    const init=(b.traderName||"?").slice(0,2).toUpperCase();
    const key=b.transactionHash||(b.wallet+(b.timestamp||""));
    const avPart=b.profileImage?('<img class="al-av" src="'+b.profileImage+'" alt="'+init+'">'):('<div class="al-av-fb">'+init+'</div>');
    const sport=detectSport(b.title);
    const sportTag=sport?('<span style="font-size:10px;font-family:var(--mono);font-weight:700;padding:1px 7px;background:rgba(64,180,255,.12);color:#40B4FF;border-radius:4px;margin-left:4px">'+sport+'</span>'):"";
    return '<div class="al-row'+(big?" big":"")+'" data-wallet="'+(b.wallet||"")+'" data-sport="'+(sport||"")+'">'
      +avPart
      +'<div class="al-main"><div class="al-trader">'+(b.traderName||"Anon")+bdg(b.categories)+sportTag+'</div><div class="al-mkt">'+(b.title||"Unknown")+'</div><div class="sb-inline-'+key+'" style="margin:4px 0"></div><div class="al-meta">Bought '+(b.outcome||"").toUpperCase()+' @ '+pr+'&#xa2;</div></div>'
      +'<div class="al-r"><div class="al-size">'+fu(b.usdValue||0)+'</div><div class="al-time">'+timeAgo(b.loggedAt||b.timestamp*1000)+'</div><button class="al-follow" data-key="'+key+'">Follow Trade</button></div>'
      +'</div>';
  }).join("");
  setTimeout(function(){
    enrichCards();
    // Also populate inline stat blocks in alerts view
    fil.forEach(function(b){
      const key=b.transactionHash||(b.wallet+(b.timestamp||""));
      const sp=detectSport(b.title);
      const oe=lbData.overall.find(function(x){return x.wallet===b.wallet;});
      const se=lbData.sports.find(function(x){return x.wallet===b.wallet;});
      const inlineEl=document.querySelector(".sb-inline-"+key);
      if(!inlineEl)return;
      if(oe||se){inlineEl.innerHTML=buildSB(oe,se,null,sp);}
      else{fetchTraderStats(b.wallet).then(function(f){if(inlineEl)inlineEl.innerHTML=buildSB(null,null,f,sp);});}
    });
  },50);
}

function renderTrades(){
  const W=trades.filter(function(t){return t.status==="WIN";}).length,L=trades.filter(function(t){return t.status==="LOSS";}).length;
  const wr=W+L>0?Math.round(W/(W+L)*100):null;let pnl=0;trades.filter(function(t){return t.status!=="OPEN";}).forEach(function(t){pnl+=calcP(t);});
  el("tp-r").textContent=W+"\u2013"+L;
  el("tp-w").textContent=wr!==null?wr+"%":"&#8212;";el("tp-w").style.color=wr===null?"var(--t4)":wr>=55?"var(--green)":wr>=50?"var(--gold)":"var(--red)";
  el("tp-p").textContent=(pnl>=0?"+":"")+fu(pnl);el("tp-p").style.color=pnl>0?"var(--green)":pnl<0?"var(--red)":"var(--t4)";
  if(!trades.length){el("tl").innerHTML="";el("tl-empty").style.display="";return;}
  el("tl-empty").style.display="none";
  el("tl").innerHTML=trades.map(function(t){
    const p=calcP(t);
    const btns=t.status==="OPEN"?'<button onclick="setSt(\''+t.id+'\',\'WIN\')" style="padding:5px 11px;border-radius:6px;border:1px solid rgba(0,200,150,.25);background:var(--grl);color:var(--green);font-size:11px;font-weight:700;cursor:pointer">W</button><button onclick="setSt(\''+t.id+'\',\'LOSS\')" style="padding:5px 11px;border-radius:6px;border:1px solid rgba(255,61,90,.25);background:var(--rl);color:var(--red);font-size:11px;font-weight:700;cursor:pointer;margin-left:4px">L</button><button onclick="setSt(\''+t.id+'\',\'PUSH\')" style="padding:5px 11px;border-radius:6px;border:1px solid var(--b2);background:transparent;color:var(--t3);font-size:11px;font-weight:700;cursor:pointer;margin-left:4px">P</button>':"";
    return '<div class="tl-row '+(t.status.toLowerCase())+'">'
      +'<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+t.market+'</div><div style="font-size:11px;color:var(--t3);font-family:var(--mono)">'+t.outcome+' @ '+t.price+'&#xa2; &middot; '+fu(parseFloat(t.amount)||0)+(t.trader?" &middot; "+t.trader:"")+'</div></div>'
      +'<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">'+btns+'<span style="font-size:16px;font-weight:900;font-family:var(--mono);color:'+(p>0?"var(--green)":p<0?"var(--red)":"var(--t4)")+'">'+(t.status==="OPEN"?"Open":(p>=0?"+":"")+fu(p))+'</span><button onclick="delTrade(\''+t.id+'\')" style="background:transparent;border:none;color:var(--t4);cursor:pointer;font-size:15px;padding:4px"><i class="ti ti-trash"></i></button></div>'
      +'</div>';
  }).join("");
}

function setSt(elOrId,s){var id=typeof elOrId==="string"?elOrId:elOrId.dataset.id;var st=s||elOrId.dataset.st;const t=trades.find(function(x){return x.id===id;});if(t)t.status=st;ss("pm:trades",trades);renderTracking();renderDash();}
function delTrade(id){trades=trades.filter(function(x){return x.id!==id;});ss("pm:trades",trades);renderTracking();renderDash();}

function renderHot(){
  const cutoff=Date.now()-86400000,hm={};
  alerts.forEach(function(a){const ts=a.loggedAt||(a.timestamp*1000);if(ts<cutoff||(a.usdValue||0)<1000)return;if(!hm[a.wallet]||a.usdValue>hm[a.wallet].usdValue)hm[a.wallet]=a;});
  const hot=Object.values(hm).sort(function(a,b){return b.usdValue-a.usdValue;}).slice(0,5);
  el("hot-sub").textContent=hot.length?hot.length+" trader"+(hot.length>1?"s":"")+" active today":"None today";
  el("hot-list").innerHTML=hot.length?hot.map(function(b){return'<div class="hot-row"><div class="hot-av">'+(b.traderName||"?").slice(0,2).toUpperCase()+'</div><div class="hot-info"><div class="hot-name">'+(b.traderName||"Anon")+bdg(b.categories)+'</div><div class="hot-mkt">'+(b.title||"Unknown")+"</div></div>"+'<div class="hot-sz">'+fu(b.usdValue)+'</div></div>';}).join(""):'<div style="font-size:12px;color:var(--t4);text-align:center;padding:8px">No qualifying buys in last 24h</div>';
}

function setLT(tab,btn){lbTab=tab;document.querySelectorAll(".lb-tab").forEach(function(b){b.classList.remove("on");});if(btn)btn.classList.add("on");renderLB();}

// Build sport-specific leaderboard from allBuys trade data
function buildSportLB(sportKey) {
  const sportMap = {
    mlb: ['yankees','red sox','dodgers','cubs','mets','astros','braves','phillies','padres','giants','cardinals','brewers','guardians','royals','twins','orioles','rays','blue jays','mariners','rangers','angels','athletics','tigers','white sox','reds','pirates','rockies','marlins','nationals','diamondbacks','baseball','mlb','first inning','run scored','innings'],
    nba: ['nba','basketball','nba finals'],
    nfl: ['nfl','football','super bowl','touchdown'],
    nhl: ['nhl','hockey','stanley cup','goals scored'],
  };
  const keywords = sportMap[sportKey] || [];
  const traderMap = {};
  allBuys.forEach(function(b) {
    const t = (b.title || '').toLowerCase();
    if (!keywords.some(function(k){return t.includes(k);})) return;
    if (!traderMap[b.wallet]) {
      traderMap[b.wallet] = {
        wallet: b.wallet,
        name: b.traderName,
        image: b.profileImage,
        categories: b.categories || [],
        totalVol: 0,
        trades: 0,
      };
    }
    traderMap[b.wallet].totalVol += (b.usdValue || 0);
    traderMap[b.wallet].trades++;
  });
  return Object.values(traderMap)
    .sort(function(a,b){return b.totalVol-a.totalVol;})
    .slice(0, 20)
    .map(function(t,i){return Object.assign({},t,{rank:i+1,pnl:t.totalVol,vol:t.totalVol,category:'SPORT'});});
}
function renderLB(){
  // Sport-specific tabs use trade data
  const sportTabs = {mlb:1,nba:1,nfl:1,nhl:1};
  // Filter to positive PnL winners only
  const rawList = sportTabs[lbTab] ? buildSportLB(lbTab) : (lbData[lbTab]||[]);
  const list = rawList.filter(function(t){return t.pnl>0;});
  const isSportTab = !!sportTabs[lbTab];
  if(!list.length){el("lb-list").innerHTML='<div class="empty"><div class="empty-ico">&#x1F3C6;</div><h3>'+(isSportTab?'No '+lbTab.toUpperCase()+' trades in current data':'Loading&#x2026;')+'</h3><p>'+(isSportTab?'Trades populate as alerts fire':'')+'</p></div>';return;}
  el("lb-list").innerHTML=list.map(function(t){
    const isW=wallets.some(function(w){return w.wallet===t.wallet;});
    const hot=alerts.some(function(a){return a.wallet===t.wallet&&(Date.now()-(a.loggedAt||a.timestamp*1000))<86400000;});
    const avPart=t.image?('<img class="lb-av" src="'+t.image+'" alt="'+((t.name||"?").slice(0,2).toUpperCase())+'" onerror="this.outerHTML=\'<div class=\\"lb-av-fb\\">'+(t.name||"?").slice(0,2).toUpperCase()+'</div>\'">'):'<div class="lb-av-fb">'+(t.name||"?").slice(0,2).toUpperCase()+'</div>';
    const als=alerts.filter(function(a){return a.wallet===t.wallet;});
    return '<div class="lb-row">'
      +'<div class="lb-rank'+(t.rank<=3?" t3":"")+'">#'+t.rank+'</div>'
      +avPart
      +'<div class="lb-info"><div class="lb-name">'+(hot?"&#x1F525; ":"")+(t.name||t.wallet.slice(0,8)+"\u2026")+'</div><div class="lb-meta"><span>Vol: '+fp(t.vol)+'</span>'+(als.length?'<span style="color:var(--gold)">'+als.length+' alert'+(als.length>1?"s":"")+'</span>':"")+'</div></div>'
      +'<div class="lb-pnl-col"><div class="lb-pnl">'+fp(t.pnl)+'</div><div class="lb-pnl-lbl">'+(t.category==="SPORT"?"Buy Vol":(t.category==="OVERALL"?"All-Time":"Sports"))+' PnL'+(t.trades?' &middot; '+t.trades+'x':'')+'</div></div>'
      +(isW?'<button class="lb-add w"><i class="ti ti-eye" style="font-size:10px"></i> Watching</button>':'<button class="lb-add" onclick="qAdd(\''+t.wallet+'\',\''+(t.name||"").replace(/'/g,"\\'")+'\')"><i class="ti ti-plus" style="font-size:10px"></i> Watch</button>')
      +'</div>';
  }).join("");
}

async function renderWallets(){
  if(!wallets.length){el("wgrid").innerHTML="";el("wempty").style.display="";return;}
  el("wempty").style.display="none";
  el("wgrid").innerHTML=wallets.map(function(w){return wcardHTML(w,[]);}).join("");
  for(const w of wallets){
    try{const r=await fetch("https://data-api.polymarket.com/trades?user="+w.wallet+"&side=BUY&takerOnly=true&limit=4");const b=await r.json();const c=el("wc-"+w.wallet);if(c&&Array.isArray(b)){const bd=c.querySelector(".wcard-body");if(bd)bd.innerHTML=wbodyHTML(w,b);}}catch(e){}
  }
}
function wcardHTML(w,buys){
  const oe=lbData.overall.find(function(x){return x.wallet===w.wallet;});
  const se=lbData.sports.find(function(x){return x.wallet===w.wallet;});
  const bs=[oe?'<span class="badge badge-o">Overall #'+oe.rank+'</span>':null,se?'<span class="badge badge-s">Sports #'+se.rank+'</span>':null].filter(Boolean).join("");
  return '<div class="wcard" id="wc-'+w.wallet+'">'
    +'<div class="wcard-hdr"><div class="wc-av-fb">'+(w.name||w.wallet).slice(0,2).toUpperCase()+'</div><div><div class="wc-name">'+(w.name||w.wallet.slice(0,8)+"\u2026")+'</div><div class="wc-bdg">'+bs+'</div></div></div>'
    +'<div class="wcard-body">'+wbodyHTML(w,buys)+'</div>'
    +'<div class="wcard-ft"><a class="wcard-link" href="https://polymarket.com/profile/'+w.wallet+'" target="_blank">View on Polymarket &#x2192;</a><button class="wcard-rm" onclick="rmW(\''+w.wallet+'\')"><i class="ti ti-trash" style="font-size:12px"></i></button></div>'
    +'</div>';
}
function wbodyHTML(w,buys){
  const oe=lbData.overall.find(function(x){return x.wallet===w.wallet;});
  const se=lbData.sports.find(function(x){return x.wallet===w.wallet;});
  const myA=alerts.filter(function(a){return a.wallet===w.wallet;});
  const pnlRows=[oe?'<div class="wpnl-row"><span class="wpnl-lbl">All-Time PnL</span><span class="wpnl-val" style="color:'+(oe.pnl>=0?"var(--green)":"var(--red)")+'">'+fp(oe.pnl)+'</span></div>':null,se?'<div class="wpnl-row"><span class="wpnl-lbl">Sports PnL</span><span class="wpnl-val" style="color:'+(se.pnl>=0?"var(--green)":"var(--red)")+'">'+fp(se.pnl)+'</span></div>':null,'<div class="wpnl-row" style="border-bottom:none"><span class="wpnl-lbl">Alerts</span><span class="wpnl-val" style="color:var(--gold)">'+myA.length+'</span></div>'].filter(Boolean).join("");
  const rec=Array.isArray(buys)&&buys.length?buys.slice(0,3).map(function(b){const u=(parseFloat(b.size)||0)*(parseFloat(b.price)||0);return'<div class="wrec-row"><span class="wrec-mkt">'+(b.title||"Unknown")+'</span><span class="wrec-sz">'+fu(u)+'</span></div>';}).join(""):'<div style="font-size:11px;color:var(--t4);padding:4px 0">Loading&#x2026;</div>';
  return'<div style="margin-bottom:10px">'+pnlRows+'</div><div class="wrec-lbl">Recent Buys</div>'+rec;
}
function qAdd(wallet,name){if(wallets.find(function(w){return w.wallet===wallet;}))return;wallets.push({wallet,name:name||null,addedAt:Date.now()});ss("pm:traders",wallets);renderLB();renderWallets();}
function rmW(wallet){wallets=wallets.filter(function(w){return w.wallet!==wallet;});ss("pm:traders",wallets);renderWallets();}

function openTM(pre){pre=pre||{};el("tm-ttl").textContent=pre.market?"Follow This Trade":"Log a Trade";el("tm-mkt").value=pre.market||"";el("tm-oc").value=pre.outcome||"YES";el("tm-pr").value=pre.price||"";el("tm-am").value="";el("tm-tr").value=pre.trader||"";el("tm-ov").classList.add("open");}
function closeTM(){el("tm-ov").classList.remove("open");}
function saveTrade(){
  const m=el("tm-mkt").value.trim();
  if(!m){el("tm-mkt").style.borderColor="var(--red)";return;}
  const oddsRaw=el("tm-pr").value.trim();
  const odds=parseInt(oddsRaw)||0;
  if(!odds||isNaN(odds)){el("tm-pr").style.borderColor="var(--red)";el("tm-pr").placeholder="-110 or +150";return;}
  trades.unshift({
    id:       Date.now().toString(),
    market:   m,
    odds:     oddsRaw,
    amount:   el("tm-am").value||"0",
    book:     el("tm-book")?el("tm-book").value:"Novig",
    betType:  el("tm-type")?el("tm-type").value:"ML",
    notes:    el("tm-tr").value.trim(),
    status:   "OPEN",
    createdAt:Date.now(),
  });
  ss("pm:trades",trades);closeTM();renderTracking();renderDash();
}
function followAlert(b){if(!b)return;openTM({market:b.title||'',odds:'',trader:b.traderName||'',betType:'ML'});showV('trades',document.querySelectorAll('.ntab')[2]);}

function openAT(){el("at-w").value="";el("at-n").value="";el("at-msg").textContent="";el("at-ov").classList.add("open");}
function closeAT(){el("at-ov").classList.remove("open");}
function saveTrader(){const w=el("at-w").value.trim();if(!w||!w.startsWith("0x")){el("at-msg").style.color="var(--red)";el("at-msg").textContent="Enter wallet starting with 0x";return;}if(wallets.find(function(t){return t.wallet===w;})){el("at-msg").style.color="var(--gold)";el("at-msg").textContent="Already watching";return;}wallets.push({wallet:w,name:el("at-n").value.trim()||null,addedAt:Date.now()});ss("pm:traders",wallets);closeAT();renderWallets();}

function openCfg(){el("cfg-tp").value=ls("pm:ntfy-topic","")||"";const t=ls("pm:ntfy-thresh","5000")||"5000";el("cfg-th").value=t;el("cfg-tv").textContent="$"+parseInt(t).toLocaleString();el("cfg-cat").value=ls("pm:ntfy-cat","all")||"all";el("cfg-msg").textContent="";el("cfg-ov").classList.add("open");}
function closeCfg(){el("cfg-ov").classList.remove("open");}
function saveCfg(){ss("pm:ntfy-topic",el("cfg-tp").value.trim());ss("pm:ntfy-thresh",el("cfg-th").value);ss("pm:ntfy-cat",el("cfg-cat").value);el("cfg-msg").style.color="var(--green)";el("cfg-msg").textContent="&#x2713; Saved";setTimeout(closeCfg,800);}
async function testNotif(){const t=el("cfg-tp").value.trim();if(!t){el("cfg-msg").style.color="var(--red)";el("cfg-msg").textContent="Enter a topic";return;}el("cfg-msg").style.color="var(--gold)";el("cfg-msg").textContent="Sending&#x2026;";try{await fetch("https://ntfy.sh/"+t,{method:"POST",mode:"no-cors",body:"&#x1F4B0; Sharp Money is live!"});el("cfg-msg").style.color="var(--green)";el("cfg-msg").textContent="&#x2713; Sent &#x2014; check phone";}catch(e){el("cfg-msg").style.color="var(--red)";el("cfg-msg").textContent="Error: "+e.message;}}

function startCd(){clearInterval(cdT);cdT=setInterval(function(){if(document.hidden)return;if(cd>0)cd-=1000;else{cd=REFRESH;fetchData();}const m=Math.floor(cd/60000),s=Math.floor((cd%60000)/1000);el("cdt").textContent=m+":"+s.toString().padStart(2,"0");},1000);}
document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeTM();closeAT();closeCfg();}});
renderDash();fetchData();cd=REFRESH;startCd();setTimeout(renderTrending,200);

</script>
</body>
</html>
