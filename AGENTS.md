# AGENTS.md - working notes for AI agents and humans

Read this before changing anything. [README.md](README.md) is user-facing; this file is
about how the code is put together, the constraints that are non-negotiable, and what
"done" means here. Update it when you change behaviour.

## Non-negotiable constraints

1. **Standard library only.** `server.py` imports nothing outside the Python 3.9 stdlib.
   No pip installs, no venv, no requirements.txt. That is the whole point: it has to run
   on a machine with no package index.
2. **No frontend build.** `static/index.html` + `static/styles.css` + `static/app.js` +
   `static/charts.js`, vanilla JS, hand-drawn SVG (one shared chart engine, no
   charting library). No framework, no bundler, no CDN, no webfonts **from a CDN** —
   the two typefaces (Instrument Sans, Azeret Mono) are vendored variable woff2 files
   in `static/fonts/` and served by `server.py` like any other static file.
3. **Single file server.** Everything server-side stays in `server.py`. If it grows past
   a point where modules are unavoidable, propose that first.
4. **Nothing personal, nothing private, nothing vendor-specific in this repo.** No
   hostnames, IP addresses, cloud instance IDs, tokens, prices you pay, or paths that
   only exist on one machine. Configuration and secrets live in `config.json`
   (gitignored). Deployment docs stay generic (`your-host`, `/opt/tokenomics`, port
   `8787`). Examples in `config.example.json` must be obviously fake.
5. **Backwards-compatible state.** `state.json` and `history.sqlite` hold long-lived
   totals. A schema change must read the old shape without migrating it into garbage:
   new `state.json` keys default to empty, new `samples` columns are added by ALTER and
   inserted by explicit column list (old databases gain columns at the end), old
   sessions without `finish` simply carry no reason split.

## Files

| file | role |
|---|---|
| `server.py` | config, restart-safe state, poller thread, costs, latency percentiles, gateway proxy, hwmon readers, HTTP handler, SSE |
| `static/index.html` | markup |
| `static/styles.css` | all styling; theming through CSS custom properties |
| `static/charts.js` | `window.TokCharts` - the dependency-free SVG chart engine (line/area, monotone interpolation, gaps, bands, refs, end pills, crosshair) plus `paths()`/`timePaths()`/`barsPath()` raw path builders the hand-built section SVGs reuse |
| `static/app.js` | SSE client, render loop, gateway observer panel (1 s poll), scope toggle, range control, theme toggle |
| `static/fonts/` | vendored variable woff2: Instrument Sans (text) + Azeret Mono (numbers), latin + latin-ext |
| `config.example.json` | documented template; copy to `config.json` |
| `Dockerfile`, `tokenomics.service` | the two supported deploys |

`config.json`, `state.json`, `history.sqlite` are gitignored and never committed.

## Data flow

```
metrics URL --(GET every poll_interval_seconds, optional Bearer)--> Poller thread
  parse_metrics()      regex-parse the exposition format, sum counters/gauges across
                       label sets; keep _bucket histograms per le and the
                       per-finished_reason split of request_success_total
  State.absorb()       counter went down? fold the previous raw values into `baseline`
                       (the reason split gets the same treatment)
  State.ensure_session() first poll of a deployment snapshots the session baseline
  compute()            rates from deltas, per-scope views, provider + pod costs
  History.add()        per-poll sample (incl. the `preempt` counter) + one hist_snap row
  broadcast()          one JSON snapshot per poll to every SSE queue
browser <--(GET /events; ": keepalive" every 15 s)
browser --(GET /api/gw_live every 1 s)--> server proxies the gateway observer (2 s
  timeout, body passed through, Cache-Control: no-store; 404 when unconfigured,
  502 with {"ok": false, "error": ...} when unreachable)
```

`GET /api/stats` returns the same snapshot for poll-only clients.

## Metrics

`COUNTERS` / `GAUGES` at the top of `server.py` are the contract. Values are summed over
label sets (e.g. `finished_reason`).

