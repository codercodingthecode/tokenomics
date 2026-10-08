# tokenomics

A live dashboard for a self-hosted LLM inference endpoint. It reads the Prometheus
`/metrics` exposed by [vLLM](https://docs.vllm.ai) or
[llama.cpp](https://github.com/ggml-org/llama.cpp) and answers three questions in one
glance:

1. **What is the server doing right now?** a four-stage pipeline - Queue → Prefill →
   Decode → Done - with waiting requests, prompt tok/s, generation tok/s against its
   rolling average, requests per minute, queue/TTFT/e2e percentiles, and one large
   throughput chart, with written notes for preemption and RAM-restore bursts - hover it to read any point in time.
2. **What is each request doing?** (needs the LLM gateway, [below](#live-requests-optional))
   one row per in-flight request from the gateway's observer endpoint - phase,
   time-to-first-token, token counts, a live tok/s sparkline, and an expandable tail of
   the characters currently being generated - plus the last 30 finished requests.
3. **Is the KV cache earning its keep?** GPU VRAM pool and CPU offload tier side by
   side, with hit rates, store/load rates, and RAM restores. **Is the hardware OK?**
   per-GPU and per-CPU temperature on a shared 0-110 °C scale with 15-min ranges,
   power, VRAM, clocks and per-thread utilisation.
4. **Was it worth running it yourself?** the saving against the hero provider, the cost
   of the same traffic per provider, a day-by-day ledger of what the API would have
   charged, and lifetime totals that survive inference-server restarts.

Everything the hardware shows comes straight from host `hwmon` and `/proc` - no vendor
CLI is invoked.

No build step, no framework, no CDN, no database server, no Python dependencies: one
stdlib-only `server.py`, four static files plus two vendored variable fonts, and a JSON
config.

## Quickstart

```bash
cp config.example.json config.json   # point it at your endpoint, add the bearer token
python3 server.py --port 8787
open http://127.0.0.1:8787/
```

Verify:

```bash
curl -s localhost:8787/healthz                 # {"ok": true}
curl -sN localhost:8787/events | head -c 300   # first SSE event
```

Python 3.9+ is the only requirement.

## Configuration

`config.json` (gitignored) holds the endpoint and its credentials:

```json
{
  "source": {
    "label": "my inference box",
    "metrics_url": "http://127.0.0.1:8000/metrics",
    "bearer_token": "secret"
  },
  "pod": {
    "name": "my box",
    "hourly_usd": 0.62,
    "started_at": "2026-09-06T09:28:00Z",
    "paused_hours": 0,
    "prior_usd": 0,
    "prior_hours": 0
  },
  "providers": [
    { "name": "Example API", "input_per_m": 10.0, "cached_input_per_m": 1.0, "output_per_m": 50.0 }
  ],
  "hero_provider": "Example API",
  "gateway": { "url": "http://127.0.0.1:8081/__gw_live" },
  "poll_interval_seconds": 5,
  "history_minutes": 60,
  "history_ttl_days": 7,
  "smoothing_seconds": 120,
  "state_file": "state.json"
}
```

| key | meaning |
|---|---|
| `source.metrics_url` | the `/metrics` URL to scrape (vLLM or llama.cpp) |
| `source.bearer_token` | `Authorization: Bearer <token>` for the scrape; omit if the endpoint is open |
| `pod.hourly_usd` | what the machine costs per hour; `0` for hardware you already own |
| `pod.started_at` | when billing for the current pod started (ISO 8601) |
| `pod.paused_hours` | hours the pod sat stopped, so wall-clock cost stays honest |
| `pod.prior_usd` / `prior_hours` | spend carried forward from a previous machine; counted in the **total** scope only |
| `providers[]` | any number of API price points, in USD per 1M tokens |
| `hero_provider` | which provider the "saved so far" hero compares against; defaults to the priciest by list price |
| `poll_interval_seconds` | scrape interval (default 5) |
| `history_minutes` | how much history the chart requests |
| `history_ttl_days` | chart-sample retention; the daily ledger is never pruned |
| `smoothing_seconds` | trailing-average window for the dashed line (default 120) |
| `gpu.sysfs` | `hwmon` root to read GPU stats from, default `/sys/class/drm` |
| `gpu.label` | display name on the GPU tiles |
| `cpu.hwmon` / `cpu.sysfs` | `hwmon` root and CPU sysfs root for the CPU tile (load, per-core busy, package temp, clocks) |
| `kv.gpu_capacity_tokens` | size of the GPU KV pool in tokens (from the vLLM startup log); turns usage % into "tokens in cache". Default 547295 |
| `kv.ram_capacity_bytes` | size of the CPU KV offload tier in bytes; turns pinned usage % into GB. Default 25760000000 (24 GiB) |
| `gateway.url` | the LLM gateway observer endpoint the page's Live requests panel polls (see [Live requests](#live-requests-optional)); omit to hide the section. Env override `TOKENOMICS_GATEWAY_URL` |

Environment overrides: `TOKENOMICS_CONFIG`, `TOKENOMICS_STATE`, `TOKENOMICS_HISTORY_DB`,
`TOKENOMICS_HOST`, `TOKENOMICS_PORT`, `TOKENOMICS_BEARER`, `TOKENOMICS_QUIET=1`,
`TOKENOMICS_GATEWAY_URL`, `TOKENOMICS_DOCKER_SOCK`,
`TOKENOMICS_VLLM_CONTAINER`, `TOKENOMICS_VLLM_STOP_TIMEOUT`, `TOKENOMICS_VLLM_CONTROL=1`
(see [Security](#security)).

CLI flags: `--config`, `--host`, `--port`.

## Two scopes

Every snapshot carries both, so switching in the UI needs no refetch:

- **total** - `baseline + current raw`: everything counted since this `state.json`
  existed, across inference-server restarts. Pod cost runs from `pod.started_at` and
  adds `pod.prior_usd`.
- **session** - counters minus a baseline snapshotted at this deployment's first
  successful poll, persisted so it survives server restarts too. Pod cost runs from the
  session start.

## Live requests (optional)

Point `gateway.url` at the LLM gateway's observer endpoint and the page grows a
**Live requests** section that polls `GET /api/gw_live` once a second (a stdlib proxy
in `server.py`, so the browser stays same-origin and the gateway URL never ships to the
client; the gateway needs no auth from the host and no CORS headers):

- **In flight.** One row per request, oldest first: thread label (last 8 chars of the
  Codex thread id, or the gateway id), a phase badge (`queued`, `prefill`, `thinking`,
  `answering`, `tool call`, `done`, `error`), time to first token, age, prompt/output
  tokens (`~` marks the gateway's pre-finish estimates), live tok/s, and a 60-poll
  tok/s sparkline on a shared 0-40 scale. Rows where a `prefill` has had no first token
  for 15 s read "waiting for GPU". Clicking a row expands the last 600 streamed
  characters in a plain-text box (marked "shown as plain text, never run") - handy for
  spotting loops.
- **Just finished.** The last 30 finished requests: finish reason, TTFT, prompt vs
  cached tokens with the cache share, output, tok/s, and duration. Rows that did not
  complete are tinted red.
- **Stale handling.** If the gateway is unreachable (e.g. restarting), the last
  snapshot is kept, a `STALE` pill shows its age, and the tables dim. When the next
  poll succeeds the panel goes live again.

Every string from the endpoint is untrusted data: the panel is built with
`textContent` only - nothing from the gateway is ever inserted as HTML or executed.
Omit `gateway.url` and the section hides itself (the proxy returns `404`).

## HTTP surface

| endpoint | what |
|---|---|
| `GET /` | the dashboard |
| `GET /events` | SSE stream, one snapshot per poll, 15 s keepalive |
| `GET /api/stats` | latest snapshot as JSON |
| `GET /api/history?minutes=N` | chart samples, bucket-averaged above 1500 points |
| `GET /api/gw_live` | proxies the gateway observer (body passed through, `Cache-Control: no-store`); `404` when no gateway is configured, `502` when it is unreachable |
| `GET /api/ledger` | per-UTC-day rollups: token deltas, the hero provider's cost for the day, and the pod's cost for the day (costs are computed server-side) |
| `GET /api/vllm` | inference container status (control disabled by default) |
| `POST /api/vllm` | `{"action": "start" \| "stop" \| "restart"}` - only when `TOKENOMICS_VLLM_CONTROL=1` |
| `GET /healthz` | `200 {"ok": true}` when the last poll succeeded, `503` with the error otherwise |

Theme: `dark` (default), `light`, and `amber` - a low-blue wall-display theme. The
header button cycles all three and the choice persists in `localStorage`;
`?theme=dark` / `?theme=light` / `?theme=amber` in the URL wins over the saved choice.
Series colors are identical in all three, so only the chrome changes.

## How it works

```
metrics URL --(GET every poll_interval, Bearer token)--> Poller thread
   parse_metrics()   sum vllm:* / llamacpp:* counters and gauges across label sets;
                     keep _bucket histograms per le and the per-finished_reason split
   State.absorb()    detect a counter reset, fold it into the baseline
   compute()         rates from deltas, per-scope views, provider + pod costs
   broadcast()       push JSON to every SSE subscriber
browser <--(SSE /events)
browser <--(GET /api/gw_live every 1 s)--> server proxies the gateway observer
```

- **Reset-safe counters.** Inference counters are process-lifetime and drop to 0 on
  restart. Any counter going backwards adds the previous raw values into a persisted
  baseline, so lifetime totals stay right; the UI shows how many restarts were absorbed.
  Delete `state.json` to count from zero.
- **llama.cpp is supported too.** `llamacpp:*` metric names are aliased onto the vLLM
  ones, including the semantic difference that llama.cpp's prompt counter excludes
  cached tokens.
- **Latency percentiles** (TTFT p50/p90, queue time p90, e2e p90) come from the
  `vllm:*_seconds_bucket` histograms: each poll's raw buckets are stored in a
  `hist_snap` table and the quantile is computed from bucket **deltas** over the chart
  window (interpolating inside the crossing bucket), falling back to the current vLLM
  lifetime. "How requests ended" is the per-`finished_reason` split of
  `request_success_total`, restart-safe like the other counters.
- **Storage.** `state.json` for baselines and the session window; `history.sqlite`
  (WAL) for chart samples (with a `preempt` column the UI uses to mark preemption
  events) with a TTL, a `hist_snap` table for the histogram percentiles, and an
  never-pruned daily `ledger` table.
- **GPU health** comes from host `hwmon`
  (`/sys/class/drm/card*/device/hwmon/hwmon*`): edge/junction/memory temps, power draw
  and cap, fan RPM, clock. Absent path (running off-box) simply means no GPU tiles - no
  vendor CLI needed.
- **Host CPU health** comes from `k10temp`/`zenpower` temp inputs under
  `cpu.hwmon` (`/sys/class/hwmon`, `Tctl` = the hottest sensor on the die), per-thread
  `scaling_cur_freq` plus `scaling_max_freq`/`boost` under `cpu.sysfs`
  (`/sys/devices/system/cpu`), and `/proc/stat` deltas for utilisation. Every reader
  returns `None` per field, the panel hides itself when all of them are absent, and a gap
  in a chart line means the sensor was missing then, not that the host was idle.
- **Stale-UI protection**: `ui_version` (max mtime of the static files) rides in every
  snapshot and the page reloads itself when it changes.

## Deploy

### Docker

```bash
docker build -t tokenomics .
docker run -d --name tokenomics --restart unless-stopped -p 8787:8787 \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v "$PWD/state:/app/state" \
  -v /sys/class/drm:/sys/class/drm:ro \
  tokenomics
```

The `state` mount keeps `state.json` and `history.sqlite` across image rebuilds; the
`/sys/class/drm` mount is what enables the GPU tiles. The host CPU panel needs no extra
mount - Docker's shared `sysfs` and `/proc/stat` already expose the CPU sensors and the
host-wide utilisation counters.

### systemd

```bash
sudo cp -r . /opt/tokenomics && cd /opt/tokenomics
sudo cp tokenomics.service /etc/systemd/system/
sudo systemctl enable --now tokenomics
```

The unit runs as `nobody`: make sure the state location is writable, or point
`TOKENOMICS_STATE` somewhere that is.

## Security

- **The dashboard has no authentication.** Run it on a trusted network, behind a
  reverse proxy with auth, or bind it to localhost and tunnel it.
- `config.json` holds the bearer token and is gitignored. `/api/stats` exposes the
  source URL but never the token.
- Container control (`POST /api/vllm`) talks to the Docker socket and is therefore
  **off unless you set `TOKENOMICS_VLLM_CONTROL=1`**. If you enable it, the dashboard
  can start and stop that container - treat the network accordingly.
- Scraping is outbound-only; nothing else about your endpoint leaves the process.

## Limits

- One endpoint per instance (run one container per endpoint on separate ports).
- Inference counters are process-wide, so there is no per-user or per-session split.
  Attribution needs a proxy with virtual keys in front.
- Provider costs use list prices from `providers[]`; cached-input assumptions differ
  between hosts, so treat the comparison as an estimate.
- The session scope starts at the first successful poll, not before.

## Contributing

Keep it boring on purpose: stdlib-only server, vanilla JS, no build step, no new
runtime dependencies. `AGENTS.md` documents the internals and the conventions. Open an
issue before adding a dependency or a framework.

## License

MIT - see [LICENSE](LICENSE).
