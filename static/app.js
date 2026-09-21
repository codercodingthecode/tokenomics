(function () {
  "use strict";
  const $ = id => document.getElementById(id);

  // ---------- theme: URL param wins, then the saved toggle, else dark (the markup default) ----------
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    const m = $("themeMeta");
    if (m) m.setAttribute("content", t === "dark" ? "#07090c" : "#f3f5f8");
  }
  const themeParam = new URLSearchParams(location.search).get("theme");
  if (themeParam === "light" || themeParam === "dark") {
    applyTheme(themeParam);
  } else {
    let saved = null;
    try { saved = localStorage.getItem("tokenomics.theme"); } catch (e) {}
    if (saved === "light" || saved === "dark") applyTheme(saved);
  }
  $("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem("tokenomics.theme", next); } catch (e) {}
  });

  let lastSnap = null;
  let scopeMode = "total";
  let rangeMin = 15;          // chart window in minutes; the live snapshot carries history_minutes of it
  let rangeData = null;       // points fetched from /api/history for a non-live range

  // ---------- formatting ----------
  const fmtInt = n => n == null ? "–" : Math.round(n).toLocaleString("en-US");
  function compact(n) {
    if (n == null) return "–";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }
  const fmt1 = n => n == null ? "–" : n.toFixed(1);
  const fmtUsd = n => n == null ? "–" : n >= 100 ? n.toFixed(0) : n.toFixed(2);
  const fmtDate = s => { if (!s) return "–"; return new Date(s).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
  const tFull = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function ago(isoStr) {
    const s = new Date(isoStr).getTime() / 1000;
    const d = Math.max(0, Math.round(Date.now() / 1000 - s));
    if (d < 60) return d + "s ago";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    return Math.floor(d / 3600) + "h " + Math.floor((d % 3600) / 60) + "m ago";
  }

  // set text on #id with a one-shot highlight when it changes
  function setVal(id, txt) {
    const el = $(id);
    if (!el || el.dataset.v === txt) return;
    el.dataset.v = txt;
    el.textContent = txt;
    const t = el.closest(".flashy");
    if (t) { t.classList.remove("flash"); void t.offsetWidth; t.classList.add("flash"); }
  }

  // total scope = top-level snapshot fields; session scope = this deployment's window
  function scopeData(s) {
    if (scopeMode === "session" && s.session) return s.session;
    return { started_at: s.since, totals: s.totals, pod: s.pod, costs: s.costs };
  }

  // ---------- GPU health ----------
  function tempClass(c) {
    if (c == null) return "t-ok";
    if (c < 70) return "t-ok";
    if (c < 85) return "t-warm";
    if (c < 95) return "t-hot";
    return "t-crit";
  }
  function gpuState(c) {
    if (c == null) return ["ok", "nominal"];
    if (c < 70) return ["ok", "nominal"];
    if (c < 85) return ["warm", "warm"];
    if (c < 95) return ["hot", "hot"];
    return ["crit", "critical"];
  }
  function gpuSpark(idx, hist) {
    const series = [];
    for (const h of (hist || [])) {
      const g = (h.gpus || []).find(x => x.index === idx);
      if (g && g.edge_c != null) series.push({ t: h.t, v: g.edge_c });
    }
    if (series.length < 2) return "";
    const W = 200, H = 40, padT = 4, padB = 4;
    const t0 = series[0].t, t1 = series[series.length - 1].t || t0 + 1;
    const vmin = Math.min(...series.map(d => d.v)), vmax = Math.max(...series.map(d => d.v));
    const span = Math.max(vmax - vmin, 5);
    const lo = vmin - span * 0.15, hi = vmax + span * 0.15;
    const x = t => (t - t0) / Math.max(t1 - t0, 1) * W;
    const y = v => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
    const path = series.map((d, i) => (i ? "L" : "M") + x(d.t).toFixed(1) + " " + y(d.v).toFixed(1)).join(" ");
    const last = series[series.length - 1];
    const col = "var(--" + tempClass(last.v) + ")";
    return `<path d="${path}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
      `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2" fill="${col}"/>`;
  }
  function gpuCard(g, hist) {
    const tc = tempClass(g.edge_c);
    const st = gpuState(g.edge_c);
    const crit = g.edge_crit_c || 110;
    const tw = g.edge_c != null ? Math.min(100, 100 * g.edge_c / crit) : 0;
    const pmax = g.power_cap_max_w || 300;
    const pw = g.power_w != null ? Math.min(100, 100 * g.power_w / pmax) : 0;
    const capw = (g.power_cap_w != null && pmax) ? Math.min(100, 100 * g.power_cap_w / pmax) : null;
    const junction = g.junction_c != null ? Math.round(g.junction_c) + "\u00b0" : "\u2013";
    const mem = g.mem_c != null ? Math.round(g.mem_c) + "\u00b0" : "\u2013";
    const cap = g.power_cap_w != null ? Math.round(g.power_cap_w) + "W" : "\u2013";
    const freq = g.freq_ghz != null ? g.freq_ghz.toFixed(2) + "GHz" : "\u2013";
    const fan = g.fan_rpm != null ? Math.round(g.fan_rpm) + "rpm" : "\u2013";
    return `<div class="gpu st-${st[0]}">
      <div class="gpu-head"><span class="gpu-name">GPU ${g.index}</span><span class="gpu-state ${st[0]}">${st[1]}</span></div>
      <div class="gpu-metrics">
        <div class="gpu-metric">
          <div class="gpu-metric-label">edge temp</div>
          <div class="gpu-metric-val ${tc}">${g.edge_c != null ? g.edge_c.toFixed(1) : "\u2013"}<small>\u00b0C</small></div>
          <div class="gbar"><div class="gbar-fill ${tc}" style="width:${tw.toFixed(1)}%"></div></div>
          <div class="gpu-metric-sub">junction <b>${junction}</b> \u00b7 mem <b>${mem}</b></div>
        </div>
        <div class="gpu-metric">
          <div class="gpu-metric-label">power</div>
          <div class="gpu-metric-val pw">${g.power_w != null ? Math.round(g.power_w) : "\u2013"}<small>W</small></div>
          <div class="gbar"><div class="gbar-fill pw" style="width:${pw.toFixed(1)}%"></div>${capw != null ? `<div class="gbar-cap" style="left:${capw.toFixed(1)}%"></div>` : ""}</div>
          <div class="gpu-metric-sub">cap <b>${cap}</b> \u00b7 <b>${freq}</b> \u00b7 <b>${fan}</b></div>
        </div>
      </div>
      <div class="gpu-spark-wrap"><div class="gpu-spark-label">edge temp \u00b7 last 15 min</div>
        <svg class="gpu-spark" viewBox="0 0 200 40" preserveAspectRatio="none">${gpuSpark(g.index, hist)}</svg></div>
    </div>`;
  }
  function renderGPUs(s) {
    const gpus = s.gpus || [];
    const grid = $("gpuGrid"), sub = $("gpuSub");
    if (!gpus.length) { sub.textContent = "no GPU data (running off-box?)"; grid.innerHTML = ""; return; }
    sub.textContent = s.gpu_label || (gpus.length + "\u00d7 amdgpu \u00b7 edge/junction/mem \u00b7 PPT power");
    grid.innerHTML = gpus.map(g => gpuCard(g, s.gpu_history || [])).join("");
  }

  // ---------- render ----------
  let uiVersion = null;
  function render(s) {
    // a redeploy changes ui_version: reload once so an open tab never runs stale code against a new API
    if (s.ui_version) { if (uiVersion && uiVersion !== s.ui_version) { location.reload(); return; } uiVersion = s.ui_version; }
    lastSnap = s;
    const st = $("status");
    st.className = "status " + (s.ok ? "ok" : "bad");
    $("statusText").textContent = s.ok ? "live" : "source unreachable";
    $("err").hidden = !!s.ok;
    $("err").textContent = s.ok ? "" : "Last error: " + s.error;
    $("updated").textContent = s.updated_at ? ago(s.updated_at) : "\u2013";
    $("since").textContent = fmtDate(s.since);
    if (s.source) { $("srcLabel").textContent = s.source.label || ""; $("model").textContent = s.source.model || ""; }
    renderGPUs(s);
    if (!s.live) return;
    const L = s.live, sc = scopeData(s), T = sc.totals, P = sc.pod;

    setVal("genTps", fmt1(L.gen_tps));
    $("genTpsAvg").textContent = fmt1(L.gen_tps_avg);
    const win = L.avg_window_s || 30, winLabel = win % 60 === 0 ? (win / 60) + " min avg" : win + " s avg";
    $("avgLabel").textContent = winLabel; $("avgLegend").textContent = winLabel;

    // delta chip: now versus the rolling average, in the same units as the hero number
    const dEl = $("genDelta"), cur = L.gen_tps, avg = L.gen_tps_avg;
    if (cur == null || avg == null) { dEl.className = "kpi-delta"; dEl.textContent = ""; }
    else {
      const d = cur - avg;
      dEl.textContent = (d >= 0 ? "+" : "\u2212") + Math.abs(d).toFixed(1);
      dEl.className = "kpi-delta " + (Math.abs(d) < 0.5 ? "" : d > 0 ? "up" : "down");
      dEl.title = Math.abs(d).toFixed(1) + " tok/s " + (d >= 0 ? "above" : "below") + " the " + winLabel;
    }

    setVal("running", fmtInt(L.running));
    $("waiting").textContent = fmtInt(L.waiting);
    $("kv").textContent = fmt1(L.kv_cache_pct);
    const kb = $("kvBar"), kvv = L.kv_cache_pct;
    kb.style.width = (kvv == null ? 0 : Math.max(0, Math.min(100, kvv))).toFixed(1) + "%";
    kb.className = kvv == null ? "" : kvv < 60 ? "" : kvv < 80 ? "warm" : kvv < 92 ? "hot" : "crit";
    setVal("itl", L.itl_ms == null ? "\u2013" : String(Math.round(L.itl_ms)));
    $("e2e").textContent = T.mean_e2e_s == null ? "\u2013" : T.mean_e2e_s.toFixed(1) + "s";
    setVal("accept", L.accept_rate == null ? "\u2013" : fmt1(100 * L.accept_rate));
    $("acceptSub").textContent = "now \u00b7 " + (T.accept_rate_pct == null ? "\u2013" : fmt1(T.accept_rate_pct) + "% in scope");

    // hero: savings versus the reference provider, pod spend on the right
    const apis = sc.costs.filter(c => c.kind === "api").slice().sort((a, b) => (b.usd || 0) - (a.usd || 0));
    const ref = apis.find(c => c.name === s.hero_provider) || apis[0] || null;
    const cheap = apis.length ? apis[apis.length - 1] : null;
    $("heroVs").textContent = ref ? "vs " + ref.name : "";
    $("podName").textContent = P.name || "";
    setVal("heroSaved", ref && P.usd != null ? "$" + fmtUsd(Math.max((ref.usd || 0) - P.usd, 0)) : "\u2013");
    $("heroSub").textContent = ref
      ? ref.name + " would be $" + fmtUsd(ref.usd) + (ref.x_pod != null ? " \u00b7 " + ref.x_pod.toFixed(1) + "\u00d7 your pod" : "")
      : "no providers configured";
    $("heroSub2").textContent = (cheap && cheap !== ref && cheap.x_pod != null)
      ? "even the cheapest route \u2014 " + cheap.name + ", $" + fmtUsd(cheap.usd) + " \u2014 is " + cheap.x_pod.toFixed(1) + "\u00d7 your pod"
      : "";
    setVal("podCost", P.usd == null ? "\u2013" : "$" + fmtUsd(P.usd));
    $("podSub").textContent = P.hours == null ? "\u2013" : P.hours.toFixed(2) + " h \u00d7 $" + P.hourly_usd.toFixed(3) + "/h";

    renderBars(sc);
    renderChips(s, sc);
    $("tokSub").textContent = (scopeMode === "session" && s.session)
      ? "this deployment \u00b7 since " + fmtDate(sc.started_at)
      : "counting since " + fmtDate(s.since);

    if (s.history_db) {
      const db = s.history_db, mb = db.bytes ? (db.bytes / 1048576).toFixed(1) + " MB" : "";
      $("dbInfo").textContent = "chart samples: " + db.rows.toLocaleString("en-US") + " in SQLite" + (mb ? " (" + mb + ")" : "") +
        ", " + db.ttl_days + "-day TTL \u00b7 totals & costs: all-time, never pruned \u00b7 daily ledger: " + (db.ledger_days || 0) + " days";
    }
    if (rangeMin === (s.history_minutes || 60)) drawChart(s.history || []);
    else if (rangeData) drawChart(rangeData);
  }

  function renderBars(sc) {
    const costs = sc.costs.slice();
    const podRow = costs.find(c => c.kind === "pod") || null;
    const apis = costs.filter(c => c.kind === "api").sort((a, b) => (b.usd || 0) - (a.usd || 0));
    const max = Math.max(1e-9, ...costs.map(c => c.usd || 0));
    const row = (cls, name, track, total, x, save) =>
      `<div class="bar ${cls}"><div class="bar-name" title="${name}">${name}</div>` +
      `<div class="bar-track">${track}</div>` +
      `<div class="bar-total">${total}</div><div class="bar-x">${x}</div><div class="bar-save">${save}</div></div>`;
    let html = apis.map(c => {
      const track =
        `<div class="seg s1" style="width:${(100 * (c.input_usd || 0) / max).toFixed(2)}%"></div>` +
        `<div class="seg s2" style="width:${(100 * (c.cached_usd || 0) / max).toFixed(2)}%"></div>` +
        `<div class="seg s3" style="width:${(100 * (c.output_usd || 0) / max).toFixed(2)}%"></div>`;
      const save = (c.x_pod != null && podRow) ? "\u2212$" + fmtUsd(Math.max(c.usd - podRow.usd, 0)) : "\u2013";
      return row("api", c.name, track, "$" + fmtUsd(c.usd), c.x_pod == null ? "\u2013" : c.x_pod.toFixed(1) + "\u00d7", save);
    }).join("");
    if (podRow) {
      html += row("pod", podRow.name,
        `<div class="seg podseg" style="width:${(100 * (podRow.usd || 0) / max).toFixed(2)}%"></div>`,
        "$" + fmtUsd(podRow.usd), "1.0\u00d7",
        podRow.hours == null ? "\u2013" : podRow.hours.toFixed(2) + " h");
    }
    $("bars").innerHTML = html;
  }

  function renderChips(s, sc) {
    const T = sc.totals;
    const items = [
      { l: "prompt tokens", v: compact(T.prompt_tokens), full: fmtInt(T.prompt_tokens), sub: "cached " + compact(T.cached_tokens) + " \u00b7 " + fmt1(T.cache_hit_pct) + "%" },
      { l: "generated", v: compact(T.generation_tokens), full: fmtInt(T.generation_tokens), sub: "incl. reasoning" },
      { l: "requests", v: fmtInt(T.requests), full: fmtInt(T.requests), sub: "completed" },
      { l: "mean latency", v: T.mean_e2e_s == null ? "\u2013" : T.mean_e2e_s.toFixed(1) + "s", full: "", sub: "end-to-end" },
      { l: "preemptions", v: fmtInt(T.preemptions), full: fmtInt(T.preemptions), sub: "" },
      { l: "vllm restarts", v: fmtInt(s.vllm_restarts_seen), full: "", sub: "absorbed \u00b7 lifetime" },
    ];
    $("chips").innerHTML = items.map(it =>
      `<div class="chip"${it.full ? ` title="${it.full}"` : ""}><div class="chip-label">${it.l}</div><div class="chip-value">${it.v}</div><div class="chip-sub">${it.sub}</div></div>`).join("");
  }

  // ---------- chart: gradient area, per-poll line + trailing average, crosshair tooltip ----------
  const svg = $("svg"), tip = $("tip"), chartEl = $("chart");
  let pts = [], idleEl = null;
  function setIdle(on) {
    if (on) {
      if (!idleEl) {
        idleEl = document.createElement("div");
        idleEl.className = "chart-idle";
        idleEl.innerHTML = "<span>idle \u2014 no generation</span>";
        chartEl.appendChild(idleEl);
      }
    } else if (idleEl) { idleEl.remove(); idleEl = null; }
  }
  function drawChart(hist) {
    const W = 1000, H = 240, padL = 46, padR = 60, padT = 16, padB = 28;
    const data = hist.filter(h => h && typeof h.gen_tps === "number");
    if (data.length < 2) { svg.innerHTML = ""; setIdle(false); pts = []; return; }
    const t0 = data[0].t, t1 = data[data.length - 1].t || t0 + 1;
    const vmax = Math.max(10, ...data.map(d => Math.max(d.gen_tps || 0, d.gen_tps_avg || 0)));
    const ymax = Math.ceil(vmax / 10) * 10;
    const x = t => padL + (W - padL - padR) * (t - t0) / Math.max(t1 - t0, 1);
    const y = v => padT + (H - padT - padB) * (1 - v / ymax);
    pts = data.map(d => ({ cx: x(d.t), cy: y(d.gen_tps || 0), cyAvg: y(d.gen_tps_avg || 0), d }));
    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const v = ymax * f;
      return `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--grid)" stroke-width="1"${f === 0 ? "" : ' stroke-dasharray="2 6"'} vector-effect="non-scaling-stroke"/>` +
        `<text x="${padL - 9}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="var(--text-3)">${Math.round(v)}</text>`;
    }).join("");
    const path = pts.map((p, i) => (i ? "L" : "M") + p.cx.toFixed(1) + " " + p.cy.toFixed(1)).join(" ");
    const pathAvg = pts.map((p, i) => (i ? "L" : "M") + p.cx.toFixed(1) + " " + p.cyAvg.toFixed(1)).join(" ");
    const area = path + ` L${pts[pts.length - 1].cx.toFixed(1)} ${y(0).toFixed(1)} L${pts[0].cx.toFixed(1)} ${y(0).toFixed(1)} Z`;
    const span = Math.max(t1 - t0, 1);
    const tfmt = t => {
      const dt = new Date(t * 1000); // history t is epoch seconds
      if (span >= 2 * 86400) return dt.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
      if (span >= 6 * 3600) return dt.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return span >= 900
        ? dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    };
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const t = t0 + span * f;
      const anchor = f === 0 ? "start" : f === 1 ? "end" : "middle";
      return `<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" font-size="10.5" fill="var(--text-3)">${tfmt(t)}</text>`;
    }).join("");
    const last = pts[pts.length - 1];
    const idle = Math.max(0, ...data.map(d => d.gen_tps || 0)) === 0;
    setIdle(idle);
    // var() is unreliable in SVG presentation attributes, so gradient stops carry it via style=""
    const defs = `<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" style="stop-color:var(--line);stop-opacity:.20"/>` +
      `<stop offset=".65" style="stop-color:var(--line);stop-opacity:.05"/>` +
      `<stop offset="1" style="stop-color:var(--line);stop-opacity:0"/>` +
      `</linearGradient></defs>`;
    const nowLabel = `<text x="${W - padR + 10}" y="${(last.cy + 4).toFixed(1)}" font-size="12" font-weight="650" fill="var(--text)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${(last.d.gen_tps || 0).toFixed(1)}</text>`;
    svg.innerHTML = defs + grid +
      `<path d="${area}" fill="url(#areaGrad)"/>` +
      `<path d="${pathAvg}" fill="none" stroke="var(--text-3)" stroke-width="1.25" stroke-dasharray="4 5" opacity=".85" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
      `<path d="${path}" fill="none" stroke="var(--line)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<line id="xh" x1="0" x2="0" y1="${padT}" y2="${H - padB}" stroke="var(--border-3)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" style="display:none"/>` +
      `<circle cx="${last.cx.toFixed(1)}" cy="${last.cy.toFixed(1)}" r="6" fill="var(--line)" opacity=".16"/>` +
      `<circle cx="${last.cx.toFixed(1)}" cy="${last.cy.toFixed(1)}" r="3" fill="var(--line)"/>` +
      `<circle id="dot" r="4.5" fill="var(--line)" stroke="var(--surface)" stroke-width="2" style="display:none"/>` +
      nowLabel + ticks;
  }
  chartEl.addEventListener("mousemove", e => {
    if (!pts.length) return;
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * 1000;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.cx - mx) < Math.abs(best.cx - mx)) best = p;
    const xh = $("xh"), dot = $("dot");
    if (!xh || !dot) return;
    xh.setAttribute("x1", best.cx); xh.setAttribute("x2", best.cx); xh.style.display = "";
    dot.setAttribute("cx", best.cx); dot.setAttribute("cy", best.cy); dot.style.display = "";
    const d = best.d;
    const tipTime = rangeMin >= 360
      ? new Date(d.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : tFull(d.t * 1000);
    tip.innerHTML = `<div class="tip-t">${tipTime}</div>` +
      `<div class="tip-r"><span>throughput</span><b class="v-big">${(d.gen_tps || 0).toFixed(1)}</b></div>` +
      `<div class="tip-r"><span>avg</span><b>${(d.gen_tps_avg || 0).toFixed(1)}</b></div>` +
      `<div class="tip-r"><span>running</span><b>${d.running || 0}</b></div>` +
      `<div class="tip-r"><span>kv cache</span><b>${d.kv == null ? "\u2013" : d.kv.toFixed(0) + "%"}</b></div>`;
    tip.style.display = "block";
    const px = best.cx / 1000 * r.width;
    tip.style.left = Math.min(px + 14, Math.max(r.width - tip.offsetWidth - 2, 0)) + "px";
    tip.style.top = "6px";
  });
  chartEl.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    const xh = $("xh"), dot = $("dot");
    if (xh) xh.style.display = "none";
    if (dot) dot.style.display = "none";
  });

  // ---------- scope toggle ----------
  const scopeBtns = Array.prototype.slice.call(document.querySelectorAll("#scope button"));
  scopeBtns.forEach(b => b.addEventListener("click", () => {
    scopeMode = b.dataset.scope;
    scopeBtns.forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    if (lastSnap) render(lastSnap);
  }));

  // ---------- chart range: the live window comes with the snapshot; longer ranges are fetched from SQLite ----------
  const rangeBtns = Array.prototype.slice.call(document.querySelectorAll("#range button"));
  const rangeNames = { 15: "last 15 minutes", 60: "last hour", 360: "last 6 hours", 1440: "last 24 hours", 10080: "last 7 days" };
  function fetchRange() {
    if (rangeMin === ((lastSnap && lastSnap.history_minutes) || 60)) return;
    fetch("/api/history?minutes=" + rangeMin).then(r => r.json()).then(j => {
      rangeData = j.points || [];
      drawChart(rangeData);
    }).catch(() => {});
  }
  rangeBtns.forEach(b => b.addEventListener("click", () => {
    rangeMin = Number(b.dataset.min);
    rangeBtns.forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    $("rangeLabel").textContent = rangeNames[rangeMin] || ("last " + rangeMin + " min");
    rangeData = null;
    if (lastSnap && rangeMin === (lastSnap.history_minutes || 60)) drawChart(lastSnap.history || []);
    else fetchRange();
  }));
  setInterval(fetchRange, 30000);
  fetchRange(); // paint the non-default default range right away (snapshot only carries history_minutes)

  // ---------- live feed: SSE with polling fallback ----------
  setInterval(() => { if (lastSnap && lastSnap.updated_at) $("updated").textContent = ago(lastSnap.updated_at); }, 1000);
  function connect() {
    let es;
    try { es = new EventSource("/events"); } catch (e) { return poll(); }
    es.onmessage = ev => { try { render(JSON.parse(ev.data)); } catch (e) {} };
    es.onerror = () => {
      es.close();
      $("status").className = "status";
      $("statusText").textContent = "reconnecting";
      setTimeout(connect, 3000);
    };
  }
  function poll() { fetch("/api/stats").then(r => r.json()).then(render).catch(() => {}); setTimeout(poll, 5000); }

  // ---------- vLLM start/stop control ----------
  (function vllmControl() {
    const pill = $("vllmPill"), pillText = $("vllmPillText"), state = $("vllmState"), msg = $("vllmMsg");
    const bStart = $("vllmStart"), bStop = $("vllmStop"), bRestart = $("vllmRestart");
    if (!pill) return;
    let busy = false;
    function setBtns(cStart, cStop, cRestart) {
      bStart.disabled = busy || !cStart;
      bStop.disabled = busy || !cStop;
      bRestart.disabled = busy || !cRestart;
    }
    function paint(s) {
      pill.className = "vllm-pill";
      if (!s || s.available === false) {
        pill.classList.add("v-unknown"); pillText.textContent = "unreachable";
        state.textContent = (s && s.error) || "docker socket unreachable"; setBtns(false, false, false); return;
      }
      if (!s.exists) {
        pill.classList.add("v-off"); pillText.textContent = "not created";
        state.textContent = "container " + (s.container || "") + " does not exist"; setBtns(false, false, false); return;
      }
      if (s.running) {
        const healthy = !s.health || s.health === "healthy";
        pill.classList.add(healthy ? "v-on" : "v-warm");
        pillText.textContent = s.health ? ("running \u00b7 " + s.health) : "running";
        state.textContent = "up" + (s.started_at ? " since " + fmtDate(s.started_at) : "");
        setBtns(false, true, true);
      } else {
        pill.classList.add("v-off"); pillText.textContent = "stopped";
        state.textContent = "container exists, stopped"; setBtns(true, false, true);
      }
    }
    function refresh() { fetch("/api/vllm").then(r => r.json()).then(paint).catch(() => paint(null)); }
    function act(a) {
      if (busy) return;
      const warn = a === "start"
        ? "Start vLLM? First start after a cold cache can take up to ~15 min."
        : "vLLM " + a + "? In-flight requests drop until it is back (a cold start can take ~15 min).";
      if (!confirm(warn)) return;
      busy = true; msg.textContent = a + "ing\u2026"; setBtns(false, false, false);
      fetch("/api/vllm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: a }) })
        .then(r => r.json())
        .then(j => { busy = false; msg.textContent = j.ok ? (a + " sent") : ("error: " + (j.error || "?")); paint(j.vllm || null); setTimeout(refresh, 1500); })
        .catch(() => { busy = false; msg.textContent = "request failed"; refresh(); });
    }
    bStart.addEventListener("click", () => act("start"));
    bStop.addEventListener("click", () => act("stop"));
    bRestart.addEventListener("click", () => act("restart"));
    refresh(); setInterval(refresh, 5000);
  })();
  connect();
})();
