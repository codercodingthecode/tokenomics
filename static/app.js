/* tokenomics — app: SSE client, render loop, gateway observer panel, scope / range / theme.
   Security rule: every string that comes from the gateway (tail, error, thread,
   tool_name, client, model, last_input_type) is written with textContent only —
   never innerHTML, never executed. The tail is displayed as plain text in a <pre>. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const TC = window.TokCharts;

  /* ---------- theme: URL param wins, then the saved choice, else dark ---------- */
  const THEMES = ["dark", "amber", "light"];
  const THEME_META = { dark: "#07090c", amber: "#120d07", light: "#f3f5f8" };
  const isTheme = t => THEMES.indexOf(t) >= 0;
  function applyTheme(t) {
    if (!isTheme(t)) t = "dark";
    document.documentElement.setAttribute("data-theme", t);
    const m = $("themeMeta");
    if (m) m.setAttribute("content", THEME_META[t]);
    const btn = $("themeBtn");
    if (btn) btn.title = "theme: " + t + " \u00b7 click for " + THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
  }
  let themeStart = new URLSearchParams(location.search).get("theme");
  if (!isTheme(themeStart)) { try { themeStart = localStorage.getItem("tokenomics.theme"); } catch (e) {} }
  applyTheme(themeStart);
  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = THEMES[(Math.max(0, THEMES.indexOf(cur)) + 1) % THEMES.length];
    applyTheme(next);
    try { localStorage.setItem("tokenomics.theme", next); } catch (e) {}
  });

  /* ---------- state ---------- */
  let lastSnap = null;
  let rangeMin = 15;
  let scopeMode = "total";
  let uiVersion = null;
  let es = null;
  let ledgerData = null;
  const gw = {
    last: null,          /* the last good /api/gw_live payload */
    okAt: 0,             /* when gw.last was received (ms) */
    stale: false,        /* true after a failed or timed-out poll */
    enabled: null,       /* null = not probed yet, false = 404: hide the section for good */
    spark: new Map(),    /* id -> number[60]: tok_s per poll, null before the first token */
    openId: null,        /* the request whose tail box is open (remembered across polls) */
    showAll: false,      /* "Show all 30" on */
  };

  /* ---------- formatting (compact primary, exact values in titles) ---------- */
  const fmtInt = n => n == null ? "\u2013" : Math.round(n).toLocaleString("en-US");
  function compact(n) {
    if (n == null) return "\u2013";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }
  const fmt1 = n => n == null ? "\u2013" : n.toFixed(1);
  function usdComma(n) {
    if (n == null) return "\u2013";
    if (n >= 100) return "$" + Math.round(n).toLocaleString("en-US");
    return "$" + n.toFixed(2);
  }
  const hhmm = ts => { const d = new Date(ts * 1000); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const hhmmss = ts => { const d = new Date(ts * 1000); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, "0")).join(":"); };
  const shortDate = isoStr => isoStr ? new Date(isoStr).toLocaleDateString([], { month: "short", day: "numeric" }) : "\u2013";
  const dayLabel = dayStr => { const p = dayStr.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" }); };
  const shortRange = m => ({ 15: "15 min", 60: "1 hour", 360: "6 hours", 1440: "24 hours", 10080: "7 days" }[m] || (m + " min"));
  /* gateway durations: "6m 52s" / "45 s" / "4.1 s" */
  function dur(s) {
    if (s == null) return "\u2014";
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + " s";
    const t = Math.round(s);
    return Math.floor(t / 60) + "m " + String(t % 60).padStart(2, "0") + "s";
  }
  /* gateway token counts: 148K / 41.7K / 3118; "\u2014" when null */
  function K(n) {
    if (n == null) return "\u2014";
    if (n < 1000) return String(Math.round(n));
    return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K";
  }
  const secStr = v => v == null ? "\u2013" : (v < 10 ? v.toFixed(2) : v.toFixed(1)) + " s";
  function agoSecs(isoStr) {
    if (!isoStr) return "\u2013";
    const d = Math.max(0, Math.round(Date.now() / 1000 - new Date(isoStr).getTime() / 1000));
    return d + " s ago";
  }

  /* ---------- DOM helpers (safe construction) ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function svgEl(tag, attrs) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function hostPort(url) { try { return new URL(url).host; } catch (e) { return ""; } }
  function lastNonNull(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && isFinite(arr[i])) return arr[i]; return null; }
  function lastNum(key, node, txt) {
    /* one-shot flash on change only (the section DOM is rebuilt every frame) */
    if (node.dataset.v === undefined || node.dataset.v !== txt) flash(node);
    node.dataset.v = txt;
    node.textContent = txt;
    return key;
  }
  function flash(node) { node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash"); }
  function hoursWord(h) { const n = Math.round(h || 0); return n + (n === 1 ? " hour" : " hours"); }


  const BASE = "M0 100H1000";
  function gradient(svg, id, color, op) {
    const defs = svgEl("defs");
    const g = svgEl("linearGradient", { id: id, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl("stop", { offset: 0, style: "stop-color:var(--" + color + ");stop-opacity:" + op }));
    g.appendChild(svgEl("stop", { offset: 1, style: "stop-color:var(--" + color + ");stop-opacity:0" }));
    defs.appendChild(g);
    svg.appendChild(defs);
  }

  /* ---------- header: source, live status, vLLM pill ---------- */
  function uptimeStr(startedAt) {
    if (!startedAt) return null;
    const s = (Date.now() - new Date(startedAt).getTime()) / 1000;
    if (!isFinite(s) || s < 0) return null;
    if (s < 3600) return "up " + Math.max(1, Math.round(s / 60)) + " m";
    return "up " + Math.round(s / 3600) + " h";
  }
  function renderHeader(s) {
    const st = $("liveStatus");
    st.classList.toggle("bad", !s.ok);
    $("liveText").textContent = s.ok ? "Live \u00b7 updated " + agoSecs(s.updated_at) : "Source unreachable";
    $("err").hidden = !!s.ok;
    $("err").textContent = s.ok ? "" : "Last error: " + s.error;
    const label = s.source ? s.source.label || "" : "";
    const model = s.source ? s.source.model || "" : "";
    $("srcLabel").textContent = label;
    $("srcSep").hidden = !(label && model);
    $("model").textContent = model;
    renderVllm(s.vllm);
  }
  function renderVllm(v) {
    const txt = $("vllmPillText"), btn = $("vllmBtn");
    btn.hidden = true;
    if (!v || v.available === false) {
      txt.textContent = (v && v.error) ? v.error : "container control unavailable";
      return;
    }
    if (!v.exists) { txt.textContent = "vLLM container missing"; return; }
    if (v.running) {
      const up = uptimeStr(v.started_at);
      const h = v.health === "healthy" ? ", healthy" : v.health ? ", " + v.health : "";
      txt.textContent = "vLLM running" + h + (up ? ", " + up : "");
      btn.textContent = "Restart\u2026";
      btn.dataset.act = "restart";
      btn.hidden = false;
    } else {
      txt.textContent = "vLLM stopped";
      btn.textContent = "Start\u2026";
      btn.dataset.act = "start";
      btn.hidden = false;
    }
  }
  $("vllmBtn").addEventListener("click", () => {
    const btn = $("vllmBtn");
    const a = btn.dataset.act;
    if (!a) return;
    const warn = a === "start"
      ? "Start vLLM? First start after a cold cache can take up to ~15 min."
      : "vLLM " + a + "? In-flight requests drop until it is back (a cold start can take ~15 min).";
    if (!confirm(warn)) return;
    btn.disabled = true;
    fetch("/api/vllm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: a }) })
      .then(r => r.json())
      .then(j => { btn.disabled = false; if (!j.ok && j.error) alert("error: " + j.error); })
      .catch(() => { btn.disabled = false; alert("request failed"); });
  });

  /* ---------- section 1: pipeline + throughput ---------- */
  const rangeNames = { 15: "last 15 minutes", 60: "last hour", 360: "last 6 hours", 1440: "last 24 hours", 10080: "last 7 days" };
  const avgLabel = s => {
    const w = (s && s.live && s.live.avg_window_s) || 120;
    return w % 60 === 0 ? (w / 60) + "-minute average" : w + "-second average";
  };
  const avgLabelShort = s => {
    const w = (s && s.live && s.live.avg_window_s) || 120;
    return w % 60 === 0 ? (w / 60) + "-min avg" : w + "s avg";
  };

  function renderS1(s) {
    const L = s.live, H = s.history || [];
    $("rangeMeta").textContent = (rangeNames[rangeMin] || ("last " + rangeMin + " min")) +
      (H.length >= 2 ? " \u00b7 " + hhmm(H[0].t) + " to " + hhmm(H[H.length - 1].t) : "");
    $("avgLegend").textContent = avgLabel(s);
    renderSummary(s, L);
    renderPipeline(s, L, H);
    drawMainChart(H);
  }

  function renderSummary(s, L) {
    const p = clear($("summary"));
    if (!L) { p.textContent = "Waiting for the first poll\u2026"; return; }
    const running = L.running || 0, waiting = L.waiting || 0;
    if (running === 0) { p.textContent = "Idle: nothing is generating."; return; }
    const avg = L.gen_tps_avg;
    const d = avg ? (L.gen_tps - avg) / avg : 0;
    const pct = Math.round(100 * Math.abs(d));
    const kvv = L.kv_cache_pct;
    let kv;
    if (kvv == null) kv = "not exposed by this server";
    else if (kvv < 25) kv = "a quarter full or less";
    else if (kvv < 45) kv = "under half full";
    else if (kvv < 50) kv = "just under half full";
    else if (kvv < 75) kv = "more than half full";
    else kv = Math.round(kvv) + "% full";
    p.appendChild(document.createTextNode("Generating "));
    p.appendChild(el("b", null, fmt1(L.gen_tps) + " tokens a second"));
    p.appendChild(document.createTextNode(" for " + running + (running === 1 ? " request" : " requests") + " while " +
      (waiting === 1 ? "1 waits" : waiting + " wait") + " for a slot. Decode is " +
      pct + "% " + (d >= 0 ? "above" : "below") + " its " + avgLabel(s) +
      " and the GPU KV cache is " + kv + "."));
  }

  function miniSvg(parts) {
    const svg = svgEl("svg", { viewBox: "0 0 1000 100", preserveAspectRatio: "none" });
    svg.setAttribute("class", "stage-mini");
    parts.forEach(a => svg.appendChild(svgEl("path", a)));
    return svg;
  }
  const baseline = () => ({ d: BASE, fill: "none", style: "stroke:var(--border-2)", "stroke-width": 1, "vector-effect": "non-scaling-stroke" });

  function makeStage(opts) {
    const st = el("div", "stage" + (opts.decode ? " decode" : ""));
    if (opts.col) st.style.setProperty("--stage", "var(--" + opts.col + ")");
    const lab = el("div", "stage-label", opts.label);
    if (opts.badge) lab.appendChild(opts.badge);
    st.appendChild(lab);
    const num = el("div", "stage-num" + (opts.numCls ? " " + opts.numCls : ""));
    const val = el("span", "val");
    val.classList.add("flashy");
    lastNum(opts.key, val, opts.num);
    num.appendChild(val);
    num.appendChild(el("small", null, opts.unit));
    st.appendChild(num);
    st.appendChild(el("div", "stage-cap", opts.caption));
    if (opts.details && opts.details.length) {
      const d = el("div", "stage-details");
      opts.details.forEach(r => {
        const row = el("div", "detail-row");
        row.appendChild(el("span", null, r[0]));
        if (r[1] != null) row.appendChild(el("b", null, r[1]));
        d.appendChild(row);
      });
      st.appendChild(d);
    }
    if (opts.extra) st.appendChild(opts.extra);
    if (opts.mini) st.appendChild(opts.mini);
    return st;
  }

  function renderPipeline(s, L, H) {
    const p = clear($("pipeline"));
    const kv = s.kv, G = kv ? (kv.gpu || {}) : {};
    const T = s.totals || {};
    const lat = s.lat || {};
    const queuedGw = gw.last ? gw.last.in_flight.filter(r => r.phase === "queued").length : null;
    const arrow = el("div", "pipe-arrow", "\u2192");

    /* 1 \u00b7 Queue */
    const qHi = Math.max(4, ...H.map(r => r.waiting || 0));
    const qMini = miniSvg([
      { d: TC.barsPath(H.map(r => r.waiting), { lo: 0, hi: qHi, bw: 0.7 }), fill: "none", style: "fill:var(--warn)" },
      baseline(),
    ]);
    const q = makeStage({ key: "q", col: "warn", label: "1 \u00b7 Queue", unit: "waiting", numCls: "warn",
      num: L.waiting == null ? "\u2013" : fmtInt(L.waiting), caption: "for a free slot",
      details: [
        ["queue time p90", secStr(lat.queue_p90)],
        ["preempted since restart", G.preemptions == null ? "\u2013" : fmtInt(G.preemptions)],
        ["queued at the gateway", queuedGw == null ? "\u2013" : String(queuedGw)],
      ],
      mini: qMini });

    /* 2 \u00b7 Prefill */
    const preHi = Math.max(1, ...H.map(r => r.prompt_tps || 0));
    const preNice = TC.niceScale(0, preHi, 4).hi;
    const pMini = miniSvg([
      { d: TC.barsPath(H.map(r => r.prompt_tps), { lo: 0, hi: preNice, bw: 0.6 }), fill: "none", style: "fill:color-mix(in srgb, var(--line) 75%, transparent)" },
      baseline(),
    ]);
    const pf = makeStage({ key: "p", col: "border-3", label: "2 \u00b7 Prefill", unit: "tok/s",
      num: compact(L.prompt_tps), caption: "reading prompts",
      details: [
        ["from prefix cache \u00b7 60 s", G.hit_rate_60s == null ? "\u2013" : (100 * G.hit_rate_60s).toFixed(1) + "%"],
        ["first token p50", secStr(lat.ttft_p50)],
      ],
      mini: pMini });

    /* 3 \u00b7 Decode */
    const genVals = H.map(r => r.gen_tps), avgVals = H.map(r => r.gen_tps_avg);
    const dNice = TC.niceScale(0, Math.max(1, ...genVals, ...avgVals), 4).hi;
    const dMini = miniSvg([
      { d: TC.paths(avgVals, { lo: 0, hi: dNice }).line, fill: "none", style: "stroke:var(--text-3)", "stroke-width": 1, "stroke-dasharray": "4 4", "vector-effect": "non-scaling-stroke" },
      { d: TC.paths(genVals, { lo: 0, hi: dNice }).line, fill: "none", style: "stroke:var(--line)", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" },
      baseline(),
    ]);
    let badge = null;
    const dd = L.gen_tps == null || L.gen_tps_avg == null ? null : L.gen_tps - L.gen_tps_avg;
    if (dd != null) {
      badge = el("span", "delta-badge" + (Math.abs(dd) < 0.5 ? "" : dd > 0 ? " up" : " down"),
        (dd >= 0 ? "+" : "\u2212") + Math.abs(dd).toFixed(1) + " vs " + avgLabelShort(s));
    }
    const dec = makeStage({ key: "d", col: "line", decode: true, label: "3 \u00b7 Decode", unit: "tok/s",
      badge, num: fmt1(L.gen_tps),
      caption: fmtInt(L.running) + (L.running === 1 ? " request generating" : " requests generating"),
      details: [
        ["between tokens", L.itl_ms == null ? "\u2013" : Math.round(L.itl_ms) + " ms"],
        ["MTP drafts kept", L.accept_rate == null ? "\u2013" : (100 * L.accept_rate).toFixed(1) + "%"],
      ],
      mini: dMini });

    /* 4 \u00b7 Done */
    const f = T.finish || {};
    const fTotal = Object.values(f).reduce((a, b) => a + b, 0);
    let extra = null;
    if (fTotal > 0) {
      extra = el("div");
      const bar = el("div", "finish-bar");
      const leg = el("div", "finish-legend");
      ["stop", "length", "abort"].forEach(k => {
        const v = f[k] || 0;
        if (v <= 0) return;
        const i = el("i", k);
        i.style.width = (100 * v / fTotal).toFixed(1) + "%";
        bar.appendChild(i);
        leg.appendChild(el("span", k, k + " " + (100 * v / fTotal).toFixed(1) + "%"));
      });
      extra.appendChild(bar);
      extra.appendChild(leg);
    }
    const done = makeStage({ key: "n", col: "border-3", label: "4 \u00b7 Done", unit: "req/min",
      num: fmt1(L.req_per_min),
      caption: (T.mean_e2e_s == null ? "\u2013" : T.mean_e2e_s.toFixed(1)) + " s end-to-end on average",
      details: [
        ["end-to-end p90", secStr(lat.e2e_p90)],
        ["how they ended", null],
      ],
      extra });

    p.append(q, arrow.cloneNode(true), pf, arrow.cloneNode(true), dec, arrow.cloneNode(true), done);
  }

  function countWord(n) { return { 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five" }[n] || String(n); }

  function findEvents(H) {
    const evs = [];
    /* preemption bursts: the preempt counter went up */
    for (let i = 1; i < H.length; i++) {
      const p0 = H[i - 1].preempt, p1 = H[i].preempt;
      if (p0 == null || p1 == null || p1 <= p0) continue;
      if (H[i].reset) continue;  /* a restart poll's preempt jump is the lifetime fold, not a burst */
      let surge = 0;
      for (let j = Math.max(1, i - 6); j <= i; j++) {
        if (H[j].reset || H[j - 1].reset) continue;  /* a restart poll's delta is the whole lifetime, not a prompt */
        surge = Math.max(surge, (H[j].prompt_tokens || 0) - (H[j - 1].prompt_tokens || 0));
      }
      const dip = H[Math.min(H.length - 1, i + 2)];
      evs.push({ kind: "preempt", x: H[i].t, n: Math.max(1, Math.round(surge / 1000)),
        kv: H[i].kv == null ? null : Math.round(H[i].kv), k: Math.round(p1 - p0),
        gen: Math.round(dip ? (dip.gen_tps || 0) : 0) });
    }
    /* idle runs: gen_tps at 0 for at least 30 s */
    let start = -1;
    for (let i = 0; i <= H.length; i++) {
      const zero = i < H.length && H[i].gen_tps != null && H[i].gen_tps <= 0;
      if (zero && start < 0) start = i;
      if ((!zero || i === H.length) && start >= 0) {
        const end = zero ? i : i - 1;
        if (end > start && H[end].t - H[start].t >= 30) {
          const dur = Math.round(H[end].t - H[start].t);
          evs.push({ kind: "idle", a: H[start].t, b: H[end].t, dur });
        }
        start = -1;
      }
    }
    /* RAM-restore bursts: load rate above ~1.5 GB/min */
    start = -1;
    for (let i = 0; i <= H.length; i++) {
      const hot = i < H.length && H[i].kv_load_gbps != null && H[i].kv_load_gbps > 1.5;
      if (hot && start < 0) start = i;
      if ((!hot || i === H.length) && start >= 0) {
        const end = hot ? i : i - 1;
        if (end > start) {
          let gb = 0;
          for (let j = start; j <= end; j++) {
            const dt = j > 0 ? H[j].t - H[j - 1].t : 5;
            gb += (H[j].kv_load_gbps || 0) * dt / 60;
          }
          evs.push({ kind: "restore", a: H[start].t, b: H[end].t, gb });
        }
        start = -1;
      }
    }
    evs.sort((a, b) => (a.x != null ? a.x : a.a) - (b.x != null ? b.x : b.a));
    return evs;
  }

  function drawMainChart(H) {
    const plot = clear($("mcPlot"));
    const notes = clear($("mcNotes"));
    const xrow = clear($("mcX"));
    if (H.length < 2) return;
    const t0 = H[0].t, t1 = H[H.length - 1].t, span = Math.max(t1 - t0, 1);
    const genVals = H.map(r => r.gen_tps), avgVals = H.map(r => r.gen_tps_avg);
    const hi = TC.niceScale(0, Math.max(1, ...genVals, ...avgVals), 5).hi;
    const gen = TC.paths(genVals, { lo: 0, hi });
    const avg = TC.paths(avgVals, { lo: 0, hi });

    const g0 = el("div", "mc-grid"); g0.style.top = "0";
    const g1 = el("div", "mc-grid"); g1.style.top = "50%";
    plot.appendChild(g0); plot.appendChild(g1);
    plot.appendChild(el("div", "mc-base"));

    const evs = findEvents(H);
    evs.forEach(e => {
      if (e.kind === "preempt") {
        const l = el("div", "mc-evline");
        l.style.left = (100 * (e.x - t0) / span).toFixed(2) + "%";
        plot.appendChild(l);
      } else {
        const b = el("div", "mc-band " + e.kind);
        b.style.left = (100 * (e.a - t0) / span).toFixed(2) + "%";
        b.style.width = (100 * Math.max(e.b - e.a, 1) / span).toFixed(2) + "%";
        if (e.kind === "idle") b.appendChild(el("span", "lbl", "idle " + e.dur + " s"));
        plot.appendChild(b);
      }
    });

    const svg = svgEl("svg", { viewBox: "0 0 1000 100", preserveAspectRatio: "none" });
    gradient(svg, "mcgen", "line", ".28");
    svg.appendChild(svgEl("path", { d: gen.area, fill: "url(#mcgen)" }));
    svg.appendChild(svgEl("path", { d: avg.line, fill: "none", style: "stroke:var(--text-3)", "stroke-width": 1.25, "stroke-dasharray": "5 5", "vector-effect": "non-scaling-stroke" }));
    svg.appendChild(svgEl("path", { d: gen.line, fill: "none", style: "stroke:var(--line)", "stroke-width": 2, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
    plot.appendChild(svg);

    const y1 = el("span", "mc-ylab", Math.round(hi) + " tok/s"); y1.style.top = "4px";
    const y2 = el("span", "mc-ylab", String(Math.round(hi / 2))); y2.style.top = "calc(50% + 4px)";
    plot.appendChild(y1); plot.appendChild(y2);

    const lastV = lastNonNull(genVals);
    if (lastV != null) {
      const yp = (1 - lastV / hi) * 100;
      const dot = el("span", "mc-dot");
      dot.style.left = "100%"; dot.style.top = yp.toFixed(1) + "%";
      const lab = el("span", "mc-end", fmt1(lastV));
      lab.style.left = "calc(100% + 12px)"; lab.style.top = yp.toFixed(1) + "%";
      plot.appendChild(dot); plot.appendChild(lab);
    }

    const mk = (frac, txt, cls) => { const s = el("span", cls, txt); s.style.left = frac; return s; };
    const x0 = mk("0", hhmm(t0));
    const x1 = mk("33.33%", hhmm(t0 + span / 3)); x1.style.transform = "translateX(-50%)";
    const x2 = mk("66.67%", hhmm(t0 + span * 2 / 3)); x2.style.transform = "translateX(-50%)";
    const x3 = el("span", null, hhmm(t1)); x3.style.right = "0";
    xrow.append(x0, x1, x2, x3);

    /* notes: one per notable event, at most 3, skip collisions */
    const placed = [];
    for (const e of evs) {
      if (e.kind !== "preempt" && e.kind !== "restore") continue;
      if (placed.length >= 3) break;
      const x = 100 * ((e.kind === "preempt" ? e.x : e.a) - t0) / span;
      if (placed.some(pp => Math.abs(pp - x) < 18)) continue;
      placed.push(x);
      const n = el("div", "mc-note " + (e.kind === "preempt" ? "bad" : "good"));
      n.style.left = x.toFixed(2) + "%";
      n.appendChild(el("div", "t", hhmm(e.kind === "preempt" ? e.x : e.a)));
      n.appendChild(el("div", "txt", e.kind === "preempt"
        ? "A " + e.n + "K-token prompt filled the cache to " + (e.kv == null ? "\u2013" : e.kv) + "%. " +
          countWord(e.k) + " request" + (e.k === 1 ? " was" : "s were") + " preempted and decode fell to " + e.gen + " tok/s."
        : "Returning sessions reloaded " + e.gb.toFixed(1) + " GB of KV from RAM instead of recomputing it."));
      notes.appendChild(n);
    }
  }

  /* ---------- section 2: live requests (gateway observer, untrusted data) ---------- */
  const PH = {
    queued: ["warn", "queued"], prefill: ["text-2", "prefill"], thinking: ["gpu-mem", "thinking"],
    answering: ["line", "answering"], tool_call: ["power", "tool call"], done: ["good", "done"], error: ["bad", "error"],
  };
  const CTX = { function_call_output: "after tool output", message: "user turn" };
  function gwLabel(r) { return r.thread ? String(r.thread).slice(-8) : r.id; }
  /* "tail is repeating": any 40-char substring (stepping 10) seen 3+ times */
  function repeats(t) {
    if (!t || t.length < 160) return false;
    for (let i = 0; i + 40 < t.length; i += 10) {
      if (t.split(t.substr(i, 40)).length - 1 >= 3) return true;
    }
    return false;
  }

  function gwPoll() {
    if (gw.enabled === false) return;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 1500);
    fetch("/api/gw_live", { signal: ctl.signal })
      .then(r => {
        if (r.status === 404) { gw.enabled = false; $("s2").hidden = true; return null; }
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(j => {
        if (!j) return;
        gw.last = j; gw.okAt = Date.now(); gw.stale = false;
        gwUpdateSpark(j);
        if (gw.openId && !j.in_flight.some(r => r.id === gw.openId)) gw.openId = null;
        renderGw();
      })
      .catch(() => {
        if (gw.enabled !== false) { gw.stale = true; renderGw(); }  /* re-render keeps the last snapshot, dims it, and updates the STALE pill */
      })
      .finally(() => clearTimeout(to));
    setTimeout(gwPoll, 1000);
  }

  function gwUpdateSpark(snap) {
    const ids = new Set(snap.in_flight.map(r => r.id));
    for (const id of Array.from(gw.spark.keys())) if (!ids.has(id)) gw.spark.delete(id);
    for (const r of snap.in_flight) {
      let a = gw.spark.get(r.id);
      if (!a) { a = []; gw.spark.set(r.id, a); }
      a.push(r.tok_s != null ? r.tok_s : null);
      if (a.length > 60) a.splice(0, a.length - 60);
    }
  }

  function renderGwStatus() {
    const n = clear($("gwStatus"));
    if (gw.stale && gw.last) {
      const age = Math.max(1, Math.round((Date.now() - gw.okAt) / 1000));
      const pill = el("span", "gw-stale");
      pill.appendChild(el("span", "tag", "STALE"));
      pill.appendChild(document.createTextNode("Gateway unreachable \u00b7 showing the " + hhmmss(gw.last.time) + " snapshot, " + age + " s old"));
      n.appendChild(pill);
    } else if (gw.okAt) {
      const s = Math.max(1, Math.round((Date.now() - gw.okAt) / 1000));
      const live = el("span", "gw-live");
      live.appendChild(el("span", "dot"));
      live.appendChild(document.createTextNode("Gateway live \u00b7 polled " + s + " s ago"));
      const origin = gw.last && gw.last.origin ? hostPort(gw.last.origin) : "";
      live.appendChild(el("span", "ep", (lastSnap && lastSnap.gateway_url ? hostPort(lastSnap.gateway_url) : "gateway") + " \u2192 vLLM " + origin));
      n.appendChild(live);
    } else if (gw.stale) {
      const pill = el("span", "gw-stale");
      pill.appendChild(el("span", "tag", "STALE"));
      pill.appendChild(document.createTextNode("Gateway unreachable"));
      n.appendChild(pill);
    }
  }

  function renderGw() {
    if (gw.enabled === false || !lastSnap) return;
    $("s2").hidden = false;
    renderGwStatus();
    const stale = gw.stale && !!gw.last;
    $("gwLiveWrap").classList.toggle("stale", stale);
    $("gwRecentWrap").classList.toggle("stale", stale);
    const snap = gw.last;
    if (!snap) {
      clear($("gwSummary")); clear($("gwLive")); clear($("gwRecent"));
      $("gwRecentSub").textContent = "";
      return;
    }
    renderGwSummary(snap, stale);
    renderGwLive(snap);
    renderGwRecent(snap);
  }

  function renderGwSummary(snap, stale) {
    const p = clear($("gwSummary"));
    const inFlight = snap.in_flight || [];
    const gen = inFlight.filter(r => ["thinking", "answering", "tool_call"].indexOf(r.phase) >= 0);
    const pre = inFlight.filter(r => r.phase === "prefill");
    const q = inFlight.filter(r => r.phase === "queued");
    const sum = gen.reduce((a, r) => a + (r.tok_s || 0), 0);
    const w = pre.filter(r => r.age_s > 15).sort((a, b) => b.age_s - a.age_s)[0];
    const are = n => n === 1 ? "is" : "are";
    p.appendChild(el("b", null, (stale ? "As of " + hhmmss(snap.time) + ", " : "") + inFlight.length + (inFlight.length === 1 ? " request in flight" : " requests in flight") + "."));
    p.appendChild(document.createTextNode(" " + gen.length + " " + are(gen.length) + " generating at " +
      sum.toFixed(1) + " tok/s combined, " + pre.length + " " + are(pre.length) +
      " waiting for a first token and " + q.length + " " + are(q.length) + " queued at the gateway." +
      (w ? " " + gwLabel(w) + " has waited " + Math.round(w.age_s) + " s without one." : "")));
  }

  function renderGwLive(snap) {
    const wrap = clear($("gwLive"));
    const head = el("div", "gw-head");
    ["Thread", "Doing", "First token", "Running", "Prompt", "Output", "tok/s", "tok/s \u00b7 last 60 s", ""].forEach((h, i) => {
      const sp = el("span", null, h);
      if (i >= 2 && i <= 6) sp.style.textAlign = "right";
      head.appendChild(sp);
    });
    wrap.appendChild(head);
    (snap.in_flight || []).forEach(r => wrap.appendChild(gwLiveRow(r, snap)));
    wrap.appendChild(el("div", "gw-foot", "~ is an estimate: prompt bytes \u00f7 3.6 before the request finishes, output counted while it streams. Exact counts and cache hits arrive with the finished request. Click a row to read what it is generating."));
  }

  function gwLiveRow(r, snap) {
    const cell = el("div", "gw-rowcell");
    const row = el("div", "gw-row");
    /* thread */
    const th = el("div", "gw-th");
    th.appendChild(el("div", "l1", gwLabel(r)));
    const sub = [CTX[r.last_input_type] || r.last_input_type, r.thread ? r.effort : r.client].filter(Boolean).join(" \u00b7 ");
    th.appendChild(el("div", "l2", sub));
    row.appendChild(th);
    /* doing: phase badge + note */
    const ph = PH[r.phase] || ["text-2", String(r.phase)];
    const doing = el("div", "gw-doing");
    const badge = el("span", "gw-phase");
    badge.style.color = "var(--" + ph[0] + ")";
    badge.style.background = "color-mix(in srgb, var(--" + ph[0] + ") 14%, transparent)";
    const dot = el("i");
    dot.style.background = "var(--" + ph[0] + ")";
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(ph[1]));
    const rep = r.phase === "thinking" && repeats(r.tail);
    const note = el("span", "gw-note");
    note.style.color = rep ? "var(--warn)" : "var(--text-2)";
    if (r.phase === "tool_call") note.textContent = r.tool_name || "";
    else if (rep) note.textContent = "tail is repeating";
    doing.appendChild(badge);
    doing.appendChild(note);
    row.appendChild(doing);
    /* numbers */
    const hasTok = r.ttft_s != null;
    row.appendChild(el("div", "gw-num", hasTok ? r.ttft_s.toFixed(2) + " s" : "\u2014"));
    const waiting = r.phase === "prefill" && !hasTok && r.age_s > 15;
    const age = el("div", "gw-num", dur(r.age_s));
    if (waiting) age.style.color = "var(--t-hot)";
    row.appendChild(age);
    const prompt = el("div", "gw-num");
    if (r.prompt_tokens_is_estimate) prompt.appendChild(el("span", "est", "~"));
    prompt.appendChild(document.createTextNode(K(r.prompt_tokens)));
    row.appendChild(prompt);
    const output = el("div", "gw-num");
    if (r.output_tokens && r.output_tokens_is_estimate) output.appendChild(el("span", "est", "~"));
    output.appendChild(document.createTextNode(r.output_tokens ? K(r.output_tokens) : "\u2014"));
    row.appendChild(output);
    row.appendChild(el("div", "gw-tok", r.tok_s == null ? "\u2014" : r.tok_s.toFixed(1)));
    /* tok/s sparkline (shared 0\u201340 scale) or wait text */
    const sp = el("div", "gw-spark");
    if (hasTok) {
      const arr = gw.spark.get(r.id) || [];
      const svg = svgEl("svg", { viewBox: "0 0 1000 100", preserveAspectRatio: "none" });
      svg.appendChild(svgEl("path", { d: BASE, fill: "none", style: "stroke:var(--border-2)", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
      const d = TC.paths(arr, { lo: 0, hi: 40 }).line;
      if (d) svg.appendChild(svgEl("path", { d: d, fill: "none", style: "stroke:var(--line)", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
      sp.appendChild(svg);
    } else {
      let txt, col;
      if (waiting) { txt = "No first token after " + Math.round(r.age_s) + " s \u00b7 waiting for GPU"; col = "t-hot"; }
      else if (r.phase === "queued") { txt = "Queued at the gateway"; col = "text-3"; }
      else { txt = "Reading the prompt or restoring KV from RAM"; col = "text-3"; }
      const w = el("span", "gw-wait", txt);
      w.style.color = "var(--" + col + ")";
      sp.appendChild(w);
    }
    row.appendChild(sp);
    /* tail toggle */
    const tb = el("div", "gw-tailbtn");
    if (r.tail) tb.appendChild(el("span", null, gw.openId === r.id ? "Hide tail" : "Show tail"));
    row.appendChild(tb);
    cell.appendChild(row);
    if (gw.openId === r.id && r.tail) cell.appendChild(gwTailBox(r));
    row.addEventListener("click", () => {
      if (!r.tail) return;
      gw.openId = gw.openId === r.id ? null : r.id;
      renderGwLive(snap);
    });
    return cell;
  }

  function gwTailBox(r) {
    const box = el("div", "gw-tailbox");
    const kind = r.phase === "tool_call" ? "tool arguments" : r.phase === "answering" ? "the answer" : "thinking";
    const chars = r.phase === "tool_call" ? r.tool_chars : r.phase === "answering" ? r.output_chars : r.reasoning_chars;
    const head = el("div", "gw-tailhead");
    head.appendChild(el("span", "a", "Last " + r.tail.length + " characters of " + kind + " \u00b7 " + (chars || 0).toLocaleString("en-US") + " streamed so far"));
    head.appendChild(el("span", "b", [r.id, r.client, r.model + (r.effort ? " " + r.effort : ""),
      (r.input_items || 0) + " input items", (r.tools || 0) + " tools", (r.events || 0).toLocaleString("en-US") + " events"].join(" \u00b7 ")));
    head.appendChild(el("span", "c", "shown as plain text, never run"));
    box.appendChild(head);
    const pre = el("pre");
    pre.textContent = r.tail; /* untrusted data: text only, never parsed or executed */
    box.appendChild(pre);
    return box;
  }

  function renderGwRecent(snap) {
    const recent = snap.recent || [];
    const okN = recent.filter(r => r.finish === "completed").length;
    const tt = recent.map(r => r.ttft_s).filter(x => x != null).sort((a, b) => a - b);
    let P = 0, C = 0;
    recent.forEach(r => { if (r.cached_tokens != null) { P += r.prompt_tokens || 0; C += r.cached_tokens || 0; } });
    $("gwRecentSub").textContent = "last " + recent.length + ": " + okN + " completed, " + (recent.length - okN) +
      " did not \u00b7 median first token " + (tt.length ? tt[Math.floor(tt.length / 2)].toFixed(2) : "\u2014") +
      " s \u00b7 " + (P ? (100 * C / P).toFixed(1) : "\u2014") + "% of their prompt tokens came from cache";
    const wrap = clear($("gwRecent"));
    const head = el("div", "gw-rhead");
    ["Thread", "Ended as", "First token", "Prompt", "From cache", "Cached", "Output", "tok/s", "Took"].forEach((h, i) => {
      const sp = el("span", null, h);
      if (i >= 2) sp.style.textAlign = "right";
      head.appendChild(sp);
    });
    wrap.appendChild(head);
    (gw.showAll ? recent : recent.slice(0, 10)).forEach(r => wrap.appendChild(gwRecentRow(r)));
    const foot = el("div", "gw-rfoot");
    const btn = el("button", "gw-more", gw.showAll ? "Show the latest 10" : "Show all " + recent.length);
    btn.type = "button";
    btn.addEventListener("click", () => { gw.showAll = !gw.showAll; renderGwRecent(snap); });
    foot.appendChild(btn);
    foot.appendChild(el("span", "note", "Rows that did not complete are tinted red."));
    wrap.appendChild(foot);
  }

  function gwRecentRow(r) {
    const ok = r.finish === "completed";
    const row = el("div", "gw-rrow" + (ok ? "" : " bad"));
    row.appendChild(el("span", null, gwLabel(r)));
    const fin = el("span", "gw-fin");
    fin.appendChild(el("span", "f " + (ok ? "ok" : "bad"), r.finish));
    if (r.error) {
      const e = el("span", "e", r.error);
      e.title = r.error;
      fin.appendChild(e);
    }
    row.appendChild(fin);
    row.appendChild(el("span", "rt", r.ttft_s == null ? "\u2014" : r.ttft_s.toFixed(2) + " s"));
    row.appendChild(el("span", "rt", K(r.prompt_tokens)));
    row.appendChild(el("span", "rt", K(r.cached_tokens)));
    const pc = r.cached_tokens != null && r.prompt_tokens ? 100 * r.cached_tokens / r.prompt_tokens : null;
    const cached = el("span", "gw-cached");
    const bar = el("span", "gw-cbar");
    const fill = el("i");
    fill.style.width = (pc == null ? 0 : pc).toFixed(1) + "%";
    bar.appendChild(fill);
    cached.appendChild(bar);
    cached.appendChild(document.createTextNode(pc == null ? "\u2014" : pc.toFixed(1) + "%"));
    row.appendChild(cached);
    row.appendChild(el("span", "rt", K(r.output_tokens)));
    row.appendChild(el("span", "rt", r.tok_s == null ? "\u2014" : r.tok_s.toFixed(1)));
    row.appendChild(el("span", "rt", dur(r.age_s)));
    return row;
  }

  /* ---------- section 3: kv cache + hardware ---------- */
  function tempClass(c) {
    if (c == null) return "t-ok";
    if (c < 70) return "t-ok";
    if (c < 85) return "t-warm";
    if (c < 95) return "t-hot";
    return "t-crit";
  }
  const STATE_WORD = { "t-ok": "nominal", "t-warm": "warm", "t-hot": "hot", "t-crit": "critical" };

  function renderS3(s) {
    const kvCol = $("kvCol"), hwCol = $("hwCol");
    const gpus = s.gpus || [], cpu = s.cpu || {};
    const hasKv = !!s.kv;
    const hasCpu = cpu.tctl_c != null || cpu.ghz_max != null || cpu.pct != null;
    const hasHw = gpus.length > 0 || hasCpu;
    kvCol.style.display = hasKv ? "" : "none";
    hwCol.style.display = hasHw ? "" : "none";
    if (!hasKv && !hasHw) { $("s3").style.display = "none"; return; }
    $("s3").style.display = "";
    if (hasKv) renderKvCol(s.kv, s.history || []);
    if (hasHw) renderHwCol(gpus, s.gpu_history || [], cpu, s.history || []);
  }

  function renderKvCol(KV, rows) {
    const G = KV.gpu || {}, R = KV.ram || {};
    const since = KV.since_restart || KV.first_seen;
    const p = clear($("kvSentence"));
    p.appendChild(el("b", null, G.hit_rate_60s == null ? "\u2013" : (100 * G.hit_rate_60s).toFixed(1) + "%"));
    p.appendChild(document.createTextNode(" of prompt tokens came straight from cache in the last minute, " +
      (G.hit_rate_since_restart == null ? "\u2013" : (100 * G.hit_rate_since_restart).toFixed(1) + "%") +
      " since the " + shortDate(since) + " restart."));

    const tiers = clear($("kvTiers"));
    const nameCell = (a, b) => { const d = el("div"); d.appendChild(el("div", "kv-tier-name", a)); d.appendChild(el("div", "kv-tier-sub", b)); return d; };
    const gbmin = v => v == null ? "\u2013" : (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " GB/min";
    /* row 1: GPU VRAM */
    tiers.appendChild(nameCell("GPU VRAM", G.capacity_tokens ? compact(G.capacity_tokens) + " tok pool" : ""));
    const gw = G.usage_pct == null ? 0 : Math.max(0, Math.min(100, G.usage_pct));
    const gbar = el("div", "kv-bar gpu");
    const gfill = el("div", "fill"); gfill.style.width = gw.toFixed(1) + "%";
    gbar.appendChild(gfill);
    gbar.appendChild(el("div", "mark91"));
    gbar.appendChild(el("span", "val", gw.toFixed(1) + "%"));
    tiers.appendChild(gbar);
    const gside = el("div", "kv-side");
    gside.appendChild(el("b", null, G.tokens == null ? "\u2013" : compact(G.tokens)));
    gside.appendChild(document.createTextNode(" tokens in use"));
    tiers.appendChild(gside);
    /* row 2: store / load flow */
    tiers.appendChild(el("div"));
    const flow = el("div", "kv-flow");
    const down = el("span");
    down.appendChild(el("span", "down", "\u2193 " + gbmin(R.store_gbps)));
    down.appendChild(document.createTextNode(" stored to RAM"));
    const up = el("span");
    up.appendChild(el("span", "up", "\u2191 " + gbmin(R.load_gbps)));
    up.appendChild(document.createTextNode(" loaded back"));
    flow.append(down, up);
    tiers.appendChild(flow);
    tiers.appendChild(el("div"));
    /* row 3: CPU RAM */
    tiers.appendChild(nameCell("CPU RAM", R.capacity_gb ? R.capacity_gb.toFixed(1) + " GiB offload tier" : ""));
    const rw = R.usage_pct == null ? 0 : Math.max(0, Math.min(100, R.usage_pct));
    const rbar = el("div", "kv-bar ram");
    const rfill = el("div", "fill"); rfill.style.width = rw.toFixed(1) + "%";
    rbar.appendChild(rfill);
    const rval = el("span", "val", rw.toFixed(1) + "% pinned");
    rval.style.left = "calc(" + rw.toFixed(1) + "% + 10px)";
    rbar.appendChild(rval);
    tiers.appendChild(rbar);
    const rside = el("div", "kv-side");
    rside.appendChild(el("b", null, R.usage_gb == null ? "\u2013" : R.usage_gb.toFixed(2) + " GB"));
    rside.appendChild(document.createTextNode(" in flight"));
    tiers.appendChild(rside);

    /* hero */
    const hero = clear($("kvHero"));
    hero.appendChild(el("span", "n", R.load_chunks == null ? "\u2013" : fmtInt(R.load_chunks)));
    hero.appendChild(el("span", "t", "KV chunks restored from RAM instead of recomputed since restart." +
      (R.ext_tokens_since_restart != null ? " That is " + compact(R.ext_tokens_since_restart) + " tokens, loaded at " +
        (R.load_mbps == null ? "\u2013" : fmtInt(R.load_mbps)) + " MB/s on average." : "")));

    /* usage chart, 0\u2013100 with the 91% preemption reference */
    const mini = clear($("kvMini"));
    mini.appendChild(el("span", "cap", "GPU KV % \u00b7 " + shortRange(rangeMin)));
    const ref = el("div", "ref"); ref.style.top = "9%";
    mini.appendChild(ref);
    const rl = el("span", "reflbl", "91% \u00b7 preemptions"); rl.style.top = "9%";
    mini.appendChild(rl);
    const P = TC.paths(rows.map(r => r.kv), { lo: 0, hi: 100 });
    const svg = svgEl("svg", { viewBox: "0 0 1000 100", preserveAspectRatio: "none" });
    gradient(svg, "kvgrad", "accent", ".22");
    svg.appendChild(svgEl("path", { d: P.area, fill: "url(#kvgrad)" }));
    svg.appendChild(svgEl("path", { d: P.line, fill: "none", style: "stroke:var(--accent)", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));
    svg.appendChild(svgEl("path", { d: BASE, fill: "none", style: "stroke:var(--border-2)", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
    mini.appendChild(svg);
  }

  function renderHwCol(gpus, gpuHist, cpu, rows) {
    const hasCpu = cpu.tctl_c != null || cpu.ghz_max != null || cpu.pct != null;
    /* sentence: name only the units that are not nominal */
    const p = clear($("hwSentence"));
    const units = [];
    gpus.forEach(g => {
      const j = g.junction_c != null ? g.junction_c : g.edge_c;
      const c = tempClass(j);
      if (c !== "t-ok" && j != null) units.push({ name: "GPU " + g.index, cls: c, v: j });
    });
    const cc = tempClass(cpu.tctl_c);
    if (cc !== "t-ok" && cpu.tctl_c != null) units.push({ name: "the CPU", cls: cc, v: cpu.tctl_c });
    if (!gpus.length && !hasCpu) {
      p.textContent = "No hardware sensors are visible from this host.";
    } else if (units.length === 0) {
      const parts = [];
      if (gpus.length) parts.push("All GPUs");
      if (hasCpu) parts.push("the CPU");
      p.textContent = parts.join(" and ") + " are nominal.";
    } else {
      units.forEach((u, i) => {
        if (i) p.appendChild(document.createTextNode(", "));
        p.appendChild(document.createTextNode(u.name + " is running "));
        p.appendChild(el("b", null, STATE_WORD[u.cls] + " at " + Math.round(u.v) + " \u00b0C"));
        p.lastChild.style.color = "var(--" + u.cls + ")";
      });
      p.appendChild(document.createTextNode(" under load."));
    }
    /* shared 0\u2013110 \u00b0C scale (GPU junction crit is 110) */
    const scale = clear($("hwScale"));
    scale.appendChild(el("div"));
    const ticks = el("div", "ticks");
    [["0\u00b0", "0", false], ["70", "63.6", true], ["85", "77.3", true], ["95", "86.4", true], ["110", null, false]].forEach(t => {
      const sp = el("span", null, t[0]);
      if (t[1] != null) { sp.style.left = t[1] + "%"; if (t[2]) sp.style.transform = "translateX(-50%)"; }
      else sp.style.right = "0";
      ticks.appendChild(sp);
    });
    scale.appendChild(ticks);
    scale.appendChild(el("div", "note", "15-min range shaded"));

    const rowsEl = clear($("hwRows"));
    function gpuRange(idx) {
      const vs = [];
      (gpuHist || []).forEach(h => {
        const g = (h.gpus || []).find(x => x.index === idx);
        if (g && (g.junction_c != null || g.edge_c != null)) vs.push(g.junction_c != null ? g.junction_c : g.edge_c);
      });
      return vs.length ? [Math.min.apply(null, vs), Math.max.apply(null, vs)] : null;
    }
    const cpuRange = (function () {
      const vs = rows.map(r => r.cpu_c).filter(v => v != null && isFinite(v));
      return vs.length ? [Math.min.apply(null, vs), Math.max.apply(null, vs)] : null;
    })();
    function hwRow(name, cls, value, range, right, last) {
      const row = el("div", "hw-grid hw-row" + (last ? " last" : ""));
      const left = el("div");
      left.appendChild(el("div", "hw-name", name));
      const st = el("div", "hw-state", STATE_WORD[cls]);
      st.style.color = "var(--" + cls + ")";
      left.appendChild(st);
      row.appendChild(left);
      const track = el("div", "hw-track");
      const zones = el("div", "hw-zones");
      const z1 = el("i"); z1.style.width = "63.6%"; z1.style.background = "var(--t-ok-bg)";
      const z2 = el("i"); z2.style.width = "13.6%"; z2.style.background = "var(--t-warm-bg)";
      const z3 = el("i"); z3.style.width = "9.1%"; z3.style.background = "var(--t-hot-bg)";
      const z4 = el("i"); z4.style.background = "var(--t-crit-bg)";
      zones.append(z1, z2, z3, z4);
      track.appendChild(zones);
      if (range) {
        const rg = el("div", "hw-range");
        rg.style.left = (100 * Math.max(range[0], 0) / 110).toFixed(1) + "%";
        rg.style.width = (100 * Math.max(range[1] - range[0], 0.5) / 110).toFixed(1) + "%";
        rg.style.background = "color-mix(in srgb, var(--" + cls + ") 35%, transparent)";
        track.appendChild(rg);
      }
      if (value != null) {
        const pos = Math.max(0, Math.min(100, 100 * value / 110));
        const now = el("div", "hw-now");
        now.style.left = pos.toFixed(1) + "%";
        now.style.background = "var(--" + cls + ")";
        track.appendChild(now);
        const lab = el("span", "hw-val", value.toFixed(1) + "\u00b0");
        lab.style.left = pos.toFixed(1) + "%";
        lab.style.color = "var(--" + cls + ")";
        track.appendChild(lab);
      }
      row.appendChild(track);
      row.appendChild(right);
      return row;
    }
    function gpuRight(g) {
      const d = el("div", "hw-side");
      const l1 = el("span");
      l1.appendChild(el("b", null, g.power_w != null ? Math.round(g.power_w) + " W" : "\u2013"));
      l1.appendChild(document.createTextNode(" of " + (g.power_cap_w != null ? Math.round(g.power_cap_w) : "\u2013") + " cap"));
      const l2 = el("span");
      l2.style.display = "inline-flex";
      l2.style.alignItems = "center";
      l2.style.gap = "5px";
      const busy = g.busy_pct != null ? Math.round(g.busy_pct) + "% busy" : "\u2013";
      const vram = g.vram_used_gb != null && g.vram_total_gb != null ? " \u00b7 " + g.vram_used_gb.toFixed(1) + "/" + Math.round(g.vram_total_gb) + " GB" : "";
      l2.appendChild(document.createTextNode(busy + vram));
      d.appendChild(l1);
      d.appendChild(document.createElement("br"));
      d.appendChild(l2);
      return d;
    }
    function cpuRight() {
      const d = el("div", "hw-side");
      d.appendChild(el("b", null, cpu.ghz_max != null ? cpu.ghz_max.toFixed(2) + " GHz" : "\u2013"));
      d.appendChild(document.createTextNode(" fastest core"));
      d.appendChild(document.createElement("br"));
      d.appendChild(document.createTextNode((cpu.pct != null ? Math.round(cpu.pct) + "% busy" : "\u2013") + " \u00b7 load " + (cpu.load1 != null ? cpu.load1.toFixed(2) : "\u2013")));
      return d;
    }
    gpus.forEach(g => {
      const j = g.junction_c != null ? g.junction_c : g.edge_c;
      rowsEl.appendChild(hwRow("GPU " + g.index, tempClass(j), j, gpuRange(g.index), gpuRight(g), false));
    });
    if (hasCpu) rowsEl.appendChild(hwRow("CPU", tempClass(cpu.tctl_c), cpu.tctl_c, cpuRange, cpuRight(), !cpu.pct_cores.length));
    if (cpu.pct_cores && cpu.pct_cores.length) {
      const row = el("div", "hw-grid hw-threads");
      row.appendChild(el("div", "lab", cpu.pct_cores.length + " threads"));
      const cells = el("div", "hw-cells");
      cells.style.gridTemplateColumns = "repeat(" + cpu.pct_cores.length + ", minmax(0, 1fr))";
      cpu.pct_cores.forEach((pct, i) => {
        const c = el("i");
        c.style.background = "color-mix(in srgb, var(--series-pod) " + Math.round(pct) + "%, var(--surface-3))";
        c.title = "cpu" + i + " \u00b7 " + Math.round(pct) + "%";
        cells.appendChild(c);
      });
      row.appendChild(cells);
      row.appendChild(el("div", "lab", "busy per thread"));
      rowsEl.appendChild(row);
    }
    const note = $("hwNote");
    const bits = [];
    if (cpu.model) bits.push(cpu.model);
    if (cpu.cores) bits.push(cpu.cores + " cores / " + (cpu.threads || cpu.cores) + " threads");
    if (cpu.boost != null) bits.push("boost " + (cpu.boost ? "on" : "off"));
    if (cpu.mem_pct != null) bits.push(Math.round(cpu.mem_pct) + "% of memory in use");
    let nt = bits.length ? bits.join(", ") + ". " : "";
    nt += gpus.length ? "GPU temps are junction (hottest point)." + (hasCpu ? " " : "") : "";
    nt += hasCpu ? "CPU is k10temp Tctl." : "";
    note.textContent = nt;
    note.style.display = nt ? "" : "none";
  }

  /* ---------- section 4: economics ---------- */
  function scopeData(s) {
    if (scopeMode === "session" && s.session) return s.session;
    return { started_at: s.since, totals: s.totals, pod: s.pod, costs: s.costs };
  }
  function renderS4(s) {
    const sc = scopeData(s);
    renderEco(s, sc);
    if (ledgerData) renderLedger(ledgerData);
    renderTotals(s, sc);
  }
  function renderEco(s, sc) {
    const left = clear($("ecoLeft"));
    const T = sc.totals, P = sc.pod;
    const apis = (sc.costs || []).filter(c => c.kind === "api").sort((a, b) => (b.usd || 0) - (a.usd || 0));
    const ref = apis.find(c => c.name === s.hero_provider) || apis[0] || null;
    const saved = ref && P.usd != null ? Math.max(ref.usd - P.usd, 0) : null;
    const hero = el("div", "save-hero");
    const n = el("span", "n");
    n.classList.add("flashy");
    lastNum("saved", n, saved == null ? "$\u2013" : usdComma(saved));
    hero.appendChild(n);
    hero.appendChild(el("span", "s", "saved since " + shortDate(sc.started_at)));
    left.appendChild(hero);
    const sent = el("p", "eco-sentence");
    if (ref && P.usd != null) {
      sent.appendChild(document.createTextNode("Your box cost "));
      sent.appendChild(el("b", "pod", usdComma(P.usd)));
      sent.appendChild(document.createTextNode(" for " + hoursWord(P.hours) + " of wall-clock time. The same tokens at " + ref.name + " list prices would have cost "));
      sent.appendChild(el("b", "api", usdComma(ref.usd)));
      sent.appendChild(document.createTextNode("."));
    } else if (P.usd != null) {
      sent.textContent = "Your box cost " + usdComma(P.usd) + " for " + hoursWord(P.hours) + " of wall-clock time. Add API providers to config.json to compare.";
    } else {
      sent.textContent = "Pod cost is not configured, so savings cannot be computed.";
    }
    left.appendChild(sent);
    if (sc.costs && sc.costs.length) {
      const bars = el("div", "cost-bars");
      const maxUsd = Math.max.apply(null, [1e-9].concat(sc.costs.map(c => c.usd || 0)));
      apis.forEach(c => {
        const row = el("div", "cost-row");
        row.appendChild(el("span", "nm", c.name));
        const track = el("div", "cost-track");
        const inner = el("div", "inner");
        inner.style.width = (100 * c.usd / maxUsd).toFixed(2) + "%";
        [["s1", c.input_usd], ["s2", c.cached_usd], ["s3", c.output_usd]].forEach(seg => {
          const d = el("div", seg[0]);
          d.style.width = (c.usd ? 100 * (seg[1] || 0) / c.usd : 0).toFixed(2) + "%";
          inner.appendChild(d);
        });
        track.appendChild(inner);
        row.appendChild(track);
        row.appendChild(el("b", "tot", usdComma(c.usd)));
        row.appendChild(el("span", "x", c.x_pod == null ? "\u2013" : c.x_pod.toFixed(1) + "\u00d7"));
        bars.appendChild(row);
      });
      const podRow = sc.costs.find(c => c.kind === "pod");
      if (podRow) {
        const row = el("div", "cost-row pod");
        row.appendChild(el("span", "nm", podRow.name));
        const track = el("div", "cost-track");
        const fill = el("div", "podfill");
        fill.style.width = (100 * (podRow.usd || 0) / maxUsd).toFixed(2) + "%";
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el("b", "tot", usdComma(podRow.usd)));
        row.appendChild(el("span", "x", "1.0\u00d7"));
        bars.appendChild(row);
      }
      left.appendChild(bars);
      const leg = el("div", "cost-legend");
      [["s1", "uncached input"], ["s2", "cached input"], ["s3", "output"]].forEach(it => {
        const sp = el("span");
        sp.appendChild(el("i", "sw " + it[0]));
        sp.appendChild(document.createTextNode(it[1]));
        leg.appendChild(sp);
      });
      left.appendChild(leg);
    }
  }
  function renderLedger(data) {
    const col = clear($("ledgerCol"));
    const days = data.days || [];
    const hero = data.hero;
    const podDay = data.pod_per_day;
    const head = el("div", "ledger-head");
    head.appendChild(el("span", "t", "Day by day"));
    const sub = el("span", "s");
    sub.appendChild(document.createTextNode("what the traffic would have cost on " + (hero || "the API")));
    if (podDay != null) {
      sub.appendChild(document.createTextNode(", against your box at "));
      sub.appendChild(el("span", "pod", "$" + podDay.toFixed(2) + " a day"));
    }
    sub.appendChild(document.createTextNode("."));
    head.appendChild(sub);
    col.appendChild(head);
    if (!days.length) { col.appendChild(el("p", "ledger-cap", "No full days recorded yet.")); return; }
    const maxApi = Math.max.apply(null, days.map(d => d.api_usd || 0).concat([0]));
    /* $100 gridlines at design scale; step up in nice sizes once days cost more */
    let step = 100;
    for (const s of [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000, 100000])
      if (Math.ceil(Math.max(maxApi, 300) / s) <= 6) { step = s; break; }
    const hi = Math.max(300, Math.ceil(Math.max(maxApi, 300) / step) * step);
    const chart = el("div", "ledger-chart");
    for (let v = step; v <= hi; v += step) {
      const g = el("div", "grid");
      g.style.top = (100 - 100 * v / hi).toFixed(2) + "%";
      chart.appendChild(g);
      const gl = el("span", "glab", v >= 1000 ? "$" + (v / 1000) + "K" : "$" + v);
      gl.style.top = (100 - 100 * v / hi).toFixed(2) + "%";
      chart.appendChild(gl);
    }
    const bars = el("div", "ledger-bars");
    days.forEach(d => {
      const b = el("i");
      b.style.height = (100 * Math.max(d.api_usd || 0, 0) / hi).toFixed(1) + "%";
      if (d.dow === 0 || d.dow === 6) b.style.opacity = ".45";
      b.title = d.day + " \u00b7 " + (d.api_usd == null ? "\u2013" : "$" + Math.round(d.api_usd) + " on " + (hero || "the API")) +
        " \u00b7 box $" + (d.pod_usd != null ? d.pod_usd.toFixed(2) : "0.00");
      bars.appendChild(b);
    });
    chart.appendChild(bars);
    if (podDay != null && podDay > 0) {
      const line = el("div", "ledger-line");
      line.style.bottom = (100 * Math.min(podDay, hi) / hi).toFixed(2) + "%";
      chart.appendChild(line);
    }
    col.appendChild(chart);
    const xl = el("div", "ledger-x");
    xl.append(el("span", null, dayLabel(days[0].day)),
              el("span", null, dayLabel(days[Math.floor(days.length / 2)].day)),
              el("span", null, dayLabel(days[days.length - 1].day)));
    col.appendChild(xl);
    col.appendChild(el("p", "ledger-cap", "Weekends are dimmed. The box costs the same every hour; the API would only charge for tokens."));
  }
  function renderTotals(s, sc) {
    const T = sc.totals;
    const t = clear($("s4Totals"));
    const cell = (v, l, title) => {
      const d = el("div");
      const n = el("div", "v", v);
      if (title) n.title = title;
      d.appendChild(n);
      d.appendChild(el("div", "l", l));
      t.appendChild(d);
    };
    cell(compact(T.prompt_tokens), "prompt tokens", fmtInt(T.prompt_tokens));
    cell(fmt1(T.cache_hit_pct) + "%", "of them cached", T.cache_hit_pct == null ? "" : T.cache_hit_pct.toFixed(2) + "%");
    cell(compact(T.generation_tokens), "generated, incl. reasoning", fmtInt(T.generation_tokens));
    cell(fmtInt(T.requests), "requests completed", fmtInt(T.requests));
    cell(fmtInt(T.preemptions), "preemptions", fmtInt(T.preemptions));
    cell(fmtInt(s.vllm_restarts_seen), "vLLM restarts absorbed", fmtInt(s.vllm_restarts_seen));
  }

  /* ---------- footer ---------- */
  function renderFooter(s) {
    const db = s.history_db || {};
    $("footer").textContent = "Read from vLLM /metrics and host hwmon every " +
      (s.poll_interval_s != null ? s.poll_interval_s : 5) + (Number(s.poll_interval_s || 5) === 1 ? " second" : " seconds") + ". Totals survive vLLM restarts and are never pruned; " +
      "chart samples are kept for " + (db.ttl_days != null ? db.ttl_days : "7") + " days" +
      (db.rows != null ? " (" + db.rows.toLocaleString("en-US") + " rows" +
        (db.bytes ? ", " + (db.bytes / 1048576).toFixed(1) + " MB" : "") + ")" : "") + ".";
  }

  /* ---------- render root ---------- */
  function render(s) {
    if (s.ui_version) {
      if (uiVersion && uiVersion !== s.ui_version) { location.reload(); return; }
      uiVersion = s.ui_version;
    }
    lastSnap = s;
    renderHeader(s);
    renderS1(s);
    renderS3(s);
    renderS4(s);
    renderFooter(s);
  }

  /* ---------- controls ---------- */
  const rangeBtns = Array.from(document.querySelectorAll("#range button"));
  function setRange(min) {
    rangeMin = Number(min);
    rangeBtns.forEach(x => {
      const on = Number(x.dataset.min) === rangeMin;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
    connect(); // re-subscribe: the stream now carries this window (first frame lands within one poll)
  }
  rangeBtns.forEach(b => b.addEventListener("click", () => setRange(b.dataset.min)));

  const scopeBtns = Array.from(document.querySelectorAll("#scope button"));
  scopeBtns.forEach(b => b.addEventListener("click", () => {
    scopeMode = b.dataset.scope;
    scopeBtns.forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    if (lastSnap) render(lastSnap);
  }));

  /* ---------- live feed: SSE with polling fallback ---------- */
  function connect() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    let next;
    try { next = new EventSource("/events?minutes=" + rangeMin); } catch (e) { return pollLoop(); }
    es = next;
    next.onmessage = ev => { try { render(JSON.parse(ev.data)); } catch (e) {} };
    next.onerror = () => {
      try { next.close(); } catch (e) {}
      if (es !== next) return; // superseded by a range-switch reconnect
      es = null;
      $("liveText").textContent = "reconnecting";
      setTimeout(connect, 3000);
    };
  }
  function pollLoop() {
    fetch("/api/stats").then(r => r.json()).then(render).catch(() => {});
    setTimeout(pollLoop, 5000);
  }

  /* 1-second tick: the "updated N s ago" / "polled N s ago" readouts */
  setInterval(() => {
    if (lastSnap && lastSnap.updated_at) {
      const st = $("liveStatus");
      if (!st.classList.contains("bad")) $("liveText").textContent = "Live \u00b7 updated " + agoSecs(lastSnap.updated_at);
    }
    if (gw.okAt && gw.enabled !== false) renderGwStatus();
  }, 1000);

  /* ledger: per-day totals from SQLite; refetch every 15 min so new days appear */
  function loadLedger() {
    fetch("/api/ledger").then(r => r.ok ? r.json() : null).then(j => {
      ledgerData = j || null;
      if (lastSnap) renderS4(lastSnap);
    }).catch(() => {});
  }
  loadLedger();
  setInterval(loadLedger, 15 * 60 * 1000);

  connect();
  gwPoll();
})();