- **vLLM**: `prompt_tokens_total`, `prompt_tokens_cached_total`,
  `generation_tokens_total`, `request_success_total`,
  `spec_decode_num_draft_tokens_total`, `spec_decode_num_accepted_tokens_total`,
  `num_preemptions_total`, `prefix_cache_{hits,queries}_total`,
  `external_prefix_cache_{hits,queries}_total`,
  `kv_offload_{store,load}_{bytes,time}_total`, `kv_offload_{store,load}_size_count`,
  `inter_token_latency_seconds_{sum,count}`,
  `e2e_request_latency_seconds_{sum,count}`; gauges `num_requests_running`,
  `num_requests_waiting`, `kv_cache_usage_perc`,
  `kv_offload_cpu_cache_{,read_,write_}usage_perc`.
  The offload counters can be absent from the exposition until first use; a missing
  name parses as 0 and never reads as a reset.
- **Histograms** (`HIST_BASES`): `vllm:time_to_first_token_seconds_bucket`,
  `vllm:request_queue_time_seconds_bucket`, `vllm:e2e_request_latency_seconds_bucket`.
  These are NOT summed over label sets — each `le` is kept as its own series in a
  `hist_snap` row per poll (JSON maps, pruned with the sample TTL). Percentiles are
  computed from bucket **deltas** between the two snapshots bracketing the client's
  chart window, interpolating linearly inside the crossing bucket; when the window
  cannot be bracketed the current vLLM lifetime (`hist_raw`) is the fallback.
- **Finish reasons**: the per-`finished_reason` split of `request_success_total`
  (stop / length / abort / ...) is tracked in `State.reason_{baseline,last_raw}` —
  the same restart-safe accounting as the main counters — and surfaced in both
  scopes' totals as `totals.finish`. llama.cpp never labels it, so it is simply `{}`.
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
- `req_per_min`: `delta60("requests")` — requests now minus the oldest sample in the
  last 60 s.
- `lat` block: `ttft_p50`, `ttft_p90`, `queue_p90`, `e2e_p90` per the window described
  above. The snapshot carries it for the default window; `frame(minutes)` recomputes it
  for other chart ranges, so the header range control drives these too.
- `kv` snapshot block: GPU tier (usage %, tokens = fraction x `kv.gpu_capacity_tokens`,
  60-s and since-restart prefix hit rate, running/waiting/preemptions) and RAM offload
  tier (in-flight pinned %/GB, store/load GB/min, since-restart GB + chunks,
  "RAM restores" = load chunk count, external-prefix tokens + hit rates,
  avg MB/s = bytes / offload time). Since-restart numbers are `state.last_raw`
  (the current vLLM lifetime); 60-s rates are deltas off the oldest sample in the window.
- Provider cost: `uncached x input + cached x cached_input + generated x output`, all
  per 1M tokens, per scope.
- Pod cost: `(now - scope_start - paused_hours) x hourly_usd`, plus `prior_usd` in the
  total scope only. Wall-clock, deliberately not token-based.
- `x_pod`: provider cost / pod cost, `null` below $0.01 so a freshly started window does
  not print an absurd multiplier.
- Daily ledger (`/api/ledger`): per-UTC-day **deltas** of the cumulative `ledger` rows,
  plus the hero provider's cost for the day's tokens and the pod's cost for the day,
  all computed **server-side** (AGENTS.md rule: no cost math in JS). The client renders
  it: bars (weekends dimmed), the pod's flat `$hourly x 24` line, day labels.

## State and restarts

- `state.json`: `baseline`, `last_raw`, `resets`, `last_reset_at`, `session
  {started_at, totals, finish}`, `reason_baseline`, `reason_last_raw`,
  `reason_started_at` (first poll that carried the per-reason split, stamped the
  first time reasons are seen; surfaced as `finish_since` so the "how they
  ended" row can label its window - it only covers traffic since that stamp,
  not the full lifetime).
  Written atomically (`.tmp` + rename) after every poll. Delete it to count from zero.
  `last_reset_at` stamps the poll that saw the most recent counter drop; the KV panels
  label their since-restart numbers with it.
- Counter reset detection is "any counter decreased". If the server restarts and serves
  more than its previous lifetime before the next poll, the reset is missed; second-scale
  polling makes that vanishingly unlikely.
- The poll that absorbs a restart reports its rates as 0/`null`: the fold puts the whole
  new lifetime into the cumulative totals, so that window's counter delta is the entire
  lifetime, not this poll's seconds — without the guard the chart gets one 30,000 tok/s
  sample and `req/min` spikes. `samples.reset` (1 on that poll, ALTER-added) tells the
  UI to skip reset-adjacent deltas in the preemption event detector.
