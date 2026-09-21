# tokenomics

A live dashboard for a self-hosted LLM inference endpoint. It reads the Prometheus
`/metrics` exposed by [vLLM](https://docs.vllm.ai) or
[llama.cpp](https://github.com/ggml-org/llama.cpp) and answers three questions in one
glance:

1. **How fast is it right now?** generated / prompt tok/s, running + waiting requests,
   KV-cache occupancy, speculative-decoding acceptance, inter-token latency.
2. **How much has it served?** prompt, cached, uncached and generated tokens, requests,
   and lifetime totals that survive inference-server restarts.
3. **What is it costing, and what would the same traffic cost from an API?** your pod's
   wall-clock spend next to a per-provider price sheet, per scope, with the saving.

Plus per-GPU temperature/power/fan (and CPU load) straight from host `hwmon`, with sparklines.

No build step, no framework, no CDN, no database server, no Python dependencies: one
stdlib-only `server.py`, three static files, and a JSON config.

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

Environment overrides: `TOKENOMICS_CONFIG`, `TOKENOMICS_STATE`, `TOKENOMICS_HISTORY_DB`,
`TOKENOMICS_HOST`, `TOKENOMICS_PORT`, `TOKENOMICS_BEARER`, `TOKENOMICS_QUIET=1`,
`TOKENOMICS_DOCKER_SOCK`, `TOKENOMICS_VLLM_CONTAINER`, `TOKENOMICS_VLLM_STOP_TIMEOUT`,
`TOKENOMICS_VLLM_CONTROL=1` (see [Security](#security)).

CLI flags: `--config`, `--host`, `--port`.

## Two scopes

Every snapshot carries both, so switching in the UI needs no refetch:

- **total** - `baseline + current raw`: everything counted since this `state.json`
  existed, across inference-server restarts. Pod cost runs from `pod.started_at` and
  adds `pod.prior_usd`.
- **session** - counters minus a baseline snapshotted at this deployment's first
  successful poll, persisted so it survives server restarts too. Pod cost runs from the
  session start.

## HTTP surface

| endpoint | what |
|---|---|
| `GET /` | the dashboard |
| `GET /events` | SSE stream, one snapshot per poll, 15 s keepalive |
| `GET /api/stats` | latest snapshot as JSON |
| `GET /api/history?minutes=N` | chart samples, bucket-averaged above 1500 points |
| `GET /api/ledger` | all-time daily rollups |
| `GET /api/vllm` | inference container status (control disabled by default) |
| `POST /api/vllm` | `{"action": "start" \| "stop" \| "restart"}` - only when `TOKENOMICS_VLLM_CONTROL=1` |
| `GET /healthz` | `200 {"ok": true}` when the last poll succeeded, `503` with the error otherwise |

Theme: dark by default, with a header toggle persisted in `localStorage`;
`?theme=light` / `?theme=dark` in the URL wins over the saved choice.

## How it works

```
metrics URL --(GET every poll_interval, Bearer token)--> Poller thread
   parse_metrics()   sum vllm:* / llamacpp:* counters and gauges across label sets
   State.absorb()    detect a counter reset, fold it into the baseline
   compute()         rates from deltas, per-scope views, provider + pod costs
   broadcast()       push JSON to every SSE subscriber
browser <--(SSE /events)--
```

- **Reset-safe counters.** Inference counters are process-lifetime and drop to 0 on
  restart. Any counter going backwards adds the previous raw values into a persisted
  baseline, so lifetime totals stay right; the UI shows how many restarts were absorbed.
  Delete `state.json` to count from zero.
- **llama.cpp is supported too.** `llamacpp:*` metric names are aliased onto the vLLM
  ones, including the semantic difference that llama.cpp's prompt counter excludes
  cached tokens.
- **Storage.** `state.json` for baselines and the session window; `history.sqlite`
  (WAL) for chart samples with a TTL and an never-pruned daily `ledger` table.
- **GPU health** comes from host `hwmon`
  (`/sys/class/drm/card*/device/hwmon/hwmon*`): edge/junction/memory temps, power draw
  and cap, fan RPM, clock. Absent path (running off-box) simply means no GPU tiles - no
  vendor CLI needed.
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
`/sys/class/drm` mount is what enables the GPU tiles.

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
