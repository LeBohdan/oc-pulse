<!-- Copyright (c) 2026 Bohdan Futerko
Website: https://www.bf.com.ua
GitHub: https://github.com/LeBohdan -->

# API — llama-swap-pulse

## Endpoints

| Method | Path | Description | Content-Type |
|--------|------|-------------|--------------|
| GET | `/pulse/health` | Health check | `application/json` |
| GET | `/pulse/metrics` | Current snapshot | `application/json` |
| GET | `/pulse/live` | SSE event stream | `text/event-stream` |

All other paths return `404 Not Found`.

---

## Health

`GET /pulse/health`

Returns service status and connection state to llama-swap.

### Response Codes

| Code | Condition |
|------|-----------|
| `200 OK` | Service running, connected to llama-swap |
| `503 Service Unavailable` | Service running, **not** connected to llama-swap |

### Response Body

```json
{
  "status": "ok",
  "llama_swap_connected": true
}
```

---

## Current Snapshot

`GET /pulse/metrics`

Returns current state of all tracked tasks.

### Response Body

```json
{
  "active": true,
  "current_task": {
    "upstream": "Qwen3.6-27B-Strata",
    "slot": 1,
    "task": 1,
    "phase": "generation",
    "prompt_tokens": 80569,
    "generated_tokens": 1042,
    "prompt_tps": 174.22,
    "generation_tps": 11.03,
    "generation_tps_3s": 11.21,
    "progress": 0.45,
    "updated_at": "2025-07-24T12:31:06Z"
  },
  "tasks": [
    {
      "slot": 0,
      "task": 9165,
      "phase": "generation",
      "prompt_tokens": 80569,
      "generated_tokens": 1042,
      "prompt_tps": 174.22,
      "generation_tps": 11.03,
      "generation_tps_3s": 11.21,
      "progress": 0.45,
      "updated_at": "2025-07-24T12:31:06Z"
    }
  ],
  "upstreams": [
    {
      "upstream": "Qwen3.6-27B-Strata",
      "engine": "strata",
      "state": "generating",
      "phase": "thinking",
      "queued": 0,
      "model": "qwen3.6-27b-iq4_xs",
      "gpu": {
        "util": 99,
        "mem_used": 25493045248,
        "mem_total": 25769803776,
        "temp": 76,
        "power": 330.05
      },
      "ram": { "used": 58739142656, "total": 67269300224 },
      "cpu": 50.2,
      "updated_at": "2025-07-24T12:31:06Z"
    }
  ]
}
```

### Schema

#### Snapshot

| Field | Type | Description |
|-------|------|-------------|
| `active` | `bool` | `true` if current task is running (not finished, not cancelled) |
| `current_task` | `TaskState` | The most recently updated task; omitted if no tasks exist |
| `tasks` | `TaskState[]` | All tracked tasks (may include recently finished/cancelled) |
| `upstreams` | `UpstreamState[]` | Polled Strata/Maya engines and their current state |

#### TaskState

| Field | Type | Description |
|-------|------|-------------|
| `upstream` | `string` | Upstream model name for tasks from polled engines (Strata/Maya); omitted for llama.cpp tasks |
| `slot` | `int` | Slot index (llama.cpp), or synthetic per-upstream id (Strata/Maya, prefixed by `upstream`) |
| `task` | `int` | Task ID (llama.cpp), or per-upstream task counter (Strata/Maya) |
| `phase` | `string` | Current phase: `prefill`, `generation`, or `finished` |
| `prompt_tokens` | `int` | Number of prompt tokens processed |
| `generated_tokens` | `int` | Number of tokens generated so far |
| `prompt_tps` | `float` | Tokens per second during prefill (omitted if not available) |
| `generation_tps` | `float` | Average tokens per second during generation (omitted if not available) |
| `generation_tps_3s` | `float` | Moving-average TPS over last 3 seconds (omitted if not available) |
| `prompt_eval_ms` | `float` | Total prompt evaluation time in ms (omitted if not available) |
| `total_ms` | `float` | Total wall-clock time in ms (omitted if not available) |
| `total_tokens` | `int` | Total tokens (prompt + generated) (omitted if not available) |
| `keep` | `float` | Fraction of prompt kept (restored) from previous slot (omitted if not available) |
| `progress` | `float` | Fraction 0.0–1.0 of generation progress (omitted if not available) |
| `graphs_reused` | `int` | Number of cached graph reuses (omitted if not available) |
| `truncated` | `int` | Truncation flag (omitted if not available) |
| `updated_at` | `string` | ISO 8601 timestamp of last update |
| `finished` | `bool` | `true` when task completed normally |
| `cancelled` | `bool` | `true` when task was cancelled |

