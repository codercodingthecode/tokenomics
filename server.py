#!/usr/bin/env python3
"""tokenomics \u2014 live token / throughput / cost dashboard for a vLLM endpoint.

Stdlib only (Python 3.9+). Polls vLLM's Prometheus /metrics, accumulates counters
across vLLM restarts, prices the traffic against API providers, and pushes updates
to the browser over Server-Sent Events. Also proxies the LLM gateway's live-request
observer (/api/gw_live -> the gateway's /__gw_live) so the browser stays same-origin.

    python3 server.py [--config config.json] [--port 8787] [--host 0.0.0.0]

The snapshot exposes two scopes:
  total   \u2014 everything counted since counting began (baseline + current, restart-safe)
  session \u2014 this deployment's window: counters since the server's first poll
            (persisted in state.json, survives server restarts)
"""
import argparse
import glob
import json
import os
import queue
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import socket as _socket

HERE = os.path.dirname(os.path.abspath(__file__))

COUNTERS = [
    "prompt_tokens_total",
    "prompt_tokens_cached_total",
    "generation_tokens_total",
    "request_success_total",
    "spec_decode_num_draft_tokens_total",
    "spec_decode_num_accepted_tokens_total",
    "num_preemptions_total",
    "prefix_cache_hits_total",
    "prefix_cache_queries_total",
    "external_prefix_cache_hits_total",
    "external_prefix_cache_queries_total",
    "kv_offload_store_bytes_total",
    "kv_offload_store_time_total",
    "kv_offload_store_size_count",
    "kv_offload_load_bytes_total",
    "kv_offload_load_time_total",
    "kv_offload_load_size_count",
    "inter_token_latency_seconds_sum",
    "inter_token_latency_seconds_count",
    "e2e_request_latency_seconds_sum",
    "e2e_request_latency_seconds_count",
    "gen_seconds_total",  # llama.cpp only: total wall-time spent generating tokens
]
GAUGES = [
    "num_requests_running", "num_requests_waiting", "kv_cache_usage_perc",
    "kv_offload_cpu_cache_usage_perc", "kv_offload_cpu_cache_read_usage_perc",
    "kv_offload_cpu_cache_write_usage_perc",
]

METRIC_RE = re.compile(r"^(?:vllm:|llamacpp:)(\w+)(?:\{([^}]*)\})?\s+([-+0-9.eE]+|NaN)\s*$")

# llama.cpp /metrics (llamacpp:*) maps onto the same canonical names vLLM uses
LLAMA_COUNTER_ALIASES = {
    "prompt_tokens_total": "prompt_tokens_total",
    "prompt_tokens_cached_total": "prompt_tokens_cached_total",
    "tokens_predicted_total": "generation_tokens_total",
    "spec_decode_num_draft_tokens_total": "spec_decode_num_draft_tokens_total",
    "spec_decode_num_accepted_tokens_total": "spec_decode_num_accepted_tokens_total",
    "tokens_predicted_seconds_total": "gen_seconds_total",
}
LLAMA_GAUGE_ALIASES = {
    "requests_processing": "num_requests_running",
    "requests_deferred": "num_requests_waiting",
}
LABEL_RE = re.compile(r'(\w+)="([^"]*)"')

# Prometheus histograms the dashboard turns into percentiles. parse_metrics() keeps the
# _bucket series per le (they are NOT summed over label sets); the client-facing
# percentiles are computed from bucket deltas over the chart window (or, as a fallback,
# over the current vLLM lifetime), interpolating linearly inside a bucket.
HIST_BASES = {
    "time_to_first_token_seconds": "ttft",
    "request_queue_time_seconds": "queue",
    "e2e_request_latency_seconds": "e2e",
}

STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "charts.js": "text/javascript; charset=utf-8",
    # vendored variable fonts (no CDN): Instrument Sans for text, Azeret Mono for numbers
    "fonts/instrument-sans.woff2": "font/woff2",
    "fonts/instrument-sans-latin-ext.woff2": "font/woff2",
    "fonts/azeret-mono.woff2": "font/woff2",
    "fonts/azeret-mono-latin-ext.woff2": "font/woff2",
}
# changes whenever a static file changes; the page reloads itself when it sees a new value
UI_VERSION = str(int(max(os.path.getmtime(os.path.join(HERE, "static", n)) for n in STATIC_FILES)))


def now_ts():
    return time.time()


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def parse_iso(s):
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).timestamp()


def hist_quantile(buckets, q):
    """q-quantile of a Prometheus histogram {le: count} (already delta'd) in seconds.

    Linear interpolation inside the bucket that crosses the quantile; +Inf carries the
    overflow. Returns None when the delta is empty."""
    if not buckets:
        return None
    ordered = []
    total = None
    for le, c in buckets.items():
        try:
            lev, cv = float(le), float(c)
        except (TypeError, ValueError):
            continue
        ordered.append((lev, cv))
        if lev == float("inf"):
            # the +Inf bucket is the histogram total itself, not an extra count
            total = cv
    if total is None:
        total = sum(c for _, c in ordered)
    if total <= 0:
        return None
    target = q * total
    ordered.sort()
    cum = 0.0
    prev = 0.0
    for lev, c in ordered:
        if lev == float("inf"):
            continue
        if c > 0 and cum + c >= target:
            return prev + (target - cum) / c * (lev - prev)
        cum += c
        prev = lev
    return prev  # all of the mass sits in the +Inf bucket


class Config:
    def __init__(self, path):
        self.path = path
        with open(path) as f:
            self.raw = json.load(f)
        src = self.raw["source"]
        self.metrics_url = src["metrics_url"]
        self.bearer = src.get("bearer_token") or os.environ.get("TOKENOMICS_BEARER", "")
        self.label = src.get("label", "vLLM")
        self.model_override = src.get("model")
        self.poll_interval = float(self.raw.get("poll_interval_seconds", 5))
        self.history_minutes = int(self.raw.get("history_minutes", 60))   # default chart window
        self.history_ttl_days = float(self.raw.get("history_ttl_days", 7))  # SQLite retention
        # trailing window for the smoothed throughput line (seconds); 30 s at a 5 s poll is only 6 samples
        self.smoothing_seconds = max(int(self.raw.get("smoothing_seconds", 120)), int(self.poll_interval))
        pod = self.raw.get("pod", {})
        self.pod_name = pod.get("name", "pod")
        self.pod_hourly = float(pod.get("hourly_usd", 0))
        self.pod_started = parse_iso(pod.get("started_at"))
        self.pod_paused_hours = float(pod.get("paused_hours", 0))
        # spend on previous pods (e.g. before a GPU swap) carried into the TOTAL scope only
        self.pod_prior_usd = float(pod.get("prior_usd", 0))
        self.pod_prior_hours = float(pod.get("prior_hours", 0))
        self.providers = self.raw.get("providers", [])
        gpu = self.raw.get("gpu", {})
        self.gpu_sysfs = gpu.get("sysfs", "/sys/class/drm")
        self.gpu_label = gpu.get("label", "")
        cpu = self.raw.get("cpu", {})
        self.cpu_hwmon = cpu.get("hwmon", "/sys/class/hwmon")            # k10temp / zenpower
        self.cpu_sysfs = cpu.get("sysfs", "/sys/devices/system/cpu")     # per-core cpufreq
        kv = self.raw.get("kv", {})
        # KV tier capacities: turn usage fractions into tokens (VRAM) and GB (RAM offload tier)
        self.kv_gpu_capacity = float(kv.get("gpu_capacity_tokens", 547295))
        self.kv_ram_capacity = float(kv.get("ram_capacity_bytes", 25760000000))
        # LLM gateway observer: the /api/gw_live proxy target. Unset -> the route 404s and
        # the page hides the Live requests section.
        self.gateway_url = os.environ.get("TOKENOMICS_GATEWAY_URL") or (self.raw.get("gateway") or {}).get("url")
        self.state_path = os.environ.get("TOKENOMICS_STATE") or os.path.join(HERE, self.raw.get("state_file", "state.json"))
        os.makedirs(os.path.dirname(os.path.abspath(self.state_path)), exist_ok=True)
        # per-poll samples live in SQLite next to state.json unless overridden
        self.history_db = (os.environ.get("TOKENOMICS_HISTORY_DB") or self.raw.get("history_db")
                           or os.path.join(os.path.dirname(os.path.abspath(self.state_path)), "history.sqlite"))
        # hero comparison provider: explicit name in config, else the priciest API by list price
        if self.raw.get("hero_provider"):
            self.hero_provider = self.raw["hero_provider"]
        elif self.providers:
            self.hero_provider = max(self.providers,
                                     key=lambda p: p.get("input_per_m", 0) + p.get("output_per_m", 0))["name"]
        else:
            self.hero_provider = None


