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

#### TaskState

| Field | Type | Description |
|-------|------|-------------|
| `slot` | `int` | Slot index on llama-swap |
| `task` | `int` | Task ID on llama-swap |
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
| `sim` | `float` | Best LCP similarity score for slot selection (omitted if not available) |
| `progress` | `float` | Fraction 0.0–1.0 of generation progress (omitted if not available) |
| `graphs_reused` | `int` | Number of cached graph reuses (omitted if not available) |
| `truncated` | `int` | Truncation flag (omitted if not available) |
| `updated_at` | `string` | ISO 8601 timestamp of last update |
| `finished` | `bool` | `true` when task completed normally |
| `cancelled` | `bool` | `true` when task was cancelled |

---

## Live Event Stream

`GET /pulse/live`

Server-Sent Events stream. Emits events as they are parsed from llama-swap logs.

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

Finished or cancelled tasks are removed from the snapshot after **60s** (configurable via `metrics.ttl`). Active tasks are removed after **10m** of inactivity. Clients should not rely on stale task data beyond these windows.

---

## Event Types

### `slot_selected`

Triggered when a slot is selected by LCP similarity for a new task. Reports the fraction of prompt kept (`keep`) and the best similarity score (`sim`).

```json
{
  "type": "slot_selected",
  "slot": 0,
  "task": -1,
  "keep": 0.985,
  "sim": 0.382,
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

---

## MetricEvent Schema (SSE `data` field)

All events share this struct. Fields marked `omitempty` may be absent depending on the event type.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Event type (see above) |
| `slot` | `int` | Slot index |
| `task` | `int` | Task ID |
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
| `sim` | `float` | Best LCP similarity score for slot selection |
| `n_tokens` | `int` | Token count from llama.cpp |
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

---

## Reconnection

If the connection to llama-swap is lost, the service automatically reconnects with exponential backoff: starting at 1s, doubling each attempt, capped at 30s. Use `/pulse/health` to detect disconnection (returns `503` while disconnected).

---

(c) Bohdan Futerko, 2026, https://www.bf.com.ua, https://github.com/LeBohdan
