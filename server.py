#!/usr/bin/env python3
"""tokenomics — live token / throughput / cost dashboard for a vLLM endpoint.

Stdlib only (Python 3.9+). Polls vLLM's Prometheus /metrics, accumulates counters
across vLLM restarts, prices the traffic against API providers, and pushes updates
to the browser over Server-Sent Events.

    python3 server.py [--config config.json] [--port 8787] [--host 0.0.0.0]

The snapshot exposes two scopes:
  total   — everything counted since counting began (baseline + current, restart-safe)
  session — this deployment's window: counters since the server's first poll
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
    "inter_token_latency_seconds_sum",
    "inter_token_latency_seconds_count",
    "e2e_request_latency_seconds_sum",
    "e2e_request_latency_seconds_count",
    "gen_seconds_total",  # llama.cpp only: total wall-time spent generating tokens
]
GAUGES = ["num_requests_running", "num_requests_waiting", "kv_cache_usage_perc"]

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

STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
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
        self.extra_requests = 0.0   # synthetic request counter for llama.cpp (0->N running transitions)
        self.session = None  # {"started_at": ts, "totals": {counter: value}} — this deployment's window
        self.load()

    def load(self):
        try:
            with open(self.path) as f:
                d = json.load(f)
            self.baseline.update(d.get("baseline", {}))
            self.last_raw.update(d.get("last_raw", {}))
            self.first_seen = d.get("first_seen")
            self.resets = d.get("resets", 0)
            self.extra_requests = float(d.get("extra_requests", 0.0))
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
                       "extra_requests": self.extra_requests, "session": self.session}, f, indent=1)
        os.replace(tmp, self.path)

    def absorb(self, raw):
        """Fold a fresh raw counter snapshot in; detect resets; return cumulative totals."""
        reset = False
        for k in COUNTERS:
            v = raw.get(k, 0.0)
            if v + 1e-9 < self.last_raw.get(k, 0.0):
                reset = True
                break
        if reset:
            for k in COUNTERS:
                self.baseline[k] += self.last_raw.get(k, 0.0)
            self.resets += 1
        for k in COUNTERS:
            self.last_raw[k] = raw.get(k, 0.0)
        if self.first_seen is None:
            self.first_seen = now_ts()
        self.save()
        return {k: self.baseline[k] + self.last_raw[k] for k in COUNTERS}

    def ensure_session(self, ts, totals):
        """First successful poll starts the session window; persisted across server restarts."""
        if self.session is None:
            self.session = {"started_at": ts, "totals": dict(totals)}
            self.save()
        return self.session


def parse_metrics(text):
    counters = {k: 0.0 for k in COUNTERS}
    gauges = {k: 0.0 for k in GAUGES}
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
        if name in counters:
            counters[name] += v  # sum over label sets (e.g. finished_reason)
        elif name in gauges:
            gauges[name] += v
        if model is None and 'model_name="' in labels:
            model = dict(LABEL_RE.findall(labels)).get("model_name")
    if is_llama:
        # llama.cpp's prompt_tokens_total EXCLUDES cached; vLLM semantics include it
        counters["prompt_tokens_total"] += counters["prompt_tokens_cached_total"]
    return counters, gauges, model, is_llama



def read_gpus(sysfs_root):
    """Per-GPU temp/power/fan/freq from host amdgpu hwmon (bind-mounted read-only).
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
        gpus.append({
            "index": idx,
            "edge_c": rd("temp1_input", 1e-3),
            "junction_c": rd("temp2_input", 1e-3),
            "mem_c": rd("temp3_input", 1e-3),
            "edge_crit_c": rd("temp1_crit", 1e-3),
            "power_w": rd("power1_average", 1e-6),
            "power_cap_w": rd("power1_cap", 1e-6),
            "power_cap_max_w": rd("power1_cap_max", 1e-6),
            "fan_rpm": rd("fan1_input"),
            "freq_ghz": rd("freq1_input", 1e-9),
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
    return total, per


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
            "prompt_tokens", "cached_tokens", "gen_tokens", "requests",
            "cpu_c", "cpu_ghz", "cpu_pct", "load1", "gpu_c"]
    EXTRA_COLS = [("cpu_c", "REAL"), ("cpu_ghz", "REAL"), ("cpu_pct", "REAL"), ("load1", "REAL"), ("gpu_c", "REAL")]

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
            "prompt_tokens REAL, cached_tokens REAL, gen_tokens REAL, requests REAL, "
            "cpu_c REAL, cpu_ghz REAL, cpu_pct REAL, load1 REAL, gpu_c REAL)")
        # databases created before the CPU panel only have the first 11 columns: ADD COLUMN keeps them
        have = {r[1] for r in self.db.execute("PRAGMA table_info(samples)")}
        for name, sqlt in self.EXTRA_COLS:
            if name not in have:
                self.db.execute("ALTER TABLE samples ADD COLUMN %s %s" % (name, sqlt))
        # all-time daily ledger: cumulative totals at the last poll of each UTC day. NEVER pruned.
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, t REAL, prompt_tokens REAL, "
            "cached_tokens REAL, gen_tokens REAL, requests REAL, pod_usd REAL)")
        self.db.commit()
        self._last_prune = 0.0
        self.prune(now_ts())

    def add(self, row, pod_usd=None):
        vals = [row.get(c) for c in self.COLS]
        day = datetime.fromtimestamp(row["t"], tz=timezone.utc).strftime("%Y-%m-%d")
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO samples VALUES (%s)" % ",".join("?" * len(self.COLS)), vals)
            self.db.execute("INSERT OR REPLACE INTO ledger VALUES (?,?,?,?,?,?,?)",
                            (day, row["t"], row.get("prompt_tokens"), row.get("cached_tokens"),
                             row.get("gen_tokens"), row.get("requests"), pod_usd))
            self.db.commit()
        if row["t"] - self._last_prune >= 60:
            self.prune(row["t"])

    def prune(self, now):
        """Delete everything older than the TTL (runs at most once a minute)."""
        with self.lock:
            self.db.execute("DELETE FROM samples WHERE t < ?", (now - self.ttl,))
            self.db.commit()
        self._last_prune = now

    def mean_gen_tps(self, since):
        with self.lock:
            avg, n = self.db.execute("SELECT AVG(gen_tps), COUNT(*) FROM samples WHERE t >= ?", (since,)).fetchone()
        return (avg or 0.0), (n or 0)

    def rows(self, since, until=None, max_points=1500):
        """Samples in [since, until]; when there are more than max_points they are averaged into
        equal time buckets (rates/kv averaged, running/waiting max, cumulative tokens max)."""
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
                    "MAX(prompt_tokens), MAX(cached_tokens), MAX(gen_tokens), MAX(requests), "
                    "AVG(cpu_c), AVG(cpu_ghz), AVG(cpu_pct), AVG(load1), MAX(gpu_c) FROM samples "
                    "WHERE t >= ? AND t <= ? GROUP BY CAST((t - ?) / ? AS INTEGER) ORDER BY 1",
                    (since, until, since, step))
            out = [dict(zip(self.COLS, r)) for r in cur.fetchall()]
        return out

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
        self.clients = set()
        self.clients_lock = threading.Lock()
        self.history = History(cfg.history_db, cfg.history_ttl_days * 86400)
        self.snapshot = {"ok": False, "error": "starting", "updated_at": iso(now_ts())}
        self.prev = None  # (ts, totals) for rate computation
        self.prev_running = None  # llama.cpp request synthesis: last requests_processing gauge
        self.gpu_history = deque(maxlen=180)  # ~15 min of GPU readings at a 5 s poll

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

        counters: cumulative counter dict for the window (session deltas already applied).
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
            },
            "pod": {"name": cfg.pod_name, "hourly_usd": cfg.pod_hourly,
                    "started_at": iso(started_ts) if started_ts else None,
                    "hours": pod_hours, "usd": pod_cost},
            "costs": costs,
        }

    def compute(self, ts, totals, gauges, model, is_llama=False):
        cfg = self.cfg
        prompt = totals["prompt_tokens_total"]
        gen = totals["generation_tokens_total"]
        drafts = totals["spec_decode_num_draft_tokens_total"]
        accepted = totals["spec_decode_num_accepted_tokens_total"]

        rates = {"gen_tps": 0.0, "prompt_tps": 0.0, "itl_ms": None, "accept_rate": None}
        if self.prev:
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
        self.prev = (ts, dict(totals))

        # smoothed throughput: trailing mean over cfg.smoothing_seconds of history (+ this poll)
        avg, n = self.history.mean_gen_tps(ts - cfg.smoothing_seconds)
        gen_tps_avg = (avg * n + rates["gen_tps"]) / (n + 1)

        total_view = self.scope_view(cfg, ts, totals, cfg.pod_started,
                                     cfg.pod_prior_usd, cfg.pod_prior_hours)
        session_view = None
        sess = self.state.session
        if sess:
            sess_counts = {k: max(totals[k] - sess["totals"].get(k, 0.0), 0.0) for k in COUNTERS}
            session_view = self.scope_view(cfg, ts, sess_counts, sess["started_at"])

        return {
            "ok": True,
            "error": None,
            "updated_at": iso(ts),
            "source": {"label": cfg.label, "metrics_url": cfg.metrics_url, "model": model},
            "since": iso(self.state.first_seen) if self.state.first_seen else None,
            "vllm_restarts_seen": self.state.resets,
            "hero_provider": cfg.hero_provider,
            "live": {
                "gen_tps": rates["gen_tps"],
                "gen_tps_avg": gen_tps_avg,
                "avg_window_s": cfg.smoothing_seconds,
                "prompt_tps": rates["prompt_tps"],
                "itl_ms": rates["itl_ms"],
                "accept_rate": rates["accept_rate"],
                "running": gauges["num_requests_running"],
                "waiting": gauges["num_requests_waiting"],
                "kv_cache_pct": None if is_llama else 100.0 * gauges["kv_cache_usage_perc"],
            },
            "totals": total_view["totals"],
            "pod": total_view["pod"],
            "costs": total_view["costs"],
            "session": session_view,
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
                counters, gauges, model, is_llama = parse_metrics(text)
                if is_llama:
                    model = self.cfg.model_override or model
                totals = self.state.absorb(counters)
                if is_llama:
                    # llama.cpp has no request counter: count 0->N transitions of requests_processing
                    prev_running = 0.0 if self.prev_running is None else self.prev_running
                    if prev_running == 0 and gauges["num_requests_running"] > 0:
                        self.state.extra_requests += gauges["num_requests_running"]
                        self.state.save()
                    self.prev_running = gauges["num_requests_running"]
                    totals["request_success_total"] += self.state.extra_requests
                self.state.ensure_session(ts, totals)
                snap = self.compute(ts, totals, gauges, model, is_llama)
                gpus = read_gpus(self.cfg.gpu_sysfs)
                if gpus:
                    self.gpu_history.append({"t": ts, "gpus": gpus})
                snap["gpus"] = gpus
                snap["gpu_label"] = self.cfg.gpu_label
                snap["gpu_history"] = list(self.gpu_history)
                cpu = read_cpu(self.cfg.cpu_hwmon, self.cfg.cpu_sysfs)
                snap["cpu"] = cpu
                L = snap["live"]
                self.history.add({"t": ts, "gen_tps": L["gen_tps"], "gen_tps_avg": L["gen_tps_avg"],
                                  "prompt_tps": L["prompt_tps"], "running": L["running"],
                                  "waiting": L["waiting"], "kv": L["kv_cache_pct"],
                                  "prompt_tokens": totals["prompt_tokens_total"],
                                  "cached_tokens": totals["prompt_tokens_cached_total"],
                                  "gen_tokens": totals["generation_tokens_total"],
                                  "requests": totals["request_success_total"],
                                  "cpu_c": cpu.get("tctl_c"), "cpu_ghz": cpu.get("ghz_max"),
                                  "cpu_pct": cpu.get("pct"), "load1": cpu.get("load1"),
                                  "gpu_c": max([g["edge_c"] for g in gpus if g.get("edge_c") is not None] or [None])},
                                 pod_usd=(snap.get("pod") or {}).get("usd"))
                snap["history"] = self.history.rows(ts - self.cfg.history_minutes * 60, ts)
                self.snapshot = snap
            except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
                snap = dict(self.snapshot)
                snap["ok"] = False
                snap["error"] = f"{type(e).__name__}: {e}"
                snap["updated_at"] = iso(ts)
                self.snapshot = snap
                self.prev = None
            self.broadcast()
            time.sleep(self.cfg.poll_interval)

    def broadcast(self):
        data = json.dumps(self.snapshot)
        with self.clients_lock:
            dead = []
            for q in self.clients:
                try:
                    q.put_nowait(data)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self.clients.discard(q)

    def subscribe(self):
        q = queue.Queue(maxsize=8)
        with self.clients_lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q):
        with self.clients_lock:
            self.clients.discard(q)


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
            return self._send(200, json.dumps({"days": POLLER.history.ledger()}))
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
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = POLLER.subscribe()
        try:
            self.wfile.write(("data: " + json.dumps(POLLER.snapshot) + "\n\n").encode())
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
    ap.add_argument("--port", type=int, default=int(os.environ.get("TOKENOMICS_PORT", "8787")))
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