#### UpstreamState

| Field | Type | Description |
|-------|------|-------------|
| `upstream` | `string` | Upstream model name as configured in llama-swap |
| `engine` | `string` | Engine kind: `strata` or `maya` |
| `state` | `string` | Engine activity state: `idle`, `reading`, `generating`, `queued`, `unloaded` |
| `phase` | `string` | Human-readable phase reported by the engine (e.g. `thinking`, `reading the prompt`) |
| `queued` | `int` | Number of requests queued on the engine |
| `model` | `string` | Model name as reported by the engine itself |
| `gpu` | `GPUStats` | GPU telemetry (omitted if not reported) |
| `ram` | `RAMStats` | Host memory telemetry, bytes (omitted if not reported) |
| `cpu` | `float` | Host CPU utilization percent |
| `updated_at` | `string` | ISO 8601 timestamp of last poll |

#### GPUStats

| Field | Type | Description |
|-------|------|-------------|
| `util` | `float` | GPU utilization percent (omitted if not available) |
| `mem_used` | `int` | GPU memory used, bytes |
| `mem_total` | `int` | GPU memory total, bytes |
| `temp` | `float` | GPU temperature °C (omitted if not available) |
| `power` | `float` | GPU power draw, watts (omitted if not available) |

#### RAMStats

| Field | Type | Description |
|-------|------|-------------|
| `used` | `int` | RAM used, bytes |
| `total` | `int` | RAM total, bytes |

---

## Live Event Stream

`GET /pulse/live`

Server-Sent Events stream. Emits events derived from llama-swap logs
(llama.cpp) and from polled engine `/metrics` snapshots (Strata/Maya).

### Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `text/event-stream` |
| `Cache-Control` | `no-cache` |
| `Connection` | `keep-alive` |
| `Access-Control-Allow-Origin` | `*` |

CORS is enabled — the stream can be consumed directly from a browser.

### Format

Each event:

```
event: <event_type>
data: <JSON>
```

### SSE Behavior

- Each subscriber gets a buffered channel of **1 event**.
- When the buffer is full, events are silently dropped — slow clients lose events rather than block the stream. This is by design — the stream is live, not reliable. Clients should not expect all events, only the most recent state.
- Clients receive an initial **snapshot** event upon connection with the current state.
- The connection persists until the client disconnects.
- Subscriptions are automatically cleaned up when the client disconnects.

### Task TTL

Finished or cancelled tasks are removed from the snapshot after **60s** (configurable via `metrics.ttl`). Active tasks are removed after **10m** of inactivity. Clients should not rely on stale task data beyond these windows. Polled engines disappear from `upstreams` when their poller stops (model unloaded) or after the same `metrics.ttl` without updates.

---

## Event Types

Task lifecycle events (`task_started`, `prefill_progress`, `generation_progress`,
`generation_complete`, `task_finished`) are emitted both for llama.cpp (parsed
from logs) and for polled Strata/Maya engines. Events from polled engines carry
an `upstream` field; llama.cpp events do not. The llama.cpp-only events
(`slot_selected`, `task_cancelled`) and the polled-engine-only `upstream_state`
are documented below.

### `slot_selected`

Triggered when a slot is selected by LCP similarity for a new task. Reports the fraction of prompt kept (`keep`).

```json
{
  "type": "slot_selected",
  "slot": 0,
  "task": -1,
  "keep": 0.384,
  "timestamp": "2025-07-24T12:29:59Z"
}
```

### `task_started`

Triggered when a new task is launched on a slot.

```json
{
  "type": "task_started",
  "slot": 0,
  "task": 9165,
  "phase": "prefill",
  "timestamp": "2025-07-24T12:30:00Z"
}
```

### `prefill_progress`

Triggered during prompt processing. Reports how many tokens have been processed so far.

```json
{
  "type": "prefill_progress",
  "slot": 0,
  "task": 9165,
  "prompt_tokens": 80569,
  "prompt_tps": 174.22,
  "progress": 0.12,
  "timestamp": "2025-07-24T12:30:01Z"
}
```

### `generation_progress`

Triggered as tokens are generated. Reports current generation speed.

```json
{
  "type": "generation_progress",
  "slot": 0,
  "task": 9165,
  "generated_tokens": 42,
  "generation_tps": 11.03,
  "generation_tps_3s": 11.21,
  "progress": 0.05,
  "timestamp": "2025-07-24T12:30:05Z"
}
```

### `generation_complete`

Triggered when generation finishes. Reports final timing.