class State:
    """Accumulated counters that survive vLLM restarts (counters reset to 0 on restart)."""

    def __init__(self, path):
        self.path = path
        self.baseline = {k: 0.0 for k in COUNTERS}   # sum of all previous vLLM lifetimes
        self.last_raw = {k: 0.0 for k in COUNTERS}   # last raw value seen from vLLM
        self.first_seen = None
        self.resets = 0
        self.last_reset_at = None
        self.extra_requests = 0.0   # synthetic request counter for llama.cpp (0->N running transitions)
        # per finished_reason split of request_success_total (stop / length / abort / ...);
        # same baseline + last_raw accounting as the main counters, so it is restart-safe
        self.reason_baseline = {}
        self.reason_last_raw = {}
        self.reason_started_at = None  # first poll where the source labeled finished_reason
        self.session = None  # {"started_at": ts, "totals": {counter: value}, "finish": {reason: value}}
        self.load()

    def load(self):
        try:
            with open(self.path) as f:
                d = json.load(f)
            self.baseline.update(d.get("baseline", {}))
            self.last_raw.update(d.get("last_raw", {}))
            self.first_seen = d.get("first_seen")
            self.resets = d.get("resets", 0)
            self.last_reset_at = d.get("last_reset_at")
            self.extra_requests = float(d.get("extra_requests", 0.0))
            self.reason_baseline = {k: float(v) for k, v in (d.get("reason_baseline") or {}).items()}
            self.reason_last_raw = {k: float(v) for k, v in (d.get("reason_last_raw") or {}).items()}
            self.reason_started_at = d.get("reason_started_at")
            s = d.get("session")
            if isinstance(s, dict) and s.get("started_at") and isinstance(s.get("totals"), dict):
                self.session = s
        except (OSError, ValueError):
            pass

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"baseline": self.baseline, "last_raw": self.last_raw,
                       "first_seen": self.first_seen, "resets": self.resets,
                       "last_reset_at": self.last_reset_at,
                       "extra_requests": self.extra_requests,
                       "reason_baseline": self.reason_baseline, "reason_last_raw": self.reason_last_raw,
                       "reason_started_at": self.reason_started_at,
                       "session": self.session}, f, indent=1)
        os.replace(tmp, self.path)

    def absorb(self, raw, reasons=None):
        """Fold a fresh raw counter snapshot in; detect resets; return cumulative totals.

        totals also carries "finish": the cumulative per-reason split ({} when the source
        never labels request_success_total, e.g. llama.cpp)."""
        reset = False
        for k in COUNTERS:
            v = raw.get(k, 0.0)
            if v + 1e-9 < self.last_raw.get(k, 0.0):
                reset = True
                break
        if reset:
            for k in COUNTERS:
                self.baseline[k] += self.last_raw.get(k, 0.0)
            for r, v in self.reason_last_raw.items():
                self.reason_baseline[r] = self.reason_baseline.get(r, 0.0) + v
            self.resets += 1
            self.last_reset_at = now_ts()
        for k in COUNTERS:
            self.last_raw[k] = raw.get(k, 0.0)
        if reasons is not None:
            for r, v in reasons.items():
                self.reason_last_raw[r] = float(v)
            if self.reason_started_at is None and self.reason_last_raw:
                self.reason_started_at = now_ts()
        if self.first_seen is None:
            self.first_seen = now_ts()
        self.save()
        totals = {k: self.baseline[k] + self.last_raw[k] for k in COUNTERS}
        known = set(self.reason_baseline) | set(self.reason_last_raw)
        totals["finish"] = {r: self.reason_baseline.get(r, 0.0) + self.reason_last_raw.get(r, 0.0)
                            for r in known}
        return totals, reset

    def ensure_session(self, ts, totals):
        """First successful poll starts the session window; persisted across server restarts."""
        if self.session is None:
            self.session = {"started_at": ts, "totals": dict(totals),
                            "finish": dict(totals.get("finish") or {})}
            self.save()
        return self.session


def parse_metrics(text):
    """Exposition format -> (counters, gauges, model, is_llama, reasons, hists).

    counters/gauges are summed over label sets; reasons is the per-finished_reason split of
    request_success_total; hists is {ttft|queue|e2e: {le: count}} keeping every bucket
    separate (percentiles come from deltas, so bucket values must not be mixed)."""
    counters = {k: 0.0 for k in COUNTERS}
    gauges = {k: 0.0 for k in GAUGES}
    reasons = {}
    hists = {"ttft": {}, "queue": {}, "e2e": {}}
    model = None
    is_llama = False
    for line in text.splitlines():
        m = METRIC_RE.match(line)
        if not m:
            continue
        name, labels, val = m.group(1), m.group(2) or "", m.group(3)
        try:
            v = float(val)
        except ValueError:
            continue
        if line.startswith("llamacpp:"):
            is_llama = True
            if name in LLAMA_COUNTER_ALIASES:
                counters[LLAMA_COUNTER_ALIASES[name]] += v
            elif name in LLAMA_GAUGE_ALIASES:
                gauges[LLAMA_GAUGE_ALIASES[name]] += v
            continue
        if name.endswith("_bucket"):
            base = name[: -len("_bucket")]
            key = HIST_BASES.get(base)
            if key is not None:
                le = dict(LABEL_RE.findall(labels)).get("le")
                if le is not None:
                    hists[key][le] = hists[key].get(le, 0.0) + v
        elif name in counters:
            counters[name] += v  # sum over label sets (e.g. finished_reason)
            if name == "request_success_total":
                fr = dict(LABEL_RE.findall(labels)).get("finished_reason")
                if fr:
                    reasons[fr] = reasons.get(fr, 0.0) + v
        elif name in gauges:
            gauges[name] += v
        if model is None and 'model_name="' in labels:
            model = dict(LABEL_RE.findall(labels)).get("model_name")
    if is_llama:
        # llama.cpp's prompt_tokens_total EXCLUDES cached; vLLM semantics include it
        counters["prompt_tokens_total"] += counters["prompt_tokens_cached_total"]
    return counters, gauges, model, is_llama, reasons, hists


