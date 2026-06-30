// The hoopilot live dashboard: a single self-contained HTML document served at
// GET /dashboard. It is intentionally dependency-free — all CSS and JS are inline
// and there are no external fonts, images, or scripts — so it works fully offline,
// inside a compiled standalone binary, and behind restrictive proxies. The page
// polls GET /v1/usage on an interval and renders proxy status + Copilot quota,
// computing per-second rates client-side from successive snapshots.
//
// Authored as a plain string (not a loader-imported asset) so it bundles with zero
// configuration across `bun run`, tsup/esbuild, and `bun build --compile`. The
// embedded source therefore avoids backticks and template substitutions.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<title>hoopilot &middot; dashboard</title>
<style>
:root {
  --bg-0:#0b0e14; --bg-1:#11151c; --bg-2:#171c25; --bg-3:#1f2630;
  --border:#262d38; --border-strong:#37404d;
  --text-0:#e6edf3; --text-1:#9aa7b4; --text-2:#5e6b78; --text-dim:#3a434e; --text-inv:#0b0e14;
  --accent:#4ea1ff; --accent-2:#56d4dd; --accent-soft:rgba(78,161,255,.14);
  --amber:#f5b042;
  --ok:#3fb950; --warn:#d8a13a; --danger:#f0556a; --info:#a371f7; --cache:#7c8cff;
  --spark:#4ea1ff; --spark-fill:color-mix(in srgb, var(--accent) 14%, transparent);
  --grid-line:rgba(255,255,255,.05);
  --flash:color-mix(in srgb, var(--accent) 22%, transparent);
  --flash-up:color-mix(in srgb, var(--ok) 22%, transparent);
  --flash-down:color-mix(in srgb, var(--danger) 22%, transparent);
  --c1:#4ea1ff; --c2:#3fb950; --c3:#d8a13a; --c4:#a371f7; --c5:#56d4dd; --c6:#f0556a;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, system-ui, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg-0:#f6f8fa; --bg-1:#ffffff; --bg-2:#f0f3f6; --bg-3:#e9edf1;
    --border:#d0d7de; --border-strong:#b6bec8;
    --text-0:#1f2328; --text-1:#5a6570; --text-2:#8a96a3; --text-dim:#bcc2c9; --text-inv:#ffffff;
    --accent:#0969da; --accent-2:#0a7ea4; --accent-soft:rgba(9,105,218,.12);
    --amber:#b5730a;
    --ok:#1a7f37; --warn:#9a6700; --danger:#cf222e; --info:#8250df; --cache:#5563e0;
    --spark:#0969da; --spark-fill:color-mix(in srgb, var(--accent) 12%, transparent);
    --grid-line:rgba(0,0,0,.06);
    --flash:color-mix(in srgb, var(--accent) 16%, transparent);
    --flash-up:color-mix(in srgb, var(--ok) 16%, transparent);
    --flash-down:color-mix(in srgb, var(--danger) 16%, transparent);
    --c1:#0969da; --c2:#1a7f37; --c3:#9a6700; --c4:#8250df; --c5:#0a7ea4; --c6:#cf222e;
  }
}
[data-theme="light"] {
  --bg-0:#f6f8fa; --bg-1:#ffffff; --bg-2:#f0f3f6; --bg-3:#e9edf1;
  --border:#d0d7de; --border-strong:#b6bec8;
  --text-0:#1f2328; --text-1:#5a6570; --text-2:#8a96a3; --text-dim:#bcc2c9; --text-inv:#ffffff;
  --accent:#0969da; --accent-2:#0a7ea4; --accent-soft:rgba(9,105,218,.12);
  --amber:#b5730a;
  --ok:#1a7f37; --warn:#9a6700; --danger:#cf222e; --info:#8250df; --cache:#5563e0;
  --spark:#0969da; --spark-fill:color-mix(in srgb, var(--accent) 12%, transparent);
  --grid-line:rgba(0,0,0,.06);
  --flash:color-mix(in srgb, var(--accent) 16%, transparent);
  --flash-up:color-mix(in srgb, var(--ok) 16%, transparent);
  --flash-down:color-mix(in srgb, var(--danger) 16%, transparent);
  --c1:#0969da; --c2:#1a7f37; --c3:#9a6700; --c4:#8250df; --c5:#0a7ea4; --c6:#cf222e;
}
* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body {
  background: var(--bg-0); color: var(--text-0); font-family: var(--sans);
  font-size: 13px; line-height: 1.4; -webkit-font-smoothing: antialiased;
}
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums slashed-zero; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums slashed-zero; }
.shell { max-width: 1280px; margin: 0 auto; padding: 0 24px 28px; }
@media (min-width: 1080px) { .shell { border-left:1px solid var(--border); border-right:1px solid var(--border); } }
@media (max-width: 680px) { .shell { padding: 0 12px 24px; } }

/* header */
header.bar {
  position: sticky; top: 0; z-index: 20; background: var(--bg-1);
  border-bottom: 1px solid var(--border); height: 48px;
}
.bar-in { max-width:1280px; margin:0 auto; height:48px; padding:0 24px; display:flex; align-items:center; gap:12px; }
@media (max-width:680px){ .bar-in{ padding:0 12px; gap:8px; } }
.wordmark { font-family: var(--mono); font-weight:700; font-size:14px; color:var(--text-0); letter-spacing:-.01em; }
.caret { display:inline-block; width:7px; height:15px; background:var(--amber); margin-left:3px; vertical-align:-2px; animation: blink 1.1s steps(1) infinite; }
.chip { font-family: var(--mono); font-size:11px; padding:2px 7px; border-radius:10px; background:var(--bg-3); color:var(--text-1); white-space:nowrap; }
.chip.plan-pro { background:var(--accent-soft); color:var(--accent); }
.chip.plan-business { background:color-mix(in srgb, var(--info) 16%, transparent); color:var(--info); }
.chip.plan-free, .chip.plan-offline { background:var(--bg-3); color:var(--text-2); }
.spacer { flex:1; }
.pill { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-family:var(--mono); padding:3px 9px; border-radius:11px; background:var(--bg-3); color:var(--text-1); }
.dot { width:7px; height:7px; border-radius:50%; background:var(--text-2); flex:none; }
.pill.live .dot { background:var(--ok); }
.pill.paused .dot { background:var(--text-2); }
.pill.reconnect { color:var(--warn); } .pill.reconnect .dot { background:var(--warn); }
.pill.authkey { color:var(--warn); } .pill.authkey .dot { background:var(--warn); }
.heartbeat { animation: hb .5s ease-out; }
.updated { font-family:var(--mono); font-size:11px; color:var(--text-2); white-space:nowrap; }
.updated.warn { color:var(--warn); } .updated.danger { color:var(--danger); }
.seg { display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
.seg button { background:transparent; color:var(--text-1); border:0; font-family:var(--mono); font-size:11px; padding:3px 8px; cursor:pointer; }
.seg button + button { border-left:1px solid var(--border); }
.seg button.active { background:var(--accent); color:var(--text-inv); }
.iconbtn { background:transparent; border:1px solid var(--border); border-radius:6px; color:var(--text-1); cursor:pointer; font-size:13px; line-height:1; padding:4px 7px; min-width:30px; }
.iconbtn:hover { background:var(--bg-3); }
button:focus-visible, input:focus-visible, .seg button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
#scanbar { position:absolute; left:0; bottom:-1px; height:1px; width:100%; overflow:hidden; }
#scanbar::after { content:""; position:absolute; left:0; top:0; height:1px; width:40%;
  background:linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: scan var(--scan-ms, 4000ms) linear infinite; }