```json
{
  "type": "generation_complete",
  "slot": 0,
  "task": 9165,
  "generated_tokens": 1042,
  "generation_tps": 11.03,
  "timestamp": "2025-07-24T12:32:00Z"
}
```

### `task_finished`

Triggered when the slot is released. Task is complete.

```json
{
  "type": "task_finished",
  "slot": 0,
  "task": 9165,
  "truncated": 0,
  "timestamp": "2025-07-24T12:32:01Z"
}
```

### `task_cancelled`

Triggered when a task is cancelled.

```json
{
  "type": "task_cancelled",
  "slot": 0,
  "task": 9165,
  "timestamp": "2025-07-24T12:31:00Z"
}
```

### `upstream_state`

Emitted once per poll tick (default every `poll.interval` = 1s) for each
polled Strata/Maya engine. Carries the engine state and hardware telemetry.
`upstream` identifies the model; `slot`/`task` are `0` and meaningless here.

```json
{
  "type": "upstream_state",
  "upstream": "Qwen3.6-27B-Strata",
  "slot": 0,
  "task": 0,
  "upstream_state": {
    "upstream": "Qwen3.6-27B-Strata",
    "engine": "strata",
    "state": "generating",
    "phase": "thinking",
    "queued": 0,
    "model": "qwen3.6-27b-iq4_xs",
    "gpu": { "util": 99, "mem_used": 25493045248, "mem_total": 25769803776, "temp": 76, "power": 330.05 },
    "ram": { "used": 58739142656, "total": 67269300224 },
    "cpu": 50.2,
    "updated_at": "2025-07-24T12:30:05Z"
  },
  "timestamp": "2025-07-24T12:30:05Z"
}
```

---

## MetricEvent Schema (SSE `data` field)

All events share this struct. Fields marked `omitempty` may be absent depending on the event type.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Event type (see above) |
| `upstream` | `string` | Upstream model name for polled-engine events; omitted for llama.cpp events |
| `slot` | `int` | Slot index (synthetic for polled engines) |
| `task` | `int` | Task ID (per-upstream counter for polled engines) |
| `phase` | `string` | Phase (present for `task_started`) |
| `prompt_tokens` | `int` | Tokens in the prompt |
| `prompt_tps` | `float` | Prompt processing speed |
| `prompt_eval_ms` | `float` | Prompt evaluation time |
| `progress` | `float` | Progress fraction 0.0–1.0 |
| `generated_tokens` | `int` | Tokens generated so far |
| `generation_tps` | `float` | Generation speed |
| `generation_tps_3s` | `float` | 3-second moving average TPS |
| `total_ms` | `float` | Total wall-clock time |
| `total_tokens` | `int` | Prompt + generated token count |
| `graphs_reused` | `int` | Cached graph reuse count |
| `truncated` | `int` | Truncation flag |
| `keep` | `float` | Fraction of prompt kept (restored) from previous slot |
| `n_tokens` | `int` | Token count from llama.cpp |
| `upstream_state` | `UpstreamState` | Engine state payload (present only for `upstream_state` events) |
| `timestamp` | `string` | ISO 8601 timestamp |

---

## Task Lifecycle

A task on a slot goes through these phases:

1. **`prefill`** — `task_started` → prompt is being processed → `prefill_progress` events
2. **`generation`** — `generation_progress` events as tokens are produced → `generation_complete`
3. **`finished`** — `task_finished` (slot released) or `task_cancelled`

```ntask_started```
  → `prefill` phase
  → `prefill_progress` (0 or more)
  → `generation_progress` (1 or more)
  → `generation_complete`
  → `task_finished` / `task_cancelled`
```

For polled Strata/Maya engines the same sequence is derived purely from the
current `/metrics` `live` snapshot and its state transitions (request history
in the payload is ignored):

| Engine `live.state` transition | Pulse events |
|--------------------------------|--------------|
| (none) → `reading` | `task_started`, then `prefill_progress` each tick |
| `reading` → `generating` | `generation_progress` each tick (prefill speed captured in the first one) |
| `generating` → `idle`/`unloaded`/`queued` | `generation_complete` + `task_finished` |

A new synthetic task starts whenever the engine enters `reading`/`generating`
with no task in flight (so pulse restarting mid-generation still reports the
running task). In-flight tasks are finalized when the model is unloaded from
llama-swap.

---

## Reconnection

If the connection to llama-swap is lost, the service automatically reconnects with exponential backoff: starting at 1s, doubling each attempt, capped at 30s. Use `/pulse/health` to detect disconnection (returns `503` while disconnected).