def read_gpus(sysfs_root):
    """Per-GPU temp/power/fan/freq from host amdgpu hwmon (bind-mounted read-only), plus
    utilisation + VRAM from card*/device when the kernel exposes them.
    Returns [] when the sysfs path is absent (e.g. running the dashboard off-box)."""
    gpus = []
    if not os.path.isdir(sysfs_root):
        return gpus
    for card in sorted(glob.glob(os.path.join(sysfs_root, "card*"))):
        suffix = os.path.basename(card)[len("card"):]
        if not suffix.isdigit():
            continue  # skip connector dirs (card0-DP-1, card0-HDMI-A-1, ...)
        idx = int(suffix)
        hws = glob.glob(os.path.join(card, "device", "hwmon", "hwmon*"))
        if not hws:
            continue
        hw = hws[0]
        def rd(name, scale=1.0):
            try:
                with open(os.path.join(hw, name)) as f:
                    return float(f.read().strip()) * scale
            except (OSError, ValueError):
                return None
        def rddev(name, scale=1.0):
            try:
                with open(os.path.join(card, "device", name)) as f:
                    return float(f.read().strip()) * scale
            except (OSError, ValueError):
                return None
        gpus.append({
            "index": idx,
            "edge_c": rd("temp1_input", 1e-3),
            "junction_c": rd("temp2_input", 1e-3),
            "mem_c": rd("temp3_input", 1e-3),
            "edge_crit_c": rd("temp1_crit", 1e-3),
            "junction_crit_c": rd("temp2_crit", 1e-3),
            "power_w": rd("power1_average", 1e-6),
            "power_cap_w": rd("power1_cap", 1e-6),
            "power_cap_max_w": rd("power1_cap_max", 1e-6),
            "fan_rpm": rd("fan1_input"),
            "freq_ghz": rd("freq1_input", 1e-9),
            "busy_pct": rddev("gpu_busy_percent"),
            "vram_used_gb": rddev("mem_info_vram_used", 1.0 / (2.0 ** 30)),
            "vram_total_gb": rddev("mem_info_vram_total", 1.0 / (2.0 ** 30)),
        })
    return gpus


CPU_CRIT_C = 95.0  # Zen 3 Tjmax. k10temp on this board exposes no crit/max file.

_cpuinfo_cache = {}


def _cpuinfo():
    """Parse /proc/cpuinfo once: model name, physical cores, threads."""
    if _cpuinfo_cache:
        return _cpuinfo_cache
    model, cores, threads = None, None, 0
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k, v = k.strip(), v.strip()
                if k == "model name" and not model:
                    model = v
                elif k == "cpu cores" and cores is None:
                    cores = int(v)
                elif k == "processor":
                    threads += 1
    except (OSError, ValueError):
        pass
    _cpuinfo_cache["model"] = model
    _cpuinfo_cache["cores"] = cores
    _cpuinfo_cache["threads"] = threads or 0
    return _cpuinfo_cache


_cpu_prev = None
_cpu_lock = threading.Lock()


def _cpu_busy(path="/proc/stat"):
    """Total + per-core busy % from two /proc/stat samples. Returns (None, []) on the first call."""
    global _cpu_prev
    try:
        with open(path) as f:
            lines = [ln for ln in f.read().splitlines() if ln.startswith("cpu")]
    except OSError:
        return None, []
    rows = []
    for ln in lines:
        parts = ln.split()
        if parts[0] == "cpu":
            rows.append((-1, [float(x) for x in parts[1:]]))   # -1 = the aggregate line, cpu0 is a real core
        else:
            rows.append((int(parts[0][3:]), [float(x) for x in parts[1:]]))
    with _cpu_lock:
        prev = _cpu_prev
        _cpu_prev = rows
    if not prev or len(prev) != len(rows):
        return None, []
    def pct_of(a, b):
        da, db = b[3] - a[3], sum(b) - sum(a)          # idle (4th) vs total jiffies
        return None if db <= 0 else max(0.0, min(100.0, 100.0 * (1 - da / db)))
    by = {i: (a, b) for (i, a), (_, b) in zip(prev, rows)}
    total = pct_of(*by[-1]) if -1 in by else None
    per = sorted((pct_of(*by[i]), i) for (i, _) in rows if i >= 0 and i in by)
    return total, [p for p, _ in per]


def read_cpu(hwmon_root="/sys/class/hwmon", cpufreq_root="/sys/devices/system/cpu"):
    """CPU thermals, clocks, utilisation, load and memory from sysfs/procfs (read-only).

    Every source is optional: off-box or without the bind mounts the dict still comes back with
    None values and the UI hides the tiles that have no data."""
    info = _cpuinfo()
    out = {"model": info.get("model"), "cores": info.get("cores"), "threads": info.get("threads"),
           "tctl_c": None, "tccd_max_c": None, "crit_c": CPU_CRIT_C,
           "ghz_avg": None, "ghz_max": None, "ghz_boost_c": None, "boost": None,
           "pct": None, "pct_cores": [], "load1": None, "load5": None, "load15": None,
           "mem_total_mb": None, "mem_used_mb": None, "mem_pct": None}

    def rd(path, scale=1.0):
        try:
            with open(path) as f:
                return float(f.read().strip()) * scale
        except (OSError, ValueError):
            return None

    # --- temperature: k10temp (Tctl + per-CCD Tccd) or zenpower ---
    if os.path.isdir(hwmon_root):
        for hw in sorted(glob.glob(os.path.join(hwmon_root, "hwmon*"))):
            try:
                with open(os.path.join(hw, "name")) as f:
                    name = f.read().strip()
            except OSError:
                continue
            if name not in ("k10temp", "zenpower", "cpu_thermal", "soc_thermal"):
                continue
            temps = []
            for lbl in glob.glob(os.path.join(hw, "temp*_label")):
                try:
                    with open(lbl) as f:
                        tag = f.read().strip()
                    temps.append((tag, rd(os.path.join(hw, os.path.basename(lbl).replace("_label", "_input")), 1e-3)))
                except OSError:
                    continue
            tctl = next((v for tag, v in temps if tag in ("Tctl", "Tdie") and v is not None), None)
            ccd = [v for tag, v in temps if tag.startswith("Tccd") and v is not None]
            if tctl is None and temps:
                tctl = next((v for _, v in temps if v is not None), None)
            out["tctl_c"] = tctl
            out["tccd_max_c"] = max(ccd) if ccd else None
            break

    # --- clocks: per-core scaling_cur_freq (kHz), plus the amd-pstate boost ceiling ---
    freqs = []
    if os.path.isdir(cpufreq_root):
        for p in sorted(glob.glob(os.path.join(cpufreq_root, "cpu[0-9]*", "cpufreq", "scaling_cur_freq"))):
            v = rd(p, 1e-6)
            if v is not None:
                freqs.append(v)
        out["ghz_boost_c"] = rd(os.path.join(cpufreq_root, "cpu0", "cpufreq", "scaling_max_freq"), 1e-6)
        b = rd(os.path.join(cpufreq_root, "cpufreq", "boost"))
        out["boost"] = None if b is None else bool(b)
    if freqs:
        out["ghz_avg"] = sum(freqs) / len(freqs)
        out["ghz_max"] = max(freqs)
        out["freq_cores"] = [round(f, 2) for f in freqs]

    # --- utilisation, load, memory ---
    total, per = _cpu_busy()
    out["pct"] = total
    out["pct_cores"] = [round(p, 1) for p in per] if per else []
    try:
        with open("/proc/loadavg") as f:
            a, b, c = f.read().split()[:3]
        out["load1"], out["load5"], out["load15"] = float(a), float(b), float(c)
    except (OSError, ValueError):
        pass
    try:
        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k = line.split(":", 1)[0]
                if k in ("MemTotal", "MemAvailable"):
                    mem[k] = float(line.split()[1])
        if "MemTotal" in mem and "MemAvailable" in mem:
            out["mem_total_mb"] = mem["MemTotal"] / 1024.0
            out["mem_used_mb"] = (mem["MemTotal"] - mem["MemAvailable"]) / 1024.0
            out["mem_pct"] = 100.0 * (1 - mem["MemAvailable"] / mem["MemTotal"]) if mem["MemTotal"] else None
    except (OSError, ValueError, IndexError):
        pass
    return out