header.bar.paused #scanbar::after, header.bar.frozen #scanbar::after { animation-play-state:paused; opacity:.35; }

/* disconnect banner */
#banner { display:none; margin-top:10px; padding:7px 12px; border-radius:5px; font-family:var(--mono); font-size:12px;
  background:color-mix(in srgb, var(--danger) 16%, transparent); color:var(--danger); border:1px solid color-mix(in srgb, var(--danger) 40%, transparent); }
#banner.ok { background:color-mix(in srgb, var(--ok) 16%, transparent); color:var(--ok); border-color:color-mix(in srgb, var(--ok) 40%, transparent); }
#banner.show { display:block; }

/* hero strip */
.hero { display:grid; grid-template-columns:repeat(4,1fr); margin:18px 0 16px; }
.vital { padding:6px 18px; }
.vital + .vital { border-left:1px solid var(--border); }
.vital .eyebrow { font-size:10px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text-1); }
.vital .vnum { font-family:var(--mono); font-variant-numeric:tabular-nums slashed-zero; font-weight:600; font-size:clamp(2rem,5vw,3.25rem); line-height:1.02; letter-spacing:-.02em; color:var(--text-0); }
.vital .vsub { font-size:11px; color:var(--text-2); min-height:14px; }
.vital .vspark { display:block; width:100%; height:24px; margin-top:4px; }
.vital.active { }
.vital.active .eyebrow { color:var(--accent); }
@media (max-width:1079px){ .hero{ grid-template-columns:repeat(2,1fr); } .vital:nth-child(3){ border-left:0; } .vital:nth-child(n+3){ border-top:1px solid var(--border); padding-top:12px; } }
@media (max-width:600px){ .hero{ grid-template-columns:1fr; } .vital + .vital{ border-left:0; border-top:1px solid var(--border); } }

/* grid + panels */
.grid { display:grid; grid-template-columns:repeat(12,1fr); gap:12px; }
.panel { position:relative; background:var(--bg-1); border:1px solid var(--border); border-radius:4px; padding:16px 12px 12px; min-width:0; }
.panel > .ptitle { position:absolute; top:-8px; left:10px; padding:0 6px; background:var(--bg-1);
  font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-1); }
.span5{ grid-column:span 5; } .span3{ grid-column:span 3; } .span4{ grid-column:span 4; }
.span7{ grid-column:span 7; } .span8{ grid-column:span 8; }
@media (max-width:1079px){ .grid{ grid-template-columns:repeat(6,1fr); }
  .span5,.span7,.span8{ grid-column:span 6; } .span3{ grid-column:span 3; } .span4{ grid-column:span 6; } }
@media (max-width:680px){ .grid{ grid-template-columns:1fr; }
  .span3,.span4,.span5,.span7,.span8{ grid-column:span 1; } }

.headline { font-family:var(--mono); font-variant-numeric:tabular-nums slashed-zero; font-weight:600; font-size:22px; line-height:1.1; }
.cap { font-size:11px; color:var(--text-2); }
.stack-bar { display:flex; height:8px; border-radius:4px; overflow:hidden; background:var(--bg-3); margin:8px 0; }
.stack-bar i { display:block; height:100%; }
.stack-bar.empty { outline:1px dashed var(--border); background:transparent; }

table.tbl { width:100%; border-collapse:collapse; font-family:var(--mono); font-variant-numeric:tabular-nums slashed-zero; font-size:12px; }
.scrollx { overflow-x:auto; }
table.tbl th { font-size:10px; font-weight:600; text-transform:uppercase; color:var(--text-2); text-align:right; padding:4px 6px; border-bottom:1px solid var(--border); white-space:nowrap; }
table.tbl th.l { text-align:left; }
table.tbl td { padding:3px 6px; text-align:right; white-space:nowrap; border-bottom:1px solid color-mix(in srgb, var(--border) 55%, transparent); }
table.tbl td.l { text-align:left; max-width:160px; overflow:hidden; text-overflow:ellipsis; }
table.tbl tr:hover td { background:var(--bg-2); }
table.tbl tr.total td { border-top:1px solid var(--border-strong); border-bottom:0; font-weight:600; color:var(--text-0); }
.minibar { display:inline-block; height:6px; border-radius:3px; background:var(--accent); vertical-align:middle; min-width:1px; }
.ghost td { color:var(--text-2); text-align:center; }
.reasoning { color:var(--info); } .cached { color:var(--cache); }

.legend { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; }
.legend .li { display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; color:var(--text-1); }
.legend .sw { width:8px; height:8px; border-radius:2px; flex:none; }

.lat-trio { display:flex; gap:18px; align-items:baseline; }
.lat-trio .b { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:20px; font-weight:600; }
.lat-trio .b small { display:block; font-size:10px; font-weight:600; text-transform:uppercase; color:var(--text-2); letter-spacing:.05em; }
.lat-p95 { color:var(--info); }
.lat-track { position:relative; height:22px; margin-top:10px; }
.lat-track .line { position:absolute; top:11px; left:0; right:0; height:1px; background:var(--border); }
.lat-track .tick { position:absolute; top:5px; width:2px; height:12px; border-radius:1px; }
.lat-track .tick.p50 { background:var(--accent); } .lat-track .tick.p95 { background:var(--info); }
.lat-track .tlab { position:absolute; top:-2px; font-family:var(--mono); font-size:9px; color:var(--text-2); transform:translateX(-50%); }
details.routes { margin-top:10px; } details.routes summary { cursor:pointer; font-size:11px; color:var(--text-2); font-family:var(--mono); }

.qrow { margin:10px 0; } .qrow .qhead { display:flex; justify-content:space-between; align-items:baseline; font-size:12px; }
.qrow .qname { color:var(--text-1); } .qrow .qval { font-family:var(--mono); font-variant-numeric:tabular-nums; color:var(--text-0); }
.qbar { position:relative; height:8px; border-radius:4px; background:var(--bg-3); margin-top:5px; overflow:hidden; }
.qbar i { position:absolute; left:0; top:0; height:100%; border-radius:4px; }
.qbar.over i.ext { background:repeating-linear-gradient(45deg, var(--danger), var(--danger) 3px, transparent 3px, transparent 6px); }
.inf { font-family:var(--mono); font-size:12px; color:var(--ok); }
.emptybox { border:1px solid var(--border); border-radius:5px; padding:14px; text-align:center; color:var(--text-2); }
.emptybox .keyglyph { font-size:20px; color:var(--text-1); }
.emptybox h4 { margin:8px 0 4px; font-family:var(--sans); font-size:13px; color:var(--text-1); font-weight:600; }
.emptybox .errline { font-family:var(--mono); font-size:11px; color:var(--text-2); word-break:break-word; margin:4px 0; }
.prompt { font-family:var(--mono); font-size:12px; color:var(--text-1); }