- `history.sqlite` (WAL): `samples` (per poll, incl. `preempt` = the raw
  `num_preemptions_total` the UI uses to spot preemption events, and `reset` = the
  restart-absorbing poll, see above) pruned by
  `history_ttl_days`; `hist_snap` (per-poll raw histogram buckets, pruned with the
  samples); `ledger` (one row per UTC day) never pruned — all-time totals are a
  feature. Columns are added by ALTER, NULL-safe, and inserted by explicit column
  list so old databases with appended columns cannot misalign.

## Gateway observer (Live requests panel)

- `GET /api/gw_live` proxies `gateway.url` (config; env override
  `TOKENOMICS_GATEWAY_URL`). Unconfigured → `404`, the page hides the section.
  Unreachable → `502 {"ok": false, "error": ...}`, the page keeps the last snapshot,
  shows the STALE pill and dims the tables.
- The gateway's contract: `{ time, origin, in_flight: [req…] (oldest first),
  recent: [req…] (last 30 finished, newest first) }` with identity
  (`id`, `thread`, `client`, `model`, `effort`), progress (`phase`, `tool_name`,
  `started_at`, `age_s`, `ttft_s`), token counts (`prompt_tokens` +
  `prompt_tokens_is_estimate`, `cached_tokens`, `output_tokens` +
  `output_tokens_is_estimate`, `tok_s`), streamed text (`reasoning_chars`,
  `output_chars`, `tool_chars`, `tail`), context (`input_items`, `tools`,
  `last_input_type`) and outcome (`finish`, `error`, `events`).
- **Everything from the gateway is untrusted data.** `app.js` builds the panel with
  `createElement`/`textContent` only — never `innerHTML` with gateway strings, never
  execute anything from `tail`.
- The client keeps a `Map<id, number[60]>` of `tok_s` per request (one entry per
  1 s poll, null before the first token, capped at 60, ids pruned when the request
  leaves `in_flight`) for the shared-scale sparklines, and one open tail id.

## Host health

`read_gpus()` walks `/sys/class/drm/card*/device/hwmon/hwmon*` for amdgpu
(edge/junction/memory temperature, power draw, cap, fan, clock) and
`card*/device/` for `gpu_busy_percent` + `mem_info_vram_{used,total}`
(`None` when the kernel does not expose them); it keeps a 15-minute ring buffer for
the per-GPU min/max ranges. The hardware column shows each GPU and the CPU on a shared
0-110 °C scale (zone strip, 15-min min-max range, now marker) with power/cap,
VRAM, clocks, per-thread utilisation (`cpu.pct_cores`) and a footnote. `read_cpu()`
uses `/proc/stat`, `/proc/loadavg`, `hwmon` (`k10temp`/`zenpower`) and `cpufreq`.
Both return empty when the paths are absent, so running the dashboard off-box degrades
quietly. Keep it this way: no vendor CLIs, no `rocm-smi`/`nvidia-smi` shelling out.

## UI conventions

- One page, four sections top to bottom, each a plain block separated by
  `border-bottom: 1px solid var(--border)` on the page background. **No cards**: no
  card borders, no backgrounds, no shadows (the only shadow in the design is the mark's
  inset highlight). Full width, `main { padding: 0 40px }`, one ambient glow at the top
  (no grid pattern).
- Economics still first overall: section 4's hero is the saving against
  `hero_provider`; the pipeline (section 1) leads with what the server is doing now.
- Two series colors only - blue for API providers, orange for the pod, validated for
  colorblind separation in every theme. Green means savings/positive. Host sensors use
  their own fixed semantic ramp (`--t-ok`/`--t-warm`/`--t-hot`/`--t-crit`, `--power`,
  `--gpu-mem`); a temp value takes the color of its state. Phase badges in the gateway
  panel reuse existing tokens (queued `--warn`, prefill `--text-2`, thinking
  `--gpu-mem`, answering `--line`, tool call `--power`, done `--good`, error `--bad`).
  Add rows rather than new hues.
- Numbers in `var(--mono)` (Azeret Mono) with `tabular-nums`, compact form primary
  (46.0M) with exact values in tooltips. Text never wears a series color.
- Both scopes ride in every snapshot, so the All time / This deployment toggle is a pure
  client switch. The header range control is the only range control on the page and
  drives the main chart, the pipeline mini charts, the KV chart and the hardware
  min-max ranges by re-subscribing the SSE with `?minutes=`.
- Charts: the engine (`TokCharts.makeChart`) still exists but the redesigned page
  hand-builds its SVGs through `TokCharts.paths()` / `barsPath()` (same monotone +
  gap rules, `vector-effect: non-scaling-stroke`). `null` is a break in the line, never
  a straight join. Colors are emitted as `var(--token)` — pass a CSS variable name,
  never a raw color, and add new files to `STATIC_FILES` in `server.py` or they will
  not be served. The main chart alone has a hover tip (crosshair + one dot per series +
  time header with generation, window avg, running, waiting, KV %): the plot is rebuilt
  every frame, so the hover elements are re-created per draw and re-positioned from the
  last pointer x; nulls drop their row. Its lines (and the tip) are drawn from the
  per-second samples averaged into 5-second buckets fixed to the epoch grid - display
  smoothing only, so the 15-min view shows load levels instead of single-sample spikes
  while the window slides; the live end pill, event notes and every other view keep the
  raw samples. Its x is time, not index (`TokCharts.timePaths`): the axis labels and
  event notes are placed by time, so a run of missed polls breaks the line instead of
  compressing time and drifting the line off its own axis.
- Ranges come from SQLite: 15 min/1 h ride the snapshot buffer, 6 h/24 h/7 d refetch.
- Themes: `dark` is the default, then `light`, then `amber`; the header button cycles
  and persists to `localStorage`, and `?theme=` wins. Only chrome changes between
  themes - data series keep the same hues, so a screenshot means the same thing.
- Gateway panel: in-flight table (150/244/92/92/100/92/66/1fr/92 grid) with a 60-poll
  tok/s sparkline on a shared 0-40 scale; below it the "Just finished" table (last 30,
  10 shown). "Waiting for GPU" = `prefill` + no first token + `age_s > 15`.
  "tail is repeating" = a client-side heuristic (any 40-char substring of `tail`,
  stepping 10, seen 3+ times) shown on `thinking` rows. One tail open at a time;
  the open id survives polls and closes itself when the request leaves `in_flight`.
- `.flashy` / `.flash` give a one-shot background flash so live movement is visible
  (pipeline big numbers, savings hero).
- The page auto-reloads when `ui_version` changes so an open tab never runs stale
  assets after a deploy.

## Run it while developing

```bash
cp config.example.json config.json    # then edit metrics_url / bearer_token
python3 server.py --port 8787
curl -s localhost:8787/healthz
curl -s localhost:8787/api/stats | head -c 400
curl -sN localhost:8787/events | head -c 300
curl -s localhost:8787/api/gw_live    # 404 without gateway.url, 502 when it is down
```

There is no test suite; the check is: it starts with a real metrics endpoint, `/healthz`
is `ok`, `/api/stats` carries `totals`, `session`, `costs`, `gpus`, `cpu`, `lat`, and the
page renders in all three themes with and without GPU data, host CPU sensors, KV metrics
(llama.cpp) and a configured gateway (no gateway = section 2 hidden; gateway down =
stale pill). Keep `python3 -c "import ast,sys;ast.parse(open('server.py').read())"`
green, and keep the file importable with no side effects until `main()` runs.

## Extending it

- **New number**: parse into `COUNTERS`/`GAUGES` (or a `HIST_BASES` entry), derive it
  in `compute()`, add it to the snapshot, render it. Do not compute costs in JS.
- **Second endpoint**: `source` would become a list plus a UI selector; keep one
  `state.json` per source so totals cannot cross-contaminate.
- **Container control** (`DockerControl`) is opt-in via `TOKENOMICS_VLLM_CONTROL=1`
  because it reaches the Docker socket. Anything new in that direction needs the same
  treatment: default off, documented, and never implied by the presence of a socket.
  The gateway proxy is the opposite shape — it is always on when configured because
  it only ever GETs one URL on the same host.

## Pull requests

Small, focused commits with an imperative subject (`add llama.cpp gauge aliases`).
Update this file and README.md in the same commit as the behaviour change. No generated
files, no lockfiles, no editor settings beyond `.gitignore`.
