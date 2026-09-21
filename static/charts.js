/* tokenomics - chart engine (no dependencies, no build step).

   One renderer for every time-series pane. Design rules it enforces:
   - "nice" y axes (ticks land on 1/2/2.5/5/10 steps) so labels stay readable at any scale;
   - Fritsch-Carlson monotone cubic interpolation: curves are smooth but never overshoot a
     sample, so a peak on screen is always a peak in the data;
   - gaps are gaps: a null sample breaks the line instead of drawing a straight lie across
     the hole (sensors appear/disappear when you change bind mounts or move hosts);
   - everything is viewBox-scaled SVG with non-scaling strokes, so panes stay crisp from a
     phone to a 4K dashboard and can share one x domain for a synchronised crosshair. */
(function (global) {
  "use strict";

  var MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
  var uid = 0;

  /* "line" and "--line" both mean the --line custom property. Emitting var(line) is invalid CSS,
     which silently falls back to black: an invisible line on a dark canvas, a black blob on a light one. */
  function v(col) { return "var(--" + String(col).replace(/^--/, "") + ")"; }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* round a raw step up to the nearest "nice" number, then snap the domain to it */
  function niceScale(lo, hi, wantTicks) {
    var want = wantTicks || 5;
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { var pad = Math.max(Math.abs(hi) * 0.1, 1); lo -= pad; hi += pad; }
    var raw = (hi - lo) / (want - 1);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var n = raw / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step: step };
  }

  function tickFmt(step) {
    var d = step >= 10 ? 0 : step % 1 === 0 ? 0 : step >= 0.1 ? 1 : 2;
    return function (v) { return v.toFixed(d); };
  }

  /* index ranges of contiguous non-null values: [[a,b], ...] inclusive */
  function runsOf(vals) {
    var runs = [], start = null;
    for (var i = 0; i < vals.length; i++) {
      var ok = vals[i] != null && isFinite(vals[i]);
      if (ok && start === null) start = i;
      if (!ok && start !== null) { runs.push([start, i - 1]); start = null; }
    }
    if (start !== null) runs.push([start, vals.length - 1]);
    return runs;
  }

  /* monotone cubic (Fritsch-Carlson): C1 continuous, no false extrema */
  function smoothRun(P) {
    var n = P.length, i;
    if (n === 0) return "";
    if (n === 1) return "M" + P[0].x.toFixed(1) + " " + P[0].y.toFixed(1) + "h.01";
    if (n === 2) return "M" + P[0].x.toFixed(1) + " " + P[0].y.toFixed(1) +
      "L" + P[1].x.toFixed(1) + " " + P[1].y.toFixed(1);
    var dx = [], m = [];
    for (i = 0; i < n - 1; i++) {
      dx[i] = P[i + 1].x - P[i].x || 1e-6;
      m[i] = (P[i + 1].y - P[i].y) / dx[i];
    }
    var t = [m[0]];
    for (i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) t[i] = 0;
      else {
        var w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
        t[i] = 3 * (dx[i - 1] + dx[i]) / (w1 / m[i - 1] + w2 / m[i]);
      }
    }
    t[n - 1] = m[n - 2];
    var d = "M" + P[0].x.toFixed(1) + " " + P[0].y.toFixed(1);
    for (i = 0; i < n - 1; i++) {
      var h = dx[i] / 3;
      d += "C" + (P[i].x + h).toFixed(1) + " " + (P[i].y + t[i] * h).toFixed(1) + " " +
        (P[i + 1].x - h).toFixed(1) + " " + (P[i + 1].y - t[i + 1] * h).toFixed(1) + " " +
        P[i + 1].x.toFixed(1) + " " + P[i + 1].y.toFixed(1);
    }
    return d;
  }

  function lineRun(P) {
    var d = "";
    for (var i = 0; i < P.length; i++) d += (i ? "L" : "M") + P[i].x.toFixed(1) + " " + P[i].y.toFixed(1);
    return d;
  }

  /* default x-axis labelling: pick the least noisy format for the visible span */
  function timeFmt(t, span) {
    var d = new Date(t * 1000);
    if (span >= 2 * 86400) return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
    if (span >= 6 * 3600) return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    if (span >= 900) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  /* ---------- the renderer ----------
     cfg = {
       svg, wrap, tip,                    elements (tip optional)
       label,                             aria-label
       height (default 240), padL, padR, xTicks,
       zeroBase (default true), padFrac (default .14), yLo/yHi overrides, xLo/xHi overrides,
       unit,                              appended to the right-edge value pill
       series: [{ get(row), color (css var name), width, dash, area (0..1), name,
                  fmt(v), noPill, noTip }],
       bands: [{ from, to, color }],     horizontal tinted zones (e.g. temp thresholds)
       refs:  [{ v, color, label }],     dashed reference lines (avg window, boost ceiling...)
       emptyHtml,                         what to paint when there is nothing to plot
       onHover(i, api)                    lets sibling charts mirror the crosshair
     } */
  function makeChart(cfg) {
    var svg = cfg.svg, wrap = cfg.wrap, tip = cfg.tip;
    var id = "c" + (++uid);
    var W = 1000, H = cfg.height || 240;
    /* gutters + tick density are recomputed per draw: a 1000px chart and a 300px chart need
       different margins, and a 4th x label on a narrow pane only collides */
    var padL = 44, padR = 58, xTicks = 4;
    var padT = cfg.padT == null ? 14 : cfg.padT;
    var padB = cfg.padB == null ? 24 : cfg.padB;
    var series = cfg.series || [];
    var rows = [], X = null, Y = null, dom = null, scale = null;
    var zb = cfg.zeroBase !== false; /* documented default: the baseline is 0 unless a pane opts out */
    if (svg && cfg.label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", cfg.label); }

    function fmtOf(s) { return s.fmt || function (v) { return v == null ? "\u2013" : v.toFixed(1); }; }

    function setEmpty(on) {
      if (!wrap) return;
      var el = wrap.querySelector(".chart-empty");
      if (on) {
        if (!el) {
          el = document.createElement("div");
          el.className = "chart-empty";
          el.innerHTML = "<span>" + (cfg.emptyHtml || "no samples yet") + "</span>";
          wrap.appendChild(el);
        }
      } else if (el) el.remove();
      if (svg) svg.style.visibility = on ? "hidden" : "";
    }

    function draw(nextRows) {
      if (!svg) return;
      rows = (nextRows || []).filter(function (r) { return r && r.t != null; });
      if (rows.length < 2) { svg.innerHTML = ""; X = null; setEmpty(rows.length === 0); if (tip) tip.style.display = "none"; return; }

      /* 1 SVG unit = 1 CSS pixel. Letting a fixed viewBox stretch to fit (the usual
         preserveAspectRatio="none" shortcut) squashes axis text horizontally; sizing the
         viewBox from the element keeps labels and strokes honest at any width. */
      W = Math.max(240, Math.round((wrap && wrap.clientWidth) || 1000));
      if (cfg.height == null && wrap && wrap.clientHeight) H = Math.round(wrap.clientHeight);
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      padL = cfg.padL != null ? cfg.padL : (W < 460 ? 32 : 44);
      padR = cfg.padR != null ? cfg.padR : (W < 460 ? 46 : 58);
      xTicks = cfg.xTicks != null ? cfg.xTicks : (W < 460 ? 2 : W < 760 ? 3 : 4);

      var xLo = cfg.xLo != null ? cfg.xLo : rows[0].t;
      var xHi = cfg.xHi != null ? cfg.xHi : rows[rows.length - 1].t;
      if (!(xHi > xLo)) xHi = xLo + 1;
      dom = { lo: xLo, hi: xHi, span: xHi - xLo };

      var vals = [];
      series.forEach(function (s) {
        s._v = rows.map(function (r) { var v = s.get(r); return v == null || !isFinite(v) ? null : v; });
        s._runs = runsOf(s._v);
        s._runs.forEach(function (rn) {
          for (var i = rn[0]; i <= rn[1]; i++) vals.push(s._v[i]);
        });
      });
      var hasData = series.some(function (s) { return s._runs.length; });
      if (!hasData) { svg.innerHTML = ""; X = null; setEmpty(true); if (tip) tip.style.display = "none"; return; }
      setEmpty(false);
      (cfg.refs || []).forEach(function (r) { if (r.v != null && !cfg.ignoreRefs) vals.push(r.v); });
      if (!vals.length) { svg.innerHTML = cfg.emptyHtml || ""; X = null; return; }
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (zb) lo = Math.min(lo, 0);
      if (cfg.yLo != null) lo = cfg.yLo;
      if (cfg.yHi != null) hi = cfg.yHi;
      if (cfg.yLo == null && !zb) { var pad = (hi - lo) * (cfg.padFrac == null ? 0.14 : cfg.padFrac); lo -= pad; hi += pad; }
      else if (cfg.yHi == null) { hi += (hi - lo) * (cfg.padFrac == null ? 0.14 : cfg.padFrac); }
      scale = niceScale(lo, hi, cfg.yTicks || 5);
      var fmtT = tickFmt(scale.step);

      X = function (t) { return padL + (W - padL - padR) * (t - dom.lo) / dom.span; };
      Y = function (v) { return padT + (H - padT - padB) * (1 - (v - scale.lo) / (scale.hi - scale.lo)); };

      var g = "", k;

      /* gradient defs (var() is unreliable in SVG presentation attributes, hence style="") */
      var stops = "";
      series.forEach(function (s, i) {
        if (!s.area) return;
        stops += '<linearGradient id="' + id + 'g' + i + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" style="stop-color:' + v(s.color) + ';stop-opacity:' + s.area + '"/>' +
          '<stop offset=".72" style="stop-color:' + v(s.color) + ';stop-opacity:' + (s.area * 0.16) + '"/>' +
          '<stop offset="1" style="stop-color:' + v(s.color) + ';stop-opacity:0"/></linearGradient>';
      });
      if (stops) g += "<defs>" + stops + "</defs>";

      /* tinted zones (clipped to the plot box) */
      (cfg.bands || []).forEach(function (b) {
        var y1 = Y(Math.min(b.to, scale.hi)), y2 = Y(Math.max(b.from, scale.lo));
        if (!(y2 > y1)) return;
        g += '<rect x="' + padL + '" x2="0" y="' + y1.toFixed(1) + '" width="' + (W - padL - padR) +
          '" height="' + (y2 - y1).toFixed(1) + '" fill="' + v(b.color) + '"/>';
      });

      /* horizontal grid + y labels */
      for (k = scale.lo; k <= scale.hi + scale.step * 1e-6; k += scale.step) {
        var yy = Y(k), last = Math.abs(k - scale.hi) < scale.step * 1e-6;
        g += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) +
          '" stroke="var(--grid)" stroke-width="1"' + (last ? "" : ' stroke-dasharray="2 6"') +
          ' vector-effect="non-scaling-stroke"/>';
        g += '<text x="' + (padL - 9) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" ' +
          'font-family="' + MONO + '" fill="var(--text-3)">' + fmtT(k) + "</text>";
      }

      /* dashed reference lines with an inline label */
      (cfg.refs || []).forEach(function (r) {
        if (r.v == null || r.v < scale.lo || r.v > scale.hi) return;
        var yr = Y(r.v);
        g += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yr.toFixed(1) + '" y2="' + yr.toFixed(1) +
          '" stroke="' + v((r.color || "text-3")) + '" stroke-width="1.2" stroke-dasharray="5 5" opacity=".7"' +
          ' vector-effect="non-scaling-stroke"/>';
        if (r.label) g += '<text x="' + (padL + 7) + '" y="' + (yr - 5).toFixed(1) + '" font-size="9.5" letter-spacing=".06em" ' +
          'font-family="' + MONO + '" fill="' + v((r.color || "text-3")) + '" opacity=".95">' + esc(r.label) + "</text>";
      });

      /* series: area under the curve, then the curve */
      series.forEach(function (s, si) {
        s._P = [];
        for (var i = 0; i < rows.length; i++) s._P.push({ x: X(rows[i].t), y: Y(s._v[i] == null ? 0 : s._v[i]) });
        var runs = s._runs;
        for (var r2 = 0; r2 < runs.length; r2++) {
          var seg = s._P.slice(runs[r2][0], runs[r2][1] + 1);
          if (!seg.length) continue;
          var line = cfg.straight ? lineRun(seg) : smoothRun(seg);
          if (s.area) {
            var base = Y(zb ? Math.max(0, scale.lo) : scale.lo);
            g += '<path d="' + line + "L" + seg[seg.length - 1].x.toFixed(1) + " " + base.toFixed(1) +
              "L" + seg[0].x.toFixed(1) + " " + base.toFixed(1) + 'Z" fill="url(#' + id + "g" + si + ')"/>';
          }
          g += '<path d="' + line + '" fill="none" stroke="' + v(s.color) + '" stroke-width="' + (s.width || 2) +
            '" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"' +
            (s.dash ? ' stroke-dasharray="' + s.dash + '"' : "") + (s.opacity ? ' opacity="' + s.opacity + '"' : "") + "/>";
        }
      });

      /* x labels */
      var xt = xTicks;
      for (k = 0; k <= xt; k++) {
        var f = k / xt, tt = dom.lo + dom.span * f;
        var anchor = k === 0 ? "start" : k === xt ? "end" : "middle";
        if (k > 0 && k < xt) g += '<line x1="' + X(tt).toFixed(1) + '" x2="' + X(tt).toFixed(1) + '" y1="' + (H - padB) +
          '" y2="' + (H - padB + 4) + '" stroke="var(--border-2)" stroke-width="1" vector-effect="non-scaling-stroke"/>';
        g += '<text x="' + X(tt).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor + '" font-size="10.5" ' +
          'font-family="' + MONO + '" fill="var(--text-3)">' + esc((cfg.xFmt || timeFmt)(tt, dom.span)) + "</text>";
      }

      /* right-edge pill with the newest value of each series */
      var pills = [];
      series.forEach(function (s) {
        if (s.noPill || !s._runs.length) return;
        var lastRun = s._runs[s._runs.length - 1];
        var li = lastRun[1];
        pills.push({ y: Y(s._v[li]), txt: fmtOf(s)(s._v[li]) + (cfg.unit || ""), color: s.color, cy: Y(s._v[li]) });
        s._last = { i: li, v: s._v[li] };
      });
      pills.sort(function (a, b) { return a.y - b.y; });
      for (k = 1; k < pills.length; k++) if (pills[k].y - pills[k - 1].y < 13) pills[k].y = pills[k - 1].y + 13;
      pills.forEach(function (p) {
        g += '<g><rect x="' + (W - padR + 8) + '" y="' + (p.y - 9).toFixed(1) + '" width="' + (padR - 10) +
          '" height="18" rx="5" fill="var(--surface-3)"/>' +
          '<text x="' + (W - padR + 13) + '" y="' + (p.y + 3.8).toFixed(1) + '" font-size="11" font-weight="650" ' +
          'font-family="' + MONO + '" fill="' + v(p.color) + '">' + esc(p.txt) + "</text></g>";
      });

      /* crosshair + hover dots (one dot per series, moved together) */
      g += '<line id="' + id + 'xh" x1="0" x2="0" y1="' + padT + '" y2="' + (H - padB) +
        '" stroke="var(--cross, var(--border-3))" stroke-width="1" stroke-dasharray="3 4" ' +
        'vector-effect="non-scaling-stroke" style="display:none"/>';
      series.forEach(function (s, i) {
        if (s.noDot) return;
        g += '<circle id="' + id + "d" + i + '" r="4.5" fill="' + v(s.color) + '" stroke="var(--surface)" ' +
          "stroke-width=\"2\" style=\"display:none\"/>";
      });
      svg.innerHTML = g;
    }

    function hitIndex(clientX) {
      if (!X || !svg) return -1;
      var r = svg.getBoundingClientRect();
      if (!r.width) return -1;
      var vx = (clientX - r.left) / r.width * W;
      var t = dom.lo + (vx - padL) / (W - padL - padR) * dom.span;
      var best = 0, bestD = Infinity;
      for (var i = 0; i < rows.length; i++) {
        var d = Math.abs(rows[i].t - t);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function showAt(i, withTip, evt) {
      if (i < 0 || !X || i >= rows.length) return api.hide();
      var x = X(rows[i].t).toFixed(1), parts;
      var xh = svg.querySelector("#" + id + "xh");
      if (xh) { xh.setAttribute("x1", x); xh.setAttribute("x2", x); xh.style.display = ""; }
      series.forEach(function (s, si) {
        if (s.noDot) return;
        var dot = svg.querySelector("#" + id + "d" + si);
        if (!dot) return;
        if (s._v[i] == null) { dot.style.display = "none"; return; }
        dot.setAttribute("cx", x); dot.setAttribute("cy", Y(s._v[i]).toFixed(1)); dot.style.display = "";
      });
      if (withTip && tip) {
        var html = cfg.tipRows ? cfg.tipRows(rows[i], i) : "";
        if (html) {
          tip.innerHTML = html;
          tip.style.display = "block";
          var r = wrap.getBoundingClientRect();
          var px = (evt ? evt.clientX - r.left : Math.min(Math.max(X(rows[i].t) / W * r.width, 0), r.width));
          var flip = px + tip.offsetWidth + 22 > r.width;
          tip.style.left = Math.max(0, flip ? px - tip.offsetWidth - 14 : px + 14) + "px";
          tip.style.top = "6px";
        }
      }
      if (cfg.onHover) cfg.onHover(i, api);
    }

    function hide() {
      if (svg) {
        var xh = svg.querySelector("#" + id + "xh");
        if (xh) xh.style.display = "none";
        series.forEach(function (s, si) {
          if (s.noDot) return;
          var dot = svg.querySelector("#" + id + "d" + si);
          if (dot) dot.style.display = "none";
        });
      }
      if (tip) tip.style.display = "none";
      if (cfg.onLeave) cfg.onLeave();
    }

    var api = { draw: draw, hitIndex: hitIndex, showAt: showAt, hide: hide,
      el: function () { return wrap; }, redraw: function () { return draw(rows); }, cfg: cfg,
      rowsOf: function () { return rows; }, valueAt: function (si, i) { return series[si]._v[i]; },
      scaleOf: function () { return scale; } };
    return api;
  }

  global.TokCharts = { makeChart: makeChart, niceScale: niceScale, timeFmt: timeFmt, esc: esc };
})(window);