class History:
    """Per-poll samples in SQLite with a TTL. The UI's chart reads from here, not from memory,
    so a dashboard restart or a pod swap never loses the last `history_ttl_days` of data."""

    COLS = ["t", "gen_tps", "gen_tps_avg", "prompt_tps", "running", "waiting", "kv",
            "prompt_tokens", "cached_tokens", "gen_tokens", "requests", "preempt",
            "cpu_c", "cpu_ghz", "cpu_pct", "load1", "gpu_c",
            "ram_kv", "kv_store_gbps", "kv_load_gbps",
            "px_hits", "px_queries", "ext_hits", "ext_queries",
            "kv_store_bytes", "kv_load_bytes", "reset"]
    EXTRA_COLS = [("cpu_c", "REAL"), ("cpu_ghz", "REAL"), ("cpu_pct", "REAL"), ("load1", "REAL"), ("gpu_c", "REAL"),
                  ("ram_kv", "REAL"), ("kv_store_gbps", "REAL"), ("kv_load_gbps", "REAL"),
                  ("px_hits", "REAL"), ("px_queries", "REAL"), ("ext_hits", "REAL"), ("ext_queries", "REAL"),
                  ("kv_store_bytes", "REAL"), ("kv_load_bytes", "REAL"), ("preempt", "REAL"),
                  ("reset", "INTEGER")]

    def __init__(self, path, ttl_seconds):
        self.path = path
        self.ttl = float(ttl_seconds)
        self.lock = threading.Lock()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS samples (t REAL PRIMARY KEY, gen_tps REAL, gen_tps_avg REAL, "
            "prompt_tps REAL, running INTEGER, waiting INTEGER, kv REAL, "
            "prompt_tokens REAL, cached_tokens REAL, gen_tokens REAL, requests REAL, preempt REAL, "
            "cpu_c REAL, cpu_ghz REAL, cpu_pct REAL, load1 REAL, gpu_c REAL, "
            "ram_kv REAL, kv_store_gbps REAL, kv_load_gbps REAL, "
            "px_hits REAL, px_queries REAL, ext_hits REAL, ext_queries REAL, "
            "kv_store_bytes REAL, kv_load_bytes REAL)")
        # databases created before newer panels only have the first columns: ADD COLUMN keeps them
        have = {r[1] for r in self.db.execute("PRAGMA table_info(samples)")}
        for name, sqlt in self.EXTRA_COLS:
            if name not in have:
                self.db.execute("ALTER TABLE samples ADD COLUMN %s %s" % (name, sqlt))
        # all-time daily ledger: cumulative totals at the last poll of each UTC day. NEVER pruned.
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, t REAL, prompt_tokens REAL, "
            "cached_tokens REAL, gen_tokens REAL, requests REAL, pod_usd REAL)")
        # one row per poll with the raw histogram buckets (JSON per metric). Pruned with the
        # samples TTL; window percentiles are deltas between two of these rows.
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS hist_snap (t REAL PRIMARY KEY, ttft TEXT, queue TEXT, e2e TEXT)")
        self.db.commit()
        self._last_prune = 0.0
        self.prune(now_ts())

    def add(self, row, pod_usd=None, hists=None):
        vals = [row.get(c) for c in self.COLS]
        day = datetime.fromtimestamp(row["t"], tz=timezone.utc).strftime("%Y-%m-%d")
        with self.lock:
            # explicit column list: old databases gain new columns via ALTER (appended at the
            # end), so positional VALUES would silently land in the wrong slot
            self.db.execute("INSERT OR REPLACE INTO samples (%s) VALUES (%s)"
                            % (",".join(self.COLS), ",".join("?" * len(self.COLS))), vals)
            self.db.execute("INSERT OR REPLACE INTO ledger VALUES (?,?,?,?,?,?,?)",
                            (day, row["t"], row.get("prompt_tokens"), row.get("cached_tokens"),
                             row.get("gen_tokens"), row.get("requests"), pod_usd))
            if hists:
                self.db.execute("INSERT OR REPLACE INTO hist_snap VALUES (?,?,?,?)",
                                (row["t"],
                                 json.dumps(hists["ttft"]) if hists.get("ttft") else None,
                                 json.dumps(hists["queue"]) if hists.get("queue") else None,
                                 json.dumps(hists["e2e"]) if hists.get("e2e") else None))
            self.db.commit()
        if row["t"] - self._last_prune >= 60:
            self.prune(row["t"])

    def prune(self, now):
        """Delete everything older than the TTL (runs at most once a minute)."""
        with self.lock:
            self.db.execute("DELETE FROM samples WHERE t < ?", (now - self.ttl,))
            self.db.execute("DELETE FROM hist_snap WHERE t < ?", (now - self.ttl,))
            self.db.commit()
        self._last_prune = now

    def mean_gen_tps(self, since):
        with self.lock:
            avg, n = self.db.execute("SELECT AVG(gen_tps), COUNT(*) FROM samples WHERE t >= ?", (since,)).fetchone()
        return (avg or 0.0), (n or 0)

    def rows(self, since, until=None, max_points=1500):
        """Samples in [since, until]; when there are more than max_points they are averaged into
        equal time buckets (rates/kv averaged, running/waiting max, cumulative counters max)."""
        until = until or now_ts()
        with self.lock:
            n = self.db.execute("SELECT COUNT(*) FROM samples WHERE t >= ? AND t <= ?", (since, until)).fetchone()[0]
            if n <= max_points:
                cur = self.db.execute("SELECT %s FROM samples WHERE t >= ? AND t <= ? ORDER BY t" % ",".join(self.COLS),
                                      (since, until))
            else:
                step = max((until - since) / max_points, 1.0)
                cur = self.db.execute(
                    "SELECT MIN(t), AVG(gen_tps), AVG(gen_tps_avg), AVG(prompt_tps), MAX(running), MAX(waiting), AVG(kv), "
                    "MAX(prompt_tokens), MAX(cached_tokens), MAX(gen_tokens), MAX(requests), MAX(preempt), "
                    "AVG(cpu_c), AVG(cpu_ghz), AVG(cpu_pct), AVG(load1), MAX(gpu_c), "
                    "AVG(ram_kv), AVG(kv_store_gbps), AVG(kv_load_gbps), "
                    "MAX(px_hits), MAX(px_queries), MAX(ext_hits), MAX(ext_queries), "
                    "MAX(kv_store_bytes), MAX(kv_load_bytes), MAX(reset) FROM samples "
                    "WHERE t >= ? AND t <= ? GROUP BY CAST((t - ?) / ? AS INTEGER) ORDER BY 1",
                    (since, until, since, step))
            out = [dict(zip(self.COLS, r)) for r in cur.fetchall()]
        return out

    def hist_window(self, since):
        """(t0, h0, t1, h1): the two histogram snapshots that bracket the window [since, now].

        h0 is the first snapshot at/after `since` (falling back to the oldest stored one);
        h1 is the newest. h0/h1 are {ttft|queue|e2e: {le: count}} or None."""
        with self.lock:
            r1 = self.db.execute("SELECT t, ttft, queue, e2e FROM hist_snap ORDER BY t DESC LIMIT 1").fetchone()
            r0 = self.db.execute("SELECT t, ttft, queue, e2e FROM hist_snap WHERE t >= ? ORDER BY t ASC LIMIT 1",
                                 (since,)).fetchone()
            if r0 is None:
                r0 = self.db.execute("SELECT t, ttft, queue, e2e FROM hist_snap ORDER BY t ASC LIMIT 1").fetchone()

        def parse(r):
            if not r or not r[0]:
                return None
            d = {}
            for i, key in ((1, "ttft"), (2, "queue"), (3, "e2e")):
                if r[i]:
                    try:
                        d[key] = {k: float(v) for k, v in json.loads(r[i]).items()}
                    except (ValueError, TypeError):
                        pass
            return d or None

        if r0 is None or r1 is None:
            return None, None, None, None
        return r0[0], parse(r0), r1[0], parse(r1)

    def ledger(self):
        cols = ["day", "t", "prompt_tokens", "cached_tokens", "gen_tokens", "requests", "pod_usd"]
        with self.lock:
            rows = self.db.execute("SELECT %s FROM ledger ORDER BY day" % ",".join(cols)).fetchall()
        return [dict(zip(cols, r)) for r in rows]

    def info(self):
        with self.lock:
            n, oldest, newest = self.db.execute("SELECT COUNT(*), MIN(t), MAX(t) FROM samples").fetchone()
            ledger_days = self.db.execute("SELECT COUNT(*) FROM ledger").fetchone()[0]
        size = 0
        for suffix in ("", "-wal"):
            try:
                size += os.path.getsize(self.path + suffix)
            except OSError:
                pass
        return {"path": self.path, "rows": n or 0, "oldest": iso(oldest) if oldest else None,
                "newest": iso(newest) if newest else None, "ttl_days": self.ttl / 86400.0, "bytes": size,
                "ledger_days": ledger_days or 0}


