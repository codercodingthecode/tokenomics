# AGENTS.md - working notes for AI agents and humans

Read this before changing anything. [README.md](README.md) is user-facing; this file is
about how the code is put together, the constraints that are non-negotiable, and what
"done" means here. Update it when you change behaviour.

## Non-negotiable constraints

1. **Standard library only.** `server.py` imports nothing outside the Python 3.9 stdlib.
   No pip installs, no venv, no requirements.txt. That is the whole point: it has to run
   on a machine with no package index.
2. **No frontend build.** `static/index.html` + `static/styles.css` + `static/app.js`,
   vanilla JS, hand-drawn SVG chart. No framework, no bundler, no CDN, no webfonts.
3. **Single file server.** Everything server-side stays in `server.py`. If it grows past
   a point where modules are unavoidable, propose that first.
4. **Nothing personal, nothing private, nothing vendor-specific in this repo.** No
   hostnames, IP addresses, cloud instance IDs, tokens, prices you pay, or paths that
   only exist on one machine. Configuration and secrets live in `config.json`
   (gitignored). Deployment docs stay generic (`your-host`, `/opt/tokenomics`, port
   `8787`). Examples in `config.example.json` must be obviously fake.
5. **Backwards-compatible state.** `state.json` and `history.sqlite` hold long-lived
   totals. A schema change must read the old shape without migrating it into garbage.

## Files

| file | role |
|---|---|
| `server.py` | config, restart-safe state, poller thread, costs, hwmon readers, HTTP handler, SSE |
| `static/index.html` | markup |
| `static/styles.css` | all styling; theming through CSS custom properties |
| `static/app.js` | SSE client, render loop, scope toggle, chart, theme toggle |
| `config.example.json` | documented template; copy to `config.json` |
| `Dockerfile`, `tokenomics.service` | the two supported deploys |

`config.json`, `state.json`, `history.sqlite` are gitignored and never committed.

## Data flow

```
metrics URL --(GET every poll_interval_seconds, optional Bearer)--> Poller thread
  parse_metrics()      regex-parse the exposition format, sum across label sets
  State.absorb()       counter went down? fold the previous raw values into `baseline`
  State.ensure_session() first poll of a deployment snapshots the session baseline
  compute()            rates from deltas, per-scope views, provider + pod costs
  broadcast()          one JSON snapshot per poll to every SSE queue
browser <--(GET /events; ": keepalive" every 15 s)
```

`GET /api/stats` returns the same snapshot for poll-only clients.

## Metrics

`COUNTERS` / `GAUGES` at the top of `server.py` are the contract. Values are summed over
label sets (e.g. `finished_reason`).

- **vLLM**: `prompt_tokens_total`, `prompt_tokens_cached_total`,
  `generation_tokens_total`, `request_success_total`,
  `spec_decode_num_draft_tokens_total`, `spec_decode_num_accepted_tokens_total`,
  `num_preemptions_total`, `inter_token_latency_seconds_{sum,count}`,
  `e2e_request_latency_seconds_{sum,count}`; gauges `num_requests_running`,
  `num_requests_waiting`, `kv_cache_usage_perc`.
- **llama.cpp**: `llamacpp:*` names are mapped onto the same internal keys through
  `LLAMA_COUNTER_ALIASES` / `LLAMA_GAUGE_ALIASES`. One semantic fix lives there:
  llama.cpp's prompt counter excludes cached tokens, so the cached total is added back
  to make `cache_hit_pct` comparable with vLLM.

When a server renames something, extend the alias maps rather than special-casing
downstream.

## Derived numbers

- `gen_tps`, `prompt_tps`: counter delta / elapsed seconds. `gen_tps_avg` is a trailing
  mean over the last `smoothing_seconds` of stored history; `avg_window_s` tells the
  client how to label it.
- `itl_ms`: `delta(inter_token_latency_sum) / delta(count)`.
- `accept_rate`: accepted / drafted speculative tokens over the window.
- `cache_hit_pct`: cached prompt tokens / prompt tokens, per scope.
- Provider cost: `uncached x input + cached x cached_input + generated x output`, all
  per 1M tokens, per scope.