.upblocks { display:flex; gap:18px; }
.upblk { } .upblk .v { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:20px; font-weight:600; }
.upblk .k { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-2); }
.upblk.err.hot { color:var(--danger); }
.rate { font-family:var(--mono); font-size:12px; } .rate.warn{ color:var(--warn);} .rate.danger{ color:var(--danger);} .rate.ok{ color:var(--ok); }
#up-spark, #thru-svg { display:block; width:100%; }
#up-spark { height:30px; margin-top:8px; }
#thru-svg { height:88px; margin-top:6px; }
.flag { font-family:var(--mono); font-size:10px; color:var(--text-2); }

footer.foot { margin-top:14px; padding-top:10px; border-top:1px solid var(--border); display:flex; flex-wrap:wrap; gap:4px 14px;
  font-family:var(--mono); font-size:11px; color:var(--text-2); }
footer.foot .end { margin-left:auto; }
@media (max-width:680px){ footer.foot .end{ margin-left:0; } }

.skel { color:var(--text-dim); }
.flash { animation: flash .6s ease-out; } .flash-up { animation: flashup .6s ease-out; } .flash-down { animation: flashdown .6s ease-out; }

/* auth takeover */
#auth { display:none; }
#auth.show { display:flex; justify-content:center; padding:64px 16px; }
.authcard { width:100%; max-width:420px; background:var(--bg-1); border:1px solid var(--border); border-radius:6px; padding:22px 18px; position:relative; }
.authcard h3 { margin:0 0 10px; font-family:var(--mono); font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-1); }
.authcard p { font-size:12px; color:var(--text-2); margin:0 0 14px; }
.authcard .row { display:flex; gap:8px; }
.authcard input { flex:1; background:var(--bg-0); border:1px solid var(--border); border-radius:5px; color:var(--text-0); font-family:var(--mono); font-size:13px; padding:8px 10px; }
.authcard input.bad { border-color:var(--danger); }
.authcard button { background:var(--accent); color:var(--text-inv); border:0; border-radius:5px; font-family:var(--mono); font-size:12px; padding:0 14px; cursor:pointer; }
.authcard .err { color:var(--danger); font-family:var(--mono); font-size:11px; min-height:14px; margin-top:8px; }
.authcard .clear { position:absolute; top:14px; right:16px; font-size:11px; color:var(--text-2); cursor:pointer; }
.dim { opacity:.45; filter:grayscale(.4); transition:opacity .2s, filter .2s; }

@keyframes blink { 50% { opacity:0; } }
@keyframes scan { 0%{ transform:translateX(-100%);} 100%{ transform:translateX(350%);} }
@keyframes hb { 0%{ transform:scale(1);} 35%{ transform:scale(1.7);} 100%{ transform:scale(1);} }
@keyframes flash { from{ background:var(--flash);} to{ background:transparent;} }
@keyframes flashup { from{ background:var(--flash-up);} to{ background:transparent;} }
@keyframes flashdown { from{ background:var(--flash-down);} to{ background:transparent;} }
@media (prefers-reduced-motion: reduce) {
  .caret { animation:none; } #scanbar::after { animation:none; opacity:.3; }
  .heartbeat { animation:none; }
  .flash, .flash-up, .flash-down { animation:none; box-shadow: inset 2px 0 0 var(--accent); }
}
</style>
</head>
<body>
<header class="bar" id="bar">
  <div class="bar-in">
    <span class="wordmark">hoopilot<span class="caret" aria-hidden="true"></span></span>
    <span class="chip" id="version-chip">v&middot;&middot;&middot;</span>
    <span class="chip plan-offline" id="plan-chip">&mdash; offline</span>
    <span class="spacer"></span>
    <span class="pill" id="conn-pill" aria-live="polite"><span class="dot" id="conn-dot"></span><span id="conn-text">connecting</span></span>
    <span class="updated" id="updated"></span>
    <span class="seg" id="seg" role="group" aria-label="Refresh interval">
      <button data-ms="2000">2s</button><button data-ms="4000" class="active">4s</button><button data-ms="10000">10s</button>
    </span>
    <button class="iconbtn" id="btn-pause" title="Pause / resume" aria-label="Pause or resume">&#10074;&#10074;</button>
    <button class="iconbtn" id="btn-theme" title="Theme: auto / dark / light" aria-label="Cycle theme">A</button>
  </div>
  <div id="scanbar" aria-hidden="true"></div>
</header>