class Poller(threading.Thread):
    def __init__(self, cfg):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.state = State(cfg.state_path)
        self.clients = {}  # client queue -> history window (minutes) the UI asked to be pushed
        self.clients_lock = threading.Lock()
        self.history = History(cfg.history_db, cfg.history_ttl_days * 86400)
        self.snapshot = {"ok": False, "error": "starting", "updated_at": iso(now_ts())}
        self.prev = None  # (ts, totals) for rate computation
        self.prev_running = None  # llama.cpp request synthesis: last requests_processing gauge
        self.hist_raw = {}  # raw histogram buckets of the current vLLM lifetime (since-restart fallback)
        self.gpu_history = deque(maxlen=max(180, int(900 / self.cfg.poll_interval)))  # 15 min of GPU readings regardless of poll interval

    def fetch(self):
        # Cloudflare-fronted endpoints 403 (error 1010) the default "Python-urllib" agent
        req = urllib.request.Request(self.cfg.metrics_url, headers={"User-Agent": "tokenomics/1.1"})
        if self.cfg.bearer:
            req.add_header("Authorization", "Bearer " + self.cfg.bearer)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read().decode("utf-8", "replace")

    @staticmethod
    def mean_e2e_s(counters):
        e2e = (counters["e2e_request_latency_seconds_sum"] /
               counters["e2e_request_latency_seconds_count"]) \
            if counters["e2e_request_latency_seconds_count"] else None
        if e2e is None and counters["gen_seconds_total"] > 0 and counters["request_success_total"] > 0:
            # llama.cpp: mean per-request generation wall-time (prompt processing not included)
            e2e = counters["gen_seconds_total"] / counters["request_success_total"]
        return e2e

    @staticmethod
    def scope_view(cfg, ts, counters, started_ts, prior_usd=0.0, prior_hours=0.0):
        """Totals + pod cost + provider costs for one window.

        counters: cumulative counter dict for the window (session deltas already applied);
                  may carry "finish" (the per-reason split), echoed through to the totals.
        started_ts: when the window's pod wall-clock starts (None -> no pod cost).
        prior_usd/prior_hours: spend and hours on earlier pods folded into this window
                               (total scope only; used across GPU swaps).
        """
        prompt = counters["prompt_tokens_total"]
        cached = min(counters["prompt_tokens_cached_total"], prompt)
        uncached = prompt - cached
        gen = counters["generation_tokens_total"]
        drafts = counters["spec_decode_num_draft_tokens_total"]
        accepted = counters["spec_decode_num_accepted_tokens_total"]

        pod_hours = None
        pod_cost = None
        if started_ts is not None:
            pod_hours = max((ts - started_ts) / 3600.0 - cfg.pod_paused_hours, 0.0)
            pod_cost = pod_hours * cfg.pod_hourly + prior_usd
            pod_hours += prior_hours

        costs = []
        for pr in cfg.providers:
            c_in = uncached * pr.get("input_per_m", 0) / 1e6
            c_cached = cached * pr.get("cached_input_per_m", pr.get("input_per_m", 0)) / 1e6
            c_out = gen * pr.get("output_per_m", 0) / 1e6
            costs.append({"name": pr["name"], "usd": c_in + c_cached + c_out,
                          "input_usd": c_in, "cached_usd": c_cached, "output_usd": c_out,
                          "kind": "api"})
        if pod_cost is not None:
            costs.append({"name": cfg.pod_name, "usd": pod_cost, "kind": "pod",
                          "hours": pod_hours, "hourly_usd": cfg.pod_hourly})
        for c in costs:
            c["x_pod"] = (c["usd"] / pod_cost) if pod_cost and pod_cost >= 0.01 else None

        return {
            "started_at": iso(started_ts) if started_ts else None,
            "totals": {
                "requests": counters["request_success_total"],
                "prompt_tokens": prompt,
                "cached_tokens": cached,
                "uncached_tokens": uncached,
                "cache_hit_pct": (100.0 * cached / prompt) if prompt else 0.0,
                "generation_tokens": gen,
                "draft_tokens": drafts,
                "accepted_tokens": accepted,
                "accept_rate_pct": (100.0 * accepted / drafts) if drafts else None,
                "preemptions": counters["num_preemptions_total"],
                "mean_e2e_s": Poller.mean_e2e_s(counters),
                "finish": counters.get("finish") or {},
            },
            "pod": {"name": cfg.pod_name, "hourly_usd": cfg.pod_hourly,
                    "started_at": iso(started_ts) if started_ts else None,
                    "hours": pod_hours, "usd": pod_cost},
            "costs": costs,
        }

    def window_lat(self, minutes):
        """Latency percentiles over the last `minutes` of histogram deltas.

        Falls back to the current vLLM lifetime (self.hist_raw) when there is not enough
        history to bracket the window. None per metric when the source has no histogram."""
        t0, h0, t1, h1 = self.history.hist_window(now_ts() - minutes * 60)
        d = None
        if h0 is not None and h1 is not None and t1 - t0 >= 5:
            d = {}
            for key in ("ttft", "queue", "e2e"):
                if key in h0 and key in h1:
                    d[key] = {le: c - h0[key].get(le, 0.0) for le, c in h1[key].items()}
        if d is None:
            d = self.hist_raw or {}
        return {
            "ttft_p50": hist_quantile(d.get("ttft"), 0.50),
            "ttft_p90": hist_quantile(d.get("ttft"), 0.90),
            "queue_p90": hist_quantile(d.get("queue"), 0.90),
            "e2e_p90": hist_quantile(d.get("e2e"), 0.90),
        }

    def ledger_days(self):
        """Per-UTC-day view of the ledger: deltas + the hero provider's cost per day,
        computed here (costs are never computed in JS)."""
        hero = None
        for p in self.cfg.providers:
            if p.get("name") == self.cfg.hero_provider:
                hero = p
                break
        if hero is None and self.cfg.providers:
            hero = self.cfg.providers[0]
        days = []
        prev = None
        for r in self.history.ledger():
            def daydelta(key):
                cur = r.get(key) or 0.0
                pv = (prev.get(key) or 0.0) if prev else 0.0
                return max(cur - pv, 0.0)
            prompt = daydelta("prompt_tokens")
            cached = min(daydelta("cached_tokens"), prompt)
            gen = daydelta("gen_tokens")
            requests = daydelta("requests")
            pod = daydelta("pod_usd")
            api = None
            if hero is not None:
                api = ((prompt - cached) * hero.get("input_per_m", 0)
                       + cached * hero.get("cached_input_per_m", hero.get("input_per_m", 0))
                       + gen * hero.get("output_per_m", 0)) / 1e6
            dow = datetime.strptime(r["day"], "%Y-%m-%d").replace(tzinfo=timezone.utc).weekday()
            days.append({"day": r["day"], "dow": (dow + 1) % 7,  # 0=Sunday, like JS getUTCDay
                         "api_usd": api, "pod_usd": pod,
                         "prompt_tokens": prompt, "cached_tokens": cached,
                         "gen_tokens": gen, "requests": requests})
            prev = r
        return {"days": days, "hero": (hero or {}).get("name") if hero else None,
                "pod_per_day": (self.cfg.pod_hourly * 24.0) if self.cfg.pod_hourly else None}

    def compute(self, ts, totals, gauges, model, is_llama=False, reset=False):
        cfg = self.cfg
        prompt = totals["prompt_tokens_total"]
        gen = totals["generation_tokens_total"]
        drafts = totals["spec_decode_num_draft_tokens_total"]
        accepted = totals["spec_decode_num_accepted_tokens_total"]

        rates = {"gen_tps": 0.0, "prompt_tps": 0.0, "itl_ms": None, "accept_rate": None,
                 "req_per_min": None}
        store_gbps, load_gbps = None, None   # KV offload tier transfer, GB/min over the last poll
        w0 = (self.history.rows(ts - 60.0, ts) or [None])[0]

        def delta60(col, cur):
            if not w0 or w0.get(col) is None:
                return None
            return max(cur - w0[col], 0.0)

        # the poll that absorbs a vLLM restart folds the old lifetime into the cumulative
        # totals, so every counter delta for this window is the whole new lifetime, not this
        # poll's seconds: report 0/None instead of a one-sample 30,000 tok/s spike
        if self.prev and not reset:
            pts, p = self.prev
            dt = max(ts - pts, 1e-6)
            rates["gen_tps"] = max(gen - p["generation_tokens_total"], 0) / dt
            rates["prompt_tps"] = max(prompt - p["prompt_tokens_total"], 0) / dt
            dcnt = totals["inter_token_latency_seconds_count"] - p["inter_token_latency_seconds_count"]
            dsum = totals["inter_token_latency_seconds_sum"] - p["inter_token_latency_seconds_sum"]
            if dcnt > 0:
                rates["itl_ms"] = 1000.0 * dsum / dcnt
            if rates["itl_ms"] is None:
                # llama.cpp: mean inter-token time = generation wall-time / tokens in the window
                dsec = totals["gen_seconds_total"] - p["gen_seconds_total"]
                dtok = gen - p["generation_tokens_total"]
                if dsec > 0 and dtok > 0:
                    rates["itl_ms"] = 1000.0 * dsec / dtok
            dd = drafts - p["spec_decode_num_draft_tokens_total"]
            da = accepted - p["spec_decode_num_accepted_tokens_total"]
            if dd > 0:
                rates["accept_rate"] = da / dd
            GB = 2.0 ** 30
            store_gbps = max(totals["kv_offload_store_bytes_total"] - p["kv_offload_store_bytes_total"], 0.0) / dt * 60.0 / GB
            load_gbps = max(totals["kv_offload_load_bytes_total"] - p["kv_offload_load_bytes_total"], 0.0) / dt * 60.0 / GB
        self.prev = (ts, dict(totals))
        rates["req_per_min"] = None if reset else delta60("requests", totals["request_success_total"])

        # smoothed throughput: trailing mean over cfg.smoothing_seconds of history (+ this poll)
        avg, n = self.history.mean_gen_tps(ts - cfg.smoothing_seconds)
        gen_tps_avg = (avg * n + rates["gen_tps"]) / (n + 1)

        total_view = self.scope_view(cfg, ts, totals, cfg.pod_started,
                                     cfg.pod_prior_usd, cfg.pod_prior_hours)
        session_view = None
        sess = self.state.session
        if sess:
            sess_counts = {k: max(totals[k] - sess["totals"].get(k, 0.0), 0.0) for k in COUNTERS}
            # per-reason session split: only for sessions snapshotted with it (old state.json
            # files predate the split; then the session view simply carries no "finish")
            if isinstance(sess.get("finish"), dict):
                total_finish = totals.get("finish") or {}
                sess_counts["finish"] = {r: max(total_finish.get(r, 0.0) - sess["finish"].get(r, 0.0), 0.0)
                                         for r in set(total_finish) | set(sess["finish"])}
            session_view = self.scope_view(cfg, ts, sess_counts, sess["started_at"])

        # KV-cache tiers: the VRAM pool + the CPU offload tier (radiance kv_offloading).
        # Since-restart numbers are state.last_raw (the current vLLM lifetime); the restart
        # time is state.last_reset_at. 60-s rates come off the oldest sample in the window.
        kv_block = None
        if not is_llama:
            raw = self.state.last_raw
            g = gauges
            GB = 2.0 ** 30

            px_h, px_q = raw["prefix_cache_hits_total"], raw["prefix_cache_queries_total"]
            ext_h, ext_q = raw["external_prefix_cache_hits_total"], raw["external_prefix_cache_queries_total"]
            st_b, st_t, st_c = raw["kv_offload_store_bytes_total"], raw["kv_offload_store_time_total"], raw["kv_offload_store_size_count"]
            ld_b, ld_t, ld_c = raw["kv_offload_load_bytes_total"], raw["kv_offload_load_time_total"], raw["kv_offload_load_size_count"]
            d_px_h, d_px_q = delta60("px_hits", totals["prefix_cache_hits_total"]), delta60("px_queries", totals["prefix_cache_queries_total"])
            d_ext_h, d_ext_q = delta60("ext_hits", totals["external_prefix_cache_hits_total"]), delta60("ext_queries", totals["external_prefix_cache_queries_total"])
            kv_block = {
                "since_restart": iso(self.state.last_reset_at) if self.state.last_reset_at else None,
                "first_seen": iso(self.state.first_seen) if self.state.first_seen else None,
                "restarts_seen": self.state.resets,
                "gpu": {
                    "capacity_tokens": cfg.kv_gpu_capacity,
                    "usage_pct": 100.0 * g["kv_cache_usage_perc"],
                    "tokens": g["kv_cache_usage_perc"] * cfg.kv_gpu_capacity,
                    "hit_rate_60s": (d_px_h / d_px_q) if d_px_h is not None and d_px_q > 0 else None,
                    "hit_rate_since_restart": (px_h / px_q) if px_q > 0 else None,
                    "hits_since_restart": px_h,
                    "queries_since_restart": px_q,
                    "running": g["num_requests_running"],
                    "waiting": g["num_requests_waiting"],
                    "preemptions": raw["num_preemptions_total"],
                },
                "ram": {
                    "capacity_bytes": cfg.kv_ram_capacity,
                    "capacity_gb": cfg.kv_ram_capacity / GB,
                    "usage_pct": 100.0 * g["kv_offload_cpu_cache_usage_perc"],
                    "usage_gb": g["kv_offload_cpu_cache_usage_perc"] * cfg.kv_ram_capacity / GB,
                    "read_pct": 100.0 * g["kv_offload_cpu_cache_read_usage_perc"],
                    "write_pct": 100.0 * g["kv_offload_cpu_cache_write_usage_perc"],
                    "store_gbps": store_gbps,
                    "load_gbps": load_gbps,
                    "store_gb": st_b / GB,
                    "store_chunks": st_c,
                    "load_gb": ld_b / GB,
                    "load_chunks": ld_c,
                    "store_mbps": (st_b / st_t) / 1e6 if st_t > 0 else None,
                    "load_mbps": (ld_b / ld_t) / 1e6 if ld_t > 0 else None,
                    "ext_tokens_since_restart": ext_h,
                    "ext_queries_since_restart": ext_q,
                    "ext_hit_rate_60s": (d_ext_h / d_ext_q) if d_ext_h is not None and d_ext_q > 0 else None,
                    "ext_hit_rate_since_restart": (ext_h / ext_q) if ext_q > 0 else None,
                },
            }

        return {
            "ok": True,
            "error": None,
            "updated_at": iso(ts),
            "source": {"label": cfg.label, "metrics_url": cfg.metrics_url, "model": model},
            "since": iso(self.state.first_seen) if self.state.first_seen else None,
            "vllm_restarts_seen": self.state.resets,
            "finish_since": iso(self.state.reason_started_at) if self.state.reason_started_at else None,
            "hero_provider": cfg.hero_provider,
            "gateway_url": cfg.gateway_url,
            "poll_interval_s": cfg.poll_interval,
            "live": {
                "gen_tps": rates["gen_tps"],
                "gen_tps_avg": gen_tps_avg,
                "avg_window_s": cfg.smoothing_seconds,
                "prompt_tps": rates["prompt_tps"],
                "itl_ms": rates["itl_ms"],
                "accept_rate": rates["accept_rate"],
                "req_per_min": rates["req_per_min"],
                "running": gauges["num_requests_running"],
                "waiting": gauges["num_requests_waiting"],
                "kv_cache_pct": None if is_llama else 100.0 * gauges["kv_cache_usage_perc"],
            },
            "kv": kv_block,
            "totals": total_view["totals"],
            "pod": total_view["pod"],
            "costs": total_view["costs"],
            "session": session_view,
            "lat": self.window_lat(cfg.history_minutes),
            "history_minutes": cfg.history_minutes,
            "ui_version": UI_VERSION,
            "history_db": self.history.info(),
            "history": self.history.rows(ts - cfg.history_minutes * 60, ts),
        }

    def run(self):
        while True:
            ts = now_ts()
            try:
                text = self.fetch()
                counters, gauges, model, is_llama, reasons, hists = parse_metrics(text)
                if is_llama:
                    model = self.cfg.model_override or model
                totals, reset = self.state.absorb(counters, reasons)
                if is_llama:
                    # llama.cpp has no request counter: count 0->N transitions of requests_processing
                    prev_running = 0.0 if self.prev_running is None else self.prev_running
                    if prev_running == 0 and gauges["num_requests_running"] > 0:
                        self.state.extra_requests += gauges["num_requests_running"]
                        self.state.save()
                    self.prev_running = gauges["num_requests_running"]
                    totals["request_success_total"] += self.state.extra_requests
                self.state.ensure_session(ts, totals)
                self.hist_raw = {k: dict(v) for k, v in hists.items() if v}
                snap = self.compute(ts, totals, gauges, model, is_llama, reset)
                gpus = read_gpus(self.cfg.gpu_sysfs)
                if gpus:
                    self.gpu_history.append({"t": ts, "gpus": gpus})
                snap["gpus"] = gpus
                snap["gpu_label"] = self.cfg.gpu_label
                snap["gpu_history"] = list(self.gpu_history)
                cpu = read_cpu(self.cfg.cpu_hwmon, self.cfg.cpu_sysfs)
                snap["cpu"] = cpu
                K = snap.get("kv") or {}
                KR = K.get("ram") or {}
                kv_sample = {} if is_llama else {
                    "ram_kv": KR.get("usage_pct"),
                    "kv_store_gbps": KR.get("store_gbps"),
                    "kv_load_gbps": KR.get("load_gbps"),
                    "px_hits": totals["prefix_cache_hits_total"],
                    "px_queries": totals["prefix_cache_queries_total"],
                    "ext_hits": totals["external_prefix_cache_hits_total"],
                    "ext_queries": totals["external_prefix_cache_queries_total"],
                    "kv_store_bytes": totals["kv_offload_store_bytes_total"],
                    "kv_load_bytes": totals["kv_offload_load_bytes_total"],
                }
                L = snap["live"]
                self.history.add({"t": ts, "gen_tps": L["gen_tps"], "gen_tps_avg": L["gen_tps_avg"],
                                  "prompt_tps": L["prompt_tps"], "running": L["running"],
                                  "waiting": L["waiting"], "kv": L["kv_cache_pct"],
                                  "prompt_tokens": totals["prompt_tokens_total"],
                                  "cached_tokens": totals["prompt_tokens_cached_total"],
                                  "gen_tokens": totals["generation_tokens_total"],
                                  "requests": totals["request_success_total"],
                                  "preempt": totals["num_preemptions_total"],
                                  "reset": 1 if reset else 0,
                                  "cpu_c": cpu.get("tctl_c"), "cpu_ghz": cpu.get("ghz_max"),
                                  "cpu_pct": cpu.get("pct"), "load1": cpu.get("load1"),
                                  "gpu_c": max([(g.get("junction_c") if g.get("junction_c") is not None else g.get("edge_c")) for g in gpus
                                   if g.get("junction_c") is not None or g.get("edge_c") is not None] or [None]),
                                  **kv_sample},
                                 pod_usd=(snap.get("pod") or {}).get("usd"), hists=hists)
                snap["history"] = self.history.rows(ts - self.cfg.history_minutes * 60, ts)
                self.snapshot = snap
            # any exception here used to kill the poller thread silently (stale page, healthy /healthz);
            # catch everything, surface it in the snapshot, keep polling.
            except Exception as e:
                snap = dict(self.snapshot)
                snap["ok"] = False
                snap["error"] = f"{type(e).__name__}: {e}"
                snap["updated_at"] = iso(ts)
                self.snapshot = snap
                self.prev = None
            try:
                self.snapshot["vllm"] = DOCKER.status()
            except Exception as e:
                self.snapshot["vllm"] = {"available": False, "error": str(e)}
            self.broadcast()
            time.sleep(self.cfg.poll_interval)

    def frame(self, minutes):
        """Snapshot JSON for one client. The chart window is whatever the client asked for:
        anything other than the live window baked into the snapshot is sliced from SQLite,
        along with the latency percentiles for that window."""
        if minutes != self.cfg.history_minutes:
            view = dict(self.snapshot)
            view["history"] = self.history.rows(now_ts() - minutes * 60)
            view["lat"] = self.window_lat(minutes)
        else:
            view = self.snapshot
        return json.dumps(view)

    def broadcast(self):
        with self.clients_lock:
            dead = []
            for q, minutes in list(self.clients.items()):
                try:
                    q.put_nowait(self.frame(minutes))
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self.clients.pop(q, None)

    def subscribe(self, minutes):
        q = queue.Queue(maxsize=8)
        with self.clients_lock:
            self.clients[q] = int(minutes)
        return q

    def unsubscribe(self, q):
        with self.clients_lock:
            self.clients.pop(q, None)


