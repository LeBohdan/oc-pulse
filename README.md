# oc-pulse

Real-time LLM inference metrics visualization for OpenCode.

## Purpose

Designed for AI researchers and developers using self-hosted inference servers. See generation speed and progress in real-time while waiting for LLM responses in OpenCode.

## Architecture

This plugin works with **llama-swap-pulse**, a companion server that:
- Reads logs from your llama-swap instance
- Exposes metrics via HTTP API and Server-Sent Events (SSE)
- Provides real-time inference data in a plugin-friendly format

The plugin automatically connects to the pulse server based on your provider's `baseURL` configuration.

## Install

Add to your `~/.config/opencode/tui.json`:

**From npm:**
```json
{
  "plugin": [
    ["oc-pulse", { "port": 8090, "debug": true }]
  ]
}
```

**From local file:**
```json
{
  "plugin": [
    ["file:///path/to/oc-pulse", { "port": 8090, "debug": true }]
  ]
}
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `8090` | Pulse server port. If omitted, defaults to `8090`. |

## How it works

- Reads the current session's provider `baseURL` automatically
- Strips path components (e.g. `/v1`, `/openai`) and uses host + port
- Displays LLM metrics in the session prompt area
- Automatically reconnects when switching providers

## Metrics

Live metrics are displayed in the right side of the session prompt:

### Prefill Phase (prompt processing)
- Progress percentage
- Processing speed (tokens/sec)
- Number of prompt tokens

### Generation Phase (response generation)
- Generation speed (tokens/sec)
- Number of tokens generated

### Completed Tasks
- Total duration
- Total tokens (prompt + generated)

### Additional Info
- Graph cache reuse count (when available)
- Model restoration similarity score (when restoring cached context)

**Status indicators:**
- `◯` — Connected but no task running
- `✕` — Pulse server running but disconnected from llama-swap
- `(empty)` — Inactive (no session or no baseURL)

## Requirements

- OpenCode >= 1.14.31
- A provider with a `baseURL` configured (e.g., a llama-swap instance)
- **llama-swap-pulse** running on your llama-swap server

  Install and configure: https://github.com/LeBohdan/llama-swap-pulse

Providers without `baseURL` (e.g., OpenRouter, API-key providers) will show `inactive` state.

---

## Copyright

(c) Bohdan Futerko, 2026, [https://www.bf.com.ua](https://www.bf.com.ua), [https://github.com/LeBohdan](https://github.com/LeBohdan)