- Pod cost: `(now - scope_start - paused_hours) x hourly_usd`, plus `prior_usd` in the
  total scope only. Wall-clock, deliberately not token-based.
- `x_pod`: provider cost / pod cost, `null` below $0.01 so a freshly started window does
  not print an absurd multiplier.

## State and restarts

- `state.json`: `baseline`, `last_raw`, `resets`, `session {started_at, totals}`.
  Written atomically (`.tmp` + rename) after every poll. Delete it to count from zero.
- Counter reset detection is "any counter decreased". If the server restarts and serves
  more than its previous lifetime before the next poll, the reset is missed; a 5 s poll
  makes that vanishingly unlikely.
- `history.sqlite` (WAL): `samples` (per poll) pruned by `history_ttl_days`, `ledger`
  (one row per UTC day) never pruned - all-time totals are a feature.

## Host health

`read_gpus()` walks `/sys/class/drm/card*/device/hwmon/hwmon*` for amdgpu
(edge/junction/memory temperature, power draw, cap, fan, clock) and keeps a
180-sample ring buffer for sparklines. `read_cpu()` uses `/proc/stat`, `/proc/loadavg`,
`hwmon` (`k10temp`/`zenpower`) and `cpufreq`. Both return empty when the paths are
absent, so running the dashboard off-box degrades quietly. Keep it this way: no vendor
CLIs, no `rocm-smi`/`nvidia-smi` shelling out.

## UI conventions

- Economics first: the hero is the saving against `hero_provider`; raw counters are
  secondary chips.
- Two series colors only - blue for API providers, orange for the pod, validated for
  colorblind separation in both themes. Green means savings/positive. Add rows rather
  than new hues.
- Numbers in `ui-monospace` with `tabular-nums`, compact form primary (46.0M) with exact
  values in tooltips. Text never wears a series color.
- Both scopes ride in every snapshot, so the Total/Session toggle is a pure client
  switch.
- Chart: per-poll line plus dashed trailing average, "now" label at the line end,
  adaptive x ticks (seconds under a 15 min span), crosshair tooltip, idle state, and
  1h/6h/24h/7d ranges served from SQLite.
- Dark is the default; the header toggle persists to `localStorage` and `?theme=` wins.
- `.flashy` / `.flash` give a one-shot background flash so live movement is visible.
- The page auto-reloads when `ui_version` changes so an open tab never runs stale
  assets after a deploy.

## Run it while developing

```bash
cp config.example.json config.json    # then edit metrics_url / bearer_token
python3 server.py --port 8787
curl -s localhost:8787/healthz
curl -s localhost:8787/api/stats | head -c 400
curl -sN localhost:8787/events | head -c 300
```

There is no test suite; the check is: it starts with a real metrics endpoint, `/healthz`
is `ok`, `/api/stats` carries `totals`, `session`, `costs`, `gpus`, and the page renders
in both themes with and without GPU data. Keep `python3 -c "import ast,sys;ast.parse(open('server.py').read())"`
green, and keep the file importable with no side effects until `main()` runs.

## Extending it

- **New number**: parse into `COUNTERS`/`GAUGES`, derive it in `compute()`, add it to the
  snapshot, render it. Do not compute costs in JS.
- **Second endpoint**: `source` would become a list plus a UI selector; keep one
  `state.json` per source so totals cannot cross-contaminate.
- **Container control** (`DockerControl`) is opt-in via `TOKENOMICS_VLLM_CONTROL=1`
  because it reaches the Docker socket. Anything new in that direction needs the same
  treatment: default off, documented, and never implied by the presence of a socket.

## Pull requests

Small, focused commits with an imperative subject (`add llama.cpp gauge aliases`).
Update this file and README.md in the same commit as the behaviour change. No generated
files, no lockfiles, no editor settings beyond `.gitignore`.