POLLER = None


DOCKER_SOCK = os.environ.get("TOKENOMICS_DOCKER_SOCK", "/var/run/docker.sock")
VLLM_CONTAINER = os.environ.get("TOKENOMICS_VLLM_CONTAINER", "vllm")
VLLM_STOP_TIMEOUT = int(os.environ.get("TOKENOMICS_VLLM_STOP_TIMEOUT", "60"))
# Start/stop/restart talks to the Docker socket, so it is off unless explicitly enabled.
VLLM_CONTROL = os.environ.get("TOKENOMICS_VLLM_CONTROL", "") == "1"
VLLM_CONTROL_OFF = ("container control is disabled \u2014 set TOKENOMICS_VLLM_CONTROL=1 "
                    "(and TOKENOMICS_VLLM_CONTAINER) to enable it")


class DockerError(Exception):
    pass


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, sockpath, timeout=90):
        super().__init__("localhost", timeout=timeout)
        self._sockpath = sockpath

    def connect(self):
        s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._sockpath)
        self.sock = s


class DockerControl:
    """Start/stop/restart the vLLM container via the Docker Engine API over its unix socket."""

    def __init__(self, sockpath=DOCKER_SOCK, container=VLLM_CONTAINER):
        self.sockpath = sockpath
        self.container = container

    def _req(self, method, path, expect):
        try:
            c = _UnixHTTPConnection(self.sockpath)
            c.request(method, path)
            r = c.getresponse()
            body = r.read()
            code = r.status
            c.close()
        except OSError as e:
            raise DockerError("docker socket unreachable: %s" % e)
        if code not in expect:
            raise DockerError("docker %s -> %d: %s" % (path, code, body[:200].decode("utf-8", "replace")))
        return code, body

    def status(self):
        if not VLLM_CONTROL:
            return {"available": False, "enabled": False, "container": self.container,
                    "error": VLLM_CONTROL_OFF}
        try:
            code, body = self._req("GET", "/containers/%s/json" % self.container, (200, 404))
        except DockerError as e:
            return {"available": False, "container": self.container, "error": str(e)}
        if code == 404:
            return {"available": True, "container": self.container, "exists": False,
                    "running": False, "state": "missing"}
        try:
            info = json.loads(body)
        except Exception as e:
            return {"available": True, "container": self.container, "error": "parse: %s" % e}
        st = info.get("State", {}) or {}
        health = (st.get("Health") or {}).get("Status")
        return {"available": True, "container": self.container, "exists": True,
                "running": bool(st.get("Running")), "state": st.get("Status"),
                "health": health, "started_at": st.get("StartedAt")}

    def action(self, act):
        if not VLLM_CONTROL:
            raise DockerError(VLLM_CONTROL_OFF)
        if act not in ("start", "stop", "restart"):
            raise DockerError("unknown action %r" % act)
        path = "/containers/%s/%s" % (self.container, act)
        if act in ("stop", "restart"):
            path += "?t=%d" % VLLM_STOP_TIMEOUT
        # 204 = done, 304 = already in that state -> both are success
        self._req("POST", path, (204, 304))
        return self.status()