<div class="shell">
  <div id="banner" role="status" aria-live="polite"></div>

  <section id="content">
    <section class="hero" aria-label="Vitals">
      <div class="vital" id="v-req"><div class="eyebrow">Req / s</div><div class="vnum skel" id="req-num">&middot;&middot;&middot;</div><div class="vsub" id="req-sub"></div><svg class="vspark" id="req-spark" viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden="true"><path class="area" fill="var(--spark-fill)" stroke="none"/><path class="line" fill="none" stroke="var(--ok)" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle r="1.6" fill="var(--ok)" style="display:none"/></svg></div>
      <div class="vital" id="v-tok"><div class="eyebrow">Tokens / s</div><div class="vnum skel" id="tok-num">&middot;&middot;&middot;</div><div class="vsub" id="tok-sub"></div><svg class="vspark" id="tok-spark" viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden="true"><path class="area" fill="var(--spark-fill)" stroke="none"/><path class="line" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle r="1.6" fill="var(--accent)" style="display:none"/></svg></div>
      <div class="vital" id="v-inflight"><div class="eyebrow">In&#8209;flight</div><div class="vnum skel" id="inflight-num">&middot;&middot;&middot;</div><div class="vsub" id="inflight-sub"></div><svg class="vspark" id="inflight-spark" viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden="true"><path class="area" fill="var(--spark-fill)" stroke="none"/><path class="line" fill="none" stroke="var(--accent-2)" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle r="1.6" fill="var(--accent-2)" style="display:none"/></svg></div>
      <div class="vital" id="v-uptime"><div class="eyebrow">Uptime</div><div class="vnum skel" id="uptime-num">&middot;&middot;&middot;</div><div class="vsub" id="uptime-sub"></div></div>
    </section>

    <section class="grid">
      <div class="panel span5"><span class="ptitle">&#9508; Proxy &middot; requests &#9504;</span>
        <div class="headline"><span id="req-total" class="skel">&middot;&middot;&middot;</span> <span class="cap">requests</span></div>
        <div class="stack-bar empty" id="route-sharebar"></div>
        <div class="stack-bar empty" id="status-healthbar"></div>
        <div class="scrollx"><table class="tbl"><thead><tr><th class="l">Route</th><th>Count</th><th>%</th><th style="width:60px">&nbsp;</th></tr></thead><tbody id="routes-body"><tr class="ghost"><td colspan="4">loading&hellip;</td></tr></tbody></table></div>
      </div>

      <div class="panel span3"><span class="ptitle">&#9508; Status &#9504;</span>
        <div class="headline"><span id="error-rate" class="skel">&middot;&middot;&middot;</span> <span class="cap">err rate</span></div>
        <div class="stack-bar empty" id="status-bar"></div>
        <div class="legend" id="status-legend"></div>
      </div>

      <div class="panel span4"><span class="ptitle">&#9508; Latency &middot; ms &#9504;</span>
        <div class="lat-trio">
          <div class="b"><small>p50</small><span id="lat-p50" class="skel">&middot;</span></div>
          <div class="b lat-p95"><small>p95</small><span id="lat-p95" class="skel">&middot;</span></div>
          <div class="b"><small>avg</small><span id="lat-avg" class="skel">&middot;</span></div>
          <div class="b"><small>obs</small><span id="lat-count" class="skel">&middot;</span></div>
        </div>
        <div class="lat-track" id="lat-track"><div class="line"></div></div>
        <details class="routes"><summary>by route</summary><div class="scrollx"><table class="tbl"><thead><tr><th class="l">Route</th><th>avg ms</th><th>count</th></tr></thead><tbody id="lat-routes"></tbody></table></div></details>
      </div>

      <div class="panel span7"><span class="ptitle">&#9508; Tokens &middot; by model &#9504;</span>
        <div class="headline"><span id="tok-total" class="skel">&middot;&middot;&middot;</span> <span class="cap">tokens &middot; <span id="tok-cache">cache &middot;%</span></span></div>
        <div class="stack-bar empty" id="tok-mixbar"></div>
        <div class="legend" id="tok-legend"></div>
        <div class="scrollx" style="margin-top:8px"><table class="tbl"><thead><tr><th class="l">Model</th><th>prompt</th><th>compl</th><th>reason</th><th>cached</th><th>total</th><th>reqs</th></tr></thead><tbody id="tok-body"><tr class="ghost"><td colspan="7">no token usage yet</td></tr></tbody></table></div>
      </div>

      <div class="panel span5"><span class="ptitle">&#9508; Copilot &middot; quota &#9504;</span>
        <div id="copilot-body"><div class="emptybox skel">loading&hellip;</div></div>
      </div>

      <div class="panel span4"><span class="ptitle">&#9508; Upstream &middot; copilot edge &#9504;</span>
        <div class="upblocks">
          <div class="upblk"><div class="v" id="up-total">&middot;</div><div class="k">calls</div></div>
          <div class="upblk err" id="up-errblk"><div class="v" id="up-errors">&middot;</div><div class="k">errors</div></div>
          <div class="upblk"><div class="v rate" id="up-rate">&middot;</div><div class="k">err rate</div></div>
        </div>
        <svg id="up-spark" viewBox="0 0 320 30" preserveAspectRatio="none" aria-hidden="true"><path class="area" fill="var(--spark-fill)" stroke="none"/><path class="line" fill="none" stroke="var(--danger)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
        <div class="flag" id="up-flag"></div>
      </div>

      <div class="panel span8"><span class="ptitle">&#9508; Throughput &#9504;</span>
        <div class="cap"><span style="color:var(--accent)">&#9632;</span> tokens/s <span id="thru-tok" class="num"></span> &nbsp; <span style="color:var(--accent-2)">&#9632;</span> req/s <span id="thru-req" class="num"></span> <span class="end" id="thru-peak" style="float:right"></span></div>
        <svg id="thru-svg" viewBox="0 0 320 88" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="thrugrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
          <line class="grid" x1="0" y1="22" x2="320" y2="22" stroke="var(--grid-line)"/>
          <line class="grid" x1="0" y1="44" x2="320" y2="44" stroke="var(--grid-line)"/>
          <line class="grid" x1="0" y1="66" x2="320" y2="66" stroke="var(--grid-line)"/>
          <path id="thru-tok-area" fill="url(#thrugrad)" stroke="none"/>
          <path id="thru-tok-line" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
          <path id="thru-req-line" fill="none" stroke="var(--accent-2)" stroke-width="1.2" vector-effect="non-scaling-stroke" opacity="0.9"/>
        </svg>
      </div>
    </section>
  </section>

  <section id="auth" aria-live="polite">
    <div class="authcard">
      <span class="clear" id="auth-clear" style="display:none">clear key</span>
      <h3>&#9508; Auth required &#9504;</h3>
      <p>This hoopilot proxy requires an API key. It is stored locally in your browser and sent as <span class="mono">x-api-key</span>.</p>
      <div class="row"><input id="auth-input" type="password" placeholder="x-api-key" autocomplete="off" spellcheck="false" /><button id="auth-connect">connect</button></div>
      <div class="err" id="auth-err"></div>
    </div>
  </section>

  <footer class="foot">
    <span id="foot-started">started &middot;</span>
    <span id="foot-uptime">uptime &middot;</span>
    <span id="foot-total">&middot; req</span>
    <span id="foot-tokens">&middot; tokens</span>
    <span id="foot-upstream">upstream &middot;</span>
    <span class="end" id="foot-cadence"></span>
  </footer>
</div>

