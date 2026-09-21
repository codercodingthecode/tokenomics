(function () {
  "use strict";
  const $ = id => document.getElementById(id);

  // ---------- theme: URL param wins, then the saved choice, else dark (the markup default) ----------
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
    // series colors are CSS custom properties, so the panes repaint themselves
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
    renderCPU(s);
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
    drawAll();
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

  // ---------- charts: one engine (static/charts.js), one instance per pane ----------
  const TC = window.TokCharts;
  const v0 = v => v == null ? "\u2013" : String(Math.round(v));
  const v1 = v => v == null ? "\u2013" : v.toFixed(1);
  const v2 = v => v == null ? "\u2013" : v.toFixed(2);
  const fmtPct = v => v == null ? "\u2013" : v0(v) + "%";
  const fmtDeg = v => v == null ? "\u2013" : v1(v) + "\u00b0C";
  const fmtGhz = v => v == null ? "\u2013" : v2(v) + " GHz";

  function tipHead(row) {
    const when = rangeMin >= 360
      ? new Date(row.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : tFull(row.t * 1000);
    return `<div class="tip-t">${when}</div>`;
  }
  // rows are [label, value, class]; a null value drops the row so tooltips never read "–"
  function tipBody(rows) {
    return rows.filter(r => r && r[1] != null && r[1] !== "")
      .map(r => `<div class="tip-r"><span>${r[0]}</span><b class="${r[2] || ""}">${r[1]}</b></div>`).join("");
  }
  function stats(rows, key) {
    const vs = rows.map(r => r[key]).filter(v => v != null && isFinite(v));
    if (!vs.length) return null;
    const sum = vs.reduce((a, b) => a + b, 0);
    return { n: vs.length, avg: sum / vs.length, lo: Math.min.apply(null, vs), hi: Math.max.apply(null, vs) };
  }
  function lastValue(rows, key) {
    for (let i = rows.length - 1; i >= 0; i--) { const v = rows[i][key]; if (v != null && isFinite(v)) return v; }
    return null;
  }

  // the idle badge belongs to the throughput pane only: 0 tok/s is a state, missing data is not
  let idleEl = null;
  function setIdle(on) {
    if (on) {
      if (!idleEl) {
        idleEl = document.createElement("div");
        idleEl.className = "chart-idle";
        idleEl.innerHTML = "<span>idle \u2014 no generation</span>";
        $("chart").appendChild(idleEl);
      }
    } else if (idleEl) { idleEl.remove(); idleEl = null; }
  }

  const chartThroughput = TC.makeChart({
    svg: $("svg"), wrap: $("chart"), tip: $("tip"),
    label: "Generation throughput in tokens per second",
    series: [
      { get: d => d.gen_tps, color: "line", width: 2, area: .22 },
      { get: d => d.gen_tps_avg, color: "text-3", width: 1.25, dash: "5 5", noDot: true, noPill: true },
    ],
    tipRows: row => tipHead(row) + tipBody([
      ["throughput", v1(row.gen_tps), "v-big"],
      ["window avg", v1(row.gen_tps_avg)],
      ["running", row.running == null ? null : v0(row.running)],
      ["kv cache", row.kv == null ? null : fmtPct(row.kv)],
    ]),
    emptyHtml: "no samples yet",
  });

  // thresholds come from the sensor's own crit point, never hard-coded per chip
  const chartTemp = TC.makeChart({
    svg: $("svgCpuT"), wrap: $("cpuTChart"), tip: $("tipCpuT"),
    label: "CPU package temperature in degrees Celsius",
    unit: "\u00b0C", yTicks: 4, zeroBase: false, padFrac: .26,
    series: [{ get: d => d.cpu_c, color: "t-ok", width: 2, area: .2 }],
    bands: [], refs: [],
    tipRows: row => tipHead(row) + tipBody([
      ["package", fmtDeg(row.cpu_c), "v-temp"],
      ["fastest core", fmtGhz(row.cpu_ghz)],
      ["busy", fmtPct(row.cpu_pct)],
      ["load 1m", row.load1 == null ? null : v1(row.load1)],
      ["gpu edge", fmtDeg(row.gpu_c)],
    ]),
    emptyHtml: "no cpu temperature sensor",
  });

  const chartClock = TC.makeChart({
    svg: $("svgCpuS"), wrap: $("cpuSChart"), tip: $("tipCpuS"),
    label: "CPU clock speed in gigahertz",
    unit: "", yTicks: 4, zeroBase: false, padFrac: .2,
    series: [{ get: d => d.cpu_ghz, color: "power", width: 2, area: .2, fmt: fmtGhz }],
    refs: [],
    tipRows: row => tipHead(row) + tipBody([
      ["fastest core", fmtGhz(row.cpu_ghz), "v-clock"],
      ["busy", fmtPct(row.cpu_pct)],
      ["package", fmtDeg(row.cpu_c)],
    ]),
    emptyHtml: "no cpufreq tables",
  });

  const chartLoad = TC.makeChart({
    svg: $("svgCpuL"), wrap: $("cpuLChart"), tip: $("tipCpuL"),
    label: "CPU utilisation percent",
    unit: "%", yLo: 0, yHi: 100, yTicks: 5,
    series: [{ get: d => d.cpu_pct, color: "series-pod", width: 2, area: .2, fmt: v => v == null ? "\u2013" : v0(v) }],
    refs: [],
    tipRows: row => tipHead(row) + tipBody([
      ["busy", fmtPct(row.cpu_pct), "v-load"],
      ["load 1m", row.load1 == null ? null : v1(row.load1)],
      ["fastest core", fmtGhz(row.cpu_ghz)],
    ]),
    emptyHtml: "no /proc/stat access",
  });

  // one x domain across the four panes: sweeping one sweeps all, so a spike lines up everywhere
  function linkCharts(list) {
    list.forEach(c => {
      const el = c.el();
      if (!el) return;
      el.addEventListener("mousemove", ev => {
        const i = c.hitIndex(ev.clientX);
        if (i < 0) return;
        list.forEach(o => o.showAt(i, o === c, ev));
      });
      el.addEventListener("mouseleave", () => list.forEach(o => o.hide()));
    });
  }

  // the live window rides on the snapshot; anything longer was fetched into rangeData
  function currentRows() {
    if (lastSnap && rangeMin === ((lastSnap.history_minutes) || 60)) return lastSnap.history || [];
    return rangeData || [];
  }

  function foot(id, st, fmt, extra) {
    const el = $(id);
    if (!el) return;
    if (!st) { el.innerHTML = "<span>no samples in this window</span>"; return; }
    el.innerHTML = "min <b>" + fmt(st.lo) + "</b> \u00b7 avg <b>" + fmt(st.avg) + "</b> \u00b7 max <b>" + fmt(st.hi) +
      "</b>" + (extra ? '<span class="sys-foot-x">' + extra + "</span>" : "");
  }

  function drawAll() {
    const rows = currentRows();
    const cpu = (lastSnap && lastSnap.cpu) || {};
    const crit = cpu.crit_c || 95;

    // temp: the line takes the heat colour of the newest sample, thresholds tint the plot
    const tempNow = lastValue(rows, "cpu_c");
    chartTemp.cfg.series[0].color = tempClass(tempNow == null ? cpu.tctl_c : tempNow);
    chartTemp.cfg.bands = [
      { from: 70, to: crit - 10, color: "t-warm-bg" },
      { from: crit - 10, to: crit, color: "t-hot-bg" },
      { from: crit, to: crit + 20, color: "t-crit-bg" },
    ];
    const ts = stats(rows, "cpu_c");
    chartTemp.cfg.refs = ts ? [{ v: ts.avg, color: "text-3", label: "window avg" }] : [];
    chartTemp.draw(rows);
    foot("cpuFootT", ts, fmtDeg, ts ? "crit <b>" + v0(crit) + "\u00b0C</b>" : "");

    const cs = stats(rows, "cpu_ghz");
    chartClock.cfg.refs = cpu.ghz_boost_c
      ? [{ v: cpu.ghz_boost_c, color: "power", label: "boost ceiling" }] : [];
    chartClock.draw(rows);
    foot("cpuFootS", cs, fmtGhz, cpu.boost == null ? ""
      : (cpu.boost ? "boost <b>on</b>" : "boost <b>off</b>"));

    const ls = stats(rows, "cpu_pct");
    chartLoad.cfg.refs = ls ? [{ v: ls.avg, color: "text-3", label: "window avg" }] : [];
    chartLoad.draw(rows);
    foot("cpuFootL", ls, fmtPct, cpu.threads ? "load1 <b>" + v1(cpu.load1) + "</b> / " + cpu.threads + "t" : "");

    let peak = 0;
    for (const r of rows) peak = Math.max(peak, r.gen_tps || 0);
    setIdle(rows.length > 1 && peak === 0);
    chartThroughput.draw(rows);
  }

  function renderCPU(s) {
    const cpu = s.cpu || {};
    const card = $("sysCard");
    if (!card) return;
    const hasAny = cpu.tctl_c != null || cpu.ghz_max != null || cpu.pct != null;
    card.classList.toggle("card-hidden", !hasAny);
    if (!hasAny) return;
    const now = (id, val, fmt, cls) => {
      const el = $(id);
      if (!el) return;
      el.className = "sys-now " + (cls || "");
      el.innerHTML = val == null ? "\u2013" : fmt(val) + "<small>" + (fmt === fmtDeg ? "\u00b0C" : fmt === fmtGhz ? "GHz" : "%") + "</small>";
    };
    now("cpuNowT", cpu.tctl_c, fmtDeg, tempClass(cpu.tctl_c));
    now("cpuNowS", cpu.ghz_max, fmtGhz, "is-clock");
    now("cpuNowL", cpu.pct, fmtPct, cpu.pct > 90 ? "t-hot" : "");
    const bits = [];
    if (cpu.model) bits.push(cpu.model);
    if (cpu.cores) bits.push(cpu.cores + "C/" + (cpu.threads || cpu.cores) + "T");
    if (cpu.load1 != null) bits.push("load " + v1(cpu.load1));
    if (cpu.mem_pct != null) bits.push("mem " + v0(cpu.mem_pct) + "%");
    if (cpu.boost != null) bits.push("boost " + (cpu.boost ? "on" : "off"));
    $("cpuSub").textContent = bits.join(" \u00b7 ") || "host sensors";
    $("cpuHint").innerHTML = "Package temp is <code>k10temp</code>/<code>coretemp</code> Tctl " +
      "(the hottest sensor on the die, not the average), clocks are <code>scaling_cur_freq</code> across all threads "
      "(the fastest core, which is where boost actually lands), utilisation is the delta of <code>/proc/stat</code>. " +
      "All of it is read off the host that runs the server, so a container needs its <code>/sys</code> bind mounts \u2014 " +
      "a gap in a line means the sensor was absent then, not that the host was idle.";
  }
  // ---------- scope toggle ----------
  const scopeBtns = Array.prototype.slice.call(document.querySelectorAll("#scope button"));
  scopeBtns.forEach(b => b.addEventListener("click", () => {
    scopeMode = b.dataset.scope;
    scopeBtns.forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    if (lastSnap) render(lastSnap);
  }));

  // ---------- chart range: the live window rides on the snapshot; longer ranges come from SQLite ----------
  const rangeBtns = Array.prototype.slice.call(document.querySelectorAll(".range button"));
  const rangeNames = { 15: "last 15 minutes", 60: "last hour", 360: "last 6 hours", 1440: "last 24 hours", 10080: "last 7 days" };
  function fetchRange() {
    if (rangeMin === ((lastSnap && lastSnap.history_minutes) || 60)) return;
    fetch("/api/history?minutes=" + rangeMin).then(r => r.json()).then(j => {
      rangeData = j.points || [];
      drawAll();
    }).catch(() => {});
  }
  // both the throughput card and the CPU card carry a range picker: they are one control, twice painted
  function setRange(min) {
    rangeMin = Number(min);
    rangeBtns.forEach(x => {
      const on = Number(x.dataset.min) === rangeMin;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const label = rangeNames[rangeMin] || ("last " + rangeMin + " min");
    $("rangeLabel").textContent = label;
    const l2 = $("sysRangeLabel");
    if (l2) l2.textContent = label;
    rangeData = null;
    if (lastSnap && rangeMin === (lastSnap.history_minutes || 60)) drawAll();
    else fetchRange();
  }
  rangeBtns.forEach(b => b.addEventListener("click", () => setRange(b.dataset.min)));
  setInterval(fetchRange, 30000);
  fetchRange(); // paint the non-default default range right away (the snapshot only carries history_minutes)

  linkCharts([chartThroughput, chartTemp, chartClock, chartLoad]);
  // the viewBox is measured in CSS pixels, so a resize has to redraw the axes rather than stretch them
  let resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawAll, 140);
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(onResize);
    ["chart", "cpuTChart", "cpuSChart", "cpuLChart"].forEach(id => { const el = $(id); if (el) ro.observe(el); });
  } else {
    window.addEventListener("resize", onResize);
  }

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