DOCKER = DockerControl()


class Handler(BaseHTTPRequestHandler):
    server_version = "tokenomics/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("TOKENOMICS_QUIET"):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _gw_live(self):
        """Proxy the LLM gateway observer so the browser stays same-origin (the gateway does
        not send CORS headers and does not need to). Body passes through unchanged."""
        url = POLLER.cfg.gateway_url
        if not url:
            return self._send(404, json.dumps({"ok": False, "error": "gateway not configured"}))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tokenomics/1.1"})
            with urllib.request.urlopen(req, timeout=2) as r:
                body = r.read()
            return self._send(200, body, "application/json; charset=utf-8")
        except Exception as e:
            return self._send(502, json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        name = None
        if path in ("/", "/index.html"):
            name = "index.html"
        elif path.startswith("/static/"):
            candidate = path[len("/static/"):]
            if candidate in STATIC_FILES:
                name = candidate
        if name is not None:
            with open(os.path.join(HERE, "static", name), "rb") as f:
                return self._send(200, f.read(), STATIC_FILES[name])
        if path == "/api/stats":
            return self._send(200, json.dumps(POLLER.snapshot))
        if path == "/api/ledger":
            return self._send(200, json.dumps(POLLER.ledger_days()))
        if path == "/api/gw_live":
            return self._gw_live()
        if path == "/api/history":
            # ?minutes=N (capped at the TTL) -> samples from SQLite, bucket-averaged above 1500 points
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            try:
                minutes = float(qs.get("minutes", [POLLER.cfg.history_minutes])[0])
            except ValueError:
                return self._send(400, json.dumps({"error": "minutes must be a number"}))
            minutes = max(1.0, min(minutes, POLLER.cfg.history_ttl_days * 1440))
            until = now_ts()
            since = until - minutes * 60
            return self._send(200, json.dumps({"since": iso(since), "until": iso(until), "minutes": minutes,
                                               "points": POLLER.history.rows(since, until)}))
        if path == "/api/vllm":
            return self._send(200, json.dumps(DOCKER.status()))
        if path == "/healthz":
            return self._send(200 if POLLER.snapshot.get("ok") else 503,
                              json.dumps({"ok": POLLER.snapshot.get("ok"),
                                          "error": POLLER.snapshot.get("error")}))
        if path == "/events":
            return self.sse()
        return self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/vllm":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                act = (json.loads(raw or b"{}") or {}).get("action")
            except Exception:
                return self._send(400, json.dumps({"error": "bad request body"}))
            if act not in ("start", "stop", "restart"):
                return self._send(400, json.dumps({"error": "action must be start|stop|restart"}))
            try:
                return self._send(200, json.dumps({"ok": True, "vllm": DOCKER.action(act)}))
            except DockerError as e:
                return self._send(502, json.dumps({"ok": False, "error": str(e)}))
        return self._send(404, json.dumps({"error": "not found"}))

    def sse(self):
        qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        try:
            minutes = float(qs.get("minutes", [POLLER.cfg.history_minutes])[0])
        except ValueError:
            minutes = POLLER.cfg.history_minutes
        minutes = max(1.0, min(minutes, POLLER.cfg.history_ttl_days * 1440))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = POLLER.subscribe(minutes)
        try:
            self.wfile.write(("data: " + POLLER.frame(minutes) + "\n\n").encode())
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=15)
                    self.wfile.write(("data: " + data + "\n\n").encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            POLLER.unsubscribe(q)


def main():
    global POLLER
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=os.environ.get("TOKENOMICS_CONFIG", os.path.join(HERE, "config.json")))
    ap.add_argument("--host", default=os.environ.get("TOKENOMICS_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("TOKENOMICS_PORT", 8787)))
    args = ap.parse_args()
    cfg = Config(args.config)
    POLLER = Poller(cfg)
    POLLER.start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"tokenomics: serving http://{args.host}:{args.port}/  <- {cfg.metrics_url} every {cfg.poll_interval:g}s",
          file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