<script>
(function(){
  "use strict";
  var byId = function(id){ return document.getElementById(id); };
  var CAP = 60;

  // ---- persistent state ----
  var LS = window.localStorage;
  var apiKey = "";
  try { apiKey = LS.getItem("hoopilot.apiKey") || ""; } catch (e) { apiKey = ""; }
  var theme = "auto";
  try { theme = LS.getItem("hoopilot.theme") || "auto"; } catch (e) { theme = "auto"; }
  var intervalMs = 4000;
  try { var sv = parseInt(LS.getItem("hoopilot.intervalMs") || "", 10); if (sv === 2000 || sv === 4000 || sv === 10000) intervalMs = sv; } catch (e) {}

  // ---- runtime state ----
  var paused = false;
  var timer = null;
  var inflightFetch = null;
  var lastSuccessAt = 0;
  var prevSample = null;        // { t, reqTotal, tokTotal, upTotal, startedAt }
  var lastRender = {};          // for change-flash
  var backoffMs = 0;
  var lastUptime = null;        // seconds; ticked locally between polls
  var hist = { req:[], tok:[], inflight:[], up:[] };

  // ---- formatting helpers ----
  function humanInt(n){
    if (n === null || n === undefined || !isFinite(n)) return "0";
    var a = Math.abs(n);
    if (a >= 1000000) return (n/1000000).toFixed(a >= 10000000 ? 0 : 1) + "M";
    if (a >= 1000) return (n/1000).toFixed(a >= 10000 ? 0 : 1) + "k";
    return String(Math.round(n));
  }
  function rate(n){
    if (n === null || n === undefined || !isFinite(n)) return "0";
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
  function pct(n){ if (!isFinite(n)) return "0%"; return (n >= 10 ? Math.round(n) : Math.round(n*10)/10) + "%"; }
  function fmtMs(n){ if (n === null || n === undefined || !isFinite(n) || n <= 0) return "0"; if (n >= 1000) return (n/1000).toFixed(2) + "s"; if (n >= 100) return String(Math.round(n)); return Math.round(n*10)/10 + ""; }
  function pad2(n){ return (n < 10 ? "0" : "") + n; }
  function fmtUptime(sec){
    sec = Math.max(0, Math.floor(sec));
    var d = Math.floor(sec/86400); sec -= d*86400;
    var h = Math.floor(sec/3600); sec -= h*3600;
    var m = Math.floor(sec/60); var s = sec - m*60;
    if (d > 0) return d + "d " + pad2(h) + ":" + pad2(m);
    if (h > 0) return h + ":" + pad2(m) + ":" + pad2(s);
    return m + ":" + pad2(s);
  }
  function titleize(key){
    var map = { premium_interactions:"Premium requests", chat:"Chat", completions:"Completions", code_review:"Code review" };
    if (map[key]) return map[key];
    return key.split("_").map(function(w){ return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }).join(" ");
  }
  function relTime(iso){
    var t = Date.parse(iso); if (!isFinite(t)) return iso || "";
    var s = Math.max(0, Math.round((Date.now() - t)/1000));
    return fmtUptime(s) + " ago";
  }
  function clearEl(el){ while (el && el.firstChild) el.removeChild(el.firstChild); }
  function mk(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined && txt !== null) e.textContent = txt; return e; }

  // Set numeric text and flash on discrete change.
  function setNum(id, value, kind, num){
    var el = byId(id); if (!el) return;
    el.classList.remove("skel");
    var s = String(value);
    if (el.textContent !== s){
      el.textContent = s;
      // Compare on the raw number (num) when provided, so directional flash works
      // even when value is a pre-formatted display string.
      var n = (num !== undefined) ? num : value;
      var prev = lastRender[id];
      if (prev !== undefined){
        var cls = "flash";
        if (kind === "delta" && typeof n === "number" && typeof prev === "number"){
          cls = n > prev ? "flash-up" : (n < prev ? "flash-down" : null);
        }
        if (cls){ el.classList.remove("flash","flash-up","flash-down"); void el.offsetWidth; el.classList.add(cls); }
      }
      lastRender[id] = n;
    }
  }
  function setText(id, s){ var el = byId(id); if (el){ el.classList.remove("skel"); el.textContent = s; } }

  // ---- sparkline rendering ----
  function pushHist(arr, v){ arr.push(v); if (arr.length > CAP) arr.shift(); }
  function buildSpark(values, w, h){
    var pts = []; for (var i=0;i<values.length;i++){ if (isFinite(values[i])) pts.push({ i:i, v:values[i] }); }
    if (pts.length < 2) return null;
    var min = Infinity, max = -Infinity;
    for (var j=0;j<values.length;j++){ var v = values[j]; if (isFinite(v)){ if (v<min) min=v; if (v>max) max=v; } }
    var flat = (max - min) <= 0;
    var pad = flat ? 1 : (max - min) * 0.05; var lo = min - pad, hi = max + pad; var span = hi - lo; if (span <= 0) span = 1;
    var n = values.length;
    var line = "", lastX = 0, lastY = 0, started = false;
    for (var k=0;k<n;k++){
      var val = values[k]; if (!isFinite(val)) continue;
      var x = (n === 1) ? w : (k * (w/(n-1)));
      var norm = flat ? 0.5 : (val - lo)/span;
      var y = h - norm*(h-2) - 1;
      line += (started ? " L" : "M") + x.toFixed(2) + "," + y.toFixed(2);
      lastX = x; lastY = y; started = true;
    }
    var area = line + " L" + lastX.toFixed(2) + "," + h + " L0," + h + " Z";
    return { line:line, area:area, lastX:lastX, lastY:lastY };
  }
  function drawSpark(svgId, values){
    var svg = byId(svgId); if (!svg) return;
    var vb = svg.viewBox.baseVal; var w = vb.width || 200, h = vb.height || 24;
    var sp = buildSpark(values, w, h);
    var line = svg.querySelector(".line"), area = svg.querySelector(".area"), dot = svg.querySelector("circle");
    if (!sp){ if (line) line.setAttribute("d",""); if (area) area.setAttribute("d",""); if (dot) dot.style.display = "none"; return; }
    if (line) line.setAttribute("d", sp.line);
    if (area) area.setAttribute("d", sp.area);
    if (dot){ dot.setAttribute("cx", sp.lastX.toFixed(2)); dot.setAttribute("cy", sp.lastY.toFixed(2)); dot.style.display = ""; }
  }

  // ---- theme ----
  function applyTheme(){
    var root = document.documentElement;
    if (theme === "dark") root.setAttribute("data-theme","dark");
    else if (theme === "light") root.setAttribute("data-theme","light");
    else root.removeAttribute("data-theme");
    byId("btn-theme").textContent = theme === "dark" ? "D" : (theme === "light" ? "L" : "A");
  }
  byId("btn-theme").addEventListener("click", function(){
    theme = theme === "auto" ? "dark" : (theme === "dark" ? "light" : "auto");
    try { LS.setItem("hoopilot.theme", theme); } catch (e) {}
    applyTheme();
  });

  // ---- interval + pause ----
  function setActiveSeg(){
    var btns = byId("seg").querySelectorAll("button");
    for (var i=0;i<btns.length;i++){ btns[i].classList.toggle("active", parseInt(btns[i].getAttribute("data-ms"),10) === intervalMs); }
    document.documentElement.style.setProperty("--scan-ms", intervalMs + "ms");
  }
  byId("seg").addEventListener("click", function(ev){
    var b = ev.target.closest ? ev.target.closest("button") : null; if (!b) return;
    intervalMs = parseInt(b.getAttribute("data-ms"),10) || 4000;
    try { LS.setItem("hoopilot.intervalMs", String(intervalMs)); } catch (e) {}
    setActiveSeg();
    if (!paused){ schedule(0); }
  });
  byId("btn-pause").addEventListener("click", function(){
    paused = !paused;
    byId("btn-pause").innerHTML = paused ? "&#9654;" : "&#10074;&#10074;";
    byId("bar").classList.toggle("paused", paused);
    if (paused){ if (timer){ clearTimeout(timer); timer = null; } setPill("paused","PAUSED",false); }
    else { setPill("live","LIVE",false); schedule(0); }
  });

  // ---- connection pill / banner ----
  function setPill(kind, text, beat){
    var pill = byId("conn-pill"); var dot = byId("conn-dot");
    pill.className = "pill " + kind;
    byId("conn-text").textContent = text;
    if (beat && dot){ dot.classList.remove("heartbeat"); void dot.offsetWidth; dot.classList.add("heartbeat"); }
  }
  function showBanner(text, ok){
    var b = byId("banner"); b.textContent = text; b.className = "show" + (ok ? " ok" : "");
    if (ok){ setTimeout(function(){ b.classList.remove("show"); }, 2000); }
  }
  function hideBanner(){ byId("banner").classList.remove("show"); }
  function setDimmed(on){ byId("content").classList.toggle("dim", on); }

  // ---- auth takeover ----
  function showAuth(rejected){
    byId("content").style.display = "none";
    byId("auth").classList.add("show");
    setPill("authkey","API KEY",false);
    byId("auth-err").textContent = rejected ? "key rejected" : "";
    byId("auth-input").classList.toggle("bad", !!rejected);
    byId("auth-clear").style.display = apiKey ? "" : "none";
    byId("auth-input").focus();
  }
  function hideAuth(){ byId("auth").classList.remove("show"); byId("content").style.display = ""; }
  byId("auth-connect").addEventListener("click", function(){
    var v = byId("auth-input").value.trim(); if (!v) return;
    apiKey = v; try { LS.setItem("hoopilot.apiKey", apiKey); } catch (e) {}
    hideAuth(); schedule(0);
  });
  byId("auth-input").addEventListener("keydown", function(ev){ if (ev.key === "Enter") byId("auth-connect").click(); });
  byId("auth-clear").addEventListener("click", function(){
    apiKey = ""; try { LS.removeItem("hoopilot.apiKey"); } catch (e) {}
    byId("auth-input").value = ""; byId("auth-clear").style.display = "none"; byId("auth-input").focus();
  });

  // ---- the poll loop (setTimeout-chained, never setInterval) ----
  var pollGen = 0;
  function schedule(delay){
    if (timer){ clearTimeout(timer); }
    if (paused) return;
    timer = setTimeout(poll, delay === undefined ? intervalMs : delay);
  }
  function poll(){
    if (paused) return;
    // A new poll supersedes any in-flight one. Bump the generation so the old
    // request's settled handlers (including its abort rejection) become no-ops
    // and never flash a false "disconnected".
    pollGen += 1; var myGen = pollGen;
    if (inflightFetch){ try { inflightFetch.abort(); } catch (e) {} }
    var ctrl = new AbortController(); inflightFetch = ctrl;
    var to = setTimeout(function(){ try { ctrl.abort(); } catch (e) {} }, Math.max(10000, intervalMs * 2));
    var headers = { "accept":"application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    fetch("/v1/usage?view=dashboard", { headers: headers, signal: ctrl.signal, cache:"no-store" }).then(function(res){
      clearTimeout(to);
      if (myGen !== pollGen) return null;
      if (res.status === 401 || res.status === 403){ inflightFetch = null; showAuth(!!apiKey); return null; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function(data){
      if (myGen !== pollGen || data === null || paused) return;
      inflightFetch = null;
      onData(data);
      backoffMs = 0; lastSuccessAt = Date.now();
      hideAuth(); setDimmed(false); hideBanner();
      setPill("live","LIVE",true);
      byId("bar").classList.remove("frozen");
      schedule(intervalMs);
    }).catch(function(err){
      clearTimeout(to);
      if (myGen !== pollGen || paused) return;
      inflightFetch = null;
      onDisconnect(err);
    });
  }
  function onDisconnect(err){
    setPill("reconnect","RECONNECTING",false);
    setDimmed(true);
    byId("bar").classList.add("frozen");
    backoffMs = backoffMs ? Math.min(Math.round(backoffMs * 1.5), 30000) : intervalMs;
    showBanner("Disconnected (" + (err && err.message ? err.message : "no response") + ") \\u2014 retrying in " + Math.round(backoffMs/1000) + "s", false);
    schedule(backoffMs);
  }

  // ---- main render ----
  function onData(usage){
    var proxy = usage.proxy || {};
    var now = Date.now();

    setText("version-chip", "v" + (usage.version || "?"));

    // rates
    var reqTotal = (proxy.requests && proxy.requests.total) || 0;
    var tokTotal = (proxy.tokens && proxy.tokens.total) || 0;
    var upTotal = (proxy.upstream && proxy.upstream.total) || 0;
    var startedAt = proxy.startedAt || "";
    var reqPerSec = NaN, tokPerSec = NaN, upDelta = 0, restarted = false;
    if (prevSample){
      var dt = (now - prevSample.t)/1000;
      if (prevSample.startedAt && startedAt && prevSample.startedAt !== startedAt) restarted = true;
      if (reqTotal < prevSample.reqTotal || tokTotal < prevSample.tokTotal) restarted = true;
      if (restarted){ reqPerSec = 0; tokPerSec = 0; upDelta = 0; }
      else if (dt > 0 && isFinite(dt)){
        reqPerSec = Math.max(0, (reqTotal - prevSample.reqTotal)/dt);
        tokPerSec = Math.max(0, (tokTotal - prevSample.tokTotal)/dt);
        upDelta = Math.max(0, upTotal - prevSample.upTotal);
      }
    }
    prevSample = { t:now, reqTotal:reqTotal, tokTotal:tokTotal, upTotal:upTotal, startedAt:startedAt };

    // hero vitals
    if (isFinite(reqPerSec)){ pushHist(hist.req, reqPerSec); setNum("req-num", rate(reqPerSec)); } else setText("req-num","\\u2014");
    if (isFinite(tokPerSec)){ pushHist(hist.tok, tokPerSec); setNum("tok-num", humanInt(tokPerSec)); } else setText("tok-num","\\u2014");
    var inflight = proxy.inFlight || 0;
    pushHist(hist.inflight, inflight); setNum("inflight-num", String(inflight), "delta", inflight);
    byId("v-inflight").classList.toggle("active", inflight > 0);
    setText("uptime-num", fmtUptime(proxy.uptimeSeconds || 0));

    setText("req-sub", hist.req.length ? ("avg " + rate(avg(hist.req)) + "/s") : "warming up");
    setText("tok-sub", hist.tok.length ? ("peak " + humanInt(Math.max.apply(null, hist.tok)) + "/s") : "warming up");
    setText("inflight-sub", inflight + " now");
    setText("uptime-sub", startedAt ? ("since " + relTime(startedAt)) : "");

    drawSpark("req-spark", hist.req);
    drawSpark("tok-spark", hist.tok);
    drawSpark("inflight-spark", hist.inflight);

    renderRequests(proxy);
    renderStatus(proxy);
    renderLatency(proxy.latency || {});
    renderTokens(proxy.tokens || {});
    renderCopilot(usage);
    renderUpstream(proxy.upstream || {}, upDelta, restarted);
    renderThroughput();
    renderFooter(usage, proxy);

    setNum("req-total", humanInt(reqTotal));
    setNum("tok-total", humanInt(tokTotal));
    lastUptime = proxy.uptimeSeconds || 0;
  }

  function avg(arr){ if (!arr.length) return 0; var s = 0; for (var i=0;i<arr.length;i++) s += arr[i]; return s/arr.length; }

  var ROUTE_COLORS = ["var(--c1)","var(--c2)","var(--c3)","var(--c4)","var(--c5)","var(--c6)"];
  function renderRequests(proxy){
    var byRoute = (proxy.requests && proxy.requests.byRoute) || {};
    var total = (proxy.requests && proxy.requests.total) || 0;
    var rows = Object.keys(byRoute).map(function(k){ return { k:k, v:byRoute[k] }; }).sort(function(a,b){ return b.v - a.v; });
    var share = byId("route-sharebar"); clearEl(share); share.className = "stack-bar" + (total ? "" : " empty");
    var body = byId("routes-body"); clearEl(body);
    if (!rows.length){ var tr = mk("tr","ghost"); var td = mk("td",null,"no requests yet"); td.colSpan = 4; tr.appendChild(td); body.appendChild(tr); return; }
    rows.forEach(function(r, idx){
      var p = total ? (r.v/total*100) : 0;
      var seg = mk("i"); seg.style.width = p + "%"; seg.style.background = ROUTE_COLORS[idx % ROUTE_COLORS.length]; seg.title = r.k + " " + pct(p); share.appendChild(seg);
      var tr = mk("tr");
      var name = mk("td","l", r.k); name.title = r.k; tr.appendChild(name);
      tr.appendChild(mk("td",null, humanInt(r.v)));
      tr.appendChild(mk("td",null, pct(p)));
      var btd = mk("td"); var bar = mk("span","minibar"); bar.style.width = Math.max(2, p) + "%"; bar.style.background = ROUTE_COLORS[idx % ROUTE_COLORS.length]; btd.appendChild(bar); tr.appendChild(btd);
      body.appendChild(tr);
    });
    var tot = mk("tr","total"); tot.appendChild(mk("td","l","total")); tot.appendChild(mk("td",null, humanInt(total))); tot.appendChild(mk("td",null,"100%")); tot.appendChild(mk("td")); body.appendChild(tot);
  }

  function statusClass(code){ var c = String(code).charAt(0); if (c === "2") return "ok"; if (c === "3") return "info"; if (c === "4") return "warn"; if (c === "5") return "danger"; return "muted"; }
  function statusColor(cls){ return cls === "ok" ? "var(--ok)" : cls === "info" ? "var(--info)" : cls === "warn" ? "var(--warn)" : cls === "danger" ? "var(--danger)" : "var(--text-2)"; }
  function renderStatus(proxy){
    var byStatus = (proxy.requests && proxy.requests.byStatus) || {};
    var total = 0, errs = 0; var groups = { ok:0, info:0, warn:0, danger:0, muted:0 };
    var codes = Object.keys(byStatus).map(function(k){ return { k:k, v:byStatus[k] }; }).sort(function(a,b){ return b.v - a.v; });
    codes.forEach(function(c){ total += c.v; var cls = statusClass(c.k); groups[cls] += c.v; if (cls === "warn" || cls === "danger") errs += c.v; });
    var bar = byId("status-bar"); clearEl(bar); bar.className = "stack-bar" + (total ? "" : " empty");
    ["ok","info","warn","danger","muted"].forEach(function(cls){ if (groups[cls] > 0){ var seg = mk("i"); seg.style.width = (groups[cls]/total*100) + "%"; seg.style.background = statusColor(cls); bar.appendChild(seg); } });
    var leg = byId("status-legend"); clearEl(leg);
    if (!codes.length){ leg.appendChild(mk("span","li","no requests yet")); }
    codes.forEach(function(c){ var li = mk("span","li"); var sw = mk("span","sw"); sw.style.background = statusColor(statusClass(c.k)); li.appendChild(sw); li.appendChild(mk("span",null, c.k + " " + humanInt(c.v))); leg.appendChild(li); });
    var er = total ? (errs/total*100) : 0;
    setNum("error-rate", pct(er));
    var el = byId("error-rate"); el.style.color = er > 5 ? "var(--danger)" : er > 1 ? "var(--warn)" : "var(--ok)";
  }

  function renderLatency(lat){
    setText("lat-p50", fmtMs(lat.p50Ms)); setText("lat-avg", fmtMs(lat.avgMs)); setText("lat-count", humanInt(lat.count || 0));
    var p95 = byId("lat-p95"); p95.classList.remove("skel"); p95.textContent = fmtMs(lat.p95Ms);
    p95.style.color = (lat.p50Ms > 0 && lat.p95Ms > 2*lat.p50Ms) ? "var(--warn)" : "var(--info)";
    // track: position p50 and p95 across 0..(p95*1.15)
    var track = byId("lat-track"); var old = track.querySelectorAll(".tick,.tlab"); for (var i=0;i<old.length;i++) old[i].remove();
    var maxv = Math.max(lat.p95Ms || 0, lat.avgMs || 0, 1) * 1.15;
    function place(v, cls){ if (!isFinite(v) || v <= 0) return; var x = Math.min(100, v/maxv*100); var t = mk("div","tick " + cls); t.style.left = x + "%"; track.appendChild(t); var lab = mk("div","tlab", fmtMs(v)); lab.style.left = x + "%"; track.appendChild(lab); }
    place(lat.p50Ms, "p50"); place(lat.p95Ms, "p95");
    var lr = byId("lat-routes"); clearEl(lr);
    var byRoute = lat.byRoute || {}; var rows = Object.keys(byRoute).map(function(k){ return { k:k, v:byRoute[k] }; }).sort(function(a,b){ return (b.v.avgMs||0) - (a.v.avgMs||0); });
    rows.forEach(function(r){ var tr = mk("tr"); var n = mk("td","l", r.k); n.title = r.k; tr.appendChild(n); tr.appendChild(mk("td",null, fmtMs(r.v.avgMs))); tr.appendChild(mk("td",null, humanInt(r.v.count||0))); lr.appendChild(tr); });
  }

  function renderTokens(tok){
    var prompt = tok.prompt||0, completion = tok.completion||0, reasoning = tok.reasoning||0, cached = tok.cached||0;
    var sum = prompt + completion + reasoning;
    var bar = byId("tok-mixbar"); clearEl(bar); bar.className = "stack-bar" + (sum ? "" : " empty");
    var parts = [ ["prompt", prompt, "var(--text-1)"], ["completion", completion, "var(--accent)"], ["reasoning", reasoning, "var(--info)"] ];
    parts.forEach(function(p){ if (sum && p[1] > 0){ var seg = mk("i"); seg.style.width = (p[1]/sum*100) + "%"; seg.style.background = p[2]; seg.title = p[0]; bar.appendChild(seg); } });
    var leg = byId("tok-legend"); clearEl(leg);
    var legParts = parts.concat([["cached", cached, "var(--cache)"]]);
    legParts.forEach(function(p){ var li = mk("span","li"); var sw = mk("span","sw"); sw.style.background = p[2]; li.appendChild(sw); var den = (p[0] === "cached") ? prompt : sum; var sh = den ? " " + pct(p[1]/den*100) : ""; li.appendChild(mk("span",null, p[0] + " " + humanInt(p[1]) + sh)); leg.appendChild(li); });
    var cacheRate = prompt ? (cached/prompt*100) : 0; setText("tok-cache", "cache " + pct(cacheRate));
    var body = byId("tok-body"); clearEl(body);
    var byModel = tok.byModel || {}; var rows = Object.keys(byModel).map(function(k){ return { k:k, v:byModel[k] }; }).sort(function(a,b){ return (b.v.total||0) - (a.v.total||0); });
    if (!rows.length){ var tr = mk("tr","ghost"); var td = mk("td",null,"no token usage yet"); td.colSpan = 7; tr.appendChild(td); body.appendChild(tr); return; }
    rows.forEach(function(r){ var m = r.v; var tr = mk("tr"); var n = mk("td","l", r.k); n.title = r.k; tr.appendChild(n);
      tr.appendChild(mk("td",null, humanInt(m.prompt||0))); tr.appendChild(mk("td",null, humanInt(m.completion||0)));
      tr.appendChild(mk("td","reasoning", humanInt(m.reasoning||0))); tr.appendChild(mk("td","cached", humanInt(m.cached||0)));
      tr.appendChild(mk("td",null, humanInt(m.total||0))); tr.appendChild(mk("td",null, humanInt(m.requests||0))); body.appendChild(tr); });
  }

  function planClass(plan){ if (!plan) return "plan-offline"; if (plan.indexOf("pro") >= 0) return "plan-pro"; if (plan.indexOf("business") >= 0 || plan.indexOf("enterprise") >= 0) return "plan-business"; return "plan-free"; }
  function renderCopilot(usage){
    var box = byId("copilot-body"); clearEl(box);
    var cp = usage.copilot; var planChip = byId("plan-chip");
    if (!cp){
      planChip.className = "chip plan-offline"; planChip.textContent = "\\u2014 offline";
      var eb = mk("div","emptybox"); eb.appendChild(mk("div","keyglyph","\\u26bf"));
      eb.appendChild(mk("h4",null,"Copilot not connected"));
      if (usage.copilot_error) eb.appendChild(mk("div","errline", usage.copilot_error));
      eb.appendChild(mk("div","prompt","$ hoopilot login"));
      box.appendChild(eb); return;
    }
    planChip.className = "chip " + planClass(cp.plan); planChip.textContent = cp.plan || "copilot";
    var head = mk("div","cap");
    var bits = [];
    if (cp.accessTypeSku) bits.push(cp.accessTypeSku);
    if (cp.chatEnabled !== undefined) bits.push(cp.chatEnabled ? "chat on" : "chat off");
    if (cp.quotaResetDate) bits.push("resets " + cp.quotaResetDate);
    head.textContent = bits.join("  \\u00b7  "); box.appendChild(head);
    var quotas = cp.quotas || {}; var keys = Object.keys(quotas);
    if (!keys.length){ box.appendChild(mk("div","cap","No metered quotas reported.")); return; }
    var order = { premium_interactions:0, chat:1, completions:2 };
    keys.sort(function(a,b){ var ra = order[a]===undefined?9:order[a], rb = order[b]===undefined?9:order[b]; return ra-rb || a.localeCompare(b); });
    keys.forEach(function(k){
      var q = quotas[k]; var row = mk("div","qrow");
      var hd = mk("div","qhead"); hd.appendChild(mk("span","qname", titleize(k)));
      if (q.unlimited){ hd.appendChild(mk("span","inf","\\u221e unlimited")); row.appendChild(hd); box.appendChild(row); return; }
      var ent = q.entitlement, rem = q.remaining, used = q.used;
      var usedPct = (q.percentRemaining !== undefined) ? (100 - q.percentRemaining) : ((ent && used !== undefined) ? (used/ent*100) : 0);
      usedPct = Math.max(0, Math.min(100, usedPct));
      var valTxt = (used !== undefined && ent !== undefined) ? (humanInt(used) + " / " + humanInt(ent)) : (rem !== undefined ? (humanInt(rem) + " left") : pct(100-usedPct) + " left");
      hd.appendChild(mk("span","qval", valTxt)); row.appendChild(hd);
      var bar = mk("div","qbar"); var fill = mk("i"); fill.style.width = usedPct + "%";
      fill.style.background = usedPct > 85 ? "var(--danger)" : usedPct > 60 ? "var(--warn)" : "var(--ok)"; bar.appendChild(fill);
      if (q.overageCount && q.overagePermitted){ bar.classList.add("over"); var ext = mk("i","ext"); ext.style.left = "100%"; ext.style.width = "8%"; bar.appendChild(ext); }
      row.appendChild(bar);
      if (q.overageCount){ var ov = mk("div","flag", humanInt(q.overageCount) + " overage" + (q.tokenBasedBilling ? " \\u00b7 token billing" : "")); row.appendChild(ov); }
      box.appendChild(row);
    });
  }

  function renderUpstream(up, delta, restarted){
    setNum("up-total", humanInt(up.total||0));
    setNum("up-errors", humanInt(up.errors||0), "delta", up.errors||0);
    var er = up.total ? (up.errors/up.total*100) : 0;
    var rt = byId("up-rate"); rt.textContent = pct(er); rt.className = "v rate " + (er > 5 ? "danger" : er > 1 ? "warn" : "ok");
    byId("up-errblk").classList.toggle("hot", (up.errors||0) > 0);
    pushHist(hist.up, delta||0); drawSpark("up-spark", hist.up);
    byId("up-flag").textContent = restarted ? "\\u21bb restarted" : "";
  }

  function renderThroughput(){
    drawDual("thru-tok-line","thru-tok-area", hist.tok, true);
    drawDual("thru-req-line", null, hist.req, false);
    setText("thru-tok", hist.tok.length ? rate(hist.tok[hist.tok.length-1]) : "\\u2014");
    setText("thru-req", hist.req.length ? rate(hist.req[hist.req.length-1]) : "\\u2014");
    var peakTok = hist.tok.length ? Math.max.apply(null, hist.tok) : 0;
    setText("thru-peak", "peak " + humanInt(peakTok) + " tok/s");
  }
  function drawDual(lineId, areaId, values, withArea){
    var svg = byId("thru-svg"); var vb = svg.viewBox.baseVal; var w = vb.width, h = vb.height;
    var sp = buildSpark(values, w, h);
    var line = byId(lineId); var area = areaId ? byId(areaId) : null;
    if (!sp){ if (line) line.setAttribute("d",""); if (area) area.setAttribute("d",""); return; }
    if (line) line.setAttribute("d", sp.line);
    if (area && withArea) area.setAttribute("d", sp.area);
  }

  function renderFooter(usage, proxy){
    setText("foot-started", proxy.startedAt ? ("started " + new Date(proxy.startedAt).toLocaleString()) : "started \\u2014");
    setText("foot-uptime", "uptime " + fmtUptime(proxy.uptimeSeconds||0));
    setText("foot-total", humanInt((proxy.requests && proxy.requests.total)||0) + " req");
    setText("foot-tokens", humanInt((proxy.tokens && proxy.tokens.total)||0) + " tokens");
    var up = proxy.upstream || {}; setText("foot-upstream", "upstream " + humanInt(up.total||0) + " / " + humanInt(up.errors||0) + " err");
    setText("foot-cadence", "polling /v1/usage every " + Math.round(intervalMs/1000) + "s \\u00b7 GET /dashboard");
  }

  // ---- 1s freshness + uptime ticker (independent of the poll loop) ----
  setInterval(function(){
    if (lastSuccessAt){
      var ago = Math.round((Date.now() - lastSuccessAt)/1000);
      var u = byId("updated"); u.textContent = "updated " + ago + "s ago";
      // Staleness only matters while polling; a deliberate pause is not "stale".
      u.className = "updated" + (paused ? "" : ago > intervalMs/1000*4 ? " danger" : ago > intervalMs/1000*2 ? " warn" : "");
    }
    // Tick uptime locally between polls so the seconds advance smoothly; each
    // successful poll re-seeds lastUptime from the authoritative server value.
    if (!paused && lastUptime !== null){
      lastUptime += 1;
      byId("uptime-num").textContent = fmtUptime(lastUptime);
      var fu = byId("foot-uptime"); if (fu) fu.textContent = "uptime " + fmtUptime(lastUptime);
    }
  }, 1000);

  // ---- boot ----
  applyTheme(); setActiveSeg();
  setPill("","CONNECTING",false);
  poll();
})();
</script>
</body>
</html>
`;
